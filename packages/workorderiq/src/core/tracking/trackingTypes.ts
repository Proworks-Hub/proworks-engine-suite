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
 * PRIME Engine — Tracking / Projection types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7.
 *
 * The Tracking module turns the raw step-state projection (from Task Flow
 * §3.5) into a higher-level, customer-facing view of "where is my order".
 *
 * Three concerns:
 *  1. **Milestones** — a small, ordered set of named phases a work order
 *     passes through. Derived from aggregate step state + whether routing
 *     has happened. Announced on the event log as `milestone.advanced`.
 *  2. **ETA** — an estimated completion timestamp built by summing the
 *     remaining estimated-duration minutes of non-completed, non-optional
 *     steps against the current wall clock. Announced as `eta.updated` when
 *     it drifts beyond a threshold.
 *  3. **Risk** — a flag raised when something is likely to push the ETA
 *     (a blocked dep, an overdue step, aggregate pace slippage). Announced
 *     as `eta.at_risk` on the false→true edge.
 *
 * All three are deterministic, pure projections over `TrackedStep[]`. The
 * use case decides which of the three events to emit by comparing the new
 * projection against the `previousProjection` the caller passes in.
 *
 * Phase 1 scope:
 *  - Milestone derivation uses state + `workstationClass === "quality_check"`
 *    as the only shape-sensitive input. No deeper per-industry customization.
 *  - ETA is a flat sum of remaining estimated minutes; no pace-adjusted
 *    forecasting. Pace-based risk detection exists (below) but it does NOT
 *    feed back into the ETA number itself — we announce risk separately so
 *    the customer-visible ETA stays stable during a single run.
 *  - Learning layer (§21) is OUT of scope here; it reads these events as
 *    training inputs but doesn't write anything in Phase 1.
 *
 * Learning hook (§21): milestone.advanced + eta.updated + eta.at_risk are
 * the three most useful signals for tuning ETA models. Keep payloads rich
 * enough that a learner can reconstruct ground-truth deltas from events alone.
 */

import type { WorkOrderId, WorkOrderStepId } from "../../models/events.js";
import type { StepState } from "../taskflow/taskFlowTypes.js";

// ---------- Milestones ----------

/**
 * The canonical milestone progression. Order matters: milestone.advanced
 * events are only emitted on FORWARD transitions.
 *
 * Mapping rules (see `deriveMilestone`):
 *   intake            — no routing yet
 *   routed            — routing done, no step started
 *   in_production     — at least one step started/paused/blocked/completed,
 *                       and non-QC required steps are NOT all completed
 *   quality_check     — all non-QC required steps completed, but at least
 *                       one QC step is still active (ready/in_progress/
 *                       paused/blocked)
 *   ready_for_pickup  — all REQUIRED steps (incl. QC) completed, some
 *                       optional steps may still remain
 *   completed         — all steps (incl. optional) completed
 */
export type Milestone =
  | "intake"
  | "routed"
  | "in_production"
  | "quality_check"
  | "ready_for_pickup"
  | "completed";

export const MILESTONE_ORDER: ReadonlyArray<Milestone> = Object.freeze([
  "intake",
  "routed",
  "in_production",
  "quality_check",
  "ready_for_pickup",
  "completed",
]);

// ---------- ETA ----------

/**
 * How trustworthy the ETA is.
 *   firm      — every remaining required step has an estimated duration,
 *               and nothing looks at-risk.
 *   tentative — at least one remaining required step is missing a duration
 *               estimate. The ETA is a lower bound at best.
 *   at_risk   — something on the floor is likely to push the ETA
 *               (see `EtaRiskReason`).
 */
export type EtaConfidence = "firm" | "tentative" | "at_risk";

/**
 * Why the ETA is at risk. Deterministic, computed from `TrackedStep[]`.
 *   dependency_blocked  — any step is in `blocked` state
 *   overdue_step        — any running step's accumulated active minutes
 *                         exceeds its estimate by >25%
 *   pace_below_estimate — aggregate accumulated-vs-estimated across all
 *                         started steps is >20% over
 */
export type EtaRiskReason =
  | "dependency_blocked"
  | "overdue_step"
  | "pace_below_estimate";

/** Drift in minutes at or above which we emit `eta.updated`. */
export const ETA_DRIFT_THRESHOLD_MINUTES = 5;

/** A step is "overdue" when accumulated > estimate * OVERDUE_RATIO. */
export const OVERDUE_RATIO = 1.25;

/** Aggregate pace slippage trigger. */
export const PACE_SLIPPAGE_RATIO = 1.2;

// ---------- Tracked step (input shape) ----------

/**
 * Minimal step view the tracking module needs. Callers assemble this from
 * the `StepSnapshot` (Task Flow §3.5) plus the routing/priority metadata
 * they already hold (estimatedDurationMinutes, optional, workstationClass).
 *
 * Keeping this decoupled from StepSnapshot means tracking doesn't become
 * a cross-module compile dependency; any caller that can produce this
 * shape (including replay-from-log projectors) can use it.
 */
export interface TrackedStep {
  readonly stepId: WorkOrderStepId;
  readonly state: StepState;
  readonly optional: boolean;
  readonly estimatedDurationMinutes?: number;
  readonly accumulatedActiveMinutes: number;
  readonly dependsOn: ReadonlyArray<WorkOrderStepId>;
  /**
   * Used only by milestone derivation to detect the QC phase. If absent,
   * the step is treated as non-QC.
   */
  readonly workstationClass?: string;
}

// ---------- Projection ----------

/**
 * A point-in-time snapshot of a work order's customer-visible status.
 *
 * Kept as a flat, Object-friendly record so it can be projected into UI
 * state, serialized for the customer portal, or written to a denormalized
 * query table without transformation.
 *
 * `estimatedCompletionAt` is omitted when the ETA can't be computed (no
 * remaining estimates, or no non-completed required steps).
 *
 * `etaRiskReason` is only present when `etaConfidence === "at_risk"`.
 */
export interface WorkOrderProjection {
  readonly workOrderId: WorkOrderId;
  readonly currentMilestone: Milestone;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  /** 0-100 integer, `Math.round((completed / total) * 100)`. 0 when no steps. */
  readonly percentComplete: number;
  readonly estimatedCompletionAt?: Date;
  readonly etaConfidence: EtaConfidence;
  readonly etaRiskReason?: EtaRiskReason;
  readonly lastUpdated: Date;
}

// ---------- Errors ----------

export type TrackingErrorCode =
  /** workOrderId mismatch between previousProjection and input. */
  | "work_order_mismatch"
  /** Required field missing or malformed on input. */
  | "invalid_command";

export interface TrackingError {
  readonly code: TrackingErrorCode;
  readonly message: string;
}

// ---------- Event payloads (§16) ----------

export interface MilestoneAdvancedPayload {
  readonly fromMilestone: Milestone;
  readonly toMilestone: Milestone;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly percentComplete: number;
}

export interface EtaUpdatedPayload {
  /** ISO-8601; absent on the very first ETA announcement. */
  readonly previousEtaAt?: string;
  /** ISO-8601; absent when the new ETA cannot be computed. */
  readonly newEtaAt?: string;
  /** Signed drift in minutes (`new - previous`). 0 when one side is absent. */
  readonly driftMinutes: number;
  readonly confidence: EtaConfidence;
}

export interface EtaAtRiskPayload {
  readonly riskReason: EtaRiskReason;
  /**
   * For `overdue_step` / `pace_below_estimate`: minutes the current actual
   * run exceeds its baseline estimate. For `dependency_blocked`: 0 (the
   * overage isn't meaningful until the block clears).
   */
  readonly minutesOverBaseline: number;
  readonly currentMilestone: Milestone;
}
