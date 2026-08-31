// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  aggregateExposure,
  assembleCoverage,
  combineEs,
  combineFxExposures,
  combineVar,
  deterministicStress,
  disclosureIfrs741,
  dv01,
  economicExposure,
  historicalVar,
  parametricVar,
  settlementExposure,
  testLimit,
  type SourceContribution,
  type SourceExpectation,
  type SourceGap,
  type VarResult,
} from "../kernel.js";

const declared: SourceExpectation[] = [
  { sourceRef: "debtiq", materiality: "required" },
  { sourceRef: "investmentiq", materiality: "contributory" },
];
const contribution = (sourceRef: string, exposureMinor: bigint): SourceContribution => ({
  sourceRef,
  positionAsOf: "2026-08-30",
  positionCount: 3,
  exposureMinor,
});
const gap = (sourceRef: string, reason: SourceGap["reason"]): SourceGap => ({ sourceRef, reason, detail: reason });

describe("§16.2 the coverage manifest — unknown vs incomplete is load-bearing", () => {
  it("a missing REQUIRED source is unknown: we cannot characterise what we are missing", () => {
    const m = assembleCoverage(declared, [contribution("investmentiq", 100n)], [gap("debtiq", "port-unbound")]);
    expect(m.coverageState).toBe("unknown");
  });
  it("only contributory sources missing is incomplete: the gap was declared non-essential", () => {
    const m = assembleCoverage(declared, [contribution("debtiq", 100n)], [gap("investmentiq", "port-timeout")]);
    expect(m.coverageState).toBe("incomplete");
  });
  it("nothing missing is complete", () => {
    const m = assembleCoverage(declared, [contribution("debtiq", 100n), contribution("investmentiq", 50n)], []);
    expect(m.coverageState).toBe("complete");
  });
  it("a partial aggregate has NO field named exposure — contributedExposure only", () => {
    const partial = aggregateExposure(assembleCoverage(declared, [contribution("debtiq", 100n)], [gap("investmentiq", "stale-beyond-tolerance")]));
    expect(partial.basis).toBe("partial");
    expect("exposureMinor" in partial).toBe(false);
    if (partial.basis === "partial") expect(partial.contributedExposureMinor).toBe(100n);
    const complete = aggregateExposure(assembleCoverage(declared, [contribution("debtiq", 100n), contribution("investmentiq", 50n)], []));
    expect(complete.basis === "complete" && complete.exposureMinor).toBe(150n);
  });
});

describe("§16.2.5 the one-sided determinacy rule", () => {
  const partialAggregate = aggregateExposure(
    assembleCoverage(declared, [contribution("debtiq", 1_000n)], [gap("investmentiq", "port-unbound")]),
  );
  const completeAggregate = aggregateExposure(
    assembleCoverage(declared, [contribution("debtiq", 1_000n), contribution("investmentiq", 0n)], []),
  );
  it("complete coverage tests determinately in both directions", () => {
    expect(testLimit("l1", completeAggregate, 500n, true).outcome).toBe("breached");
    expect(testLimit("l1", completeAggregate, 5_000n, true).outcome).toBe("within-limit");
  });
  it("a MONOTONE limit is proven breached on partial data — the missing positions cannot cure it", () => {
    const r = testLimit("gross-notional", partialAggregate, 500n, true);
    expect(r.outcome).toBe("breached");
    expect(r.publishableEvent).toBe("risk.limit.breached");
  });
  it("but never proven within limit on partial data", () => {
    const r = testLimit("gross-notional", partialAggregate, 5_000n, true);
    expect(r.outcome).toBe("indeterminate");
    expect(r.deficiency?.missingSources).toContain("investmentiq");
    expect(r.publishableEvent).toBe("risk.limit.indeterminate");
  });
  it("a NON-monotone limit is indeterminate in both directions on partial data", () => {
    expect(testLimit("net-fx", partialAggregate, 500n, false).outcome).toBe("indeterminate");
    expect(testLimit("net-fx", partialAggregate, 5_000n, false).outcome).toBe("indeterminate");
  });
  it("undeclared monotonicity is indeterminate ALWAYS; LIM-1: every indeterminate carries a deficiency", () => {
    const r = testLimit("mystery", partialAggregate, 1n, undefined);
    expect(r.outcome).toBe("indeterminate");
    expect(r.deficiency).not.toBeNull();
  });
  it("LIM-3: a suspended limit is indeterminate, never within-limit", () => {
    const r = testLimit("l1", completeAggregate, 5_000n, true, true);
    expect(r.outcome).toBe("indeterminate");
  });
});

describe("§16.3 FX — three kinds, never summed", () => {
  it("transaction and translation refuse to combine (FX-1)", () => {
    const r = combineFxExposures([
      { fxKind: "transaction", entityRef: "e1", currencyPair: "EUR/GBP", netMinor: 100n },
      { fxKind: "translation", entityRef: "e1", currencyPair: "EUR/GBP", netMinor: 200n },
    ]);
    expect(!r.ok && r.refusal.kind).toBe("fx_exposure_kind_mismatch");
  });
  it("cross-entity netting refuses without an explicit declaration", () => {
    const r = combineFxExposures([
      { fxKind: "transaction", entityRef: "e1", currencyPair: "EUR/GBP", netMinor: 100n },
      { fxKind: "transaction", entityRef: "e2", currencyPair: "EUR/GBP", netMinor: -100n },
    ]);
    expect(r.ok).toBe(false);
  });
  it("same kind, same entity combines", () => {
    const r = combineFxExposures([
      { fxKind: "transaction", entityRef: "e1", currencyPair: "EUR/GBP", netMinor: 100n },
      { fxKind: "transaction", entityRef: "e1", currencyPair: "EUR/GBP", netMinor: -30n },
    ]);
    expect(r.ok && r.value.combinedNetMinor).toBe(70n);
  });
  it("economic exposure refuses and reports the assumption set instead of a number", () => {
    const r = economicExposure(["EUR/GBP"]);
    expect(!r.ok && r.refusal.kind).toBe("economic_exposure_not_measurable_from_positions");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("elasticity(EUR/GBP)");
  });
});

describe("§16.4 DV01 — the approximation block is the output, not a footnote", () => {
  it("computes DV01 with the validity range attached", () => {
    // Modified duration 4.2, price 1,000,000.00 minor → DV01 = 4.2 × price × 0.0001.
    const r = dv01(420_000_000n, 100_000_000n, 100, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dv01Minor).toBe(42_000n);
    expect(r.value.approximation.assumesParallelShift).toBe(true);
  });
  it("a shock beyond the linear validity range refuses — the number that gets used outside its range", () => {
    const r = dv01(420_000_000n, 100_000_000n, 100, 250);
    expect(!r.ok && r.refusal.kind).toBe("shock_beyond_linear_validity");
  });
});

describe("§16.6.3 settlement exposure — gross, always (CP-1)", () => {
  it("sums legs gross; the type is its own kind and monotone by construction", () => {
    const r = settlementExposure("bank-x", [500n, -300n]);
    expect(r.grossMinor).toBe(800n);
    expect(r.kind).toBe("settlement-exposure");
    expect(r.monotone).toBe(true);
  });
});

describe("§16.9 VaR and ES — gated, and VaR never aggregates", () => {
  const scenarioSet = { setId: "hist-2020s", digest: "d1", lossesMinor: [-500n, -100n, -900n, -50n, -300n] };
  const gatedInputs = {
    coverageState: "complete" as const,
    scenarioSet,
    horizon: "10d",
    confidencePermille: 990,
    revaluation: "full" as const,
    limitations: ["lookback window excludes pre-2020 stress"],
  };
  it("all gates met: the quantile loss with the scenario set identity and limitations", () => {
    const r = historicalVar(gatedInputs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lossAtQuantileMinor).toBe(-50n);
    expect(r.value.scenarioSetRef.digest).toBe("d1");
    expect(r.value.limitations.length).toBeGreaterThan(0);
  });
  it("partial coverage refuses: VaR depends on offsets", () => {
    const r = historicalVar({ ...gatedInputs, coverageState: "incomplete" });
    expect(!r.ok && r.refusal.kind).toBe("var_gates_not_met");
  });
  it("an empty limitations block refuses — not defaulted", () => {
    const r = historicalVar({ ...gatedInputs, limitations: [] });
    expect(r.ok).toBe(false);
  });
  it("parametric VaR refuses without a documented distribution — an assumed normal is not a distribution", () => {
    const r = parametricVar(undefined);
    expect(!r.ok && r.refusal.kind).toBe("distribution_assumption_undocumented");
  });
  it("VAR-AGG-1: no operation combines two VaR figures — the sum can UNDERSTATE", () => {
    const one = historicalVar(gatedInputs);
    if (!one.ok) return;
    const r = combineVar(one.value, one.value);
    expect(!r.ok && r.refusal.kind).toBe("var_aggregation_forbidden");
  });
  it("ES combines only over an identical scenario set digest", () => {
    const mismatch = combineEs([
      { esMinor: -100n, scenarioSetDigest: "d1" },
      { esMinor: -200n, scenarioSetDigest: "d2" },
    ]);
    expect(!mismatch.ok && mismatch.refusal.kind).toBe("scenario_set_mismatch");
    const matched = combineEs([
      { esMinor: -100n, scenarioSetDigest: "d1" },
      { esMinor: -200n, scenarioSetDigest: "d1" },
    ]);
    expect(matched.ok && matched.value.combinedEsMinor).toBe(-300n);
  });
  it("IFRS 7.41: the disclosure is conditional on the explanation", () => {
    const one = historicalVar(gatedInputs);
    if (!one.ok) return;
    const noMethodology = disclosureIfrs741(one.value, "  ");
    expect(!noMethodology.ok && noMethodology.refusal.kind).toBe("disclosure_limitations_block_required");
    const full = disclosureIfrs741(one.value, "historical simulation, full revaluation");
    expect(full.ok).toBe(true);
  });
});

describe("§16.11 deterministic stress — honest over coverage (STRESS-1)", () => {
  const set = {
    setId: "severe-1",
    version: "1.0.0",
    digest: "sd1",
    rationale: "rates +300bps with FX dislocation",
    authoredBy: "human.steven",
    shocks: [{ riskFactorRef: "gbp-rates", shockBps: 300, liquidityHorizonDays: 30 }],
  };
  it("complete coverage yields stressLoss; anything less yields contributedStressLoss", () => {
    const complete = deterministicStress(set, "complete", [-500n, -300n]);
    expect(complete.basis === "complete" && complete.stressLossMinor).toBe(-800n);
    const partial = deterministicStress(set, "incomplete", [-500n]);
    expect(partial.basis).toBe("partial");
    expect("stressLossMinor" in partial).toBe(false);
  });
});

// Type-level guard (G-22): the VaR result is branded; a bare arithmetic sum of
// two results does not typecheck as a VarResult. Kept as a compile assertion.
type AssertBranded = VarResult["__brand"] extends "var-result-no-arithmetic" ? true : never;
const _brandCheck: AssertBranded = true;
void _brandCheck;
