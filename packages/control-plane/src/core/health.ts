// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  dependencyHealthSchema,
  engineReadinessSchema,
  errorBudgetSchema,
  trustStateSchema,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Whether an engine is alright.
//
// Two rules shape this file, and both exist because the failure they prevent is
// silent:
//
//   SILENCE IS NOT HEALTH. An engine the console has heard nothing from is
//   `unknown`, never `operational`. A dashboard that renders green because no
//   telemetry arrived is worse than no dashboard: it is actively reassuring
//   during the exact incident it was built for.
//
//   COLOUR IS NEVER THE ONLY SIGNAL. Every state carries a label and an icon
//   token as well as a colour, because roughly one in twelve men cannot
//   distinguish the amber warning from the green operational — and the person
//   on call at 3am is whoever is on call.
// ─────────────────────────────────────────────────────────────────────────────

export const engineStateSchema = z.enum([
  "operational",
  "busy",
  "warning",
  "degraded",
  "failed",
  "maintenance",
  /** Not in the brief, and not optional. See above. */
  "unknown",
]);
export type EngineState = z.infer<typeof engineStateSchema>;

/** How a state should read, sound and move. Presentation reads this, never a switch. */
export interface EngineStateDescriptor {
  readonly state: EngineState;
  /** The words on screen. Never omitted, never abbreviated to a dot. */
  readonly label: string;
  /** Icon name, resolved by the console. A second non-colour channel. */
  readonly icon: string;
  /** Ordering for "worst first" lists. Higher is more urgent. */
  readonly severity: number;
  /**
   * Idle animation speed, 0..1. Zero means the scene holds still.
   *
   * Failure slows to near-stillness rather than flashing. A frantic card is
   * how a dashboard makes an incident harder to read, and the operator needs
   * to think, not to be alarmed — the red marker already did the alarming.
   */
  readonly motion: number;
  /** True when the console should surface it without being asked. */
  readonly demandsAttention: boolean;
}

export const ENGINE_STATES: Readonly<Record<EngineState, EngineStateDescriptor>> = {
  operational: { state: "operational", label: "Operational", icon: "check-circle", severity: 0, motion: 0.35, demandsAttention: false },
  busy: { state: "busy", label: "High activity", icon: "activity", severity: 1, motion: 1, demandsAttention: false },
  maintenance: { state: "maintenance", label: "Maintenance", icon: "wrench", severity: 2, motion: 0, demandsAttention: false },
  unknown: { state: "unknown", label: "No telemetry", icon: "help-circle", severity: 3, motion: 0.1, demandsAttention: true },
  warning: { state: "warning", label: "Warning", icon: "alert-triangle", severity: 4, motion: 0.25, demandsAttention: true },
  degraded: { state: "degraded", label: "Degraded", icon: "alert-octagon", severity: 5, motion: 0.15, demandsAttention: true },
  failed: { state: "failed", label: "Failed", icon: "x-octagon", severity: 6, motion: 0.05, demandsAttention: true },
};

export function describeEngineState(state: EngineState): EngineStateDescriptor {
  return ENGINE_STATES[state] ?? ENGINE_STATES.unknown;
}

// ── What an engine reports ───────────────────────────────────────────────────

/**
 * An engine's own account of itself.
 *
 * Deliberately WITHOUT a state field. The engine reports facts; the console
 * decides what they mean. An engine that reports its own health has to agree
 * with every other engine about the thresholds, and it never does — one calls
 * a 4% failure rate degraded and another calls it Tuesday.
 */
export const engineHeartbeatSchema = z
  .object({
    engineId: z.string().min(1),
    /** Whatever the deployed package says it is. */
    version: z.string().min(1),
    /** When the engine produced this. Staleness is measured against it. */
    observedAt: z.string().min(1),
    startedAt: z.string().min(1).optional(),

    jobsProcessed: z.number().int().nonnegative().default(0),
    jobsFailed: z.number().int().nonnegative().default(0),
    /** Mean is fine for a card; the performance panel wants percentiles. */
    avgLatencyMs: z.number().nonnegative().optional(),
    p95LatencyMs: z.number().nonnegative().optional(),
    queueDepth: z.number().int().nonnegative().optional(),

    /** Open circuits, from the resilience runtime. Any open circuit is degradation. */
    openCircuits: z.array(z.string()).default([]),
    /** Set by an operator, not inferred. Maintenance is a decision. */
    maintenance: z.boolean().default(false),
    /** Free text the engine wants an operator to see. */
    message: z.string().optional(),

    // ── Added for the observability contract ─────────────────────────────
    //
    // Optional, so every existing reporter keeps working, and absent means
    // NOT REPORTED rather than healthy — `deriveEngineHealth` reads what is
    // present and says so, which is the same rule the rest of this system
    // applies to unknown.

    /**
     * Whether the process is alive, and separately whether it can take new
     * work. A draining engine is live and not ready, and one boolean forces
     * those into an answer that is wrong half the time.
     */
    readiness: engineReadinessSchema.optional(),
    /**
     * Per dependency, with latency. What an engine is waiting on.
     *
     * Optional rather than defaulted to `[]`, and the distinction is real: an
     * empty array asserts "this engine has no dependencies", which is a claim.
     * Absent says "not reported", which is the truth for every reporter written
     * before this field existed.
     */
    dependencies: z.array(dependencyHealthSchema).optional(),
    /** How full it is. 0..1 per resource. */
    saturation: z.record(z.string(), z.number().min(0).max(1)).optional(),
    errorBudget: errorBudgetSchema.optional(),
    /** Config and schema versions, which drift independently of the package. */
    configVersion: z.string().min(1).optional(),
    schemaVersion: z.string().min(1).optional(),
    /**
     * The engine's trust posture, as Sentinel last set it.
     *
     * Reported, never self-assessed: an engine deciding it is trusted is the
     * shape this whole architecture refuses. It is here so an operator reading
     * one heartbeat can see it, not so the engine can claim it.
     */
    trustPosture: trustStateSchema.optional(),
  })
  .strict();
export type EngineHeartbeat = z.infer<typeof engineHeartbeatSchema>;

/** Where the thresholds live, so they are one decision rather than nine. */
export interface HealthPolicy {
  /** Older than this and the engine is `unknown`. */
  staleAfterMs: number;
  /** Failure rate above this is `degraded`. */
  degradedFailureRate: number;
  /** Failure rate above this is `warning`. */
  warningFailureRate: number;
  /** Every job failing, with enough jobs to mean it, is `failed`. */
  failedFailureRate: number;
  /** Below this many jobs the rate is noise, not a signal. */
  minimumSampleSize: number;
  /** Queue depth above this is `busy`. */
  busyQueueDepth: number;
}

export const DEFAULT_HEALTH_POLICY: HealthPolicy = {
  staleAfterMs: 90_000,
  warningFailureRate: 0.01,
  degradedFailureRate: 0.05,
  failedFailureRate: 0.5,
  // Two failures out of two is a 100% failure rate and almost certainly means
  // the engine has barely been asked to do anything. Rates need a denominator
  // before they are worth colouring a dashboard with.
  minimumSampleSize: 20,
  busyQueueDepth: 50,
};

export interface EngineHealth {
  readonly engineId: string;
  readonly state: EngineState;
  readonly descriptor: EngineStateDescriptor;
  readonly version?: string;
  readonly failureRate: number;
  readonly heartbeat?: EngineHeartbeat;
  /** Why this state, in words an operator can act on. */
  readonly reason: string;
  readonly observedAt?: string;
  readonly staleMs?: number;
}

/**
 * Turns an engine's report into a state, with the reasoning attached.
 *
 * `reason` is not decoration. "Degraded" on its own sends someone digging
 * through logs to discover what the console already knew; "8.2% of 340 jobs
 * failed" starts them in the right place.
 *
 * Ordering matters and is deliberate: maintenance beats everything, because an
 * engine somebody deliberately took down should not page anyone. Staleness
 * beats the metrics, because metrics from an engine that stopped reporting
 * describe a moment that has passed.
 */
export function deriveEngineHealth(
  engineId: string,
  heartbeat: EngineHeartbeat | undefined,
  options: { now: number; policy?: HealthPolicy },
): EngineHealth {
  const policy = options.policy ?? DEFAULT_HEALTH_POLICY;

  if (!heartbeat) {
    return {
      engineId,
      state: "unknown",
      descriptor: describeEngineState("unknown"),
      failureRate: 0,
      reason: "The console has received no telemetry from this engine.",
    };
  }

  const total = heartbeat.jobsProcessed;
  const failureRate = total > 0 ? heartbeat.jobsFailed / total : 0;
  const observedMs = Date.parse(heartbeat.observedAt);
  const staleMs = Number.isNaN(observedMs) ? undefined : options.now - observedMs;

  const base = {
    engineId,
    version: heartbeat.version,
    failureRate,
    heartbeat,
    observedAt: heartbeat.observedAt,
    staleMs,
  };

  const settle = (state: EngineState, reason: string): EngineHealth => ({
    ...base,
    state,
    descriptor: describeEngineState(state),
    reason,
  });

  if (heartbeat.maintenance) {
    return settle("maintenance", heartbeat.message ?? "An operator placed this engine in maintenance.");
  }

  if (staleMs === undefined) {
    return settle("unknown", `The engine reported an unreadable timestamp (${heartbeat.observedAt}).`);
  }
  if (staleMs > policy.staleAfterMs) {
    return settle(
      "unknown",
      `Last heard from ${Math.round(staleMs / 1000)}s ago; anything over ${Math.round(policy.staleAfterMs / 1000)}s is treated as silence.`,
    );
  }

  const sampled = total >= policy.minimumSampleSize;

  if (sampled && failureRate >= policy.failedFailureRate) {
    return settle("failed", `${percent(failureRate)} of ${total} jobs failed.`);
  }
  if (heartbeat.openCircuits.length > 0) {
    // A tripped breaker is a dependency the engine has given up calling. That
    // is degradation whatever the failure rate says — the rate looks healthy
    // precisely because the engine stopped trying.
    return settle(
      "degraded",
      `Circuit open: ${heartbeat.openCircuits.join(", ")}. The engine has stopped calling a dependency.`,
    );
  }
  if (sampled && failureRate >= policy.degradedFailureRate) {
    return settle("degraded", `${percent(failureRate)} of ${total} jobs failed.`);
  }
  if (sampled && failureRate >= policy.warningFailureRate) {
    return settle("warning", `${percent(failureRate)} of ${total} jobs failed.`);
  }
  if (heartbeat.queueDepth !== undefined && heartbeat.queueDepth >= policy.busyQueueDepth) {
    return settle("busy", `${heartbeat.queueDepth} jobs queued.`);
  }

  return settle(
    "operational",
    total > 0 ? `${total} jobs, ${percent(failureRate)} failed.` : "Idle and reporting normally.",
  );
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;
}

/**
 * The one-line answer for the top of the dashboard.
 *
 * Reports the WORST state present, never an average. Averaging health is how
 * seven healthy engines hide one that is on fire, and the number that results
 * ("87% healthy") is one nobody can act on.
 */
export function summariseFleet(healths: readonly EngineHealth[]): {
  worst: EngineState;
  label: string;
  online: number;
  total: number;
  needingAttention: EngineHealth[];
} {
  const needingAttention = healths
    .filter((h) => h.descriptor.demandsAttention)
    .sort((a, b) => b.descriptor.severity - a.descriptor.severity);

  const worst = needingAttention[0]?.state ?? (healths.length > 0 ? "operational" : "unknown");
  const online = healths.filter(
    (h) => h.state !== "unknown" && h.state !== "failed",
  ).length;

  return {
    worst,
    label:
      needingAttention.length === 0 && healths.length > 0
        ? "All systems operational"
        : `${needingAttention.length} of ${healths.length} need attention`,
    online,
    total: healths.length,
    needingAttention,
  };
}
