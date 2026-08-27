// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationError,
  CircuitOpenError,
  PermanentError,
  TransientError,
  cacheKey,
  fromTraceparent,
  propagationHeaders,
  rateLimitKey,
  requirePermission,
  toTraceparent,
  withSpan,
  type RequestContext,
} from "@proworks-hub/contracts";
import { createCircuitBreaker, createRateLimiter } from "../resilienceRuntime.js";
import {
  createInMemoryArtifactStore,
  createInMemoryCache,
  createInMemoryFeatureFlags,
  createInMemoryNotifier,
  createInMemoryTracer,
} from "../platformServices.js";
import { createWebhookDispatcher, signWebhook, verifyWebhook } from "../webhooks.js";

const tenant = { organizationId: "acme", roles: [] };
const trace = { correlationId: "cor_1" };

const requestContext = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  requestId: "req_1",
  tenant,
  identity: { subject: "user_1", kind: "user", roles: ["operator"], permissions: ["quote.read"] },
  trace,
  apiVersion: "v1",
  receivedAt: "2026-08-27T00:00:00.000Z",
  ...overrides,
});

describe("the circuit breaker", () => {
  it("opens after consecutive failures and then fails fast", async () => {
    let clock = 0;
    const cb = createCircuitBreaker({
      policy: { failureThreshold: 3, openDurationMs: 1000 },
      now: () => clock,
    });
    const failing = () => Promise.reject(new TransientError("dependency down"));

    for (let i = 0; i < 3; i += 1) {
      await expect(cb.run("costiq", failing)).rejects.toThrow(TransientError);
    }
    expect(cb.state("costiq")).toBe("open");

    // Not attempted at all now — that is the point. A slow failure has become
    // a fast one, so the capacity behind it is not consumed.
    const attempt = vi.fn(failing);
    await expect(cb.run("costiq", attempt)).rejects.toThrow(CircuitOpenError);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("does not count a permanent error against the dependency", async () => {
    const cb = createCircuitBreaker({ policy: { failureThreshold: 2 } });
    // Bad input from one caller must not deny service to everyone else.
    for (let i = 0; i < 5; i += 1) {
      await expect(
        cb.run("costiq", () => Promise.reject(new PermanentError("bad request"))),
      ).rejects.toThrow(PermanentError);
    }
    expect(cb.state("costiq")).toBe("closed");
  });

  it("probes after the open window and closes when the dependency returns", async () => {
    let clock = 0;
    const cb = createCircuitBreaker({
      policy: { failureThreshold: 1, openDurationMs: 1000, successThreshold: 2 },
      now: () => clock,
    });

    await expect(cb.run("c", () => Promise.reject(new TransientError("down")))).rejects.toThrow();
    expect(cb.state("c")).toBe("open");

    clock = 1500;
    await cb.run("c", () => "back");
    expect(cb.state("c")).toBe("half-open");
    await cb.run("c", () => "back");
    expect(cb.state("c")).toBe("closed");
  });

  it("reopens immediately if the probe fails", async () => {
    let clock = 0;
    const cb = createCircuitBreaker({ policy: { failureThreshold: 1, openDurationMs: 100 }, now: () => clock });
    await expect(cb.run("c", () => Promise.reject(new TransientError("down")))).rejects.toThrow();
    clock = 200;
    await expect(cb.run("c", () => Promise.reject(new TransientError("still down")))).rejects.toThrow();
    expect(cb.state("c")).toBe("open");
  });

  it("resets a success count, because the threshold is about consecutive failures", async () => {
    const cb = createCircuitBreaker({ policy: { failureThreshold: 3 } });
    await expect(cb.run("c", () => Promise.reject(new TransientError("blip")))).rejects.toThrow();
    await cb.run("c", () => "fine");
    await expect(cb.run("c", () => Promise.reject(new TransientError("blip")))).rejects.toThrow();
    // An occasional error under load is not an outage.
    expect(cb.state("c")).toBe("closed");
  });
});

describe("rate limiting", () => {
  it("allows up to the limit and then refuses with a retry hint", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const rule = { scope: "org", limit: 3, windowMs: 1000 };

    for (let i = 0; i < 3; i += 1) expect(limiter.check("k", rule).allowed).toBe(true);

    const refused = limiter.check("k", rule);
    expect(refused.allowed).toBe(false);
    // A 429 with no Retry-After makes a client guess, and clients guess badly.
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("slides, so an allowance cannot be spent twice across a boundary", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const rule = { scope: "org", limit: 2, windowMs: 1000 };

    limiter.check("k", rule);
    limiter.check("k", rule);
    expect(limiter.check("k", rule).allowed).toBe(false);

    // Half a window later, only the oldest has aged out.
    clock = 1100;
    expect(limiter.check("k", rule).allowed).toBe(true);
  });

  it("scopes keys so one organization cannot exhaust another's allowance", () => {
    const ctx = requestContext();
    expect(rateLimitKey("organization", ctx)).toBe("org:acme");
    expect(rateLimitKey("user", ctx)).toBe("user:user_1");
    expect(rateLimitKey("organization", requestContext({ tenant: { organizationId: "other", roles: [] } })))
      .not.toBe(rateLimitKey("organization", ctx));
  });
});

describe("authorization at the boundary", () => {
  it("throws rather than returning false", async () => {
    const authorizer = { can: (ctx: RequestContext, p: string) => ctx.identity.permissions.includes(p) };
    await expect(requirePermission(authorizer, requestContext(), "quote.read")).resolves.toBeUndefined();
    // A boolean a caller can ignore is a boolean a caller will ignore.
    await expect(requirePermission(authorizer, requestContext(), "quote.delete")).rejects.toThrow(
      AuthorizationError,
    );
  });
});

describe("the cache", () => {
  it("is never the source of truth — every read can miss", () => {
    let clock = 0;
    const cache = createInMemoryCache({ now: () => clock });
    cache.set("k", { v: 1 }, 100);
    expect(cache.get("k")).toEqual({ v: 1 });
    clock = 200;
    expect(cache.get("k")).toBeUndefined();
  });

  it("scopes keys so a shared cache cannot leak across tenants", () => {
    const a = cacheKey({ organizationId: "acme" }, "material", "steel");
    const b = cacheKey({ organizationId: "other" }, "material", "steel");
    expect(a).not.toBe(b);
    // Genuinely shared reference data is explicit about being shared.
    expect(cacheKey(undefined, "material", "steel")).toMatch(/^shared:/);
  });

  it("invalidates by prefix, which is how an event clears derived entries", () => {
    const cache = createInMemoryCache();
    cache.set("t:acme:quote:1", 1);
    cache.set("t:acme:quote:2", 2);
    cache.set("t:other:quote:1", 3);
    expect(cache.deleteByPrefix("t:acme:quote:")).toBe(2);
    expect(cache.get("t:other:quote:1")).toBe(3);
  });
});

describe("feature flags", () => {
  it("treats an unknown flag as off", () => {
    // A typo in a flag name must not ship an unfinished capability.
    expect(createInMemoryFeatureFlags().isEnabled("forgeiq.experimental_nesting", tenant)).toBe(false);
  });

  it("enables per organization, so shops adopt at their own pace", () => {
    const flags = createInMemoryFeatureFlags();
    flags.enableFor("costiq.vendor_learning", "acme");
    expect(flags.isEnabled("costiq.vendor_learning", { organizationId: "acme" })).toBe(true);
    expect(flags.isEnabled("costiq.vendor_learning", { organizationId: "other" })).toBe(false);
  });

  it("lets an explicit disable beat the default", () => {
    const flags = createInMemoryFeatureFlags([
      { key: "a.b", enabledByDefault: true, enabledFor: [], disabledFor: [] },
    ]);
    flags.disableFor("a.b", "acme");
    // The lever you reach for when one shop is having a bad day.
    expect(flags.isEnabled("a.b", { organizationId: "acme" })).toBe(false);
    expect(flags.isEnabled("a.b", { organizationId: "other" })).toBe(true);
  });
});

describe("artifacts", () => {
  it("stores bytes and hands back a reference", () => {
    const store = createInMemoryArtifactStore();
    const artifact = store.put({
      tenant,
      artifactType: "dxf",
      contentType: "application/dxf",
      data: new Uint8Array([1, 2, 3]),
      sourceEngine: "forgeiq",
      sourceEntityId: "plan_1",
    });
    expect(artifact.sizeBytes).toBe(3);
    // Events carry this, never the bytes.
    expect(artifact.storageLocation).toBeTruthy();
    expect(store.read(artifact.artifactId)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("recognises identical bytes rather than storing them twice", () => {
    const store = createInMemoryArtifactStore();
    const put = () =>
      store.put({
        artifactType: "receipt-image",
        contentType: "image/png",
        data: new Uint8Array([9, 9, 9]),
        sourceEngine: "receiptiq",
        sourceEntityId: "receipt_1",
      });
    expect(put().artifactId).toBe(put().artifactId);
    expect(store.size()).toBe(1);
  });

  it("finds everything one operation produced", () => {
    const store = createInMemoryArtifactStore();
    store.put({ artifactType: "dxf", contentType: "x", data: new Uint8Array([1]), sourceEngine: "forgeiq", sourceEntityId: "plan_1" });
    store.put({ artifactType: "svg", contentType: "x", data: new Uint8Array([2]), sourceEngine: "forgeiq", sourceEntityId: "plan_1" });
    expect(store.listBySource("forgeiq", "plan_1")).toHaveLength(2);
  });
});

describe("notifications", () => {
  it("records what happened without deciding how it reaches anyone", () => {
    const notifier = createInMemoryNotifier();
    notifier.notify({
      tenant,
      kind: "job.failed",
      severity: "urgent",
      title: "Nesting failed",
      recipients: [],
      trace,
    });
    // The engine said what happened. Email or push is somebody else's decision.
    expect(notifier.all()[0]).toMatchObject({ kind: "job.failed", severity: "urgent" });
  });

  it("scopes retrieval by tenant", () => {
    const notifier = createInMemoryNotifier();
    notifier.notify({ tenant, kind: "a", severity: "info", title: "A", recipients: [], trace });
    notifier.notify({
      tenant: { organizationId: "other", roles: [] },
      kind: "b", severity: "info", title: "B", recipients: [], trace,
    });
    expect(notifier.forTenant("acme")).toHaveLength(1);
  });
});

describe("tracing", () => {
  it("nests spans under one trace", async () => {
    const tracer = createInMemoryTracer();
    await withSpan(tracer, "prime.workflow", async (parent) => {
      await withSpan(tracer, "forgeiq.plan", () => "plan", { parent: parent.context() });
      await withSpan(tracer, "costiq.cost", () => "cost", { parent: parent.context() });
    });

    const [root] = tracer.spans();
    const trail = tracer.trace(root!.traceId);
    expect(trail).toHaveLength(3);
    expect(trail.filter((s) => s.parentSpanId === root!.spanId)).toHaveLength(2);
  });

  it("records the exception and still ends the span", async () => {
    const tracer = createInMemoryTracer();
    await expect(
      withSpan(tracer, "costiq.cost", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const [span] = tracer.spans();
    expect(span!.status).toBe("error");
    expect(span!.exception?.message).toBe("boom");
    // The error path is the one you most want to see, so it must not leak.
    expect(span!.endedAt).toBeDefined();
  });

  it("round-trips a W3C traceparent", () => {
    const ctx = { correlationId: "c", traceId: "a".repeat(32), spanId: "b".repeat(16) };
    const header = toTraceparent(ctx)!;
    expect(fromTraceparent(header, "c")).toMatchObject({ traceId: ctx.traceId, spanId: ctx.spanId });
  });

  it("returns nothing for a malformed traceparent rather than a broken trace", () => {
    expect(fromTraceparent("garbage", "c")).toBeUndefined();
    expect(fromTraceparent("00-short-x-01", "c")).toBeUndefined();
    expect(toTraceparent({ correlationId: "c" })).toBeUndefined();
  });

  it("propagates correlation even when there is no trace id", () => {
    // Correlation survives a hop that drops traceparent. Something surviving
    // beats the whole thread breaking at one badly behaved proxy.
    expect(propagationHeaders({ correlationId: "cor_9" })["x-correlation-id"]).toBe("cor_9");
  });
});

describe("webhooks", () => {
  const endpointInput = {
    tenant,
    url: "https://partner.example.com/hook",
    eventTypes: ["receipt.*"],
    secret: "a-secret-at-least-16-chars",
    active: true,
  };

  it("signs every delivery, and a receiver can verify it", async () => {
    const transport =
      vi.fn<(url: string, body: string, headers: Record<string, string>) => Promise<{ status: number }>>(
        async () => ({ status: 200 }),
      );
    const dispatcher = createWebhookDispatcher({ transport });
    const endpoint = dispatcher.register(endpointInput);

    const delivery = await dispatcher.dispatch(endpoint, {
      eventId: "evt_1",
      eventType: "receipt.normalized",
      payload: { fingerprint: "f" },
    });

    expect(delivery.status).toBe("delivered");
    const call = transport.mock.calls[0];
    expect(call).toBeDefined();
    const [, body, headers] = call!;
    expect(verifyWebhook(endpoint.secret, headers["x-proworks-signature"]!, body).valid).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const timestamp = new Date().toISOString();
    const signed = signWebhook("secret-one-that-is-long", timestamp, "{}");
    expect(verifyWebhook("secret-two-that-is-long", signed.header, "{}").valid).toBe(false);
  });

  it("rejects a stale payload before checking the signature", () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    const signed = signWebhook("a-secret-at-least-16-chars", old, "{}");
    // A valid signature on an ancient payload is what a replay looks like.
    const result = verifyWebhook("a-secret-at-least-16-chars", signed.header, "{}");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/tolerance/);
  });

  it("only sends to endpoints subscribed to that event type", () => {
    const dispatcher = createWebhookDispatcher({ transport: async () => ({ status: 200 }) });
    dispatcher.register(endpointInput);
    dispatcher.register({ ...endpointInput, eventTypes: ["cost.calculation.completed"] });

    expect(dispatcher.endpointsFor("acme", "receipt.normalized")).toHaveLength(1);
    expect(dispatcher.endpointsFor("other", "receipt.normalized")).toHaveLength(0);
  });

  it("disables an endpoint that keeps failing rather than retrying it forever", async () => {
    const dispatcher = createWebhookDispatcher({
      transport: async () => ({ status: 500 }),
      disableAfterFailures: 3,
    });
    const endpoint = dispatcher.register(endpointInput);

    for (let i = 0; i < 3; i += 1) {
      await dispatcher.dispatch(dispatcher.endpoints()[0]!, {
        eventId: `e${i}`, eventType: "receipt.normalized", payload: {},
      });
    }

    // A dead URL hammered every minute is a slow denial of service on
    // ourselves, and it hides the endpoints that are merely struggling.
    const after = dispatcher.endpoints().find((e) => e.endpointId === endpoint.endpointId)!;
    expect(after.active).toBe(false);
    expect(after.disabledReason).toMatch(/consecutive failures/);
  });

  it("logs a failed delivery and replays the original payload unchanged", async () => {
    let status = 500;
    const dispatcher = createWebhookDispatcher({ transport: async () => ({ status }) });
    const endpoint = dispatcher.register(endpointInput);

    const failed = await dispatcher.dispatch(endpoint, {
      eventId: "evt_1", eventType: "receipt.normalized", payload: { original: true },
    });
    expect(failed.status).toBe("failed");

    status = 200;
    const replayed = await dispatcher.replay(failed.deliveryId);
    expect(replayed?.status).toBe("delivered");
    // The fact happened when it happened — re-deriving it could quietly
    // rewrite history for the partner.
    expect(replayed?.payload).toEqual({ original: true });
    expect(replayed?.attempt).toBe(2);
  });

  it("records a transport that throws, rather than losing the delivery", async () => {
    const dispatcher = createWebhookDispatcher({
      transport: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const endpoint = dispatcher.register(endpointInput);
    const delivery = await dispatcher.dispatch(endpoint, {
      eventId: "e", eventType: "receipt.normalized", payload: {},
    });
    expect(delivery.status).toBe("failed");
    expect(delivery.error).toMatch(/ECONNREFUSED/);
    // "Did you send it?" must have an answer.
    expect(dispatcher.deliveries({ status: "failed" })).toHaveLength(1);
  });
});
