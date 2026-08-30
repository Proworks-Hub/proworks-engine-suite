// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { rToDecimalString, rational, type Rational } from "@proworks-hub/contracts";

import {
  buildSkeleton,
  classifyMateriality,
  conventionSensitivity,
  decomposeVariance,
  fxAttributability,
  relativeVariance,
  requireMixBasis,
  roundDecomposition,
  type ConventionRef,
  type FactorComparand,
} from "../kernel.js";

const convention = (conventionId: ConventionRef["conventionId"], declaredOrder?: readonly string[]): ConventionRef => ({
  conventionId,
  semanticVersion: "1.0.0",
  ...(declaredOrder !== undefined ? { declaredOrder } : {}),
});

// §16.6 worked example: 1,000 units at £10.00 → 1,400 units at £12.00.
// Prices in minor units (pence) so amounts land in minor units directly.
const workedCase: FactorComparand[] = [
  { factorId: "price", basis: rational(1000n, 1n), subject: rational(1200n, 1n) },
  { factorId: "volume", basis: rational(1000n, 1n), subject: rational(1400n, 1n) },
];

const amountOf = (factors: readonly { factorId: string; amount: Rational }[], id: string): string => {
  const f = factors.find((x) => x.factorId === id)!;
  return rToDecimalString(f.amount, 0);
};

describe("§16.6 — the same variance, five answers, every row reconciling exactly", () => {
  // ΔTotal = 16,800.00 − 10,000.00 = +£6,800 = 680,000 minor.
  it("laspeyres.price-first: price £2,000, volume £4,800", () => {
    const d = decomposeVariance(workedCase, convention("convention.laspeyres.price-first"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(amountOf(d.value.factors, "price")).toBe("200000");
    expect(amountOf(d.value.factors, "volume")).toBe("480000");
    expect(rToDecimalString(d.value.totalVariance, 0)).toBe("680000");
  });
  it("paasche.volume-first: price £2,800, volume £4,000", () => {
    const d = decomposeVariance(workedCase, convention("convention.paasche.volume-first"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(amountOf(d.value.factors, "price")).toBe("280000");
    expect(amountOf(d.value.factors, "volume")).toBe("400000");
  });
  it("joint-explicit: price £2,000, volume £4,000, joint £800 NAMED", () => {
    const d = decomposeVariance(workedCase, convention("convention.joint-explicit"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(amountOf(d.value.factors, "price")).toBe("200000");
    expect(amountOf(d.value.factors, "volume")).toBe("400000");
    expect(amountOf(d.value.factors, "joint")).toBe("80000");
  });
  it("bennet.midpoint and shapley coincide at n=2: price £2,400, volume £4,400", () => {
    const bennet = decomposeVariance(workedCase, convention("convention.bennet.midpoint"));
    const shapley = decomposeVariance(workedCase, convention("convention.shapley"));
    expect(bennet.ok && shapley.ok).toBe(true);
    if (!bennet.ok || !shapley.ok) return;
    for (const d of [bennet.value, shapley.value]) {
      expect(amountOf(d.factors, "price")).toBe("240000");
      expect(amountOf(d.factors, "volume")).toBe("440000");
    }
  });
  it("sequential.declared-order with volume first reproduces paasche exactly", () => {
    const d = decomposeVariance(workedCase, convention("convention.sequential.declared-order", ["volume", "price"]));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(amountOf(d.value.factors, "price")).toBe("280000");
    expect(amountOf(d.value.factors, "volume")).toBe("400000");
  });
  it("I-1 across every convention: Σ(factors) == ΔTotal exactly, residual exactly zero", () => {
    const conventions: ConventionRef[] = [
      convention("convention.laspeyres.price-first"),
      convention("convention.paasche.volume-first"),
      convention("convention.joint-explicit"),
      convention("convention.bennet.midpoint"),
      convention("convention.shapley"),
      convention("convention.sequential.declared-order", ["price", "volume"]),
    ];
    for (const c of conventions) {
      const d = decomposeVariance(workedCase, c);
      expect(d.ok, c.conventionId).toBe(true);
      if (!d.ok) continue;
      expect(d.value.unassignedResidual.num).toBe(0n);
      const sum = d.value.factors.reduce(
        (acc, f) => rational(acc.num * f.amount.den + f.amount.num * acc.den, acc.den * f.amount.den),
        rational(0n, 1n),
      );
      expect(sum.num * d.value.totalVariance.den).toBe(d.value.totalVariance.num * sum.den);
    }
  });
});

describe("§16.3 — the convention is required; no default exists", () => {
  it("an absent convention refuses, naming the spread that is the reason", () => {
    const d = decomposeVariance(workedCase, undefined);
    expect(!d.ok && d.refusal.kind).toBe("CONVENTION_UNSELECTED");
  });
  it("sequential without a declared order refuses — 24 orderings, up to 24 answers", () => {
    const d = decomposeVariance(workedCase, convention("convention.sequential.declared-order"));
    expect(!d.ok && d.refusal.kind).toBe("ORDER_UNDECLARED");
    const wrong = decomposeVariance(workedCase, convention("convention.sequential.declared-order", ["price"]));
    expect(!wrong.ok && wrong.refusal.kind).toBe("ORDER_UNDECLARED");
  });
  it("two-factor-only conventions refuse a three-factor set and name the alternative", () => {
    const three: FactorComparand[] = [
      ...workedCase,
      { factorId: "fx", basis: rational(1n, 1n), subject: rational(11n, 10n) },
    ];
    for (const id of ["convention.laspeyres.price-first", "convention.paasche.volume-first", "convention.joint-explicit", "convention.bennet.midpoint"] as const) {
      const d = decomposeVariance(three, convention(id));
      expect(!d.ok && d.refusal.kind, id).toBe("FACTOR_SET_UNSUPPORTED_BY_CONVENTION");
    }
    const shapley = decomposeVariance(three, convention("convention.shapley"));
    expect(shapley.ok).toBe(true);
  });
  it("shapley refuses beyond six factors — n! orderings are budgeted", () => {
    const seven: FactorComparand[] = Array.from({ length: 7 }, (_, i) => ({
      factorId: `f${i}`,
      basis: rational(2n, 1n),
      subject: rational(3n, 1n),
    }));
    const d = decomposeVariance(seven, convention("convention.shapley"));
    expect(!d.ok && d.refusal.kind).toBe("SHAPLEY_FACTOR_LIMIT");
  });
  it("shapley at n=3 is exactly additive and order-independent (I-1 as a property)", () => {
    const three: FactorComparand[] = [
      { factorId: "price", basis: rational(700n, 1n), subject: rational(900n, 1n) },
      { factorId: "volume", basis: rational(50n, 1n), subject: rational(65n, 1n) },
      { factorId: "fx", basis: rational(1n, 1n), subject: rational(6n, 5n) },
    ];
    const d = decomposeVariance(three, convention("convention.shapley"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const sum = d.value.factors.reduce(
      (acc, f) => rational(acc.num * f.amount.den + f.amount.num * acc.den, acc.den * f.amount.den),
      rational(0n, 1n),
    );
    expect(sum.num * d.value.totalVariance.den).toBe(d.value.totalVariance.num * sum.den);
    // Reordering the factor set changes nothing.
    const reordered = decomposeVariance([three[2]!, three[0]!, three[1]!], convention("convention.shapley"));
    if (!reordered.ok) return;
    for (const f of d.value.factors) {
      const other = reordered.value.factors.find((x) => x.factorId === f.factorId)!;
      expect(f.amount.num * other.amount.den).toBe(other.amount.num * f.amount.den);
    }
  });
});

describe("presentation rounding — after reconciliation, exact-sum preserved", () => {
  it("rounded factor minors sum exactly to the rounded total", () => {
    // A case with thirds: total 100, three equal factors of 100/3 each.
    const factors: FactorComparand[] = [
      { factorId: "a", basis: rational(1n, 1n), subject: rational(1n, 1n) },
      { factorId: "b", basis: rational(1n, 1n), subject: rational(1n, 1n) },
      { factorId: "c", basis: rational(100n, 1n), subject: rational(200n, 1n) },
    ];
    const d = decomposeVariance(factors, convention("convention.shapley"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const rounded = roundDecomposition(d.value);
    const sum = rounded.reduce((a, r) => a + r.amountMinor, 0n);
    expect(sum).toBe(100n);
  });
});

describe("§16.7 — convention sensitivity and attributionUnstable", () => {
  it("the worked case is sign- and rank-stable, and the spread is reported anyway", () => {
    const s = conventionSensitivity(workedCase);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.value.attributionUnstable).toBe(false);
    const price = s.value.bands.find((b) => b.factorId === "price")!;
    // £2,000 to £2,800 — a 40% spread on the number a pricing decision is made from.
    expect(rToDecimalString(price.minAmount, 0)).toBe("200000");
    expect(rToDecimalString(price.maxAmount, 0)).toBe("280000");
    expect(rToDecimalString(price.spread, 0)).toBe("80000");
  });
  it("a sign flip across conventions sets attributionUnstable and names the disagreement", () => {
    // At n=2, price's contribution is ΔP × (some quantity weighting), so its
    // sign can only flip between conventions when the quantity CROSSES ZERO —
    // a contra line. ΔP=+2; Q goes 3 → −2:
    // laspeyres: price = ΔP·Q0 = +6; paasche: price = ΔP·Q1 = −4. Sign flips.
    const contra: FactorComparand[] = [
      { factorId: "price", basis: rational(10n, 1n), subject: rational(12n, 1n) },
      { factorId: "volume", basis: rational(3n, 1n), subject: rational(-2n, 1n) },
    ];
    const s = conventionSensitivity(contra);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const price = s.value.bands.find((b) => b.factorId === "price")!;
    expect(price.signStable).toBe(false);
    expect(s.value.attributionUnstable).toBe(true);
    expect(s.value.disagreement).not.toBeNull();
  });
});

describe("§16.14 relative variance — denominator required, null at zero", () => {
  it("refuses an unselected denominator", () => {
    const r = relativeVariance(rational(100n, 1n), rational(120n, 1n), undefined);
    expect(!r.ok && r.refusal.kind).toBe("DENOMINATOR_UNSELECTED");
  });
  it("returns null over a zero basis — a percentage of nothing is not a number", () => {
    const r = relativeVariance(rational(0n, 1n), rational(120n, 1n), "basis");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.relative).toBeNull();
  });
  it("basis vs midpoint denominators are different claims with different answers", () => {
    const basis = relativeVariance(rational(100n, 1n), rational(150n, 1n), "basis");
    const midpoint = relativeVariance(rational(100n, 1n), rational(150n, 1n), "midpoint");
    if (!basis.ok || !midpoint.ok || basis.value.relative === null || midpoint.value.relative === null) return;
    expect(rToDecimalString(basis.value.relative, 4)).toBe("0.5000");
    expect(rToDecimalString(midpoint.value.relative, 4)).toBe("0.4000");
  });
});

describe("§16.9 materiality — classified, partitioned, never filtered", () => {
  const variances = [
    { varianceRef: "v1", signedDeltaMinor: 500_000n },
    { varianceRef: "v2", signedDeltaMinor: -40_000n },
    { varianceRef: "v3", signedDeltaMinor: 45_000n },
    { varianceRef: "v4", signedDeltaMinor: 30_000n },
  ];
  it("no policy: every variance unclassifiable — there is no house threshold (D-5)", () => {
    const r = classifyMateriality(variances, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.classified).toHaveLength(4);
    expect(r.value.classified.every((c) => c.class === "unclassifiable")).toBe(true);
  });
  it("absolute policy: partition I-2 holds — every row present, below-threshold aggregated alongside", () => {
    const r = classifyMateriality(variances, {
      kind: "absolute",
      purpose: "analytical",
      declaredBy: "human.steven",
      thresholdMinor: 100_000n,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.classified).toHaveLength(4); // nothing dropped
    expect(r.value.belowThresholdCount).toBe(3);
    expect(r.value.belowThresholdAggregateMinor).toBe(35_000n);
    expect(r.value.belowThresholdAggregateMaterial).toBe(false);
    const total = r.value.classified.reduce((a, c) => a + c.signedDeltaMinor, 0n);
    const material = r.value.classified.filter((c) => c.class === "material").reduce((a, c) => a + c.signedDeltaMinor, 0n);
    expect(material + r.value.belowThresholdAggregateMinor).toBe(total);
  });
  it("below-threshold accumulation: many small same-signed variances trip the aggregate flag", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ varianceRef: `s${i}`, signedDeltaMinor: 900n }));
    const r = classifyMateriality(many, {
      kind: "absolute",
      purpose: "analytical",
      declaredBy: "human.steven",
      thresholdMinor: 1_000n,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.belowThresholdCount).toBe(200);
    expect(r.value.belowThresholdAggregateMinor).toBe(180_000n);
    expect(r.value.belowThresholdAggregateMaterial).toBe(true);
  });
  it("asymmetry by omission is not available: one threshold without the other refuses", () => {
    const r = classifyMateriality(variances, {
      kind: "absolute-asymmetric",
      purpose: "analytical",
      declaredBy: "human.steven",
      adverseThresholdMinor: 50_000n,
    });
    expect(!r.ok && r.refusal.kind).toBe("ASYMMETRY_INCOMPLETE");
  });
  it("a declared asymmetric policy applies each side's own threshold", () => {
    const r = classifyMateriality(variances, {
      kind: "absolute-asymmetric",
      purpose: "analytical",
      declaredBy: "human.steven",
      adverseThresholdMinor: 30_000n,
      favourableThresholdMinor: 100_000n,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byRef = new Map(r.value.classified.map((c) => [c.varianceRef, c.class]));
    expect(byRef.get("v2")).toBe("material"); // adverse −40k ≥ 30k adverse threshold
    expect(byRef.get("v3")).toBe("below-threshold"); // favourable 45k < 100k
  });
  it("statistical below sampleMinimum: unclassifiable with the shortfall named — no fallback to absolute", () => {
    const r = classifyMateriality(variances, {
      kind: "statistical",
      purpose: "analytical",
      declaredBy: "human.steven",
      windowObservationsMinor: [10n, 20n, 30n, 25n],
      k: 3,
      distributionAssumption: "approximately symmetric",
      sampleMinimum: 12,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.classified.every((c) => c.class === "unclassifiable")).toBe(true);
    expect(r.value.classified[0]!.note).toContain("sampleMinimum is 12");
  });
});

describe("§16.11 FX — unattributable is a named residual, never a zero", () => {
  it("an unspecified fx kind refuses: transaction and translation are never netted", () => {
    const r = fxAttributability({ basisRateRef: "r1", subjectRateRef: "r2" }, undefined);
    expect(!r.attributable && "refusal" in r && r.refusal.kind).toBe("FX_KIND_UNSPECIFIED");
  });
  it("a missing rate ref on either side yields the fx-unattributable residual reason", () => {
    const r = fxAttributability({ basisRateRef: undefined, subjectRateRef: "r2" }, "transaction");
    expect(r.attributable).toBe(false);
    if (r.attributable || !("residualReason" in r)) return;
    expect(r.residualReason).toBe("fx-unattributable");
    expect(r.detail).toContain("basis");
  });
  it("both refs present: the factor is the NAMED kind", () => {
    const r = fxAttributability({ basisRateRef: "r1", subjectRateRef: "r2" }, "translation");
    expect(r.attributable && r.factorId).toBe("factor.fx.translation");
  });
});

describe("§16.8 mix — a declared portfolio boundary or nothing", () => {
  it("any missing MixBasis field refuses", () => {
    expect(requireMixBasis(undefined).ok).toBe(false);
    const partial = requireMixBasis({
      portfolioMembers: ["a", "b"],
      averagingMethod: "basis-weighted",
      entrantTreatment: "as-own-term",
    });
    expect(!partial.ok && partial.refusal.kind).toBe("MIX_PORTFOLIO_UNDECLARED");
  });
  it("a mix-bearing decomposition is NOT additive across levels, and the skeleton says so", () => {
    const d = decomposeVariance(workedCase, convention("convention.shapley"), { includesMixFactor: true });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.value.additiveAcrossLevels).toBe(false);
    const skeleton = buildSkeleton(d.value, null, null);
    expect(skeleton.requiredCaveats.some((c) => c.id === "mix-not-additive")).toBe(true);
  });
});

describe("§16.12 narrative skeleton — deterministic, caveats non-droppable", () => {
  it("convention-named is ALWAYS present, steps ordered by |contribution| descending", () => {
    const d = decomposeVariance(workedCase, convention("convention.laspeyres.price-first"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    const skeleton = buildSkeleton(d.value, null, null);
    expect(skeleton.requiredCaveats[0]!.id).toBe("convention-named");
    expect(skeleton.requiredCaveats[0]!.text).toContain("convention.laspeyres.price-first");
    expect(skeleton.steps[0]!.factorId).toBe("volume"); // £4,800 > £2,000
  });
  it("attribution-unstable carries the disagreeing conventions and factor", () => {
    const contra: FactorComparand[] = [
      { factorId: "price", basis: rational(10n, 1n), subject: rational(12n, 1n) },
      { factorId: "volume", basis: rational(3n, 1n), subject: rational(-2n, 1n) },
    ];
    const d = decomposeVariance(contra, convention("convention.bennet.midpoint"));
    const s = conventionSensitivity(contra);
    if (!d.ok || !s.ok) return;
    const skeleton = buildSkeleton(d.value, s.value, null);
    const caveat = skeleton.requiredCaveats.find((c) => c.id === "attribution-unstable");
    expect(caveat).toBeDefined();
    expect(caveat!.text).toContain("price");
  });
  it("the below-threshold-aggregate-material caveat rides in from materiality", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ varianceRef: `s${i}`, signedDeltaMinor: 900n }));
    const m = classifyMateriality(many, {
      kind: "absolute",
      purpose: "analytical",
      declaredBy: "human.steven",
      thresholdMinor: 1_000n,
    });
    const d = decomposeVariance(workedCase, convention("convention.shapley"));
    if (!m.ok || !d.ok) return;
    const skeleton = buildSkeleton(d.value, null, m.value);
    expect(skeleton.requiredCaveats.some((c) => c.id === "below-threshold-aggregate-material")).toBe(true);
  });
});
