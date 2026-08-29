// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  deliverableTo,
  deliveryExpectationSchema,
  hasExpired,
  hiveMessageSchema,
  shouldRetry,
  type Acknowledgement,
  type DeliveryExpectation,
  type HiveMessage,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// EventIQ — Wave I. The durable, governed asynchronous event backbone.
//
// Charter: "How can engines reliably know that something happened without
// routing every interaction synchronously through Prime?"
//
// Doctrine, and the sentence this file is arranged around:
//
//   "Events tell the Hive what happened. They do not decide what should be
//    authorized next."
//
// WHAT IT OWNS AND WHAT IT DOES NOT
//
// Authoritative for: accepted event envelopes, delivery and subscription state,
// consumer offsets, replay state, dead-letter state, transport metadata.
//
// NOT authoritative for: the business facts the events carry. An order event
// passing through here does not make EventIQ a source of truth for orders, and
// `sourceOfTruthFor()` returns the transport concerns only — there is a test.
//
// THE FIVE REQUIRED INVARIANTS, EACH WITH CODE BEHIND IT
//
//   Event delivery does not create authority.
//       `deliveryGrantsAuthority()` returns false always. A consumer that
//       receives an event has learned something happened, not acquired the
//       right to act on it.
//
//   Replay shall not knowingly duplicate irreversible consequential effects.
//       `replay()` REFUSES a consumer that has not declared idempotency, and
//       refuses harder when the events carry irreversible effects. This is the
//       one that would otherwise turn a recovery into a second incident.
//
//   Tenant routing boundaries remain intact.
//       Every delivery goes through `deliverableTo`. A subscription cannot be
//       created across tenants, and a system-scoped subscriber does not
//       thereby receive tenant-scoped events.
//
//   EventIQ does not become the source of truth for domain facts.
//       The log stores envelopes, not entities, and exposes no query by
//       business key.
//
//   Prime is not required to relay all events.
//       Nothing here references Prime. Constitution §2.3.
//
// IT IMPLEMENTS COMMUNICATION CORE'S VOCABULARY, IT DOES NOT REDEFINE IT
//
// Charter: "Communication Core defines event primitives; EventIQ operationalizes
// them." So the delivery expectation, the acknowledgement outcomes, `shouldRetry`
// and `hasExpired` all come from the shared contract rather than being restated
// here. EventIQ decides WHEN to retry by asking Communication's function, not by
// having an opinion of its own.
// ─────────────────────────────────────────────────────────────────────────────

export const EVENTIQ_ENGINE_ID = "hive.platform.eventiq";

/** What EventIQ is authoritative for. Transport, never content. */
export const EVENTIQ_SOURCE_OF_TRUTH: readonly string[] = Object.freeze([
  "event_envelope",
  "delivery_state",
  "subscription_state",
  "consumer_offset",
  "replay_state",
  "dead_letter_state",
  "event_transport_metadata",
]);

export function sourceOfTruthFor(): readonly string[] {
  return EVENTIQ_SOURCE_OF_TRUTH;
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export const subscriptionSchema = z
  .object({
    subscriptionId: z.string().min(1),
    /** The consumer group. Members share one offset. */
    consumerGroup: z.string().min(1),
    consumerId: z.string().min(1),
    /** Message types this subscription wants. Exact, or `*` for all. */
    messageTypes: z.array(z.string().min(1)).min(1),
    /**
     * The tenant this subscription reads.
     *
     * Required. A subscription with no tenant would receive whatever routing
     * happened to hand it, which is how a boundary is crossed by omission.
     * System-scoped consumers declare that explicitly below.
     */
    tenant: z.string().min(1).nullable(),
    /** True for a consumer of engine-lifecycle events that belong to no tenant. */
    systemScoped: z.boolean(),
    expectation: deliveryExpectationSchema,
    /**
     * Whether this consumer suppresses duplicate effects.
     *
     * Drives the replay gate. Declared by the consumer and taken at its word
     * here — EventIQ cannot inspect a consumer's implementation — but recorded,
     * so a consumer that claimed idempotency and duplicated an effect has a
     * traceable claim rather than a shrug.
     */
    idempotent: z.boolean(),
    createdAt: z.string().min(1),
  })
  .strict()
  .refine((s) => (s.tenant === null) === s.systemScoped, {
    message:
      "A subscription reads one tenant or declares itself system-scoped, never both and never neither. A missing tenant is far more often a bug than a system consumer.",
    path: ["tenant"],
  });
export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * An acknowledgement of one delivery to one subscription.
 *
 * Communication Core's `acknowledgementSchema` covers the outcome vocabulary and
 * the rule that anything short of acceptance must say why. This adds the
 * subscription, because EventIQ delivers one message to many subscriptions and
 * an acknowledgement that did not say which one had answered would advance the
 * wrong checkpoint.
 */
export const eventDeliveryAckSchema = z
  .object({
    messageId: z.string().min(1),
    subscriptionId: z.string().min(1),
    by: z.string().min(1),
    at: z.string().min(1),
    outcome: z.enum(["accepted", "duplicate", "rejected", "deferred"]),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((a) => a.outcome === "accepted" || Boolean(a.reason), {
    message:
      "A rejection, deferral or duplicate must say why — Communication Core's rule, restated here because this schema adds a field rather than extending that one.",
    path: ["reason"],
  });
export type EventDeliveryAck = z.infer<typeof eventDeliveryAckSchema>;

export const deliveryStateSchema = z.enum([
  "pending",
  "delivered",
  "acknowledged",
  "retrying",
  "dead_lettered",
  "expired",
]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;

export interface DeliveryAttempt {
  readonly messageId: string;
  readonly subscriptionId: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly firstAttemptedAt: string;
  readonly lastAttemptedAt: string;
  readonly lastReason: string;
  /** Set once dead-lettered, so provenance survives (charter: Dead-Letter Resolve). */
  readonly deadLetteredAt: string | null;
}

export interface AcceptedEvent {
  readonly message: HiveMessage;
  readonly sequence: number;
  readonly acceptedAt: string;
}

/** The engine's own events (charter: Events Published). */
export const eventiqEventSchema = z.enum([
  "EventAccepted",
  "EventDeliveryFailed",
  "EventDeadLettered",
  "EventReplayStarted",
  "EventReplayCompleted",
  "SubscriptionDegraded",
]);
export type EventIqEvent = z.infer<typeof eventiqEventSchema>;

// ── Governance and containment ports ─────────────────────────────────────────

/**
 * Whether an action is authorized.
 *
 * A port. EventIQ never decides authority — charter: "Governance determines
 * whether consequential actions, data use, delegation, and access are
 * authorized. Where required authority cannot be established, the action fails
 * closed or escalates."
 */
export interface EventAuthority {
  mayPublish(input: { producerId: string; tenant: string | null; messageType: string }): {
    permitted: boolean;
    reason: string;
    decisionId: string;
  };
  mayReplay(input: {
    requestedBy: string;
    tenant: string | null;
    fromSequence: number;
    toSequence: number;
  }): { permitted: boolean; reason: string; decisionId: string };
}

/** Sentinel's ability to isolate a stream or a consumer (charter §Sentinel). */
export interface StreamContainment {
  isolatedSubscriptions(): readonly string[];
  isolatedMessageTypes(): readonly string[];
}

// ── Results ──────────────────────────────────────────────────────────────────

export type PublishResult =
  | { readonly accepted: true; readonly event: AcceptedEvent }
  | { readonly accepted: false; readonly reason: string; readonly failedClosed: boolean };

export type SubscribeResult =
  | { readonly subscribed: true; readonly subscription: Subscription }
  | { readonly subscribed: false; readonly reason: string };

export interface PolledEvent {
  readonly message: HiveMessage;
  readonly sequence: number;
  readonly attempt: number;
  readonly isReplay: boolean;
}

export type ReplayResult =
  | { readonly started: true; readonly events: readonly PolledEvent[]; readonly decisionId: string }
  | { readonly started: false; readonly reason: string };

export interface EventIq {
  /** Charter contract: Publish Event. */
  publish(input: unknown): PublishResult;

  /** Charter contract: Consume Event. */
  subscribe(input: unknown): SubscribeResult;

  /**
   * Events waiting for a subscription, from its checkpoint forward.
   *
   * Does not advance the offset. `acknowledge` does — a poll that advanced the
   * checkpoint would lose every message the consumer crashed before handling.
   */
  poll(subscriptionId: string, limit?: number): readonly PolledEvent[];

  /** Records what the consumer did. Advances the offset only on acceptance. */
  acknowledge(input: unknown): { recorded: boolean; reason: string };

  /** Charter contract: Replay. Refuses a non-idempotent consumer. */
  replay(input: {
    subscriptionId: string;
    fromSequence: number;
    toSequence: number;
    requestedBy: string;
    /** Whether the range is known to contain irreversible effects. */
    containsIrreversibleEffects?: boolean;
  }): ReplayResult;

  /** Charter contract: Dead-Letter Resolve. Provenance preserved. */
  deadLetters(subscriptionId?: string): readonly DeliveryAttempt[];
  resolveDeadLetter(input: {
    messageId: string;
    subscriptionId: string;
    disposition: "discard" | "redeliver";
    authorizedBy: string;
    reason: string;
  }): { resolved: boolean; reason: string };

  /** The consumer's checkpoint. */
  offsetOf(subscriptionId: string): number;
  /** Backpressure: how far behind a subscription is. */
  lag(subscriptionId: string): number;

  subscriptions(): readonly Subscription[];
  count(): number;
}

export interface EventIqOptions {
  authority: EventAuthority;
  containment?: StreamContainment;
  now?: () => Date;
  /**
   * How far behind a subscription may fall before it is reported degraded.
   *
   * Backpressure is observed and announced rather than applied by dropping.
   * Dropping events to relieve pressure loses the ones a struggling consumer
   * most needed.
   */
  degradedLagThreshold?: number;
  /** The engine's own events (charter: Events Published). */
  onEngineEvent?: (event: EventIqEvent, detail: Readonly<Record<string, string | number | boolean>>) => void;
}

export function createEventIq(options: EventIqOptions): EventIq {
  const now = options.now ?? (() => new Date());
  const degradedLag = options.degradedLagThreshold ?? 100;

  const log: AcceptedEvent[] = [];
  const subs = new Map<string, Subscription>();
  /** Offset per consumer GROUP, not per consumer. Members share a checkpoint. */
  const offsets = new Map<string, number>();
  const attempts = new Map<string, DeliveryAttempt>();

  const attemptKey = (messageId: string, subscriptionId: string) => `${messageId}::${subscriptionId}`;
  const isolated = () => ({
    subscriptions: new Set(options.containment?.isolatedSubscriptions() ?? []),
    types: new Set(options.containment?.isolatedMessageTypes() ?? []),
  });

  const matches = (subscription: Subscription, message: HiveMessage): boolean => {
    // Tenant boundary first, always. Charter invariant: tenant routing
    // boundaries remain intact.
    if (subscription.systemScoped) {
      // A system-scoped consumer receives system-scoped events only. Being
      // system-scoped is not a wildcard over tenants — that would be the
      // boundary crossing this invariant exists to prevent.
      if (!message.systemScoped) return false;
    } else if (!deliverableTo(message, subscription.tenant!)) {
      return false;
    }

    return (
      subscription.messageTypes.includes("*") ||
      subscription.messageTypes.includes(message.messageType)
    );
  };

  return {
    publish(input) {
      const parsed = hiveMessageSchema.safeParse(input);
      if (!parsed.success) {
        return {
          accepted: false,
          reason: `Not a valid Hive message: ${JSON.stringify(parsed.error.flatten())}`,
          failedClosed: false,
        };
      }

      const message = parsed.data;
      const tenant = message.tenant?.organizationId ?? null;

      const decision = options.authority.mayPublish({
        producerId: message.producerId,
        tenant,
        messageType: message.messageType,
      });
      if (!decision.permitted) {
        // Fails closed. Charter: where authority cannot be established, the
        // action fails closed or escalates.
        return {
          accepted: false,
          reason: `Governance refused publication: ${decision.reason}`,
          failedClosed: true,
        };
      }

      if (isolated().types.has(message.messageType)) {
        return {
          accepted: false,
          reason: `Sentinel has isolated the ${message.messageType} stream.`,
          failedClosed: true,
        };
      }

      // Deduplication by message id. Charter capability: deduplication /
      // idempotency references. A re-published id is not an error — it is the
      // producer retrying — so the original is returned rather than a refusal.
      const existing = log.find((e) => e.message.messageId === message.messageId);
      if (existing) return { accepted: true, event: existing };

      const event: AcceptedEvent = {
        message,
        sequence: log.length,
        acceptedAt: now().toISOString(),
      };
      log.push(event);

      options.onEngineEvent?.("EventAccepted", {
        messageId: message.messageId,
        messageType: message.messageType,
        sequence: event.sequence,
        governanceDecisionId: decision.decisionId,
      });

      return { accepted: true, event };
    },

    subscribe(input) {
      const parsed = subscriptionSchema.safeParse(input);
      if (!parsed.success) {
        return {
          subscribed: false,
          reason: `Not a valid subscription: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }

      const subscription = parsed.data;
      if (subs.has(subscription.subscriptionId)) {
        return { subscribed: false, reason: `Subscription ${subscription.subscriptionId} exists.` };
      }

      subs.set(subscription.subscriptionId, subscription);
      // A new consumer group starts at the head, not at zero. Replaying the
      // entire history into a new subscriber is a replay, and a replay is
      // authorized separately.
      if (!offsets.has(subscription.consumerGroup)) {
        offsets.set(subscription.consumerGroup, log.length);
      }
      return { subscribed: true, subscription };
    },

    poll(subscriptionId, limit = 50) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return [];
      if (isolated().subscriptions.has(subscriptionId)) return [];

      const from = offsets.get(subscription.consumerGroup) ?? 0;
      const out: PolledEvent[] = [];
      const at = now();

      for (const event of log.slice(from)) {
        if (out.length >= limit) break;
        if (!matches(subscription, event.message)) continue;

        const key = attemptKey(event.message.messageId, subscriptionId);
        const prior = attempts.get(key);

        if (prior?.state === "dead_lettered" || prior?.state === "acknowledged") continue;

        // Expiry, per Communication Core's own function.
        if (hasExpired(subscription.expectation, at)) {
          attempts.set(key, {
            messageId: event.message.messageId,
            subscriptionId,
            state: "expired",
            attempts: prior?.attempts ?? 0,
            firstAttemptedAt: prior?.firstAttemptedAt ?? at.toISOString(),
            lastAttemptedAt: at.toISOString(),
            lastReason: "Delivery expectation expired before delivery.",
            deadLetteredAt: null,
          });
          continue;
        }

        const attempt = (prior?.attempts ?? 0) + 1;
        attempts.set(key, {
          messageId: event.message.messageId,
          subscriptionId,
          state: "delivered",
          attempts: attempt,
          firstAttemptedAt: prior?.firstAttemptedAt ?? at.toISOString(),
          lastAttemptedAt: at.toISOString(),
          lastReason: "Delivered for handling.",
          deadLetteredAt: null,
        });

        out.push({
          message: event.message,
          sequence: event.sequence,
          attempt,
          isReplay: false,
        });
      }

      const behind = log.length - from;
      if (behind > degradedLag) {
        options.onEngineEvent?.("SubscriptionDegraded", { subscriptionId, lag: behind });
      }

      return out;
    },

    acknowledge(input) {
      // EventIQ's acknowledgement carries a subscription id; Communication
      // Core's does not, and that is a real distinction rather than an
      // oversight. Communication's acknowledgement is about a MESSAGE — one
      // recipient's answer to one delivery. EventIQ delivers the same message
      // to many subscriptions, so its record has to say which one answered.
      //
      // A first version cast the two together and TypeScript refused, correctly.
      // The Communication-shaped acknowledgement is now derived for the parts
      // Communication owns (retry semantics), and the subscription id stays on
      // EventIQ's side where it belongs.
      const parsed = eventDeliveryAckSchema.safeParse(input);

      if (!parsed.success) {
        return { recorded: false, reason: `Not a valid acknowledgement: ${JSON.stringify(parsed.error.flatten())}` };
      }

      const ack = parsed.data;
      const subscription = subs.get(ack.subscriptionId);
      if (!subscription) return { recorded: false, reason: `No subscription ${ack.subscriptionId}.` };

      const key = attemptKey(ack.messageId, ack.subscriptionId);
      const prior = attempts.get(key);
      if (!prior) return { recorded: false, reason: `Nothing was delivered for ${ack.messageId}.` };

      const at = now().toISOString();

      if (ack.outcome === "accepted" || ack.outcome === "duplicate") {
        attempts.set(key, { ...prior, state: "acknowledged", lastAttemptedAt: at, lastReason: ack.reason ?? "Accepted." });
        // The checkpoint advances past this message and no further. Advancing
        // to the head would skip anything the consumer has not yet seen.
        const event = log.find((e) => e.message.messageId === ack.messageId);
        if (event) {
          const current = offsets.get(subscription.consumerGroup) ?? 0;
          offsets.set(subscription.consumerGroup, Math.max(current, event.sequence + 1));
        }
        return { recorded: true, reason: "Acknowledged; checkpoint advanced." };
      }

      const expectation: DeliveryExpectation = subscription.expectation;
      // The retry decision is Communication Core's, asked in its own vocabulary.
      // EventIQ decides WHEN to ask, not what the answer is.
      const communicationAck: Acknowledgement = {
        messageId: ack.messageId,
        by: ack.by,
        at: ack.at,
        outcome: ack.outcome,
        ...(ack.reason === undefined ? {} : { reason: ack.reason }),
      };
      const retryable = shouldRetry(communicationAck, expectation, prior.attempts);

      if (retryable) {
        attempts.set(key, {
          ...prior,
          state: "retrying",
          lastAttemptedAt: at,
          lastReason: ack.reason ?? "Deferred.",
        });
        options.onEngineEvent?.("EventDeliveryFailed", {
          messageId: ack.messageId,
          subscriptionId: ack.subscriptionId,
          attempts: prior.attempts,
        });
        return { recorded: true, reason: "Will be redelivered." };
      }

      attempts.set(key, {
        ...prior,
        state: "dead_lettered",
        lastAttemptedAt: at,
        lastReason: ack.reason ?? "Rejected.",
        deadLetteredAt: at,
      });
      options.onEngineEvent?.("EventDeadLettered", {
        messageId: ack.messageId,
        subscriptionId: ack.subscriptionId,
        attempts: prior.attempts,
        consequenceIfLost: expectation.consequenceIfLost,
      });
      return { recorded: true, reason: "Dead-lettered; provenance preserved." };
    },

    replay(input) {
      const subscription = subs.get(input.subscriptionId);
      if (!subscription) return { started: false, reason: `No subscription ${input.subscriptionId}.` };

      // ── THE INVARIANT ──────────────────────────────────────────────────
      //
      // "Replay shall not knowingly duplicate irreversible consequential
      // effects." A replay into a consumer that acts again on what it already
      // handled turns a recovery into a second incident.
      if (!subscription.idempotent) {
        return {
          started: false,
          reason:
            `Subscription ${input.subscriptionId} has not declared itself idempotent. Replaying into a consumer that ` +
            "acts again on what it already handled turns a recovery into a second incident.",
        };
      }

      if (input.containsIrreversibleEffects === true) {
        return {
          started: false,
          reason:
            "The requested range is declared to contain irreversible consequential effects. Idempotency suppresses a repeated " +
            "effect; it does not undo one that cannot be undone. This needs a compensating operation, not a replay.",
        };
      }

      const decision = options.authority.mayReplay({
        requestedBy: input.requestedBy,
        tenant: subscription.tenant,
        fromSequence: input.fromSequence,
        toSequence: input.toSequence,
      });
      if (!decision.permitted) {
        return { started: false, reason: `Governance refused replay: ${decision.reason}` };
      }

      options.onEngineEvent?.("EventReplayStarted", {
        subscriptionId: input.subscriptionId,
        fromSequence: input.fromSequence,
        toSequence: input.toSequence,
        governanceDecisionId: decision.decisionId,
      });

      const events = log
        .slice(input.fromSequence, input.toSequence + 1)
        .filter((e) => matches(subscription, e.message))
        .map((e) => ({ message: e.message, sequence: e.sequence, attempt: 0, isReplay: true }));

      options.onEngineEvent?.("EventReplayCompleted", {
        subscriptionId: input.subscriptionId,
        delivered: events.length,
      });

      return { started: true, events, decisionId: decision.decisionId };
    },

    deadLetters(subscriptionId) {
      return [...attempts.values()].filter(
        (a) => a.state === "dead_lettered" && (subscriptionId === undefined || a.subscriptionId === subscriptionId),
      );
    },

    resolveDeadLetter(input) {
      const key = attemptKey(input.messageId, input.subscriptionId);
      const attempt = attempts.get(key);
      if (!attempt || attempt.state !== "dead_lettered") {
        return { resolved: false, reason: `${input.messageId} is not dead-lettered on ${input.subscriptionId}.` };
      }

      // Provenance preserved either way: the attempt keeps its history and its
      // `deadLetteredAt`, and the disposition is appended to the reason rather
      // than replacing it. Charter: "authorized disposition of failed events
      // with preserved provenance."
      attempts.set(key, {
        ...attempt,
        state: input.disposition === "redeliver" ? "retrying" : "dead_lettered",
        lastReason: `${attempt.lastReason} | ${input.disposition} by ${input.authorizedBy}: ${input.reason}`,
      });
      return { resolved: true, reason: `${input.disposition} recorded.` };
    },

    offsetOf(subscriptionId) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return 0;
      return offsets.get(subscription.consumerGroup) ?? 0;
    },

    lag(subscriptionId) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return 0;
      return log.length - (offsets.get(subscription.consumerGroup) ?? 0);
    },

    subscriptions: () => [...subs.values()],
    count: () => log.length,
  };
}

/**
 * Charter invariant: "Event delivery does not create authority."
 *
 * Always false. A consumer that received an event has learned that something
 * happened; it has not acquired the right to act on it. The same shape as
 * `receiptImpliesAuthorization()` in Communication Core, one layer down — and
 * the charter's doctrine says it in one line: "Events tell the Hive what
 * happened. They do not decide what should be authorized next."
 */
export function deliveryGrantsAuthority(_event: PolledEvent): false {
  return false;
}

/**
 * Charter invariant: "Prime is not required to relay all events."
 *
 * Always false, and the reason nothing in this file references Prime.
 * Constitution §2.3.
 */
export function primeRelayRequired(): false {
  return false;
}
