// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { createInMemoryMetrics, type InMemoryMetrics } from "@proworks-hub/platform-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// A harness for finding out where the time goes.
//
// The directive asks for the ABILITY to simulate load, explicitly without
// promising any particular number. That distinction is the honest one and this
// file keeps to it: nothing here claims the platform supports ten thousand
// users. It measures what the engines actually do, so a bottleneck is found by
// looking rather than by guessing.
//
// What this measures is the ENGINES — pure functions over in-memory state. It
// does not measure a database, a network, or a browser, because none of those
// are in the suite. That makes it good at finding algorithmic problems, which
// are the ones that get baked in early and are expensive to remove later, and
// useless for capacity planning. Both halves of that are worth knowing.
// ─────────────────────────────────────────────────────────────────────────────

export interface ScaleResult {
  label: string;
  operations: number;
  totalMs: number;
  opsPerSecond: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Anything the run reported as gone wrong. */
  errors: number;
}

export interface ScaleRunOptions {
  label: string;
  operations: number;
  /** Runs before timing starts, so warm-up cost is not attributed to the run. */
  warmup?: number;
  /**
   * Called once after warm-up, before timing.
   *
   * Warm-up executes the REAL operation, so it mutates whatever that operation
   * touches — counters, logs, queues. A caller that then asserts on that state
   * gets warm-up's contribution folded in and a confusing off-by-N. This is
   * where to reset it.
   */
  afterWarmup?: () => void;
  /** Overridable so a test can be deterministic. */
  now?: () => number;
  metrics?: InMemoryMetrics;
}

const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
};

/**
 * Runs one operation N times and reports the distribution.
 *
 * Percentiles rather than an average, for the reason that keeps mattering: an
 * average hides the one call that took two seconds, and that call is the
 * complaint. p99 is where a system's real behaviour lives.
 */
export async function measure(
  operation: (iteration: number) => Promise<void> | void,
  options: ScaleRunOptions,
): Promise<ScaleResult> {
  const now = options.now ?? (() => performance.now());
  const durations: number[] = [];
  let errors = 0;

  for (let i = 0; i < (options.warmup ?? 0); i += 1) {
    try {
      await operation(-1 - i);
    } catch {
      // Warm-up failures are not counted; the run below reports real ones.
    }
  }

  options.afterWarmup?.();

  const startedAt = now();
  for (let i = 0; i < options.operations; i += 1) {
    const opStart = now();
    try {
      await operation(i);
    } catch {
      errors += 1;
    }
    const elapsed = now() - opStart;
    durations.push(elapsed);
    options.metrics?.observe("scale.operation_ms", elapsed, { run: options.label });
  }
  const totalMs = now() - startedAt;

  const sorted = [...durations].sort((a, b) => a - b);
  return {
    label: options.label,
    operations: options.operations,
    totalMs,
    opsPerSecond: totalMs > 0 ? (options.operations / totalMs) * 1000 : 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    errors,
  };
}

/**
 * Runs the same operation at several sizes and reports how cost scales.
 *
 * This is the question that actually matters early. Absolute throughput on one
 * laptop tells you almost nothing; whether doubling the input doubles the time
 * or quadruples it tells you whether the design survives growth.
 */
export async function scalingProfile(
  operation: (size: number) => Promise<void> | void,
  sizes: readonly number[],
  label: string,
  options: { repetitions?: number } = {},
): Promise<Array<{ size: number; totalMs: number; msPerItem: number; scalingFactor: number }>> {
  // ── Why the MINIMUM of several runs, not one run or an average ────────────
  //
  // A single sample per size made this flake: one GC pause or one scheduler
  // hiccup during the largest run inflates the ratio past the threshold, and
  // the suite reports a scaling regression that is really the machine being
  // busy. I saw ×3.06 against a 2.5 limit on a loaded machine and green on
  // every quiet run.
  //
  // The threshold is NOT the thing to relax — a previous fix here already made
  // that call correctly, choosing to measure more work rather than accept a
  // worse result. This keeps the threshold and fixes the measurement instead.
  //
  // The minimum is the right statistic. An algorithm's cost is a FLOOR: every
  // sample sits at or above it, and everything above is contamination. A mean
  // or a median carries that contamination into the number; the minimum is the
  // least-contended observation and therefore the closest estimate of what the
  // code actually costs.
  //
  // It does not weaken the assertion. A genuine O(n²) regression raises the
  // floor itself, so the minimum climbs with it and the ratio still catches it.
  const repetitions = Math.max(1, options.repetitions ?? 3);

  const rows: Array<{ size: number; totalMs: number; msPerItem: number; scalingFactor: number }> = [];
  let previous: { size: number; totalMs: number } | undefined;

  for (const size of sizes) {
    let totalMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < repetitions; attempt += 1) {
      const started = performance.now();
      await operation(size);
      totalMs = Math.min(totalMs, performance.now() - started);
    }

    // Cost per item against the previous size. Flat means linear; climbing
    // means something quadratic is hiding in there.
    const scalingFactor =
      previous && previous.totalMs > 0
        ? totalMs / previous.totalMs / (size / previous.size)
        : 1;

    rows.push({ size, totalMs, msPerItem: totalMs / size, scalingFactor });
    previous = { size, totalMs };
  }

  return rows;
}

/** Formats a result for a human reading CI output. */
export function formatResult(result: ScaleResult): string {
  return [
    `${result.label}: ${result.operations} ops in ${result.totalMs.toFixed(0)}ms`,
    `${result.opsPerSecond.toFixed(0)}/s`,
    `p50 ${result.p50Ms.toFixed(3)}ms`,
    `p95 ${result.p95Ms.toFixed(3)}ms`,
    `p99 ${result.p99Ms.toFixed(3)}ms`,
    result.errors > 0 ? `${result.errors} ERRORS` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A metrics collector wired for a scale run. */
export const scaleMetrics = (): InMemoryMetrics => createInMemoryMetrics();

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic complexity measurement.
//
// A wall-clock ratio answers "was this fast on this machine just now", which is
// not the question these tests are asking. They are asking "is the cost per
// item constant as N grows" — a property of the algorithm, not of the hardware,
// and one that can be measured exactly.
//
// So: count the WORK, not the time. Every engine here takes its storage as an
// injected port, which means a counting wrapper sees every read the engine
// performs. If a per-item operation were secretly O(n) in the store's size, it
// would have to read the store, and the count would climb. It cannot climb for
// any other reason — no GC pause, no scheduler, no other process on the box can
// change how many times a function was called.
//
// The result is a test that fails only when the complexity actually regresses.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkCount {
  readonly size: number;
  /**
   * Port operations performed while processing `size` items.
   *
   * Reads AND writes. Counting only reads was my first attempt and it measured
   * nothing: work-order creation appends and never reads, so the counter stayed
   * at zero and the assertion was vacuous. The quantity that actually reflects
   * the algorithm is total port traffic.
   */
  readonly operations: number;
  /** Operations per item. Flat means linear; climbing means super-linear. */
  readonly operationsPerItem: number;
}

/**
 * Counts port reads across growing input sizes.
 *
 * `run` is handed a counter it must increment once per port OPERATION — in
 * practice by wrapping the port it injects. Returning the count rather than
 * timing it is what makes this deterministic.
 */
export async function workCountProfile(
  run: (size: number, countOperation: () => void) => Promise<void> | void,
  sizes: readonly number[],
): Promise<WorkCount[]> {
  const rows: WorkCount[] = [];

  for (const size of sizes) {
    let operations = 0;
    await run(size, () => {
      operations += 1;
    });
    rows.push({ size, operations, operationsPerItem: operations / size });
  }

  return rows;
}

/**
 * Whether cost per item stayed flat.
 *
 * Compares the largest size's reads-per-item against the smallest. Linear work
 * gives a ratio of 1.0 exactly — not approximately, exactly, because these are
 * integer call counts. The tolerance exists only for algorithms with a genuine
 * constant-factor difference at small N, and is far tighter than any wall-clock
 * bound could be.
 */
export function costPerItemGrowth(rows: readonly WorkCount[]): number {
  if (rows.length < 2) {
    throw new Error(
      "costPerItemGrowth needs at least two sizes. One sample measures nothing about growth.",
    );
  }

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;

  // ── A ZERO BASELINE IS A BROKEN MEASUREMENT, NOT A PASS ───────────────────
  //
  // My first version returned 1 here, and the test using it counted zero
  // operations at every size and passed. It proved nothing at all — the exact
  // "unmeasured counts as satisfied" failure this codebase refuses everywhere
  // else, reintroduced inside the tool meant to catch regressions.
  //
  // Throwing is right: a counter that never incremented means the wrapper is
  // not on the path the code actually uses, and silently reporting healthy
  // growth from no data is worse than failing loudly.
  if (first.operationsPerItem === 0) {
    throw new Error(
      `The work counter recorded zero operations at size ${first.size}. ` +
        "Nothing was measured, so no growth can be computed — the counting wrapper is not on the path under test.",
    );
  }

  return last.operationsPerItem / first.operationsPerItem;
}
