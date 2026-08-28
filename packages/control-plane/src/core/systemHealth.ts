// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineHealth } from "./health.js";

// ─────────────────────────────────────────────────────────────────────────────
// The single number at the top of the dashboard.
//
// A headline health score is genuinely useful — it is the thing somebody checks
// from across the room — but the obvious implementation is an average, and an
// average is exactly how seven healthy engines hide one that is on fire.
//
// So it is a MINIMUM, not a mean. The score cannot read 100% while any
// component is unhealthy, which keeps the panel honest without changing what it
// looks like: when everything is fine it says 100%, which is what a healthy
// system should show.
//
// And a component nobody measures is EXCLUDED and named, never assumed to be
// perfect. Scoring an unmeasured dimension as 100% is how a dashboard reports
// security posture it has never once checked.
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthComponent {
  readonly key: string;
  readonly label: string;
  /** 0..1. */
  readonly score: number;
  /** What the number came from, so a low score is actionable. */
  readonly detail: string;
}

export interface SystemHealthScore {
  /**
   * 0..1, the worst measured component.
   *
   * Null when nothing could be measured — which is not zero and not one. An
   * empty console has not proven the system healthy, and it has not proven it
   * broken either.
   */
  readonly overall: number | null;
  readonly components: readonly HealthComponent[];
  /**
   * Dimensions this build does not measure.
   *
   * Named in the UI rather than quietly omitted, because "we do not check this"
   * and "this is fine" look identical on a dashboard that only shows the
   * things it scored.
   */
  readonly unmeasured: readonly string[];
  /** Which component is dragging the score down. */
  readonly weakest?: HealthComponent;
}

export interface SystemHealthOptions {
  /** Latency at or below this scores full marks. */
  latencyBudgetMs?: number;
  /**
   * Scores this console cannot compute, supplied by the host.
   *
   * Security posture is the obvious one: nothing in this package can observe
   * it, so it is either handed in with a real number behind it or it is listed
   * as unmeasured.
   */
  supplied?: readonly HealthComponent[];
  /** Dimensions to name as unmeasured when no supplied score covers them. */
  expected?: readonly { key: string; label: string }[];
}

export const DEFAULT_EXPECTED_COMPONENTS = [
  { key: "security", label: "Security" },
] as const;

/**
 * Scores the fleet.
 *
 * Three things are computed here because the heartbeats support them:
 *
 *   AVAILABILITY — how many engines are actually reporting and not failed.
 *   RELIABILITY  — the aggregate success rate across everything they did.
 *   PERFORMANCE  — observed latency against a budget.
 *
 * Anything else is the host's to supply or the console's to admit it does not
 * know.
 */
export function computeSystemHealth(
  healths: readonly EngineHealth[],
  options: SystemHealthOptions = {},
): SystemHealthScore {
  const latencyBudgetMs = options.latencyBudgetMs ?? 2_000;
  const components: HealthComponent[] = [];

  if (healths.length > 0) {
    const counted = healths.length;
    const up = healths.filter((h) => h.state !== "failed" && h.state !== "unknown").length;
    components.push({
      key: "availability",
      label: "Availability",
      score: up / counted,
      detail: `${up} of ${counted} reporting and serving.`,
    });

    let processed = 0;
    let failed = 0;
    for (const health of healths) {
      processed += health.heartbeat?.jobsProcessed ?? 0;
      failed += health.heartbeat?.jobsFailed ?? 0;
    }
    if (processed > 0) {
      components.push({
        key: "reliability",
        label: "Reliability",
        score: 1 - failed / processed,
        detail: `${failed.toLocaleString()} of ${processed.toLocaleString()} jobs failed.`,
      });
    }

    const latencies = healths
      .map((h) => h.heartbeat?.p95LatencyMs ?? h.heartbeat?.avgLatencyMs)
      .filter((value): value is number => typeof value === "number");
    if (latencies.length > 0) {
      // The slowest engine sets it, for the same reason the overall score is a
      // minimum: an average latency across nine engines is a number that stays
      // reassuring while one of them times out.
      const worst = Math.max(...latencies);
      components.push({
        key: "performance",
        label: "Performance",
        score: Math.max(0, Math.min(1, 1 - Math.max(0, worst - latencyBudgetMs) / latencyBudgetMs)),
        detail: `Slowest engine at ${Math.round(worst)}ms against a ${latencyBudgetMs}ms budget.`,
      });
    }
  }

  for (const supplied of options.supplied ?? []) {
    components.push({ ...supplied, score: Math.max(0, Math.min(1, supplied.score)) });
  }

  const expected = options.expected ?? DEFAULT_EXPECTED_COMPONENTS;
  const present = new Set(components.map((c) => c.key));
  const unmeasured = expected.filter((e) => !present.has(e.key)).map((e) => e.label);

  if (components.length === 0) {
    return { overall: null, components, unmeasured };
  }

  const weakest = components.reduce((worst, candidate) =>
    candidate.score < worst.score ? candidate : worst,
  );

  return { overall: weakest.score, components, unmeasured, weakest };
}

/** Renders a 0..1 score the way the panel shows it. */
export function formatScore(score: number | null): string {
  if (score === null) return "—";
  // Rounded down, never up. A 99.6% that displays as 100% is a dashboard
  // reporting perfection it does not have, and the gap it hides is the one
  // somebody is looking for.
  return `${Math.floor(score * 1000) / 10}%`;
}
