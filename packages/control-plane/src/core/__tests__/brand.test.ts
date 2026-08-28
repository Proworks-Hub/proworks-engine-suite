// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { BRAND, BRAND_COLORS, brandVars, kindNoun, navLabel } from "../brand.js";
import { MOTION_LANGUAGE, motionLanguageFor } from "../motionLanguage.js";
import { computeSystemHealth, formatScore } from "../systemHealth.js";
import { computeHiveLayout } from "../topology.js";
import { createEngineRegistry } from "../registry.js";
import { deriveEngineHealth, engineStateSchema, type EngineHeartbeat } from "../health.js";
import { SUITE_MANIFESTS } from "../../manifests/index.js";
import { ENGINE_PALETTE } from "../../react/palette.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const fresh = new Date(NOW - 5_000).toISOString();

const health = (id: string, over: Partial<EngineHeartbeat> = {}) =>
  deriveEngineHealth(
    id,
    {
      engineId: id,
      version: "1.0.0",
      observedAt: fresh,
      jobsProcessed: 1_000,
      jobsFailed: 0,
      openCircuits: [],
      maintenance: false,
      ...over,
    },
    { now: NOW },
  );

describe("naming", () => {
  it("keeps the product name in one place", () => {
    expect(BRAND.signature).toContain(BRAND.full);
    expect(BRAND.signature).toContain(BRAND.tier);
  });

  it("names a thing after what it actually is", () => {
    // The board's sidebar reads "Tracking Engine". Tracking was deliberately
    // built as a projection over what the engines publish, not as an engine,
    // and the label is derived from `kind` so the interface cannot say
    // otherwise without the architecture changing first.
    const byId = Object.fromEntries(SUITE_MANIFESTS.map((m) => [m.id, m]));
    expect(navLabel(byId["forgeiq"]!)).toBe("ForgeIQ Engine");
    expect(navLabel(byId["tracking"]!)).toBe("Tracking Service");
    expect(navLabel(byId["notifications"]!)).toBe("Notifications Service");
  });

  it("does not say Intelligence twice", () => {
    const ai = SUITE_MANIFESTS.find((m) => m.kind === "intelligence")!;
    expect(navLabel(ai)).toBe("AI / Intelligence");
  });

  it("has a noun for every kind", () => {
    for (const kind of ["engine", "service", "intelligence"] as const) {
      expect(kindNoun(kind).length, kind).toBeGreaterThan(3);
    }
  });
});

describe("the colour system", () => {
  it("keeps the brand blue and Prime's blue apart", () => {
    // The whole point of giving each engine a colour is that a colour
    // identifies an engine. A blue that sometimes means "the product" and
    // sometimes means "Prime" identifies nothing.
    expect(BRAND_COLORS.primary).not.toBe(ENGINE_PALETTE["engine-blue"]!.base);
  });

  it("sets every variable the console chrome reads", () => {
    const vars = brandVars();
    for (const key of ["--hive-primary", "--hive-bg", "--hive-surface", "--hive-border", "--hive-text"]) {
      expect(vars[key], key).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("the motion language", () => {
  it("collapses seven health states into three ways of moving", () => {
    // Health answers "what is true" and needs seven. Motion answers "how should
    // this look" and needs three — a scene with seven animation vocabularies is
    // one nobody can read at a glance, which is the only reason it moves.
    for (const state of engineStateSchema.options) {
      expect(MOTION_LANGUAGE[motionLanguageFor(state).state], state).toBeDefined();
    }
  });

  it("does not dress a planned outage as a failure", () => {
    // Using the failure vocabulary for maintenance is how a team learns to
    // ignore the failure vocabulary.
    expect(motionLanguageFor("maintenance").state).toBe("idle");
  });

  it("never lets not-knowing look calm", () => {
    expect(motionLanguageFor("unknown").state).toBe("attention");
    expect(motionLanguageFor("degraded").state).toBe("attention");
  });

  it("reserves processing for actual load", () => {
    expect(motionLanguageFor("busy").state).toBe("processing");
    expect(motionLanguageFor("operational").state).toBe("idle");
  });
});

describe("the headline health score", () => {
  it("reads 100% when everything genuinely is", () => {
    const score = computeSystemHealth([health("a"), health("b")], {
      latencyBudgetMs: 2_000,
      supplied: [{ key: "security", label: "Security", score: 1, detail: "Scan clean." }],
    });
    expect(formatScore(score.overall)).toBe("100%");
  });

  it("is the worst component, never the average", () => {
    // Averaging is how seven healthy engines hide one that is on fire. With one
    // engine dead out of eight, a mean would still read about 94%.
    const healths = [
      ...Array.from({ length: 7 }, (_, i) => health(`ok-${i}`)),
      deriveEngineHealth("dead", undefined, { now: NOW }),
    ];
    const score = computeSystemHealth(healths);
    expect(score.overall).toBeCloseTo(7 / 8);
    expect(score.weakest?.key).toBe("availability");
  });

  it("lets the slowest engine set performance", () => {
    const score = computeSystemHealth(
      [health("fast", { avgLatencyMs: 100 }), health("slow", { avgLatencyMs: 4_000 })],
      { latencyBudgetMs: 2_000 },
    );
    expect(score.components.find((c) => c.key === "performance")?.score).toBe(0);
  });

  it("names what it does not measure instead of scoring it perfect", () => {
    // "We do not check this" and "this is fine" look identical on a dashboard
    // that only shows the things it scored.
    const score = computeSystemHealth([health("a")]);
    expect(score.unmeasured).toContain("Security");
    expect(score.components.some((c) => c.key === "security")).toBe(false);
  });

  it("counts a supplied score once it is actually supplied", () => {
    const score = computeSystemHealth([health("a")], {
      supplied: [{ key: "security", label: "Security", score: 0.6, detail: "Two findings open." }],
    });
    expect(score.unmeasured).toEqual([]);
    expect(score.weakest?.key).toBe("security");
  });

  it("reports nothing rather than zero when it knows nothing", () => {
    const score = computeSystemHealth([]);
    expect(score.overall).toBeNull();
    expect(formatScore(null)).toBe("—");
  });

  it("rounds down, so 99.6% never displays as 100%", () => {
    // A dashboard reporting perfection it does not have hides exactly the gap
    // somebody is looking for.
    expect(formatScore(0.996)).toBe("99.6%");
    expect(formatScore(0.9999)).toBe("99.9%");
  });

  it("explains a low score in numbers", () => {
    const score = computeSystemHealth([health("a", { jobsProcessed: 1_000, jobsFailed: 120 })]);
    expect(score.weakest?.detail).toContain("120");
  });
});

describe("services in the hive", () => {
  const registry = createEngineRegistry(SUITE_MANIFESTS);

  it("leaves them out by default", () => {
    expect(computeHiveLayout(registry).nodes.map((n) => n.engineId)).not.toContain("tracking");
  });

  it("draws them when the console asks, without promoting them", () => {
    // The hive is a picture of the system, and the services are part of the
    // system. What must not move is the count.
    const layout = computeHiveLayout(registry, { includeServices: true });
    expect(layout.nodes.map((n) => n.engineId)).toContain("tracking");
    expect(registry.engines).toHaveLength(8);
  });

  it("keeps the intelligence layer off the ring either way", () => {
    // It is not a node in the flow; it is the thing several nodes call. Drawing
    // it as a peer would misdescribe that to anyone learning the system here.
    const layout = computeHiveLayout(registry, { includeServices: true });
    expect(layout.nodes.map((n) => n.engineId)).not.toContain("ai-intelligence");
  });

  it("still puts Prime at the centre with services present", () => {
    expect(computeHiveLayout(registry, { includeServices: true }).core?.engineId).toBe("prime");
  });
});

describe("a fleet nobody is reporting on", () => {
  const silent = (id: string) => deriveEngineHealth(id, undefined, { now: NOW });

  it("scores nothing rather than zero when every engine is unknown", () => {
    // Eight unknown engines is epistemically identical to no engines: the
    // console has no telemetry. Scoring 0% would report a total outage, which
    // is a different and much louder claim.
    const score = computeSystemHealth([silent("a"), silent("b"), silent("c")]);
    expect(score.overall).toBeNull();
    expect(formatScore(score.overall)).toBe("—");
  });

  it("says why it scored nothing", () => {
    const score = computeSystemHealth([silent("a")]);
    expect(score.unmeasured[0]).toContain("no engine is reporting");
  });

  it("still scores availability when only some are unknown", () => {
    // A partly-silent fleet is real information: something IS reporting, and
    // the ones that are not drag the number down exactly as they should.
    const score = computeSystemHealth([health("up"), silent("down")]);
    expect(score.overall).toBeCloseTo(0.5);
    expect(score.weakest?.key).toBe("availability");
  });
});
