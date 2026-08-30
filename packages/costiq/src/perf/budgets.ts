/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/perf/budgets.ts
 * Module:   cost-iq-engine / perf
 * Purpose:  Catching the algorithmic regression, not the noisy stopwatch.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ABSOLUTE TIMINGS ARE NOISE. GROWTH IS SIGNAL.
//
// A benchmark that fails when a build agent is busy gets muted within a month,
// and a muted benchmark is worse than none — it is a check everybody believes
// is running. So this module treats the two questions separately:
//
//   BUDGETS are absolute, and set an order of magnitude or more above the
//   measured figure. They exist to catch something catastrophic — an accidental
//   O(n²), a synchronous retry loop — not to police a 15% drift. A budget tight
//   enough to catch 15% is a budget that fails on a noisy machine, and each one
//   here records what was actually measured so the headroom is visible rather
//   than implied.
//
//   SCALING is a ratio, and it is the sensitive check. Doubling the input and
//   measuring how much longer it takes is stable across wildly different
//   hardware, because the noise divides out. A linear algorithm stays near 2×
//   whether the machine is fast or slow; a quadratic one goes to 4× on both.
//
// THIS IS NOT HYPOTHETICAL
//
// The graph rollup in this package took 16.4 seconds on 100,000 nodes because
// it used `Array.shift` on the work queue, which is O(n) per call. Every test
// passed. Every result was correct. The fix — a read cursor instead of shift —
// took it to 0.24 seconds, a factor of 68.
//
// An absolute budget would not have caught it: 16.4s on a graph nobody had
// built yet looked like "large graphs are slow", which is what everybody
// expects. A scaling check would have caught it immediately, because the
// exponent was 2 and it was supposed to be 1.
// ─────────────────────────────────────────────────────────────────────────────

export interface PerformanceBudget {
  readonly operation: string;
  /** The input size the budget is stated at. */
  readonly atSize: number;
  /** Milliseconds. Generous by design — see the header. */
  readonly budgetMs: number;
  /** What was actually measured when the budget was set, and on what. */
  readonly measuredMs: number;
  readonly measuredOn: string;
  /** How the work is expected to grow with input size. */
  readonly expectedGrowth: "CONSTANT" | "LOGARITHMIC" | "LINEAR" | "LINEARITHMIC";
  readonly note: string;
}

/**
 * The declared budgets.
 *
 * `measuredMs` is recorded next to `budgetMs` so the headroom is visible. A
 * budget with no record of what it was set against is a number somebody
 * invented, and the next person cannot tell whether 500ms is generous or
 * already tight.
 */
export const PERFORMANCE_BUDGETS: readonly PerformanceBudget[] = Object.freeze([
  {
    operation: "costGraph.rollup",
    atSize: 100_000,
    budgetMs: 3_000,
    measuredMs: 97,
    measuredOn: "Windows 11, development machine, single-threaded, Node 22",
    expectedGrowth: "LINEAR",
    note: "Was 16,400ms with `Array.shift` on the work queue; a read cursor took the whole build-and-roll to 240ms and the rollup alone to 97ms. The scaling check is what would have caught that, not this budget.",
  },
  {
    operation: "costGraph.cycleDetection",
    atSize: 100_000,
    budgetMs: 3_000,
    measuredMs: 89,
    measuredOn: "Windows 11, development machine, single-threaded, Node 22",
    expectedGrowth: "LINEAR",
    note: "Measured as part of buildCostGraph, which is where cycle detection runs. Iterative depth-first traversal; depth is bounded by the resource limits rather than by the stack.",
  },
  {
    operation: "decimal.allocate",
    atSize: 10_000,
    budgetMs: 1_000,
    measuredMs: 33,
    measuredOn: "Windows 11, development machine, single-threaded, Node 22",
    expectedGrowth: "LINEARITHMIC",
    note: "Largest-remainder allocation sorts the remainders, so n log n is expected rather than linear.",
  },
  {
    operation: "modelHealth.assess",
    atSize: 10_000,
    budgetMs: 1_000,
    measuredMs: 4,
    measuredOn: "Windows 11, development machine, single-threaded, Node 22",
    expectedGrowth: "LINEARITHMIC",
    note: "One pass over components, then a sort of the findings. 4ms against a 1,000ms budget is far more headroom than the others; the budget is set where a structural regression would land rather than where this measurement sits.",
  },
]);

export function budgetFor(operation: string): PerformanceBudget {
  const found = PERFORMANCE_BUDGETS.find((b) => b.operation === operation);
  if (found === undefined) {
    throw new Error(
      `No performance budget is declared for "${operation}". An operation with no budget is one nobody notices going quadratic — declare it in PERFORMANCE_BUDGETS, with the figure you measured and the machine you measured it on.`,
    );
  }
  return found;
}

/**
 * The growth exponent implied by two measurements.
 *
 *     time ∝ size^k   ⟹   k = log(t₂/t₁) / log(s₂/s₁)
 *
 * Linear work gives k ≈ 1, quadratic k ≈ 2. Returns null when a measurement is
 * too small to divide by — a 0ms baseline produces an infinite or undefined
 * exponent, and reporting one would be reporting noise as a finding.
 */
export function growthExponent(
  small: { readonly size: number; readonly ms: number },
  large: { readonly size: number; readonly ms: number },
): number | null {
  if (small.ms <= 0 || large.ms <= 0) return null;
  if (small.size <= 0 || large.size <= small.size) return null;
  return Math.log(large.ms / small.ms) / Math.log(large.size / small.size);
}

/** The exponent each growth class is allowed to reach before it is a finding. */
export const GROWTH_CEILING: Readonly<Record<PerformanceBudget["expectedGrowth"], number>> = Object.freeze({
  CONSTANT: 0.5,
  LOGARITHMIC: 0.5,
  LINEAR: 1.5,
  // n log n at these sizes measures around 1.1; 1.5 leaves room for noise while
  // staying well clear of quadratic, which is the thing worth catching.
  LINEARITHMIC: 1.5,
});

export type ScalingVerdict =
  | { readonly acceptable: true; readonly exponent: number | null; readonly note: string }
  | { readonly acceptable: false; readonly exponent: number; readonly note: string };

/**
 * Whether measured growth matches what was declared.
 *
 * An unmeasurable result (everything ran in under a millisecond) is ACCEPTABLE
 * rather than a failure. The alternative is a check that fails on fast hardware,
 * which is the fastest possible way to get a benchmark muted.
 */
export function assessScaling(
  budget: PerformanceBudget,
  small: { readonly size: number; readonly ms: number },
  large: { readonly size: number; readonly ms: number },
): ScalingVerdict {
  const exponent = growthExponent(small, large);
  if (exponent === null) {
    return {
      acceptable: true,
      exponent: null,
      note: `"${budget.operation}" ran too fast at these sizes to measure growth. That is not a failure — a check that fails on fast hardware gets muted, and a muted check is worse than none.`,
    };
  }

  const ceiling = GROWTH_CEILING[budget.expectedGrowth];
  if (exponent > ceiling) {
    return {
      acceptable: false,
      exponent,
      note: `"${budget.operation}" is declared ${budget.expectedGrowth} but measured an exponent of ${exponent.toFixed(
        2,
      )} between ${small.size} and ${large.size} items (${small.ms}ms → ${large.ms}ms), over the ceiling of ${ceiling}. An exponent near 2 means the work is quadratic in the input — usually an O(n) operation inside an O(n) loop, such as \`Array.shift\`, \`indexOf\`, or a lookup that should be a Map.`,
    };
  }

  return {
    acceptable: true,
    exponent,
    note: `"${budget.operation}" measured an exponent of ${exponent.toFixed(2)}, within the ${ceiling} ceiling for ${budget.expectedGrowth}.`,
  };
}

export type BudgetVerdict =
  | { readonly withinBudget: true; readonly headroomFactor: number; readonly note: string }
  | { readonly withinBudget: false; readonly overBy: number; readonly note: string };

/** Whether a measurement fits the declared absolute budget. */
export function assessBudget(budget: PerformanceBudget, measuredMs: number): BudgetVerdict {
  if (measuredMs > budget.budgetMs) {
    return {
      withinBudget: false,
      overBy: measuredMs - budget.budgetMs,
      note: `"${budget.operation}" took ${measuredMs}ms at ${budget.atSize} items, over its ${budget.budgetMs}ms budget by ${
        measuredMs - budget.budgetMs
      }ms. The budget was set with generous headroom over the ${budget.measuredMs}ms originally measured on ${budget.measuredOn}, so exceeding it means something structural changed rather than the machine being busy.`,
    };
  }
  return {
    withinBudget: true,
    headroomFactor: measuredMs <= 0 ? Number.POSITIVE_INFINITY : budget.budgetMs / measuredMs,
    note: `"${budget.operation}" took ${measuredMs}ms against a ${budget.budgetMs}ms budget.`,
  };
}

/**
 * A benchmark result, in a shape a host can store and compare over time (R11).
 *
 * Records the hardware, because a figure with no machine attached cannot be
 * compared with anything. Two runs on different agents that differ by 40% have
 * told you about the agents, not about the code.
 */
export interface BenchmarkRecord {
  readonly operation: string;
  readonly size: number;
  readonly ms: number;
  readonly measuredOn: string;
  readonly at: string;
  readonly commit: string | null;
}

export type TrendVerdict = {
  readonly comparable: boolean;
  readonly changeFactor: number | null;
  readonly note: string;
};

/**
 * Compares a new benchmark with a stored one.
 *
 * Refuses to compare across different hardware or different input sizes rather
 * than producing a number that looks meaningful. A regression report that is
 * really a hardware difference costs somebody a day, and after it happens twice
 * nobody reads the report.
 */
export function compareBenchmarks(baseline: BenchmarkRecord, current: BenchmarkRecord): TrendVerdict {
  if (baseline.operation !== current.operation) {
    return { comparable: false, changeFactor: null, note: "Different operations. There is nothing to compare." };
  }
  if (baseline.size !== current.size) {
    return {
      comparable: false,
      changeFactor: null,
      note: `Measured at different sizes (${baseline.size} vs ${current.size}). Compare like with like, or compute a growth exponent instead.`,
    };
  }
  if (baseline.measuredOn !== current.measuredOn) {
    return {
      comparable: false,
      changeFactor: null,
      note: `Measured on different hardware ("${baseline.measuredOn}" vs "${current.measuredOn}"). Any difference here is about the machines, and reporting it as a regression is how benchmark reports stop being read.`,
    };
  }
  if (baseline.ms <= 0) {
    return {
      comparable: false,
      changeFactor: null,
      note: "The baseline was too fast to measure, so there is no ratio to take.",
    };
  }

  const factor = current.ms / baseline.ms;
  return {
    comparable: true,
    changeFactor: factor,
    note:
      factor > 1.5
        ? `${factor.toFixed(2)}× slower than the baseline (${baseline.ms}ms → ${current.ms}ms). Worth looking at.`
        : factor < 0.67
          ? `${(1 / factor).toFixed(2)}× faster than the baseline (${baseline.ms}ms → ${current.ms}ms).`
          : `Within noise of the baseline (${baseline.ms}ms → ${current.ms}ms).`,
  };
}
