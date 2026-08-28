// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createVisualizationAdapter, createVisualizationBudget } from "../visualization.js";
import { SUITE_MANIFESTS } from "../../manifests/index.js";
import type { EngineManifest } from "../manifest.js";

const adapter = createVisualizationAdapter(SUITE_MANIFESTS);

const event = (over: Record<string, unknown> = {}) => ({
  eventId: "evt-1",
  eventType: "manufacturing.plan.generated",
  eventVersion: 1,
  occurredAt: "2026-08-27T12:00:00.000Z",
  publishedAt: "2026-08-27T12:00:00.100Z",
  source: { service: "forgeiq" },
  trace: { correlationId: "corr-7" },
  payload: { planId: "plan-1", customerName: "Jane Doe", totalCents: 48_000 },
  ...over,
});

describe("a real event becomes real motion", () => {
  it("translates a plan being generated into ForgeIQ emitting a packet", () => {
    const visual = adapter.translate(event());
    expect(visual).toMatchObject({
      engineId: "forgeiq",
      effect: "emit",
      destination: "costiq",
      source: "forgeiq",
      correlationId: "corr-7",
      visualHint: "workpiece",
    });
  });

  it("carries no payload into the visual layer", () => {
    // A console that renders payloads into a scene has put customer data on a
    // wallboard, and the wallboard is in an office. Inspecting a payload is a
    // deliberate, permissioned click in the trace view.
    const visual = adapter.translate(event());
    expect(JSON.stringify(visual)).not.toContain("Jane Doe");
    expect(JSON.stringify(visual)).not.toContain("48000");
  });

  it("shows nothing for an event nobody mapped", () => {
    // No event, no motion — and no invented motion either. Decorative pulses
    // are indistinguishable from real ones, which makes the real ones worthless.
    expect(adapter.translate(event({ eventType: "some.internal.thing" }))).toBeNull();
  });

  it("does not let one engine's mapping light up another engine's event", () => {
    // The same event type published by a different service belongs to that
    // service's scene, or to nobody.
    const visual = adapter.translate(
      event({ eventType: "manufacturing.plan.generated", source: { service: "costiq" } }),
    );
    expect(visual?.engineId).not.toBe("forgeiq");
  });

  it("lets a routed event light up the engine receiving it", () => {
    // Prime publishes the routing; the destination engine's own manifest says
    // what arriving work should look like.
    const visual = adapter.translate(
      event({ eventType: "manufacturing.request.routed", source: { service: "prime" } }),
    );
    expect(visual).toMatchObject({ engineId: "prime", effect: "emit", destination: "forgeiq" });
  });
});

describe("telemetry the console did not expect", () => {
  it("returns nothing instead of throwing, whatever arrives", () => {
    // A console that throws on a malformed event goes blank during the incident
    // that produced the malformed event.
    for (const junk of [
      null, undefined, 42, "event", [], {},
      { eventType: "x.y" },
      { eventType: 7, source: { service: "forgeiq" } },
      { eventType: "manufacturing.plan.generated", source: {} },
      { eventType: "manufacturing.plan.generated", source: { service: "forgeiq" } },
      event({ eventId: undefined }),
      event({ source: null }),
    ]) {
      expect(() => adapter.translate(junk), JSON.stringify(junk)).not.toThrow();
      expect(adapter.translate(junk), JSON.stringify(junk)).toBeNull();
    }
  });

  it("loses only the correlation id when the trace is malformed", () => {
    // The animation still belongs on screen. Dropping it because one field is
    // unreadable would hide a real event; losing the link to its trace is the
    // proportionate cost.
    const visual = adapter.translate(event({ trace: "not-an-object" }));
    expect(visual?.engineId).toBe("forgeiq");
    expect(visual?.correlationId).toBeUndefined();
  });

  it("survives an event with no timestamps rather than rendering NaN", () => {
    const visual = adapter.translate(event({ occurredAt: undefined, publishedAt: undefined }));
    expect(visual).not.toBeNull();
    expect(Number.isNaN(Date.parse(visual!.timestamp))).toBe(false);
  });

  it("clamps an intensity a manifest should not have carried", () => {
    const rogue: EngineManifest = {
      ...SUITE_MANIFESTS[1]!,
      id: "rogue",
      eventMappings: [
        { eventType: "rogue.thing.happened", effect: "activate", intensity: Number.POSITIVE_INFINITY },
      ],
    };
    const visual = createVisualizationAdapter([rogue]).translate(
      event({ eventType: "rogue.thing.happened", source: { service: "rogue" } }),
    );
    expect(visual?.intensity).toBe(0);
  });
});

describe("choosing between overlapping mappings", () => {
  const manifest: EngineManifest = {
    ...SUITE_MANIFESTS[1]!,
    id: "layered",
    eventMappings: [
      { eventType: "*", effect: "activate", intensity: 0.1 },
      { eventType: "material.*", effect: "receive", intensity: 0.4 },
      { eventType: "material.purchase.detected", effect: "emit", intensity: 0.9 },
    ],
  };
  const layered = createVisualizationAdapter([manifest]);
  const from = (eventType: string) =>
    layered.translate(event({ eventType, source: { service: "layered" } }));

  it("prefers the exact mapping over the prefix and the wildcard", () => {
    // Otherwise an audit-style `*` mapping silently outranks the specific one
    // somebody wrote, and the scene shows a generic pulse forever while the
    // intended mapping sits there looking correct.
    expect(from("material.purchase.detected")?.effect).toBe("emit");
  });

  it("prefers the prefix over the wildcard", () => {
    expect(from("material.price.observed")?.effect).toBe("receive");
  });

  it("falls back to the wildcard for everything else", () => {
    expect(from("something.else.entirely")?.effect).toBe("activate");
  });
});

describe("staying cheap on the operator's machine", () => {
  it("stops drawing past the budget, and counts what it dropped", () => {
    // 5,000 jobs a minute would otherwise queue 5,000 animations, and the
    // browser that tries is the browser that stops responding during the
    // incident. "Throughput so high we stopped drawing it" is itself
    // information, so the count is kept.
    let clock = 0;
    const budget = createVisualizationBudget({ maxEffectsPerEnginePerSecond: 3, now: () => clock });
    const pulse = adapter.translate(event())!;

    const drawn = Array.from({ length: 10 }, () => budget.admit(pulse)).filter(Boolean);
    expect(drawn).toHaveLength(3);
    expect(budget.droppedFor("forgeiq")).toBe(7);
  });

  it("opens a fresh budget each second", () => {
    let clock = 0;
    const budget = createVisualizationBudget({ maxEffectsPerEnginePerSecond: 2, now: () => clock });
    const pulse = adapter.translate(event())!;

    expect([budget.admit(pulse), budget.admit(pulse), budget.admit(pulse)].filter(Boolean)).toHaveLength(2);
    clock += 1_000;
    expect(budget.admit(pulse)).not.toBeNull();
  });

  it("never drops an alert to stay inside the budget", () => {
    // Sampling throughput is fine — one pulse looks much like the next. An
    // alert dropped for a graphics card is a failure the operator was not shown.
    let clock = 0;
    const budget = createVisualizationBudget({ maxEffectsPerEnginePerSecond: 1, now: () => clock });
    const pulse = adapter.translate(event())!;
    const alert = adapter.translate(
      event({ eventType: "shop.order.line.unmatched", source: { service: "order-ingestion" } }),
    )!;
    expect(alert.effect).toBe("alert");

    budget.admit(pulse);
    for (let i = 0; i < 50; i += 1) budget.admit(pulse);
    expect(budget.admit(alert)).not.toBeNull();
  });

  it("budgets each engine separately", () => {
    // One noisy engine must not silence the other seven.
    let clock = 0;
    const budget = createVisualizationBudget({ maxEffectsPerEnginePerSecond: 1, now: () => clock });
    const forge = adapter.translate(event())!;
    const receipt = adapter.translate(
      event({ eventType: "receipt.normalized", source: { service: "receiptiq" } }),
    )!;

    budget.admit(forge);
    expect(budget.admit(forge)).toBeNull();
    expect(budget.admit(receipt)).not.toBeNull();
  });
});
