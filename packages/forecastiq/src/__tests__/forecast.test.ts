// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { rToDecimalString, rational } from "@proworks-hub/contracts";

import {
  buildInterval,
  checkHistory,
  classifyIntermittency,
  computeFva,
  croston,
  mapeWithDefinedness,
  masePerHorizon,
  naiveDrift,
  naiveRandomWalk,
  naiveSeasonal,
  reconcileBottomUp,
  recordOverride,
  scoreOverride,
  seasonalNaiveDenominator,
  selectMethod,
  trackBias,
  type BacktestError,
  type StructureNode,
} from "../kernel.js";

describe("§16.16 insufficient history — the typed refusal with minimums", () => {
  const requirements = [
    { methodRef: { methodId: "method.forecast.ets", semanticVersion: "1.0.0", effectiveFrom: "2026-08-30" }, minimumObservations: 24, minimumSeasonalCycles: 2 },
    { methodRef: { methodId: "method.forecast.naive.random-walk", semanticVersion: "1.0.0", effectiveFrom: "2026-08-30" }, minimumObservations: 1, minimumSeasonalCycles: 0 },
  ];
  it("a forecast from three data points does not exist, and the refusal names what IS servable", () => {
    const r = checkHistory([1n, 2n, 3n], requirements[0]!, 12, requirements);
    expect(!r.ok && r.refusal.kind).toBe("insufficient_history");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("method.forecast.naive.random-walk");
  });
});

describe("§16.1 the naive family — the benchmark is a lookup", () => {
  const series = [10n, 20n, 30n, 40n, 12n, 22n, 32n, 42n]; // m=4, two cycles
  it("seasonal naive repeats the prior cycle; the period is SUPPLIED, never inferred", () => {
    const r = naiveSeasonal(series, 4, 6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([12n, 22n, 32n, 42n, 12n, 22n]);
    const noPeriod = naiveSeasonal(series, undefined, 4);
    expect(!noPeriod.ok && noPeriod.refusal.kind).toBe("seasonal_period_not_supplied");
  });
  it("random walk repeats the last observation; drift extrapolates exactly", () => {
    const rw = naiveRandomWalk(series, 3);
    expect(rw.ok && rw.value).toEqual([42n, 42n, 42n]);
    // drift over [10..42]: per-step (42−10)/7; h=7 → 42+32 = 74 exactly.
    const drift = naiveDrift(series, 7);
    expect(drift.ok).toBe(true);
    if (!drift.ok) return;
    expect(drift.value[6]).toBe(74n);
  });
});

describe("§16.5 intermittency and Croston — gated, correction required", () => {
  const lumpySeries = [0n, 0n, 50n, 0n, 0n, 0n, 5n, 0n, 90n, 0n, 0n, 2n];
  it("classifies against DECLARED thresholds", () => {
    const r = classifyIntermittency(lumpySeries, 130n, 49n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.adiTimes100).toBe(300n); // 12 periods / 4 demands
    expect(r.value.class).toBe("lumpy"); // high ADI, high CV²
  });
  it("Croston refuses without the bias-correction choice — neither form is a default", () => {
    const r = croston(lumpySeries, 100n, undefined);
    expect(!r.ok && r.refusal.kind).toBe("croston_correction_unselected");
  });
  it("SBA applies (1 − α/2) to the classical estimate exactly", () => {
    const classical = croston(lumpySeries, 100n, "classical");
    const sba = croston(lumpySeries, 100n, "sba");
    expect(classical.ok && sba.ok).toBe(true);
    if (!classical.ok || !sba.ok) return;
    const scaled = rational(classical.value.forecastPerPeriod.num * 1900n, classical.value.forecastPerPeriod.den * 2000n);
    expect(rToDecimalString(sba.value.forecastPerPeriod, 6)).toBe(rToDecimalString(scaled, 6));
  });
});

describe("§16.12/§16.13 MASE, FVA and the verdict that is allowed to be bad", () => {
  const series = [10n, 20n, 30n, 40n, 12n, 22n, 32n, 42n, 11n, 21n, 31n, 41n];
  const denominator = seasonalNaiveDenominator(series, 4)!;
  const errorsAt = (h: number, values: bigint[]): BacktestError[] => values.map((absErrorMinor, i) => ({ origin: i, horizon: h, absErrorMinor }));
  it("the seasonal-naive denominator is the in-sample scale, exact", () => {
    // Cycle 2 deltas are 2 each (12−10, ...), cycle 3 deltas are 1 each
    // (|11−12|, ...): (4×2 + 4×1) / 8 = 1.5.
    expect(rToDecimalString(denominator, 2)).toBe("1.50");
  });
  it("a degenerate denominator yields insufficient-history-to-judge — never a large MASE presented as informative", () => {
    const flat = [5n, 5n, 5n, 5n, 5n, 5n, 5n, 5n];
    expect(seasonalNaiveDenominator(flat, 4)).toBeNull();
    const fva = computeFva(errorsAt(1, [1n, 1n, 1n]), errorsAt(1, [2n, 2n, 2n]), null, 1, 3, 50n);
    expect(fva.verdict).toBe("insufficient-history-to-judge");
    expect(fva.fva).toBeNull();
  });
  it("FVA positive beyond the margin → adds-value; negative beyond → worse-than-naive; within → no-better", () => {
    const naiveErrors = errorsAt(1, [4n, 4n, 4n, 4n]);
    expect(computeFva(errorsAt(1, [1n, 1n, 1n, 1n]), naiveErrors, denominator, 1, 3, 50n).verdict).toBe("adds-value");
    expect(computeFva(errorsAt(1, [9n, 9n, 9n, 9n]), naiveErrors, denominator, 1, 3, 50n).verdict).toBe("worse-than-naive");
    expect(computeFva(errorsAt(1, [4n, 4n, 4n, 4n]), naiveErrors, denominator, 1, 3, 50n).verdict).toBe("no-better-than-naive");
  });
  it("too few origins → insufficient-history-to-judge, never adds-value", () => {
    const fva = computeFva(errorsAt(1, [1n]), errorsAt(1, [4n]), denominator, 1, 3, 50n);
    expect(fva.verdict).toBe("insufficient-history-to-judge");
  });
  it("MASE is per horizon; a horizon with no errors is null, not zero", () => {
    expect(masePerHorizon(errorsAt(1, [2n, 2n]), denominator, 2)).toBeNull();
  });
  it("MAPE carries a definedness count and is never selection-eligible", () => {
    const r = mapeWithDefinedness([
      { actualMinor: 100n, forecastMinor: 90n },
      { actualMinor: 0n, forecastMinor: 10n }, // undefined at zero
      { actualMinor: 200n, forecastMinor: 220n },
    ]);
    expect(r.definedOver).toBe(2);
    expect(r.undefinedCount).toBe(1);
    expect(r.selectionEligible).toBe(false);
  });
});

describe("§16.11 selection — best that beats seasonal naive, else naive itself", () => {
  const naive = { methodId: "method.forecast.naive.seasonal", maseTimes1000: 1_000n };
  it("a single split is one draw — refused", () => {
    const r = selectMethod([{ methodId: "ets", maseTimes1000: 800n }], naive, 1, 5);
    expect(!r.ok && r.refusal.kind).toBe("insufficient_origins");
  });
  it("no candidate beats naive → the selection IS seasonal naive, verdict visible", () => {
    const r = selectMethod([{ methodId: "ets", maseTimes1000: 1_100n }], naive, 8, 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.selectedMethodId).toBe("method.forecast.naive.seasonal");
    expect(r.value.fvaVerdict).toBe("no-better-than-naive");
    expect(r.value.selectionContaminated).toBe(true);
  });
  it("the best beating candidate wins, and contamination is flagged regardless", () => {
    const r = selectMethod(
      [
        { methodId: "ets", maseTimes1000: 900n },
        { methodId: "theta", maseTimes1000: 850n },
      ],
      naive,
      8,
      5,
    );
    expect(r.ok && r.value.selectedMethodId).toBe("theta");
    if (r.ok) expect(r.value.selectionContaminated).toBe(true);
  });
});

describe("§16.14 bias — detected, published, never auto-corrected", () => {
  it("a crossing tracking signal publishes the finding with autoCorrectionApplied false", () => {
    const finding = trackBias([10n, 12n, 9n, 11n], 3, 300n); // all positive → strong signal
    expect(finding.thresholdCrossed).toBe(true);
    expect(finding.publishes).toBe("forecast.bias.detected");
    expect(finding.autoCorrectionApplied).toBe(false);
  });
  it("cancelling errors do not cross — bias and accuracy are different failures", () => {
    const finding = trackBias([10n, -10n, 10n, -10n], 1, 300n);
    expect(finding.thresholdCrossed).toBe(false);
    expect(finding.meanErrorMinor).toBe(0n);
  });
});

describe("§16.6 intervals — declared basis, honest coverage", () => {
  it("basis is required; coverage is null until enough origins and renders 'not yet measured'", () => {
    const noBasis = buildInterval(undefined, 800, 90n, 110n, 0, 0, 10);
    expect(!noBasis.ok && noBasis.refusal.kind).toBe("interval_basis_required");
    const young = buildInterval("empirical-backtest", 800, 90n, 110n, 3, 4, 10);
    expect(young.ok).toBe(true);
    if (!young.ok) return;
    expect(young.value.coverageObservedPermille).toBeNull();
    expect(young.value.renderedAs).toBe("80% interval (coverage not yet measured)");
  });
  it("measured coverage renders the OBSERVED figure beside the nominal — never '80% confident'", () => {
    const r = buildInterval("empirical-backtest", 800, 90n, 110n, 10, 14, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.coverageObservedPermille).toBe(714);
    expect(r.value.renderedAs).toBe("80% interval (observed coverage 71.4% over 14 origins)");
  });
});

describe("§16.10 coherence — proven post-quantization with a required residual rule", () => {
  const nodes: StructureNode[] = [
    { nodeRef: "total", childRefs: ["a", "b", "c"] },
    { nodeRef: "a", childRefs: [] },
    { nodeRef: "b", childRefs: [] },
    { nodeRef: "c", childRefs: [] },
  ];
  const thirds = new Map([
    ["a", rational(100n, 3n)],
    ["b", rational(100n, 3n)],
    ["c", rational(100n, 3n)],
  ]);
  it("an absent residual rule refuses — the remainder's destination is never emergent", () => {
    const r = reconcileBottomUp(nodes, thirds, undefined);
    expect(!r.ok && r.refusal.kind).toBe("residual_rule_required");
  });
  it("I-COH holds exactly on the quantized values a user sees", () => {
    const r = reconcileBottomUp(nodes, thirds, "largest-remainder");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.quantized;
    expect(q.get("a")! + q.get("b")! + q.get("c")!).toBe(q.get("total")!);
    expect(q.get("total")!).toBe(100n); // three thirds quantize to exactly 100
    expect(r.value.coherence).toBe("proven");
  });
  it("a crossed (grouped) structure stays coherent on BOTH aggregation paths", () => {
    // product × region: two parents share the same bottom cells.
    const crossed: StructureNode[] = [
      { nodeRef: "product-p1", childRefs: ["p1r1", "p1r2"] },
      { nodeRef: "region-r1", childRefs: ["p1r1", "p2r1"] },
      { nodeRef: "p1r1", childRefs: [] },
      { nodeRef: "p1r2", childRefs: [] },
      { nodeRef: "p2r1", childRefs: [] },
    ];
    const bottoms = new Map([
      ["p1r1", rational(70n, 3n)],
      ["p1r2", rational(50n, 3n)],
      ["p2r1", rational(40n, 3n)],
    ]);
    const r = reconcileBottomUp(crossed, bottoms, "largest-remainder");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.quantized;
    expect(q.get("product-p1")).toBe(q.get("p1r1")! + q.get("p1r2")!);
    expect(q.get("region-r1")).toBe(q.get("p1r1")! + q.get("p2r1")!);
  });
});

describe("§16.15 overrides — the replaced forecast is retained and scored", () => {
  it("an override without the pre-override forecast is refused — the adjustment's cost must stay computable", () => {
    const r = recordOverride("o1", "human.steven", "customer churn known", undefined, [100n, 100n]);
    expect(!r.ok && r.refusal.kind).toBe("override_missing_pre_override");
  });
  it("scoredFva is null until actuals; scoring then compares pre vs post", () => {
    const r = recordOverride("o1", "human.steven", "customer churn known", [100n, 100n], [80n, 80n]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scoredFva).toBeNull();
    // Actuals 82, 78: pre errors |−18|+|−22| = 40; post |2|+|−2| = 4. Human helped.
    const scored = scoreOverride(r.value, [82n, 78n]);
    expect(scored.scoredFva).not.toBeNull();
    expect(rToDecimalString(scored.scoredFva!, 0)).toBe("18"); // (40−4)/2
  });
});
