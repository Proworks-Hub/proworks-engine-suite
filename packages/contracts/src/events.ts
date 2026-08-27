// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// The platform event envelope.
//
// Without this, the engines end up calling each other. ForgeIQ would import
// CostIQ to price a plan; ReceiptIQ would import CostIQ to update a price;
// CostIQ would import ReceiptIQ to read one. Every arrow added is a package
// that can no longer be lifted out on its own, and the portability is the
// asset.
//
// An event says something ALREADY HAPPENED. The publisher does not know or care
// who listens — that ignorance is the whole architectural property. ReceiptIQ
// publishes `material.purchase.detected` and never learns that CostIQ, an
// inventory module and an analytics projection all acted on it.
//
// This generalises the EventLog Prime already runs — append, subscribe, replay,
// upgrade-on-read migrations, projections — rather than inventing a second
// mechanism. Prime's log is work-order-scoped by design and stays that way;
// this is the cross-engine tier above it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event names are lowercase, dotted, and end in a past-tense verb:
 * `receipt.ingested`, `manufacturing.plan.generated`.
 *
 * Two segments or more. Both shapes are legitimate — `entity.action` when the
 * entity is unambiguous, `domain.entity.action` when it is not — and requiring
 * three would rename `receipt.ingested` into something longer for no gain.
 *
 * Past tense is not a style preference. `plan.generate` reads like an
 * instruction and invites a publisher to expect something to happen; a
 * publisher that expects an outcome has coupled itself to its consumers, which
 * is the thing the bus exists to prevent. Commands are a separate shape.
 */
export const eventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
    "event type must be lowercase and dotted, e.g. receipt.ingested or manufacturing.plan.generated",
  );

export const eventSourceSchema = z
  .object({
    /** Which engine or service published this, e.g. "forgeiq". */
    service: z.string().min(1),
    /** Which copy, when several run. Useful when one instance misbehaves. */
    instance: z.string().min(1).optional(),
  })
  .strict();

export const PLATFORM_EVENT_VERSION = 1;

export const platformEventSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: eventTypeSchema,
    /**
     * The payload's version, not the envelope's. Events are public contracts:
     * add fields freely, and cut a new version rather than changing the meaning
     * of one that exists. Consumers handle the versions they know and ignore
     * the rest.
     */
    eventVersion: z.number().int().positive().default(1),

    /** When the fact became true. */
    occurredAt: z.string().min(1),
    /** When it reached the bus. Differs from occurredAt after a retry or replay. */
    publishedAt: z.string().min(1),

    source: eventSourceSchema,

    /**
     * Who this happened for.
     *
     * Optional, and the absence is meaningful rather than lazy: an event about
     * CANONICAL knowledge — a merchant recognized, a price observed — belongs
     * to nobody, and attaching a tenant to it would recreate the leak the
     * ownership model exists to prevent. Everything else must carry one.
     *
     * `assertTenantScoped` below is how a consumer states which it expects.
     */
    tenant: tenantContextSchema.optional(),

    /** Required. An untraceable event is one nobody can debug later. */
    trace: traceContextSchema,

    /** What this event is about, when it is about a specific thing. */
    aggregate: z
      .object({ type: z.string().min(1), id: z.string().min(1) })
      .strict()
      .optional(),

    payload: z.unknown(),

    /** Transport concerns only — never domain data a consumer should read. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type EventSource = z.infer<typeof eventSourceSchema>;

/** The envelope, typed by payload. */
export interface PlatformEvent<TPayload = unknown>
  extends Omit<z.infer<typeof platformEventSchema>, "payload"> {
  payload: TPayload;
}

// ── Publishing ───────────────────────────────────────────────────────────────

/** What a publisher supplies. The bus assigns identity and timing. */
export interface PublishEventInput<TPayload = unknown> {
  eventType: string;
  eventVersion?: number;
  source: EventSource;
  tenant?: z.infer<typeof tenantContextSchema>;
  trace: z.infer<typeof traceContextSchema>;
  aggregate?: { type: string; id: string };
  payload: TPayload;
  metadata?: Record<string, unknown>;
  /** When the fact became true, if that is not now — a backfill, an import. */
  occurredAt?: string;
}

export type EventHandler<TPayload = unknown> = (
  event: PlatformEvent<TPayload>,
) => Promise<void> | void;

/** Stops a subscription. */
export type Unsubscribe = () => void;

export interface SubscribeOptions {
  /**
   * Names the consumer. Required, because delivery is at-least-once and the
   * only way to know whether THIS consumer already handled an event is to know
   * which consumer is asking.
   */
  consumer: string;
}

/**
 * The port. A host binds an in-memory implementation in development and a real
 * broker in production; no engine knows which.
 *
 * Consumers must be idempotent. Any transport worth using will redeliver at
 * some point, and a consumer that creates a job or adds inventory on each
 * delivery will eventually do it twice.
 */
export interface EventBus {
  publish<TPayload>(input: PublishEventInput<TPayload>): Promise<PlatformEvent<TPayload>>;

  /**
   * Subscribes to one or more event types. `*` matches everything, and
   * `domain.*` matches a domain — useful for audit and projections, which want
   * the stream rather than a list they must keep updating.
   */
  subscribe<TPayload = unknown>(
    eventTypes: string | readonly string[],
    handler: EventHandler<TPayload>,
    options: SubscribeOptions,
  ): Unsubscribe;
}

/**
 * Remembers what a consumer has already handled, so redelivery is harmless.
 *
 * A port rather than a table: Family Table would back this with IndexedDB and
 * ProWorks with Postgres, and neither belongs inside an engine.
 */
export interface ProcessedEventLedger {
  hasProcessed(consumer: string, eventId: string): Promise<boolean> | boolean;
  markProcessed(consumer: string, eventId: string): Promise<void> | void;
}

// ── Guards ───────────────────────────────────────────────────────────────────

/**
 * Asserts an event carries the tenant a private consumer needs.
 *
 * Consumers that write into tenant-scoped storage should call this rather than
 * reading `event.tenant?.organizationId` and carrying on — an event with no
 * tenant is either canonical knowledge that should not be written there, or a
 * publisher bug. Both are worth stopping for.
 */
export function assertTenantScoped(
  event: PlatformEvent,
): asserts event is PlatformEvent & { tenant: z.infer<typeof tenantContextSchema> } {
  if (!event.tenant) {
    throw new Error(
      `Event ${event.eventType} (${event.eventId}) carries no tenant. Either it describes ` +
        `canonical knowledge, which must not be written into tenant-scoped storage, or the ` +
        `publisher omitted one.`,
    );
  }
}

/** True when the subscription pattern matches the event type. */
export function eventTypeMatches(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern === eventType) return true;
  if (pattern.endsWith(".*")) return eventType.startsWith(pattern.slice(0, -1));
  return false;
}

// ── Publishing from inside an engine ─────────────────────────────────────────

export interface EnginePublisherOptions {
  /** Absent means the engine publishes nothing. That is a supported setup. */
  bus?: EventBus;
  source: EventSource;
  /**
   * Called when publication fails. Publication is best-effort and MUST NOT
   * fail the operation that produced the fact — a plan that was generated was
   * still generated even if telling the world about it did not work.
   *
   * That is also the honest limitation of this design: the domain operation and
   * its event are not one transaction, so a crash between them loses the event.
   * Closing that gap is what the transactional outbox is for, and it belongs in
   * a host that has a database, not in a pure engine.
   */
  onPublishError?: (error: Error, eventType: string) => void;
}

/**
 * Returns a publish function an engine can call without becoming asynchronous
 * and without learning who listens.
 *
 * Deliberately fire-and-forget. `calculate()` is synchronous by design so a
 * caller gets a cost without awaiting, and making it async so an event could be
 * awaited would be the tail wagging the dog.
 */
export function createEnginePublisher(
  options: EnginePublisherOptions,
): <TPayload>(input: Omit<PublishEventInput<TPayload>, "source">) => void {
  return <TPayload>(input: Omit<PublishEventInput<TPayload>, "source">) => {
    if (!options.bus) return;
    try {
      const result = options.bus.publish({ ...input, source: options.source } as PublishEventInput<TPayload>);
      // A rejected promise nobody handles crashes some runtimes outright, so
      // the rejection is routed rather than left floating.
      void Promise.resolve(result).catch((cause: unknown) => {
        options.onPublishError?.(
          cause instanceof Error ? cause : new Error(String(cause)),
          input.eventType,
        );
      });
    } catch (cause) {
      options.onPublishError?.(
        cause instanceof Error ? cause : new Error(String(cause)),
        input.eventType,
      );
    }
  };
}
