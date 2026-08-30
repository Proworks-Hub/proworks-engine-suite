/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import type { CostComponent } from "../../domain/costModel.js";
import { buildCostGraph } from "../../core/costGraph.js";
import { explain, narrationBrief, summarise, type ExplanationLevel } from "../explanationLevels.js";

// ─────────────────────────────────────────────────────────────────────────────
// "Why does this cost that" is seven different questions.
//
// A salesperson wants a sentence. An auditor wants rate ids and a fingerprint.
// Serving both the same answer fails both — and every level must reconcile,
// because an explanation whose parts do not add up is a set of numbers near
// each other.
// ─────────────────────────────────────────────────────────────────────────────

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

const component = (over: Partial<CostComponent> & { componentId: string; amount: string }): CostComponent =>
  ({
    kind: "MATERIAL",
    label: over.componentId,
    currency: "GBP",
    included: true,
    notes: [],
    basisId: "b1",
    ...over,
  }) as CostComponent;

// Listed SMALLEST first, deliberately. An earlier version listed them in
// descending order, which is also the order the sort produces — so a mutation
// removing the sort changed nothing and survived.
const components: readonly CostComponent[] = [
  component({ componentId: "coat", label: "Powder coat", amount: "20.00", kind: "SUBCONTRACT" }),
  component({ componentId: "laser", label: "Laser time", amount: "60.00", kind: "MACHINE" }),
  component({ componentId: "labour", label: "Fabrication", amount: "120.00", kind: "LABOR", quantity: "240", quantityUnit: "min" }),
  component({ componentId: "steel", label: "Corten steel", amount: "200.00", quantity: "100", quantityUnit: "kg" }),
];

const graph = (() => {
  const built = buildCostGraph(components);
  if (!built.ok) throw new Error("fixture failed to build");
  return built.graph;
})();

const at = (level: ExplanationLevel, over: Record<string, unknown> = {}) =>
  explain({
    graph,
    components,
    currency: "GBP",
    quantity: d("4"),
    level,
    scale: 8,
    mode: "HALF_EVEN",
    ...over,
  });

describe("L0 — the answer", () => {
  it("is the total and the unit cost, and nothing else", () => {
    const e = at(0);
    expect(n(e.total)).toBe("400");
    expect(n(e.unitCost!)).toBe("100");
    expect(e.byKind).toBeUndefined();
    expect(e.drivers).toBeUndefined();
    expect(e.components).toBeUndefined();
  });

  it("gives a one-line summary", () => {
    expect(summarise(at(0))).toBe("400.00 GBP.");
  });

  it("reports no unit cost for a zero quantity rather than dividing", () => {
    expect(at(0, { quantity: d("0") }).unitCost).toBeNull();
  });
});

describe("L1 — where the money is", () => {
  it("groups by kind, largest first", () => {
    const e = at(1);
    expect(e.byKind!.map((k) => k.kind)).toEqual(["MATERIAL", "LABOR", "MACHINE", "SUBCONTRACT"]);
    expect(n(e.byKind![0]!.amount)).toBe("200");
    expect(n(e.byKind![0]!.percentOfTotal)).toBe("50");
  });

  it("has shares that sum to 100", () => {
    // The reconciliation property at this depth.
    const e = at(1);
    const sum = e.byKind!.reduce((acc, k) => acc + Number(toString(k.percentOfTotal)), 0);
    expect(sum).toBeCloseTo(100, 6);
  });

  it("reports the unpriced share separately", () => {
    const withUnpriced = [...components, component({ componentId: "u", amount: "0", kind: "UNPRICED" })];
    const built = buildCostGraph(withUnpriced);
    if (!built.ok) throw new Error("build failed");
    const e = explain({
      graph: built.graph,
      components: withUnpriced,
      currency: "GBP",
      quantity: d("4"),
      level: 1,
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(e.unpricedShare).toBeDefined();
  });
});

describe("L2 — what drives it", () => {
  it("ranks the largest contributors", () => {
    const e = at(2, { driverCount: 2 });
    expect(e.drivers!.map((x) => x.componentId)).toEqual(["steel", "labour"]);
    expect(e.drivers![0]!.rank).toBe(1);
  });

  it("says how much the listed drivers actually account for", () => {
    // Without this a reader sees "the top two are X and Y" and cannot tell
    // whether that is most of the cost or a fifth of it.
    const e = at(2, { driverCount: 2 });
    expect(n(e.driversCover!)).toBe("80");
  });

  it("ranks by magnitude, not signed value", () => {
    // A large credit is as interesting as a large charge.
    const withCredit = [
      component({ componentId: "a-credit", label: "Rebate", amount: "-500.00" }),
      component({ componentId: "z-small", label: "Small", amount: "1.00" }),
    ];
    const built = buildCostGraph(withCredit);
    if (!built.ok) throw new Error("build failed");
    const e = explain({
      graph: built.graph,
      components: withCredit,
      currency: "GBP",
      quantity: d("1"),
      level: 2,
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(e.drivers![0]!.componentId).toBe("a-credit");
  });

  it("is deterministic when two drivers tie", () => {
    const tied = [
      component({ componentId: "z", label: "Z", amount: "50.00" }),
      component({ componentId: "a", label: "A", amount: "50.00" }),
    ];
    const built = buildCostGraph(tied);
    if (!built.ok) throw new Error("build failed");
    const run = () =>
      explain({ graph: built.graph, components: tied, currency: "GBP", quantity: d("1"), level: 2, scale: 8, mode: "HALF_EVEN" })
        .drivers!.map((x) => x.componentId);
    expect(run()).toEqual(["a", "z"]);
    expect(run()).toEqual(run());
  });
});

describe("L3 — every line", () => {
  it("lists all components with quantity and implied rate", () => {
    const e = at(3);
    expect(e.components).toHaveLength(4);
    const steel = e.components!.find((c) => c.componentId === "steel")!;
    // 200 over 100 kg is £2/kg, derived rather than stored — a rolled-up
    // estimate may no longer carry the rate.
    expect(n(steel.impliedRate!)).toBe("2");
  });

  it("reports no implied rate where there is no quantity", () => {
    const e = at(3);
    expect(e.components!.find((c) => c.componentId === "laser")!.impliedRate).toBeNull();
  });

  it("reports no implied rate for a ZERO quantity rather than dividing by it", () => {
    // A component recorded with a quantity of zero is real — a consumable that
    // was configured but never drawn. Dividing by it has no answer.
    const withZero = [component({ componentId: "unused", amount: "0.00", quantity: "0", quantityUnit: "each" })];
    const built = buildCostGraph(withZero);
    if (!built.ok) throw new Error("build failed");
    const e = explain({
      graph: built.graph,
      components: withZero,
      currency: "GBP",
      quantity: d("1"),
      level: 3,
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(e.components![0]!.impliedRate).toBeNull();
  });

  it("includes components excluded from the total, so nothing is hidden", () => {
    const withMemo = [...components, component({ componentId: "memo", amount: "999.00", included: false })];
    const built = buildCostGraph(withMemo);
    if (!built.ok) throw new Error("build failed");
    const e = explain({
      graph: built.graph,
      components: withMemo,
      currency: "GBP",
      quantity: d("4"),
      level: 3,
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(e.components!.some((c) => c.componentId === "memo")).toBe(true);
    // But it does not change the total, AND the explanation still reconciles —
    // the second assertion is what catches an excluded component being summed.
    expect(n(e.total)).toBe("400");
    expect(e.reconciles).toBe(true);
    expect(n(e.reconciliationGap)).toBe("0");
  });
});

describe("L4 to L6 — evidence, alternatives and audit", () => {
  const extras = {
    evidence: [{ componentId: "steel", basisId: "b1", sourceKind: "CONTRACT", observedAt: "2026-08-01", wasFallback: false, caveats: ["Excludes delivery"] }],
    evidenceQuality: {
      coverage: 100, freshness: 90, sourceStrength: 100, sampleSufficiency: 100,
      normalization: 100, assumptionLoad: 100, validatedVariance: null, weakest: [],
    },
    assumptions: [{ id: "a1", statement: "Assumed 5% scrap.", because: "No measured yield.", affectsComponentIds: [] }],
    rejectedAlternatives: [{ basisId: "b2", reason: "Forecast rates are not accepted." }],
    sensitivities: [{ componentId: "steel", label: "Corten steel", swing: d("40") }],
    audit: {
      fingerprint: "fnv128:abc", methodId: "DIRECT_JOB", methodVersion: "1.0.0",
      policyId: "p", policyVersion: "1", computedAt: "2026-08-30T00:00:00.000Z", rateIds: ["rate.steel"],
    },
  };

  it("adds evidence only at L4 and above", () => {
    expect(at(3, extras).evidence).toBeUndefined();
    expect(at(4, extras).evidence).toHaveLength(1);
  });

  it("adds alternatives only at L5 and above", () => {
    expect(at(4, extras).rejectedAlternatives).toBeUndefined();
    expect(at(5, extras).rejectedAlternatives).toHaveLength(1);
  });

  it("adds the audit trail only at L6", () => {
    expect(at(5, extras).audit).toBeUndefined();
    expect(at(6, extras).audit!.fingerprint).toBe("fnv128:abc");
    expect(at(6, extras).audit!.methodVersion).toBe("1.0.0");
  });

  it("carries every level below the requested one", () => {
    const e = at(6, extras);
    expect(e.byKind).toBeDefined();
    expect(e.drivers).toBeDefined();
    expect(e.components).toBeDefined();
    expect(e.evidence).toBeDefined();
    expect(e.sensitivities).toBeDefined();
  });
});

describe("every explanation reconciles", () => {
  it("reports zero gap when the parts make the total", () => {
    const e = at(3);
    expect(e.reconciles).toBe(true);
    expect(n(e.reconciliationGap)).toBe("0");
  });

  it("REPORTS a gap rather than claiming to reconcile", () => {
    // An explanation that claims to reconcile and does not is worse than one
    // that admits a gap.
    const broken = [component({ componentId: "a", amount: "10.00" })];
    const built = buildCostGraph(broken);
    if (!built.ok) throw new Error("build failed");
    // A graph whose rollup disagrees with the component sum cannot occur
    // through the normal path, so it is forced here to prove the check works.
    const fakeGraph = {
      ...built.graph,
      nodes: new Map([["a", { ...built.graph.nodes.get("a")!, ownAmount: d("99.00") }]]),
    };
    const e = explain({
      graph: fakeGraph,
      components: broken,
      currency: "GBP",
      quantity: d("1"),
      level: 1,
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(e.reconciles).toBe(false);
    expect(n(e.reconciliationGap)).toBe("89");
  });
});

describe("a narrator receives numbers it cannot recompute", () => {
  it("hands over formatted strings, not quantities and rates", () => {
    // The structural version of "AI may narrate but not re-derive". A model
    // given raw quantities and rates will eventually multiply them, and
    // eventually get a different number from the one the customer read.
    const brief = narrationBrief(at(6, {
      audit: { fingerprint: "fnv128:abc", methodId: "M", methodVersion: "1", policyId: "p", policyVersion: "1", computedAt: "t", rateIds: [] },
    }));
    expect(brief.total).toBe("400.00");
    expect(typeof brief.topDrivers[0]!.amount).toBe("string");
    expect(brief.topDrivers[0]!.share).toContain("%");
    // No quantity or rate anywhere in the brief.
    expect(JSON.stringify(brief)).not.toContain("quantity");
    expect(JSON.stringify(brief)).not.toContain("impliedRate");
  });

  it("carries the fingerprint so a narration can cite it", () => {
    const brief = narrationBrief(at(6, {
      audit: { fingerprint: "fnv128:xyz", methodId: "M", methodVersion: "1", policyId: "p", policyVersion: "1", computedAt: "t", rateIds: [] },
    }));
    expect(brief.fingerprint).toBe("fnv128:xyz");
  });

  it("carries caveats and assumptions forward", () => {
    const brief = narrationBrief(at(4, {
      evidence: [{ componentId: "steel", basisId: "b1", sourceKind: "CONTRACT", observedAt: "x", wasFallback: false, caveats: ["Excludes delivery"] }],
      assumptions: [{ id: "a", statement: "Assumed 5% scrap.", because: "x", affectsComponentIds: [] }],
    }));
    expect(brief.caveats).toContain("Excludes delivery");
    expect(brief.assumptions).toContain("Assumed 5% scrap.");
  });
});

describe("explanations are deterministic", () => {
  it("produces identical output for identical input", () => {
    const first = JSON.stringify(at(6), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (let i = 0; i < 5; i += 1) {
      expect(JSON.stringify(at(6), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(first);
    }
  });

  it("does not depend on the order components were supplied in", () => {
    const forward = at(3).components!.map((c) => c.componentId);
    const built = buildCostGraph([...components].reverse());
    if (!built.ok) throw new Error("build failed");
    const reversed = explain({
      graph: built.graph,
      components: [...components].reverse(),
      currency: "GBP",
      quantity: d("4"),
      level: 3,
      scale: 8,
      mode: "HALF_EVEN",
    }).components!.map((c) => c.componentId);
    expect(reversed).toEqual(forward);
  });
});
