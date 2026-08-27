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
 * PRIME Engine — Terminal types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.8.
 *
 * A work order ends its life in exactly one of two terminal states:
 *   - `completed` — every non-optional step is `completed` (Task Flow §3.5
 *     state). Optional steps are allowed to be completed, skipped, or any
 *     non-completed state; they don't gate completion. Announced via the
 *     `work_order.completed` event.
 *   - `cancelled` — the work order is abandoned before all required steps
 *     are done. Cancellation carries a coded reason + free-text detail and
 *     a snapshot of how far the WO had progressed. Announced via the
 *     `work_order.cancelled` event.
 *
 * Both are once-only, terminal transitions — a completed or cancelled WO
 * can't be re-terminated. The use case enforces this with an `already_terminal`
 * guard that the caller passes in via `currentTerminalState`.
 *
 * This module completes the §16 event catalog for Phase 1. Every spec event
 * type (`work_order.completed`, `work_order.cancelled`) now has a producer.
 *
 * Learning layer hook (§21): both events carry enough audit detail
 * (totalActiveMinutes, finalMilestone, cancellation reason codes) to feed
 * downstream models without requiring a log rescan of upstream step.* events.
 */

import type {
  WorkOrderEvent,
  WorkOrderId,
} from "../../models/events.js";
import type { Milestone } from "../tracking/trackingTypes.js";

// ---------- Terminal state ----------

export type WorkOrderTerminalState = "completed" | "cancelled";

/**
 * Coded cancellation reasons. Kept narrow so the learning layer can train
 * on them without free-text NLP. `other` is the escape hatch and MUST be
 * paired with a non-empty `reasonDetail` string — the use case enforces this.
 */
export type CancellationReasonCode =
  | "customer_request"
  | "unable_to_fulfill"
  | "quality_failure"
  | "duplicate_order"
  | "superseded_by_change_order"
  | "other";

// ---------- Step aggregation ----------

/**
 * Per-work-order step aggregation captured at terminal time. Computed by
 * `summarizeSteps(trackedSteps)` (terminalRules.ts).
 *
 * Counts distinguish required vs. optional so the completed payload can
 * surface "how much of the elective work actually got done" — useful for
 * invoicing / upsell analytics.
 */
export interface StepSummary {
  /** Required, non-optional steps that reached `completed` state. */
  readonly completedRequiredCount: number;
  /** Required steps that were NOT completed (blocked/in_progress/etc.). Only meaningful for cancel. */
  readonly incompleteRequiredCount: number;
  /** Optional steps that reached `completed` state. */
  readonly completedOptionalCount: number;
  /** Optional steps that never reached `completed` — "skipped" in business terms. */
  readonly skippedOptionalCount: number;
  /** Sum of `accumulatedActiveMinutes` across ALL steps (required + optional). */
  readonly totalActiveMinutes: number;
}

// ---------- Terminal snapshot ----------

/**
 * Output record from a successful `complete` or `cancel` call. Callers
 * persist this on whatever their "work order" projection table is. The
 * event log is still the source of truth; this is a convenience.
 */
export interface WorkOrderTerminalSnapshot {
  readonly workOrderId: WorkOrderId;
  readonly terminalState: WorkOrderTerminalState;
  readonly reachedAt: Date;
  readonly reachedBy: string;
  readonly finalMilestone: Milestone;
  readonly stepSummary: StepSummary;
  /** Only present when `terminalState === "cancelled"`. */
  readonly cancellationReasonCode?: CancellationReasonCode;
  /** Only present when `terminalState === "cancelled"`. Free text, required for `other`. */
  readonly cancellationReasonDetail?: string;
}

// ---------- Inputs ----------

export interface CompleteWorkOrderInput {
  readonly workOrderId: WorkOrderId;
  readonly completedBy: string;
  readonly trackedSteps: ReadonlyArray<import(
    "../tracking/trackingTypes.js"
  ).TrackedStep>;
  /**
   * Current milestone from the caller's projection. Recorded in the
   * completed event payload as `finalMilestone` so the log reflects what
   * the customer was shown at the moment of completion.
   */
  readonly currentMilestone: Milestone;
  /**
   * Non-null only if the WO was already terminated. When set, the use case
   * rejects with `already_terminal`. Callers that don't maintain a
   * projection can pass `undefined`.
   */
  readonly currentTerminalState?: WorkOrderTerminalState;
}

export interface CancelWorkOrderInput {
  readonly workOrderId: WorkOrderId;
  readonly cancelledBy: string;
  readonly trackedSteps: ReadonlyArray<import(
    "../tracking/trackingTypes.js"
  ).TrackedStep>;
  readonly currentMilestone: Milestone;
  readonly reasonCode: CancellationReasonCode;
  /** Free-text rationale. Required when `reasonCode === "other"`. */
  readonly reasonDetail?: string;
  readonly currentTerminalState?: WorkOrderTerminalState;
}

// ---------- Errors ----------

export type TerminalErrorCode =
  /** One or more required steps are not `completed` — can't close the WO. */
  | "not_all_required_steps_completed"
  /** WO is already in a terminal state (completed or cancelled). */
  | "already_terminal"
  /** Required field missing or malformed on the command. */
  | "invalid_command"
  /** `other` reason code without a reasonDetail. */
  | "reason_detail_required";

export interface TerminalError {
  readonly code: TerminalErrorCode;
  readonly message: string;
  /** For `not_all_required_steps_completed`: which required steps are still open. */
  readonly incompleteStepIds?: ReadonlyArray<string>;
}

// ---------- Event payloads (§16) ----------

export interface WorkOrderCompletedPayload {
  readonly finalMilestone: Milestone;
  readonly completedRequiredCount: number;
  readonly completedOptionalCount: number;
  readonly skippedOptionalCount: number;
  readonly totalActiveMinutes: number;
  readonly completedBy: string;
}

export interface WorkOrderCancelledPayload {
  readonly reasonCode: CancellationReasonCode;
  /** Present only when supplied — required for `reasonCode === "other"`. */
  readonly reasonDetail?: string;
  readonly cancelledAtMilestone: Milestone;
  readonly completedRequiredCount: number;
  readonly incompleteRequiredCount: number;
  readonly totalActiveMinutes: number;
  readonly cancelledBy: string;
}

// ---------- Re-exports for consumers (convenience) ----------

/** Typed event record for a WO-completed append, useful for test assertions. */
export type WorkOrderCompletedEvent = WorkOrderEvent<WorkOrderCompletedPayload>;
export type WorkOrderCancelledEvent = WorkOrderEvent<WorkOrderCancelledPayload>;
