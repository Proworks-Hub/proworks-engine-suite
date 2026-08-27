// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — Tracking projection rules (pure)
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7.
 *
 * Contains deterministic, side-effect-free helpers that derive the
 * `WorkOrderProjection` fields from a `TrackedStep[]`. The use case
 * (`advanceMilestoneUseCase.ts`) orchestrates these and decides which
 * events to emit; this file just computes numbers and labels.
 *
 * Everything here is framework-agnostic and trivially unit-testable.
 */

import type {
  EtaRiskReason,
  Milestone,
  TrackedStep,
} from "./trackingTypes.js";
import {
  MILESTONE_ORDER,
  OVERDUE_RATIO,
  PACE_SLIPPAGE_RATIO,
} from "./trackingTypes.js";

const MS_PER_MINUTE = 60_000;
const QC_CLASS = "quality_check";

// ---------- Milestone derivation ----------

/**
 * Map aggregate step state + "have we routed yet" onto the canonical
 * milestone progression. See `Milestone` docs in trackingTypes.ts for the
 * rule set. Pure; no I/O.
 */
export function deriveMilestone(
  trackedSteps: ReadonlyArray<TrackedStep>,
  hasRoutingEvent: boolean
): Milestone {
  // No steps (or not yet routed) → still in intake.
  if (trackedSteps.length === 0 || !hasRoutingEvent) {
    return "intake";
  }

  const required = trackedSteps.filter((s) => !s.optional);
  const anyStartedOrBeyond = trackedSteps.some((s) =>
    isStartedOrBeyond(s.state)
  );

  // "completed" — every step (required + optional) is in completed state.
  if (trackedSteps.every((s) => s.state === "completed")) {
    return "completed";
  }

  const requiredAllCompleted =
    required.length > 0 && required.every((s) => s.state === "completed");

  // "ready_for_pickup" — all required done; only optional steps may remain.
  if (requiredAllCompleted) {
    return "ready_for_pickup";
  }

  // "quality_check" — all non-QC required steps done, but there's an active
  // QC step still working itself out.
  const qcRequired = required.filter((s) => s.workstationClass === QC_CLASS);
  const nonQcRequired = required.filter(
    (s) => s.workstationClass !== QC_CLASS
  );
  if (qcRequired.length > 0) {
    const nonQcDone =
      nonQcRequired.length === 0 ||
      nonQcRequired.every((s) => s.state === "completed");
    if (nonQcDone && qcRequired.some((s) => s.state !== "completed")) {
      return "quality_check";
    }
  }

  // "in_production" — someone has physically picked up the first step.
  if (anyStartedOrBeyond) {
    return "in_production";
  }

  // Routed, nothing has started yet.
  return "routed";
}

function isStartedOrBeyond(state: TrackedStep["state"]): boolean {
  return (
    state === "in_progress" ||
    state === "paused" ||
    state === "blocked" ||
    state === "completed"
  );
}

// ---------- Progress (counts + percent) ----------

export interface ProgressSnapshot {
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly percentComplete: number;
}

/**
 * Counts + percent complete over REQUIRED (non-optional) steps. Optional
 * steps don't count toward the customer-visible completion percentage —
 * they might not be run at all for a given order, and including them
 * would make the percent jitter based on upsell decisions.
 */
export function computeProgress(
  trackedSteps: ReadonlyArray<TrackedStep>
): ProgressSnapshot {
  const required = trackedSteps.filter((s) => !s.optional);
  const total = required.length;
  const completed = required.filter((s) => s.state === "completed").length;
  const percent =
    total === 0 ? 0 : Math.round((completed / total) * 100);
  return {
    completedStepCount: completed,
    totalStepCount: total,
    percentComplete: percent,
  };
}

// ---------- ETA estimation ----------

export interface EtaEstimate {
  /** Absent when no ETA can be computed. */
  readonly eta?: Date;
  /** True when any remaining required step is missing `estimatedDurationMinutes`. */
  readonly tentative: boolean;
}

/**
 * Sum remaining duration across non-completed, non-optional steps; add to
 * `now` to get an ETA. If any remaining required step lacks an estimate,
 * the ETA is marked `tentative` (but is still returned using whatever
 * estimates ARE available — a lower bound is more useful than nothing).
 *
 * If there are no non-completed required steps, the ETA is `now` (the WO
 * is effectively already done pending the caller writing that state).
 */
export function estimateCompletionAt(
  trackedSteps: ReadonlyArray<TrackedStep>,
  now: Date
): EtaEstimate {
  // Nothing to schedule at all — don't invent an ETA. This is the
  // "brand-new work order, not routed yet" case. Announcing an ETA of
  // `now` here would trip the use case's "eta appeared" edge and emit
  // a spurious `eta.updated` event on a WO that hasn't even been routed.
  if (trackedSteps.length === 0) {
    return { tentative: false };
  }

  const remainingRequired = trackedSteps.filter(
    (s) => !s.optional && s.state !== "completed"
  );
  if (remainingRequired.length === 0) {
    return { eta: now, tentative: false };
  }

  let totalRemainingMinutes = 0;
  let tentative = false;
  let anyEstimated = false;

  for (const step of remainingRequired) {
    if (step.estimatedDurationMinutes === undefined) {
      tentative = true;
      continue;
    }
    anyEstimated = true;
    const remaining = Math.max(
      0,
      step.estimatedDurationMinutes - step.accumulatedActiveMinutes
    );
    totalRemainingMinutes += remaining;
  }

  if (!anyEstimated) {
    // We have remaining work but zero estimates — can't produce any ETA.
    return { tentative: true };
  }

  const eta = new Date(now.getTime() + totalRemainingMinutes * MS_PER_MINUTE);
  return { eta, tentative };
}

// ---------- Risk assessment ----------

export interface RiskAssessment {
  readonly atRisk: boolean;
  readonly reason?: EtaRiskReason;
  readonly minutesOverBaseline: number;
}

/**
 * Decide whether the ETA is at risk. First match wins (cheapest/most
 * actionable reason surfaces first).
 *
 * Ordering rationale:
 *   1. `dependency_blocked` — categorical; nothing else matters while a
 *      step is stuck.
 *   2. `overdue_step` — a specific step is running way long; surface THAT
 *      step's overage so supervisors can intervene on the offender.
 *   3. `pace_below_estimate` — aggregate slippage across all started work;
 *      catches diffuse slowness that doesn't trip any single-step threshold.
 */
export function assessEtaRisk(
  trackedSteps: ReadonlyArray<TrackedStep>
): RiskAssessment {
  // 1. Any blocked step → categorical risk.
  if (trackedSteps.some((s) => s.state === "blocked")) {
    return {
      atRisk: true,
      reason: "dependency_blocked",
      minutesOverBaseline: 0,
    };
  }

  // 2. Per-step overage > OVERDUE_RATIO for in-progress / paused steps.
  for (const step of trackedSteps) {
    if (step.estimatedDurationMinutes === undefined) continue;
    if (step.state !== "in_progress" && step.state !== "paused") continue;
    const threshold = step.estimatedDurationMinutes * OVERDUE_RATIO;
    if (step.accumulatedActiveMinutes > threshold) {
      const over = step.accumulatedActiveMinutes - step.estimatedDurationMinutes;
      return {
        atRisk: true,
        reason: "overdue_step",
        minutesOverBaseline: Math.round(over),
      };
    }
  }

  // 3. Aggregate pace across all steps that have been worked on
  //    (in_progress, paused, completed). `pending` / `ready` steps have no
  //    actual minutes accrued yet, so including them would smear the ratio.
  let actualSum = 0;
  let estimatedSum = 0;
  for (const step of trackedSteps) {
    if (step.estimatedDurationMinutes === undefined) continue;
    if (!isStartedOrBeyond(step.state)) continue;
    actualSum += step.accumulatedActiveMinutes;
    estimatedSum += step.estimatedDurationMinutes;
  }
  if (estimatedSum > 0 && actualSum > estimatedSum * PACE_SLIPPAGE_RATIO) {
    return {
      atRisk: true,
      reason: "pace_below_estimate",
      minutesOverBaseline: Math.round(actualSum - estimatedSum),
    };
  }

  return { atRisk: false, minutesOverBaseline: 0 };
}

// ---------- Milestone ordering helpers ----------

/** Index into MILESTONE_ORDER; -1 only on a bogus / unrecognized milestone. */
export function milestoneIndex(milestone: Milestone): number {
  return MILESTONE_ORDER.indexOf(milestone);
}

export function isForwardTransition(
  prev: Milestone,
  next: Milestone
): boolean {
  return milestoneIndex(next) > milestoneIndex(prev);
}
