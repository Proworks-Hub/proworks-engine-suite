// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { DEFAULT_ALERT_POLICY, createAlertRegistry } from "../alerts.js";
import { REDACTED, buildTrace, inspectPayload, redactPayload } from "../tracing.js";
import { deriveEngineHealth, type EngineHeartbeat } from "../health.js";
import type { ObservedHeartbeat } from "../heartbeat.js";

const T0 = Date.parse("2026-08-27T12:00:00.000Z");

const beat = (over: Partial<EngineHeartbeat> = {}, at = T0): ObservedHeartbeat => ({
  engineId: "forgeiq",
  version: "2.1.4",
  observedAt: new Date(at - 1_000).toISOString(),
  jobsProcessed: 1_000,
  jobsFailed: 0,
  openCircuits: [],
  maintenance: false,
  source: "reported",
  observedEvents: 0,
  ...over,
});

const healthAt = (at: number, over: Partial<EngineHeartbeat> = {}) =>
  deriveEngineHealth("forgeiq", beat(over, at), { now: at });

describe("alerts that do not exhaust the person reading them", () => {
  it("does not fire for a problem that lasts a moment", () => {
    // A deploy, a restart or one slow batch should not page anybody.
    const registry = createAlertRegistry();
    const bad = healthAt(T0, { jobsFailed: 900 });
    const { opened } = registry.apply([bad], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    expect(opened).toEqual([]);
    expect(registry.active()).toEqual([]);
  });

  it("fires once the problem has persisted", () => {
    const registry = createAlertRegistry();
    const later = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    registry.apply([healthAt(T0, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    const { opened } = registry.apply(
      [healthAt(later, { jobsFailed: 900 })],
      { forgeiq: beat({ jobsFailed: 900 }, later) },
      later,
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ kind: "engine.failed", severity: "critical", source: "forgeiq" });
  });

  it("keeps the same alert for the same problem instead of a new one each tick", () => {
    // The whole design. Fresh alerts per snapshot means four hundred
    // notifications an hour, and then the system gets muted — after which
    // nobody is watching and everybody believes somebody is.
    const registry = createAlertRegistry();
    let opened = 0;
    for (let i = 0; i <= 20; i += 1) {
      const at = T0 + i * 30_000;
      opened += registry.apply(
        [healthAt(at, { jobsFailed: 900 })],
        { forgeiq: beat({ jobsFailed: 900 }, at) },
        at,
      ).opened.length;
    }
    expect(opened).toBe(1);
    expect(registry.active()).toHaveLength(1);
    expect(registry.active()[0]!.occurrences).toBeGreaterThan(10);
  });

  it("refreshes the reason while keeping the alert", () => {
    // An operator reading it should see the current numbers, not the ones from
    // whenever it first fired.
    const registry = createAlertRegistry();
    const open = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    registry.apply([healthAt(T0, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    registry.apply([healthAt(open, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }, open) }, open);

    const later = open + 60_000;
    registry.apply(
      [healthAt(later, { jobsProcessed: 2_000, jobsFailed: 1_900 })],
      { forgeiq: beat({ jobsProcessed: 2_000, jobsFailed: 1_900 }, later) },
      later,
    );
    expect(registry.active()[0]!.reason).toContain("2000");
  });

  it("does not resolve on one good sample", () => {
    // A flapping engine that recovers for four seconds would otherwise close
    // and immediately reopen, and the sawtooth is indistinguishable from a
    // broken console.
    const registry = createAlertRegistry();
    const open = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    registry.apply([healthAt(T0, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    registry.apply([healthAt(open, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }, open) }, open);

    const blip = open + 1_000;
    const { resolved } = registry.apply([healthAt(blip)], { forgeiq: beat({}, blip) }, blip);
    expect(resolved).toEqual([]);
    expect(registry.active()).toHaveLength(1);
  });

  it("resolves once it has genuinely been clear", () => {
    const registry = createAlertRegistry();
    const open = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    registry.apply([healthAt(T0, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    registry.apply([healthAt(open, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }, open) }, open);

    const clear = open + DEFAULT_ALERT_POLICY.resolveAfterMs + 1_000;
    const { resolved } = registry.apply([healthAt(clear)], { forgeiq: beat({}, clear) }, clear);
    expect(resolved).toHaveLength(1);
    expect(registry.active()).toEqual([]);
    expect(registry.history()[0]?.resolvedAt).toBeTruthy();
  });

  it("says nothing about an engine somebody deliberately took down", () => {
    const registry = createAlertRegistry();
    for (const at of [T0, T0 + 120_000, T0 + 240_000]) {
      registry.apply(
        [healthAt(at, { maintenance: true, jobsFailed: 900, openCircuits: ["db"] })],
        { forgeiq: beat({ maintenance: true, jobsFailed: 900, openCircuits: ["db"] }, at) },
        at,
      );
    }
    expect(registry.active()).toEqual([]);
  });

  it("alerts on silence, which is the problem nobody notices", () => {
    const registry = createAlertRegistry();
    const silent = deriveEngineHealth("forgeiq", undefined, { now: T0 });
    registry.apply([silent], {}, T0);
    const later = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    const { opened } = registry.apply(
      [deriveEngineHealth("forgeiq", undefined, { now: later })],
      {},
      later,
    );
    expect(opened[0]?.kind).toBe("engine.unknown");
  });

  it("puts critical above warning in the list", () => {
    const registry = createAlertRegistry();
    const open = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    const snapshot = (at: number) => {
      const failing = deriveEngineHealth("a", beat({ engineId: "a", jobsFailed: 900 }, at), { now: at });
      const slow = deriveEngineHealth("b", beat({ engineId: "b", avgLatencyMs: 9_000 }, at), { now: at });
      registry.apply([failing, slow], {
        a: beat({ engineId: "a", jobsFailed: 900 }, at),
        b: beat({ engineId: "b", avgLatencyMs: 9_000 }, at),
      }, at);
    };
    snapshot(T0);
    snapshot(open);
    expect(registry.active()[0]!.severity).toBe("critical");
  });

  it("keeps an acknowledged alert open, because the problem is still true", () => {
    const registry = createAlertRegistry();
    const open = T0 + DEFAULT_ALERT_POLICY.openAfterMs + 1_000;
    registry.apply([healthAt(T0, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }) }, T0);
    registry.apply([healthAt(open, { jobsFailed: 900 })], { forgeiq: beat({ jobsFailed: 900 }, open) }, open);

    const acked = registry.acknowledge("forgeiq:engine.failed", "steven", open);
    expect(acked?.acknowledgedBy).toBe("steven");
    expect(registry.active()).toHaveLength(1);
  });
});

describe("following one order across the engines", () => {
  const event = (service: string, eventType: string, offsetMs: number, payload: unknown = {}) => ({
    eventId: `e-${service}-${offsetMs}`,
    eventType,
    source: { service },
    occurredAt: new Date(T0 + offsetMs).toISOString(),
    publishedAt: new Date(T0 + offsetMs).toISOString(),
    trace: { correlationId: "corr-1" },
    payload,
  });

  const events = [
    event("order-ingestion", "shop.order.normalized", 0),
    event("prime", "manufacturing.request.routed", 120),
    event("forgeiq", "manufacturing.plan.generated", 1_320),
    event("costiq", "cost.calculation.completed", 2_210),
  ];

  it("orders by time, not by arrival", () => {
    // An at-least-once bus delivers out of order often enough that a trace
    // built in receipt order shows an effect before its cause — and an operator
    // who sees that once stops believing the next one.
    const trace = buildTrace([...events].reverse(), "corr-1")!;
    expect(trace.entries.map((e) => e.source)).toEqual([
      "order-ingestion", "prime", "forgeiq", "costiq",
    ]);
  });

  it("gives offsets and durations, which is what a waterfall needs", () => {
    const trace = buildTrace(events, "corr-1")!;
    expect(trace.entries[1]!.offsetMs).toBe(120);
    expect(trace.entries[1]!.durationMs).toBe(1_200);
    expect(trace.entries[3]!.durationMs).toBeUndefined();
    expect(trace.totalMs).toBe(2_210);
  });

  it("ignores events belonging to a different piece of work", () => {
    const other = { ...event("costiq", "cost.calculation.completed", 50), trace: { correlationId: "corr-2" } };
    expect(buildTrace([...events, other], "corr-1")!.entries).toHaveLength(4);
  });

  it("marks the failures the manifests declare", () => {
    const trace = buildTrace(
      [...events, event("order-ingestion", "shop.order.line.unmatched", 900)],
      "corr-1",
      { failureEventTypes: new Set(["shop.order.line.unmatched"]) },
    )!;
    expect(trace.failureCount).toBe(1);
  });

  it("returns nothing rather than an empty trace for an unknown id", () => {
    expect(buildTrace(events, "corr-nope")).toBeNull();
  });

  it("survives junk in the event list", () => {
    expect(() => buildTrace([null, 7, {}, ...events], "corr-1")).not.toThrow();
    expect(buildTrace([null, 7, {}, ...events], "corr-1")!.entries).toHaveLength(4);
  });

  it("carries no payload in the default view", () => {
    // The trace view is the console's most dangerous feature: a complete record
    // of what a customer ordered, assembled on a screen that may be on a wall.
    const trace = buildTrace(
      [event("order-ingestion", "shop.order.normalized", 0, { customerName: "Jane Doe", email: "j@x.com" })],
      "corr-1",
    )!;
    expect(JSON.stringify(trace)).not.toContain("Jane Doe");
    expect(JSON.stringify(trace)).not.toContain("j@x.com");
    // But it says a payload exists, so an operator knows there is something to
    // request rather than concluding the event was empty.
    expect(trace.entries[0]!.hasPayload).toBe(true);
  });
});

describe("payload inspection, once somebody is allowed", () => {
  const payload = {
    orderId: "ord-1",
    customerName: "Jane Doe",
    shippingAddress: { line1: "1 High St", postcode: "AB1 2CD" },
    lines: [{ sku: "SKU-ABCD1234", qty: 2, email: "jane@example.com" }],
    widthIn: 24,
    ownership: "tenant-private",
  };

  it("blanks what identifies a person and keeps what explains the job", () => {
    // An engineer debugging a routing failure needs the shape of the order.
    // Being trusted with that does not make the customer's address appropriate.
    const result = redactPayload(payload) as typeof payload;
    expect(result.customerName).toBe(REDACTED);
    expect(result.shippingAddress).toBe(REDACTED);
    expect(result.lines[0]!.email).toBe(REDACTED);
    expect(result.orderId).toBe("ord-1");
    expect(result.widthIn).toBe(24);
    expect(result.lines[0]!.sku).toBe("SKU-ABCD1234");
  });

  it("matches whole words, so it does not blank things it should not", () => {
    // A redactor that blanks `ownership` for containing `owner` gets switched
    // off, and a redactor that is off redacts nothing.
    expect((redactPayload(payload) as typeof payload).ownership).toBe("tenant-private");
  });

  it("lists what it removed instead of hiding its own redactions", () => {
    // Otherwise an engineer concludes the field was missing from the event, and
    // goes looking for a publisher bug that does not exist.
    const inspection = inspectPayload({ eventId: "e-1", payload });
    expect(inspection.redactedFields).toContain("customerName");
    expect(inspection.redactedFields).toContain("lines[0].email");
  });

  it("does not hang on a payload that points at itself", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(() => redactPayload(cyclic)).not.toThrow();
  });

  it("leaves primitives alone", () => {
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload("plain")).toBe("plain");
  });
});
