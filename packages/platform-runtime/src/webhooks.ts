// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  TenantContext,
  WebhookDelivery,
  WebhookDispatcher,
  WebhookEndpoint,
  WebhookSignature,
} from "@proworks-hub/contracts";
import { eventTypeMatches, webhookEndpointSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Outbound webhooks.
//
// The event bus is internal — engines talking to consumers we own. This is the
// outside edge: somebody else's system, on somebody else's network, which will
// be down when we need it and will occasionally receive the same delivery
// twice.
//
// Three things that make an integration partner's life bearable, and ours:
//
//   SIGNED, with the timestamp inside the signature. A receiver that cannot
//   verify us cannot tell our POST from anyone else's, and a signature that
//   excludes the timestamp can be replayed an hour later.
//
//   LOGGED. "Did you send it?" must have an answer. "Probably" is not one.
//
//   REPLAYABLE. When their side was broken, the fix is to send it again — not
//   to ask us to regenerate a fact from last Tuesday.
//
// An endpoint that fails persistently is DISABLED rather than retried forever.
// A dead URL retried every minute is a slow denial of service against
// ourselves, and it hides the endpoints that are merely struggling.
// ─────────────────────────────────────────────────────────────────────────────

export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export interface WebhookDispatcherOptions {
  /**
   * How a request is actually made. Injected because an engine that imports an
   * HTTP client has taken a dependency it cannot be lifted away from — and
   * because a test needs to fail on demand.
   */
  transport: WebhookTransport;
  /** Consecutive failures before an endpoint is switched off. */
  disableAfterFailures?: number;
  /** Where endpoints and delivery history live. Defaults to in-memory. */
  store?: WebhookStore;
  now?: () => Date;
  generateId?: () => string;
}

/**
 * Narrower than the WebhookDispatcher port: registration and lookup are
 * synchronous here, so a caller need not await a Map.
 *
 * This narrowing is not cosmetic. A port that returns `T | Promise<T>` reads
 * fine and typechecks wrong at every call site that forgets, and tests do not
 * catch it because they run with types stripped. Every concrete implementation
 * in this suite narrows its port for that reason.
 */
export interface InMemoryWebhookDispatcher extends WebhookDispatcher {
  register(
    endpoint: Omit<WebhookEndpoint, "endpointId" | "createdAt" | "consecutiveFailures">,
  ): WebhookEndpoint;
  endpointsFor(tenantId: string, eventType: string): WebhookEndpoint[];
  dispatch(
    endpoint: WebhookEndpoint,
    event: { eventId: string; eventType: string; payload: unknown },
  ): Promise<WebhookDelivery>;
  deliveries(filter?: {
    endpointId?: string;
    status?: WebhookDelivery["status"];
    limit?: number;
  }): WebhookDelivery[];
  replay(deliveryId: string): Promise<WebhookDelivery | null>;
  endpoints(): WebhookEndpoint[];
}

const randomId = (prefix: string): string => {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return typeof g.crypto?.randomUUID === "function"
    ? `${prefix}_${g.crypto.randomUUID()}`
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Signs a payload with the endpoint's secret.
 *
 * A keyed FNV construction, chosen so this package stays dependency-free and
 * runs anywhere. It is NOT HMAC-SHA256, and a production dispatcher should
 * bind one — the point of this implementation is that the signing SEAM exists
 * and every delivery goes through it, so upgrading the algorithm is one
 * function rather than a protocol change with every partner.
 */
export function signWebhook(secret: string, timestamp: string, body: string): WebhookSignature {
  // The timestamp is inside the signed material, so a captured payload cannot
  // be replayed later against a receiver that checks freshness.
  const material = `${timestamp}.${body}`;
  let hash = 0x811c9dc5;
  for (const char of `${secret}:${material}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const signature = hash.toString(16).padStart(8, "0");
  return {
    timestamp,
    signature,
    header: `t=${timestamp},v1=${signature}`,
  };
}

/** What a receiver runs. Exported so a partner can be handed working code. */
export function verifyWebhook(
  secret: string,
  header: string,
  body: string,
  options: { toleranceMs?: number; now?: () => number } = {},
): { valid: boolean; reason?: string } {
  const now = options.now ?? (() => Date.now());
  const tolerance = options.toleranceMs ?? 5 * 60_000;

  const timestamp = /t=([^,]+)/.exec(header)?.[1];
  const provided = /v1=([^,]+)/.exec(header)?.[1];
  if (!timestamp || !provided) return { valid: false, reason: "malformed signature header" };

  const age = now() - new Date(timestamp).getTime();
  // Checked BEFORE the signature: a valid signature on an ancient payload is
  // exactly what a replay looks like.
  if (Number.isNaN(age)) return { valid: false, reason: "unparseable timestamp" };
  if (Math.abs(age) > tolerance) return { valid: false, reason: "timestamp outside tolerance" };

  const expected = signWebhook(secret, timestamp, body).signature;
  return expected === provided ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

/**
 * Where endpoints and delivery history live.
 *
 * Both belong in a host's database rather than a process. The registry is
 * CONFIGURATION — which partners we send to, and their secrets — and a
 * dispatcher that forgot it on restart would simply stop delivering to
 * everybody. The log is the answer to "did you send it?", and this file's own
 * opening argument is that "probably" is not one; a log that dies with the
 * process makes "probably" the only available answer after any restart.
 */
export interface WebhookStore {
  readonly durability: "in-memory" | "durable";
  endpoints(): readonly WebhookEndpoint[];
  endpoint(endpointId: string): WebhookEndpoint | null;
  putEndpoint(endpoint: WebhookEndpoint): void;
  deliveries(): readonly WebhookDelivery[];
  recordDelivery(delivery: WebhookDelivery): void;
}

export function createInMemoryWebhookStore(): WebhookStore {
  const registry = new Map<string, WebhookEndpoint>();
  const log: WebhookDelivery[] = [];
  return {
    durability: "in-memory",
    endpoints: () => [...registry.values()],
    endpoint: (id) => registry.get(id) ?? null,
    putEndpoint: (e) => {
      registry.set(e.endpointId, e);
    },
    deliveries: () => log,
    recordDelivery: (d) => {
      log.push(d);
    },
  };
}

export function createWebhookDispatcher(
  options: WebhookDispatcherOptions,
): InMemoryWebhookDispatcher {
  const store = options.store ?? createInMemoryWebhookStore();
  const now = options.now ?? (() => new Date());
  const generateId = options.generateId ?? randomId;
  const disableAfter = options.disableAfterFailures ?? 10;
  const registry = new Map<string, WebhookEndpoint>();
  const log: WebhookDelivery[] = [];

  const send = async (
    endpoint: WebhookEndpoint,
    event: { eventId: string; eventType: string; payload: unknown },
    attempt: number,
  ): Promise<WebhookDelivery> => {
    const timestamp = now().toISOString();
    const body = JSON.stringify({
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      deliveredAt: timestamp,
    });
    const signature = signWebhook(endpoint.secret, timestamp, body);

    const delivery: WebhookDelivery = {
      deliveryId: generateId("whd"),
      endpointId: endpoint.endpointId,
      eventId: event.eventId,
      eventType: event.eventType,
      attempt,
      status: "pending",
      payload: event.payload,
      signature: signature.header,
      createdAt: timestamp,
    };

    try {
      const response = await options.transport(endpoint.url, body, {
        "content-type": "application/json",
        "x-proworks-signature": signature.header,
        "x-proworks-event-id": event.eventId,
        "x-proworks-event-type": event.eventType,
      });

      const ok = response.status >= 200 && response.status < 300;
      const settled: WebhookDelivery = {
        ...delivery,
        status: ok ? "delivered" : "failed",
        responseStatus: response.status,
        attemptedAt: now().toISOString(),
        ...(ok ? {} : { error: `endpoint returned ${response.status}` }),
      };
      store.recordDelivery(settled);

      const failures = ok ? 0 : endpoint.consecutiveFailures + 1;
      store.putEndpoint({
        ...endpoint,
        consecutiveFailures: failures,
        ...(failures >= disableAfter
          ? {
              active: false,
              disabledAt: now().toISOString(),
              disabledReason: `${failures} consecutive failures`,
            }
          : {}),
      });

      return settled;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const settled: WebhookDelivery = {
        ...delivery,
        status: "failed",
        error: error.message,
        attemptedAt: now().toISOString(),
      };
      store.recordDelivery(settled);

      const failures = endpoint.consecutiveFailures + 1;
      store.putEndpoint({
        ...endpoint,
        consecutiveFailures: failures,
        ...(failures >= disableAfter
          ? {
              active: false,
              disabledAt: now().toISOString(),
              disabledReason: `${failures} consecutive failures`,
            }
          : {}),
      });
      return settled;
    }
  };

  return {
    register(input) {
      const endpoint = webhookEndpointSchema.parse({
        ...input,
        endpointId: generateId("whe"),
        consecutiveFailures: 0,
        createdAt: now().toISOString(),
      });
      store.putEndpoint(endpoint);
      return endpoint;
    },

    endpointsFor: (tenantId, eventType) =>
      [...store.endpoints()].filter(
        (e) =>
          e.active &&
          e.tenant.organizationId === tenantId &&
          e.eventTypes.some((pattern) => eventTypeMatches(pattern, eventType)),
      ),

    dispatch: (endpoint, event) => send(endpoint, event, 1),

    deliveries(filter) {
      let all = [...store.deliveries()];
      if (filter?.endpointId) all = all.filter((d) => d.endpointId === filter.endpointId);
      if (filter?.status) all = all.filter((d) => d.status === filter.status);
      return filter?.limit ? all.slice(-filter.limit) : all;
    },

    async replay(deliveryId) {
      const original = store.deliveries().find((d) => d.deliveryId === deliveryId);
      if (!original) return null;
      const endpoint = store.endpoint(original.endpointId);
      if (!endpoint) return null;
      // Replays the ORIGINAL payload, not a regenerated one. The fact being
      // reported happened when it happened; re-deriving it could produce
      // something different and quietly rewrite history for the partner.
      return send(
        endpoint,
        { eventId: original.eventId, eventType: original.eventType, payload: original.payload },
        original.attempt + 1,
      );
    },

    endpoints: () => [...store.endpoints()],
  };
}

/** Convenience for a host wiring the bus to its partners' endpoints. */
export interface WebhookFanoutOptions {
  dispatcher: WebhookDispatcher;
  tenantOf: (event: { tenant?: TenantContext }) => string | undefined;
}
