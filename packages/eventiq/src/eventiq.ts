// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  HIVE_MESSAGE_SCHEMA_VERSION,
  deliverableTo,
  deliveryExpectationSchema,
  hasExpired,
  hiveMessageSchema,
  shouldRetry,
  type Acknowledgement,
  type DeliveryExpectation,
  type HiveMessage,
  type InstanceIdentity,
} from "@proworks-hub/contracts";

import {
  createInMemoryEventIqStore,
  type DeliveryAttempt,
  type EventIqStore,
  type ReplaySession,
  type StoredEvent,
} from "./store.js";

export type { DeliveryAttempt, DeliveryState, EventIqStore, InboxRecord, ReplaySession, StoredEvent } from "./store.js";

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
// WHAT IS ACTUALLY GUARANTEED, AND WHAT IS NOT
//
//   DELIVERY      At-least-once, per Communication Core's vocabulary, which
//                 deliberately has no `exactly-once` member. A message may
//                 arrive twice and consumers must be idempotent.
//
//                 What the Hive provides instead is EFFECTIVELY EXACTLY-ONCE
//                 BUSINESS SEMANTICS, and only for messages that ask for it: a
//                 message carrying an `idempotencyKey` is suppressed once its
//                 consumer group has accepted that operation. A message
//                 without one gets at-least-once and nothing more, which is
//                 correct for telemetry and wrong for anything consequential.
//
//   ORDERING      FIFO WITHIN one `orderingKey`, and only for a subscription
//                 whose `expectation.ordering` is not `none`. Nothing else.
//                 No global order, no per-tenant order, no cross-instance
//                 order — the last of those being a promise nothing could keep
//                 without a clock two instances share.
//
//   DURABILITY    Whatever the bound store provides, and `durability()` says
//                 which. The in-memory adapter is honest about being
//                 in-memory; every guarantee about offsets, dead letters and
//                 replay history is a guarantee about state, and only as good
//                 as where the state lives.
//
//   INSTANCE      An event is stamped with the instance that ACCEPTED it, from
//                 configuration. A message claiming a different origin is
//                 refused. There is no cross-instance delivery.
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

/**
 * An event this instance accepted.
 *
 * `globalInstanceId` is bound here from EventIQ's own configuration and is
 * never read from the message. A producer that writes its own instance into a
 * payload has asserted an origin, not established one — the same mistake as a
 * request naming its own tenant, one layer out.
 */
export type AcceptedEvent = StoredEvent;

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
  /**
   * Which replay produced this delivery. Present only when `isReplay`.
   *
   * The original event is delivered UNCHANGED — same id, same timestamp, same
   * sequence. Replay provenance rides on the delivery, not on the event,
   * because rewriting an event to look newly created destroys the only record
   * of when the thing actually happened.
   */
  readonly replaySessionId?: string;
  /** The instance that accepted this event. Bound, not claimed. */
  readonly globalInstanceId: string;
}

export type ReplayResult =
  | {
      readonly started: true;
      readonly events: readonly PolledEvent[];
      readonly decisionId: string;
      readonly replaySessionId: string;
    }
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

  /** Every replay this instance has performed. Auditable after the fact. */
  replaySessions(): readonly ReplaySession[];

  /**
   * Whether state survives a restart.
   *
   * Exposed so a host can check its own wiring, and so a test can assert that
   * an in-memory binding is not being mistaken for a durable one. Every
   * guarantee EventIQ makes about offsets, dead letters and replay history is
   * a guarantee about state — and it is only true if the state is durable.
   */
  durability(): "in-memory" | "durable";

  /** Which Hive instance this is. For an operator asking what is bound. */
  instance(): InstanceIdentity;

  subscriptions(): readonly Subscription[];
  count(): number;
}

export interface EventIqOptions {
  /**
   * Which Hive instance this EventIQ IS. REQUIRED, never defaulted.
   *
   * The whole of instance isolation rests on this being configuration rather
   * than inference. An EventIQ that guessed its instance — from a tenant, from
   * a message, from an environment variable it fell back on — would make
   * "which instance produced this" a question answered by whatever was
   * convenient at the time.
   *
   * Separate from tenant, and deliberately not derivable from one: a tenant may
   * operate several instances, and an instance may serve several tenant
   * contexts under future deployment models.
   */
  instance: InstanceIdentity;
  authority: EventAuthority;
  /**
   * Where state lives. Defaults to the deterministic in-memory adapter.
   *
   * A default rather than a requirement because in-memory is the correct
   * binding for a test and for a single-process development host, and it says
   * `durability: "in-memory"` so nothing can mistake it for the durable one.
   */
  store?: EventIqStore;
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
  const store = options.store ?? createInMemoryEventIqStore();
  const instanceId = options.instance.globalInstanceId;
  let replaySeq = 0;

  const subs = new Map<string, Subscription>();

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
      // ── Schema version, before anything reads the body ─────────────────
      //
      // Checked first and reported distinctly. `hiveMessageSchema` refuses an
      // unknown version anyway, but it refuses it as one more field validation
      // error in a JSON blob — and "this producer is a version we do not
      // understand" needs a different response from "this message is
      // malformed". One is a deployment-skew problem between instances running
      // different approved engine versions; the other is a bug.
      //
      // UNKNOWN IS NOT COMPATIBLE. There is no upgrade-on-read here and no
      // best-effort reinterpretation: a version this build has never seen is
      // refused, because guessing at the meaning of an unrecognized envelope is
      // how two halves of a workflow come to disagree about what was sent.
      const claimedVersion = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (claimedVersion !== undefined && claimedVersion !== HIVE_MESSAGE_SCHEMA_VERSION) {
        return {
          accepted: false,
          reason:
            `Schema version ${String(claimedVersion)} is not supported by this instance, which speaks ` +
            `version ${HIVE_MESSAGE_SCHEMA_VERSION}. An unrecognized version is refused rather than ` +
            "reinterpreted: unknown does not mean compatible.",
          failedClosed: true,
        };
      }

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

      // ── The instance boundary ──────────────────────────────────────────
      //
      // A message may CLAIM an origin. If it claims a different instance, it is
      // refused — not accepted-and-tagged, not rewritten to this instance.
      //
      // Cross-instance delivery requires a governed relationship, cryptographic
      // identity, and a Sentinel-inspectable transport, none of which exist
      // yet. Until they do, the honest answer to a foreign message is no. A
      // temporary allow-all bridge here would be the insecure substitute the
      // architecture forbids, and it would be the hardest thing to remove
      // later, because by then something would depend on it.
      if (message.origin && message.origin.globalInstanceId !== instanceId) {
        return {
          accepted: false,
          reason:
            `Message ${message.messageId} claims to originate in instance ` +
            `${message.origin.globalInstanceId} and this is ${instanceId}. Cross-instance delivery ` +
            "requires a governed relationship through the Interconnect, which does not exist yet. " +
            "Refused rather than bridged.",
          failedClosed: true,
        };
      }

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
      //
      // An indexed lookup now rather than a scan of the log, which is what
      // publish and acknowledge both did. Linear in the length of the log is a
      // cost that only appears once a log is long enough to matter, which is
      // the point at which it is hardest to change.
      const existing = store.byMessageId(message.messageId);
      if (existing) return { accepted: true, event: existing };

      const event: StoredEvent = {
        message,
        sequence: store.count(),
        acceptedAt: now().toISOString(),
        // Bound from configuration. Never `message.origin.globalInstanceId`:
        // that is the claim, this is the fact.
        globalInstanceId: instanceId,
      };
      store.append(event);

      options.onEngineEvent?.("EventAccepted", {
        messageId: message.messageId,
        messageType: message.messageType,
        sequence: event.sequence,
        globalInstanceId: instanceId,
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
      if (store.offsetOf(subscription.consumerGroup) === null) {
        store.setOffset(subscription.consumerGroup, store.count());
      }
      return { subscribed: true, subscription };
    },

    poll(subscriptionId, limit = 50) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return [];
      if (isolated().subscriptions.has(subscriptionId)) return [];

      const from = store.offsetOf(subscription.consumerGroup) ?? 0;
      const out: PolledEvent[] = [];
      const at = now();

      /**
       * Ordering keys still in flight for this subscription.
       *
       * EventIQ promises FIFO WITHIN an ordering key and nothing more. A
       * message whose key already has an unacknowledged message ahead of it is
       * held back until that one is answered; messages with no key, or with a
       * different key, are unaffected.
       *
       * Global ordering is deliberately not promised. It would serialize every
       * unrelated workflow through one queue, and across instances it would be
       * a promise nothing could keep — one instance cannot order another's
       * events without a shared clock nobody has.
       */
      const blockedKeys = new Set<string>();

      for (const event of store.from(from)) {
        if (out.length >= limit) break;
        if (!matches(subscription, event.message)) continue;

        const prior = store.attemptOf(event.message.messageId, subscriptionId);

        if (prior?.state === "dead_lettered" || prior?.state === "acknowledged") continue;

        // ── The consumer inbox ───────────────────────────────────────────
        //
        // Keyed by the operation, not the message. Two messages can describe
        // one operation when a producer retried and minted a new id, and a
        // consumer deduplicating on message id would perform the effect twice
        // while believing it had not.
        //
        // Keyed by the ACCEPTING instance too, so that when messages
        // eventually arrive from elsewhere, two instances that independently
        // chose the same key do not look like one operation already done.
        const key = event.message.idempotencyKey;
        if (
          key !== undefined &&
          store.hasProcessed({
            globalInstanceId: event.globalInstanceId,
            idempotencyKey: key,
            consumerGroup: subscription.consumerGroup,
          })
        ) {
          continue;
        }

        // ── Ordering ─────────────────────────────────────────────────────
        //
        // Enforced only where the SUBSCRIPTION asked for it.
        // `expectation.ordering` already existed — `none | per-entity |
        // per-tenant | per-workflow` — and nothing read it. This is where it
        // becomes load-bearing: the scope says a consumer needs order, the
        // message's `orderingKey` says which stream it belongs to, and neither
        // alone is enough.
        //
        // A consumer that declared `none` is not slowed down by another
        // consumer's ordering requirement, which is the difference between a
        // guarantee somebody asked for and a global serialization nobody did.
        const ordering = event.message.orderingKey;
        if (ordering !== undefined && subscription.expectation.ordering !== "none") {
          if (blockedKeys.has(ordering)) continue;
          // Everything after this one in the same stream waits for it.
          blockedKeys.add(ordering);
        }

        // Expiry, per Communication Core's own function.
        if (hasExpired(subscription.expectation, at)) {
          store.putAttempt({
            messageId: event.message.messageId,
            subscriptionId,
            globalInstanceId: event.globalInstanceId,
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
        store.putAttempt({
          messageId: event.message.messageId,
          subscriptionId,
          globalInstanceId: event.globalInstanceId,
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
          globalInstanceId: event.globalInstanceId,
        });
      }

      const behind = store.count() - from;
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

      const prior = store.attemptOf(ack.messageId, ack.subscriptionId);
      if (!prior) return { recorded: false, reason: `Nothing was delivered for ${ack.messageId}.` };

      const at = now().toISOString();

      if (ack.outcome === "accepted" || ack.outcome === "duplicate") {
        store.putAttempt({ ...prior, state: "acknowledged", lastAttemptedAt: at, lastReason: ack.reason ?? "Accepted." });
        // The checkpoint advances past this message and no further. Advancing
        // to the head would skip anything the consumer has not yet seen.
        const event = store.byMessageId(ack.messageId);
        if (event) {
          const current = store.offsetOf(subscription.consumerGroup) ?? 0;
          store.setOffset(subscription.consumerGroup, Math.max(current, event.sequence + 1));

          // The inbox is written only on ACCEPTANCE, and only for a message
          // that named an operation. A consumer that rejected or deferred has
          // not performed the effect, and recording it as processed would
          // suppress the redelivery it is waiting for.
          //
          // `duplicate` counts as processed because that is what the consumer
          // is reporting: it recognised the operation and did not repeat it.
          if (event.message.idempotencyKey !== undefined) {
            store.markProcessed({
              globalInstanceId: event.globalInstanceId,
              idempotencyKey: event.message.idempotencyKey,
              consumerGroup: subscription.consumerGroup,
              messageId: event.message.messageId,
              processedAt: at,
            });
          }
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
        store.putAttempt({
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

      store.putAttempt({
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

      replaySeq += 1;
      const replaySessionId = `replay_${instanceId}_${replaySeq}`;
      const startedAt = now().toISOString();

      options.onEngineEvent?.("EventReplayStarted", {
        subscriptionId: input.subscriptionId,
        replaySessionId,
        fromSequence: input.fromSequence,
        toSequence: input.toSequence,
        governanceDecisionId: decision.decisionId,
      });

      // The original events, UNCHANGED. Same ids, same timestamps, same
      // sequences. Replay provenance travels on the delivery — `isReplay` and
      // the session id — and never on the event, because an event rewritten to
      // look newly created has destroyed the only record of when the thing
      // actually happened.
      const events: PolledEvent[] = store
        .range(input.fromSequence, input.toSequence)
        .filter((e) => matches(subscription, e.message))
        .map((e) => ({
          message: e.message,
          sequence: e.sequence,
          attempt: 0,
          isReplay: true,
          replaySessionId,
          globalInstanceId: e.globalInstanceId,
        }));

      // Recorded, not merely announced. An engine event is a signal somebody
      // may have been listening for; this is the record that exists afterwards,
      // when the question is who replayed what and under whose decision.
      store.recordReplay({
        replaySessionId,
        subscriptionId: input.subscriptionId,
        requestedBy: input.requestedBy,
        fromSequence: input.fromSequence,
        toSequence: input.toSequence,
        decisionId: decision.decisionId,
        startedAt,
        delivered: events.length,
      });

      options.onEngineEvent?.("EventReplayCompleted", {
        subscriptionId: input.subscriptionId,
        replaySessionId,
        delivered: events.length,
      });

      return { started: true, events, decisionId: decision.decisionId, replaySessionId };
    },

    deadLetters(subscriptionId) {
      return store.attempts().filter(
        (a) => a.state === "dead_lettered" && (subscriptionId === undefined || a.subscriptionId === subscriptionId),
      );
    },

    resolveDeadLetter(input) {
      const attempt = store.attemptOf(input.messageId, input.subscriptionId);
      if (!attempt || attempt.state !== "dead_lettered") {
        return { resolved: false, reason: `${input.messageId} is not dead-lettered on ${input.subscriptionId}.` };
      }

      // Provenance preserved either way: the attempt keeps its history and its
      // `deadLetteredAt`, and the disposition is appended to the reason rather
      // than replacing it. Charter: "authorized disposition of failed events
      // with preserved provenance."
      store.putAttempt({
        ...attempt,
        state: input.disposition === "redeliver" ? "retrying" : "dead_lettered",
        lastReason: `${attempt.lastReason} | ${input.disposition} by ${input.authorizedBy}: ${input.reason}`,
      });
      return { resolved: true, reason: `${input.disposition} recorded.` };
    },

    offsetOf(subscriptionId) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return 0;
      return store.offsetOf(subscription.consumerGroup) ?? 0;
    },

    lag(subscriptionId) {
      const subscription = subs.get(subscriptionId);
      if (!subscription) return 0;
      return store.count() - (store.offsetOf(subscription.consumerGroup) ?? 0);
    },

    replaySessions: () => store.replaySessions(),
    durability: () => store.durability,
    instance: () => options.instance,

    subscriptions: () => [...subs.values()],
    count: () => store.count(),
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
