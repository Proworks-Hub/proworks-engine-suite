// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared platform services.
//
// Each of these exists because the alternative is every engine growing its own
// version: five caches with five invalidation bugs, four notification systems
// that each know about email. Ports keep the concern in one place without
// putting an implementation inside an engine.
// ─────────────────────────────────────────────────────────────────────────────

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * A cache, with one rule stated in the type: **it is never the source of
 * truth.** Every read can miss, and a caller that cannot cope with a miss has
 * written a bug that will surface the first time the cache restarts.
 */
export interface Cache {
  get<T>(key: string): Promise<T | undefined> | T | undefined;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
  /**
   * Invalidates everything under a prefix — how an event-driven invalidation
   * clears a whole entity's derived entries without listing them.
   */
  deleteByPrefix(prefix: string): Promise<number> | number;
}

/**
 * Builds a cache key that cannot collide across tenants.
 *
 * A shared cache with un-scoped keys is a cross-tenant data leak that looks
 * like a performance optimisation, which is why this is a function rather
 * than a convention.
 */
export function cacheKey(
  tenant: { organizationId: string } | undefined,
  namespace: string,
  id: string,
): string {
  return tenant ? `t:${tenant.organizationId}:${namespace}:${id}` : `shared:${namespace}:${id}`;
}

// ── Feature flags ────────────────────────────────────────────────────────────

export const featureFlagSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
    description: z.string().optional(),
    /** Off unless something says otherwise. A flag that defaults on is not a flag. */
    enabledByDefault: z.boolean().default(false),
    /** Organizations this is on for, regardless of the default. */
    enabledFor: z.array(z.string()).default([]),
    /** Organizations this is explicitly off for. Wins over everything. */
    disabledFor: z.array(z.string()).default([]),
  })
  .strict();
export type FeatureFlag = z.infer<typeof featureFlagSchema>;

/**
 * Whether a capability is on for a given organization.
 *
 * Organization-scoped from the start, because the ecosystem's whole point is
 * several applications and several shops adopting capabilities at different
 * times. A global boolean would need replacing the first time that happened.
 */
export interface FeatureFlags {
  isEnabled(key: string, tenant?: { organizationId: string }): boolean | Promise<boolean>;
  list(): FeatureFlag[] | Promise<FeatureFlag[]>;
}

// ── Artifacts ────────────────────────────────────────────────────────────────

export const artifactSchema = z
  .object({
    artifactId: z.string().min(1),
    /** Who owns the bytes. Absent only for genuinely shared reference material. */
    tenant: tenantContextSchema.optional(),
    artifactType: z.enum([
      "cad", "svg", "dxf", "pdf", "image", "receipt-image",
      "toolpath", "nesting", "report", "export", "other",
    ]),
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    /** Content hash — how a duplicate upload is recognised as the same bytes. */
    checksum: z.string().min(1),
    /** Where the bytes actually are. Opaque; only the store interprets it. */
    storageLocation: z.string().min(1),
    /** Which engine made it, and from what. */
    sourceEngine: z.string().optional(),
    sourceEntityId: z.string().optional(),
    createdAt: z.string().min(1),
    createdBy: z.string().optional(),
  })
  .strict();
export type Artifact = z.infer<typeof artifactSchema>;

/**
 * Where generated files live.
 *
 * The rule the type is shaped around: **events carry a reference, never the
 * bytes.** A CAD file inside an event payload is a message no broker will
 * enjoy and a log nobody can read.
 */
export interface ArtifactStore {
  put(input: {
    tenant?: z.infer<typeof tenantContextSchema>;
    artifactType: Artifact["artifactType"];
    contentType: string;
    data: Uint8Array;
    sourceEngine?: string;
    sourceEntityId?: string;
    createdBy?: string;
  }): Promise<Artifact> | Artifact;

  get(artifactId: string): Promise<Artifact | null> | Artifact | null;
  read(artifactId: string): Promise<Uint8Array | null> | Uint8Array | null;
  delete(artifactId: string): Promise<void> | void;
  listBySource(sourceEngine: string, sourceEntityId: string): Promise<Artifact[]> | Artifact[];
}

// ── Notifications ────────────────────────────────────────────────────────────

export const notificationSchema = z
  .object({
    notificationId: z.string().min(1),
    tenant: tenantContextSchema,
    /** What happened, in the same past-tense style as events. */
    kind: z.string().min(1),
    severity: z.enum(["info", "warning", "urgent"]).default("info"),
    title: z.string().min(1),
    body: z.string().optional(),
    /** Where to go to act on it. */
    link: z.string().optional(),
    /** Who should see it. Empty means everyone in the organization. */
    recipients: z.array(z.string()).default([]),
    trace: traceContextSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type Notification = z.infer<typeof notificationSchema>;

/**
 * Announces that something happened. It does NOT decide how that reaches a
 * person.
 *
 * An engine saying "job.failed" must not know whether that becomes an email, a
 * push, or a row on a dashboard — those are per-host, per-organization, and
 * change without the engine changing.
 */
export interface Notifier {
  notify(notification: Omit<Notification, "notificationId" | "createdAt">): Promise<Notification> | Notification;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export const webhookEndpointSchema = z
  .object({
    endpointId: z.string().min(1),
    tenant: tenantContextSchema,
    url: z.string().url(),
    /** Which event types to send. Supports `domain.*` and `*`. */
    eventTypes: z.array(z.string()).min(1),
    /**
     * Used to sign every payload. A receiver that cannot verify the signature
     * cannot tell our delivery from anybody else's POST.
     */
    secret: z.string().min(16),
    active: z.boolean().default(true),
    /** Consecutive failures. An endpoint that is gone gets disabled, not retried forever. */
    consecutiveFailures: z.number().int().min(0).default(0),
    disabledAt: z.string().optional(),
    disabledReason: z.string().optional(),
    createdAt: z.string().min(1),
  })
  .strict();
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;

export const webhookDeliverySchema = z
  .object({
    deliveryId: z.string().min(1),
    endpointId: z.string().min(1),
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    attempt: z.number().int().min(1),
    status: z.enum(["pending", "delivered", "failed", "abandoned"]),
    responseStatus: z.number().int().optional(),
    error: z.string().optional(),
    /** Kept so a delivery can be replayed exactly as it was sent. */
    payload: z.unknown(),
    signature: z.string().optional(),
    attemptedAt: z.string().optional(),
    createdAt: z.string().min(1),
  })
  .strict();
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;

/**
 * Outbound delivery to whoever integrates with us.
 *
 * Every delivery is logged and replayable. An integration partner asking "did
 * you send it?" is a question that must have an answer, and "probably" is not
 * one.
 */
export interface WebhookDispatcher {
  register(endpoint: Omit<WebhookEndpoint, "endpointId" | "createdAt" | "consecutiveFailures">):
    | Promise<WebhookEndpoint>
    | WebhookEndpoint;
  endpointsFor(tenantId: string, eventType: string): Promise<WebhookEndpoint[]> | WebhookEndpoint[];
  dispatch(endpoint: WebhookEndpoint, event: { eventId: string; eventType: string; payload: unknown }):
    | Promise<WebhookDelivery>
    | WebhookDelivery;
  deliveries(filter?: { endpointId?: string; status?: WebhookDelivery["status"]; limit?: number }):
    | Promise<WebhookDelivery[]>
    | WebhookDelivery[];
  /** Sends a logged delivery again, unchanged. */
  replay(deliveryId: string): Promise<WebhookDelivery | null> | WebhookDelivery | null;
}

/**
 * The signature a receiver verifies.
 *
 * Timestamped and included in the signed material, so a captured payload
 * cannot be replayed against the receiver an hour later.
 */
export interface WebhookSignature {
  timestamp: string;
  signature: string;
  header: string;
}
