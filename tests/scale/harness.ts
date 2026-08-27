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
): Promise<Array<{ size: number; totalMs: number; msPerItem: number; scalingFactor: number }>> {
  const rows: Array<{ size: number; totalMs: number; msPerItem: number; scalingFactor: number }> = [];
  let previous: { size: number; totalMs: number } | undefined;

  for (const size of sizes) {
    const started = performance.now();
    await operation(size);
    const totalMs = performance.now() - started;

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
