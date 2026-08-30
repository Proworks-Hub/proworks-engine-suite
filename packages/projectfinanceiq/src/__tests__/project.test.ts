// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  costPerformanceIndex,
  detectCircularity,
  estimateAtCompletion,
  reviseBaseline,
  schedulePerformanceIndex,
  type EvInputs,
} from "../kernel.js";

// The K-2 golden: BAC 1,000,000; EV 400,000; AC 500,000; PV 500,000.
// CPI = 0.8, SPI = 0.8.
const GOLDEN: EvInputs = {
  bacMinor: 100_000_000n,
  evMinor: 40_000_000n,
  acMinor: 50_000_000n,
  pvMinor: 50_000_000n,
};

describe("K-2 — three defensible EAC formulas, 33.75% of BAC apart", () => {
  it("refuses without a named formula", () => {
    const outcome = estimateAtCompletion(GOLDEN, undefined);
    expect(!outcome.ok && outcome.refusal.kind).toBe("EAC_FORMULA_UNSELECTED");
  });
  it("the three formulas produce the K-2 spread on the golden case", () => {
    const typical = estimateAtCompletion(GOLDEN, "ac-plus-remaining");
    const cpi = estimateAtCompletion(GOLDEN, "bac-over-cpi");
    const combined = estimateAtCompletion(GOLDEN, "combined-cpi-spi");
    expect(typical.ok && typical.value.eacMinor).toBe(110_000_000n); // 1,100,000
    expect(cpi.ok && cpi.value.eacMinor).toBe(125_000_000n); // 1,250,000
    expect(combined.ok && combined.value.eacMinor).toBe(143_750_000n); // 1,437,500
    // Every result names the formula that produced it.
    expect(typical.ok && typical.value.methodRef.methodId).toBe("EAC-AC-PLUS-REMAINING");
  });
});

describe("defined-ness traps — undefined is a state, not a number", () => {
  it("CPI with zero AC and SPI with zero PV are UNDEFINED, not infinity and not zero", () => {
    const noCost = costPerformanceIndex({ ...GOLDEN, acMinor: 0n });
    expect(noCost.state).toBe("undefined");
    const noPlan = schedulePerformanceIndex({ ...GOLDEN, pvMinor: 0n });
    expect(noPlan.state).toBe("undefined");
    const eac = estimateAtCompletion({ ...GOLDEN, acMinor: 0n }, "bac-over-cpi");
    expect(!eac.ok && eac.refusal.kind).toBe("MEASURE_UNDEFINED");
  });
});

describe("method circularity — the degenerate pairing is refused, not warned", () => {
  it("cost-incurred progress with a CPI-based EAC can never signal an overrun", () => {
    const circular = detectCircularity("cost-incurred", "bac-over-cpi");
    expect(!circular.ok && circular.refusal.kind).toBe("METHOD_CIRCULARITY");
    const independent = detectCircularity("physical-output", "bac-over-cpi");
    expect(independent.ok).toBe(true);
    const typicalOk = detectCircularity("cost-incurred", "ac-plus-remaining");
    expect(typicalOk.ok).toBe(true);
  });
});

describe("baselines — immutable versions, never rewrites", () => {
  it("revisions append with authorization and supersede pointers", () => {
    const initial = reviseBaseline([], { bacMinor: 100_000_000n });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const unauthorized = reviseBaseline(initial.value, { bacMinor: 120_000_000n });
    expect(!unauthorized.ok && unauthorized.refusal.kind).toBe("BASELINE_IMMUTABLE");
    const revised = reviseBaseline(initial.value, { bacMinor: 120_000_000n, authorizationRef: "gov-1" });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value).toHaveLength(2);
    expect(revised.value[1]?.supersedes).toBe(1);
    // The prior baseline is still exactly what it was.
    expect(revised.value[0]?.bacMinor).toBe(100_000_000n);
  });
});
