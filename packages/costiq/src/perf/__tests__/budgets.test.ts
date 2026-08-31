/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { allocate, fromString, toString } from "../../domain/decimal.js";
import { buildCostGraph, rollup } from "../../core/costGraph.js";
import type { CostComponent } from "../../domain/costModel.js";
import { assessModelHealth, type HealthPolicy, type ModelComponentHealth } from "../../core/costModelHealth.js";
import {
  GROWTH_CEILING,
  PERFORMANCE_BUDGETS,
  assessBudget,
  assessScaling,
  budgetFor,
  compareBenchmarks,
  growthExponent,
  type BenchmarkRecord,
} from "../budgets.js";

// ─────────────────────────────────────────────────────────────────────────────
// Two kinds of check, doing two different jobs. The budget catches something
// catastrophic; the scaling exponent catches the accidental O(n²) that every
// test passes through with correct results.
// ─────────────────────────────────────────────────────────────────────────────

const timed = (work: () => void): number => {
  // `performance.now()` rather than `Date.now()`, and the difference is not
  // cosmetic here. `Date.now()` on Windows advances in steps of roughly 1-16ms,
  // so once this code got fast enough that the 25k rollup takes ~8ms, the
  // small measurement is only a handful of ticks and a single tick of error is
  // over 10%. The scaling check divides the two measurements, so that error
  // lands straight in the exponent -- which is how a 1.53 reading against a
  // 1.5 ceiling turned up on a machine doing nothing wrong.
  //
  // This is the fix that made the gate honest. Running the perf suite
  // sequentially removes CONTENTION; sub-millisecond resolution removes
  // QUANTISATION, and the 1.53 failure was the second one.
  const started = performance.now();
  work();
  return performance.now() - started;
};

/**
 * The fastest of several runs.
 *
 * Wall-clock under a parallel test suite measures this machine's contention as
 * much as this code. Contention only ever makes a run SLOWER -- nothing
 * schedules work faster than uncontended -- so the minimum is the sample least
 * contaminated by everything else running, and it is what a benchmark should
 * compare.
 *
 * This does not weaken the gate. A genuinely quadratic rollup is quadratic in
 * its best run too, so the exponent still lands near 2 and still fails. What
 * it removes is the failure mode where the suite goes red because another test
 * file happened to be busy, which is a gate nobody can act on and everybody
 * learns to re-run.
 */
const bestOf = (runs: number, work: () => void): number => {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i += 1) best = Math.min(best, timed(work));
  return best;
};

describe("growth exponent is the sensitive check, because noise divides out", () => {
  it("reads linear growth as an exponent near 1", () => {
    expect(growthExponent({ size: 1_000, ms: 10 }, { size: 2_000, ms: 20 })).toBeCloseTo(1, 5);
  });

  it("reads quadratic growth as an exponent near 2", () => {
    // The shape of the `Array.shift` defect this module exists for.
    expect(growthExponent({ size: 1_000, ms: 10 }, { size: 2_000, ms: 40 })).toBeCloseTo(2, 5);
  });

  it("is unchanged by a machine that is uniformly slower", () => {
    // The whole reason a ratio beats a stopwatch: multiply both measurements by
    // three and the exponent does not move.
    const fast = growthExponent({ size: 1_000, ms: 10 }, { size: 2_000, ms: 40 })!;
    const slow = growthExponent({ size: 1_000, ms: 30 }, { size: 2_000, ms: 120 })!;
    expect(slow).toBeCloseTo(fast, 10);
  });

  it("returns null rather than a number when a measurement is zero", () => {
    // log(0) is -Infinity. Reporting that as an exponent would be reporting
    // noise as a finding.
    expect(growthExponent({ size: 1_000, ms: 0 }, { size: 2_000, ms: 20 })).toBeNull();
    expect(growthExponent({ size: 1_000, ms: 10 }, { size: 2_000, ms: 0 })).toBeNull();
  });

  it("returns null when the sizes do not increase", () => {
    expect(growthExponent({ size: 2_000, ms: 10 }, { size: 2_000, ms: 20 })).toBeNull();
    expect(growthExponent({ size: 2_000, ms: 10 }, { size: 1_000, ms: 20 })).toBeNull();
  });
});

describe("scaling verdicts", () => {
  const linearBudget = budgetFor("costGraph.rollup");

  it("accepts linear growth on a linear operation", () => {
    const verdict = assessScaling(linearBudget, { size: 1_000, ms: 10 }, { size: 4_000, ms: 40 });
    expect(verdict.acceptable).toBe(true);
  });

  it("REJECTS quadratic growth on a linear operation", () => {
    const verdict = assessScaling(linearBudget, { size: 1_000, ms: 10 }, { size: 4_000, ms: 160 });
    expect(verdict.acceptable).toBe(false);
    if (!verdict.acceptable) {
      expect(verdict.exponent).toBeCloseTo(2, 5);
      expect(verdict.note).toContain("Array.shift");
    }
  });

  it("names the shape of the defect rather than just failing", () => {
    // "Too slow" sends somebody looking at the machine. "An O(n) operation
    // inside an O(n) loop" sends them to the loop.
    const verdict = assessScaling(linearBudget, { size: 1_000, ms: 10 }, { size: 4_000, ms: 160 });
    if (!verdict.acceptable) expect(verdict.note).toContain("O(n) operation inside an O(n) loop");
  });

  it("treats an unmeasurably fast run as acceptable, not as a failure", () => {
    // A check that fails on fast hardware is a check that gets muted, and a
    // muted check is worse than none.
    const verdict = assessScaling(linearBudget, { size: 1_000, ms: 0 }, { size: 4_000, ms: 0 });
    expect(verdict.acceptable).toBe(true);
    expect(verdict.note).toContain("gets muted");
  });

  it("holds a linearithmic operation to the same ceiling, which still excludes quadratic", () => {
    const nLogN = budgetFor("decimal.allocate");
    expect(GROWTH_CEILING[nLogN.expectedGrowth]).toBe(1.5);
    expect(assessScaling(nLogN, { size: 1_000, ms: 10 }, { size: 4_000, ms: 46 }).acceptable).toBe(true);
    expect(assessScaling(nLogN, { size: 1_000, ms: 10 }, { size: 4_000, ms: 160 }).acceptable).toBe(false);
  });
});

describe("absolute budgets exist to catch something catastrophic", () => {
  it("accepts a measurement inside the budget and reports the headroom", () => {
    const verdict = assessBudget(budgetFor("costGraph.rollup"), 300);
    expect(verdict.withinBudget).toBe(true);
    if (verdict.withinBudget) expect(verdict.headroomFactor).toBeCloseTo(10, 1);
  });

  it("rejects a measurement over the budget and says it is structural", () => {
    const verdict = assessBudget(budgetFor("costGraph.rollup"), 5_000);
    expect(verdict.withinBudget).toBe(false);
    if (!verdict.withinBudget) {
      expect(verdict.overBy).toBe(2_000);
      expect(verdict.note).toContain("rather than the machine being busy");
    }
  });

  it("treats the budget as inclusive at the boundary", () => {
    expect(assessBudget(budgetFor("costGraph.rollup"), 3_000).withinBudget).toBe(true);
    expect(assessBudget(budgetFor("costGraph.rollup"), 3_001).withinBudget).toBe(false);
  });

  it("records what was measured, and on what, next to every budget", () => {
    // A budget with no record of what it was set against is a number somebody
    // invented, and nobody can tell whether it is generous or already tight.
    for (const budget of PERFORMANCE_BUDGETS) {
      expect(budget.measuredMs).toBeGreaterThan(0);
      expect(budget.measuredOn.length).toBeGreaterThan(0);
      expect(budget.budgetMs).toBeGreaterThan(budget.measuredMs);
      expect(budget.note.length).toBeGreaterThan(0);
    }
  });

  it("refuses to guess a budget for an undeclared operation", () => {
    expect(() => budgetFor("costGraph.somethingNew")).toThrow(/nobody notices going quadratic/);
  });
});

describe("benchmarks are only compared with comparable benchmarks", () => {
  const record = (over: Partial<BenchmarkRecord> = {}): BenchmarkRecord => ({
    operation: "costGraph.rollup",
    size: 100_000,
    ms: 240,
    measuredOn: "agent-a",
    at: "2026-08-30T00:00:00.000Z",
    commit: null,
    ...over,
  });

  it("reports a real regression", () => {
    const verdict = compareBenchmarks(record(), record({ ms: 900 }));
    expect(verdict.comparable).toBe(true);
    expect(verdict.note).toContain("slower than the baseline");
  });

  it("reports an improvement", () => {
    expect(compareBenchmarks(record({ ms: 900 }), record({ ms: 240 })).note).toContain("faster");
  });

  it("calls a small difference noise rather than a finding", () => {
    expect(compareBenchmarks(record(), record({ ms: 260 })).note).toContain("Within noise");
  });

  it("REFUSES to compare across different hardware", () => {
    // A regression report that is really a hardware difference costs somebody a
    // day, and after it happens twice nobody reads the report.
    const verdict = compareBenchmarks(record(), record({ ms: 900, measuredOn: "agent-b" }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.note).toContain("about the machines");
  });

  it("REFUSES to compare across different sizes", () => {
    const verdict = compareBenchmarks(record(), record({ size: 50_000 }));
    expect(verdict.comparable).toBe(false);
    expect(verdict.note).toContain("growth exponent instead");
  });

  it("refuses to compare different operations", () => {
    expect(compareBenchmarks(record(), record({ operation: "decimal.allocate" })).comparable).toBe(false);
  });

  it("refuses to take a ratio against an unmeasurable baseline", () => {
    expect(compareBenchmarks(record({ ms: 0 }), record()).comparable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE REAL MEASUREMENTS
//
// These run the actual code at two sizes and check the growth. They are the
// point of the module; everything above is the machinery that makes their
// verdicts trustworthy.
// ─────────────────────────────────────────────────────────────────────────────

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

const wideGraph = (n: number): CostComponent[] => {
  const components: CostComponent[] = [component({ componentId: "root", amount: "0" })];
  for (let i = 0; i < n; i += 1) {
    components.push(component({ componentId: `n${i}`, amount: "0.01", parentId: "root" }));
  }
  return components;
};

const build = (components: readonly CostComponent[]) => {
  const result = buildCostGraph(components);
  if (!result.ok) throw new Error(`build failed: ${result.problems.map((p) => p.message).join("; ")}`);
  return result.graph;
};

const healthPolicy: HealthPolicy = {
  staleAfterDays: 90,
  veryStaleAfterDays: 365,
  minimumSourceStrength: 40,
  maximumUnpricedFraction: fromString("1"),
  minimumCoverageFraction: fromString("0"),
  scale: 4,
  mode: "HALF_EVEN",
};

describe("measured against the real code", () => {
  it("rolls up a 100,000-node graph inside its budget", () => {
    const components = wideGraph(100_000);
    const graph = build(components);
    const ms = timed(() => {
      const result = rollup(graph);
      expect(toString(result.total)).toBe("1000.00");
    });
    const verdict = assessBudget(budgetFor("costGraph.rollup"), ms);
    expect(verdict.withinBudget, verdict.note).toBe(true);
  }, 60_000);

  it("rolls up LINEARLY, which is what would have caught the shift defect", () => {
    // 16.4s → 0.24s came from replacing `Array.shift` with a read cursor. The
    // absolute budget looked fine before that fix — "large graphs are slow" is
    // what everybody expects. The exponent did not.
    const small = { size: 25_000, ms: 0 };
    const large = { size: 100_000, ms: 0 };
    const smallGraph = build(wideGraph(small.size));
    const largeGraph = build(wideGraph(large.size));
    // INTERLEAVED best-of-five, not two separate best-of-N passes.
    //
    // The exponent is a RATIO, so what corrupts it is not noise but noise that
    // hits one size harder than the other. Measuring all the small runs and
    // then all the large ones lets background load drift between the two
    // groups, and the larger workload is the one that suffers most under
    // memory pressure from parallel workers -- which inflates the ratio and
    // reads as a complexity regression that is not there.
    //
    // Alternating them means any drift lands on both, and taking the minimum
    // of each keeps the least-contended sample. A genuinely quadratic rollup
    // is still quadratic in its best interleaved run.
    let bestSmall = Number.POSITIVE_INFINITY;
    let bestLarge = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i += 1) {
      bestSmall = Math.min(bestSmall, timed(() => rollup(smallGraph)));
      bestLarge = Math.min(bestLarge, timed(() => rollup(largeGraph)));
    }
    small.ms = bestSmall;
    large.ms = bestLarge;

    const verdict = assessScaling(budgetFor("costGraph.rollup"), small, large);
    expect(verdict.acceptable, verdict.note).toBe(true);
  }, 120_000);

  it("allocates across 10,000 weights inside its budget", () => {
    const weights = Array.from({ length: 10_000 }, (_, i) => fromString(String((i % 7) + 1)));
    const ms = timed(() => {
      const parts = allocate(fromString("100000.00"), weights, 2, "HALF_EVEN");
      expect(parts).toHaveLength(10_000);
    });
    const verdict = assessBudget(budgetFor("decimal.allocate"), ms);
    expect(verdict.withinBudget, verdict.note).toBe(true);
  }, 60_000);

  it("assesses a 10,000-component model's health inside its budget", () => {
    const components: ModelComponentHealth[] = Array.from({ length: 10_000 }, (_, i) => ({
      ref: `c${i}`,
      label: `c${i}`,
      provenance: {
        sourceKind: "OBSERVED_TRANSACTION",
        sourceRef: `t${i}`,
        sourceSystem: "ReceiptIQ",
        observedAt: "2026-08-01T00:00:00.000Z",
        caveats: [],
        unitConverted: false,
      },
      coverageFraction: fromString("1"),
      valueShareFraction: fromString("0.0001"),
    }));
    const ms = timed(() => {
      const report = assessModelHealth(components, healthPolicy, new Date("2026-08-30T00:00:00.000Z"));
      expect(report.findings).toEqual([]);
    });
    const verdict = assessBudget(budgetFor("modelHealth.assess"), ms);
    expect(verdict.withinBudget, verdict.note).toBe(true);
  }, 60_000);
});
