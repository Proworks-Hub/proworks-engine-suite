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
 * PRIME Engine — Task Flow types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.5 (Task Flow / step lifecycle),
 *       §16 (event catalog: step.* events).
 *
 * Task Flow is where steps actually move on the floor. It's the state
 * machine layer that converts `PrioritizedStep[]` (from Priority §3.4)
 * into a live projection of what each step is doing right now.
 *
 * State model:
 *   pending      → before any dependency is satisfied
 *   ready        → all dependsOn have state=completed; step is claimable
 *   in_progress  → an operator has started the step
 *   paused       → started but temporarily halted (break, shift change, etc.)
 *                  distinct from blocked — paused is voluntary, blocked is stuck
 *   blocked      → upstream problem (missing material, station down, dep rolled
 *                  back). Resolvable by unblocking, not by resuming.
 *   completed    → terminal state. No transitions out — rework is a NEW event,
 *                  not a backward transition.
 *
 * Orthogonal annotations (do NOT change state):
 *   issue_flagged → quality concern raised mid-step, kept in a running list.
 *   rework.logged → post-completion event recording that additional time was
 *                   spent recovering from a defect. Belongs to the parent step
 *                   for audit; emits step.rework.logged, never reopens the step.
 *
 * Elapsed-time tracking: `accumulatedActiveMinutes` + `lastResumedAt` form a
 * classic running-total pattern. Pause flushes (now - lastResumedAt) into the
 * accumulator and clears lastResumedAt. Resume / start set lastResumedAt = now.
 * Complete does a final flush. The spec §3.5 calls this "wall clock per step",
 * distinct from the estimated duration that came from the template.
 *
 * Phase 1 scope:
 * - Emits all 8 step.* events in the catalog.
 * - Readiness computation is a pure function over snapshots; the use case
 *   handles one transition at a time and the caller batches.
 * - No auto-start policy (when step X completes, we do NOT automatically
 *   start step Y even if it becomes ready). That's a scheduling decision,
 *   deferred to a later module.
 * - No operator skill-check at start — routing already ensured eligibility
 *   at the station level. Station-operator pairings are outside Phase 1.
 */

import type {
  WorkOrderId,
  WorkOrderStepId,
} from "../../models/events.js";

// ---------- State ----------

export type StepState =
  | "pending"
  | "ready"
  | "in_progress"
  | "paused"
  | "blocked"
  | "completed";

// ---------- Annotations ----------

export type IssueSeverity = "minor" | "major" | "critical";

export interface IssueFlag {
  readonly flaggedAt: string;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly description: string;
}

/**
 * Rework recorded against a (typically completed) step. The step does NOT
 * reopen — rework is a separate correction recorded in history.
 */
export interface ReworkEntry {
  readonly loggedAt: string;
  readonly rootCause: string;
  readonly minutesAdded: number;
  readonly recoveryNotes?: string;
}

// ---------- Snapshot ----------

/**
 * The projection of a single step at a point in time. Replaying step.* events
 * in order reconstructs this. The use case consumes the current snapshot and
 * returns an evolved one.
 */
export interface StepSnapshot {
  readonly stepId: WorkOrderStepId;
  readonly workOrderId: WorkOrderId;
  readonly state: StepState;
  readonly dependsOn: ReadonlyArray<WorkOrderStepId>;

  /** ISO-8601, set when state first becomes `ready`. */
  readonly readyAt?: string;
  /** ISO-8601, set when the step first enters `in_progress`. */
  readonly startedAt?: string;
  /**
   * ISO-8601. Set while the step is actively running (in_progress) or just
   * after a resume. Cleared on pause/block/complete. Used to compute the
   * in-flight chunk of active time.
   */
  readonly lastResumedAt?: string;
  /** Wall-clock active minutes accumulated across all pause/resume cycles. */
  readonly accumulatedActiveMinutes: number;
  readonly pauseCount: number;

  readonly blockerReason?: string;
  readonly issueFlags: ReadonlyArray<IssueFlag>;
  readonly reworkEntries: ReadonlyArray<ReworkEntry>;

  /** ISO-8601, set once, when state reaches `completed`. */
  readonly completedAt?: string;

  /** Optional — who (user) is currently working the step. */
  readonly assignedOperatorId?: string;
}

// ---------- Commands ----------

/**
 * All the ways a step can advance. Discriminated union so the use case can
 * route to the right transition with exhaustive type checking.
 */
export type AdvanceStepCommand =
  | {
      readonly kind: "mark_ready";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
    }
  | {
      readonly kind: "start";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly operatorId?: string;
    }
  | {
      readonly kind: "pause";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly reason?: string;
    }
  | {
      readonly kind: "resume";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
    }
  | {
      readonly kind: "complete";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly outputNotes?: string;
    }
  | {
      readonly kind: "block";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly reason: string;
    }
  | {
      readonly kind: "unblock";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      /**
       * Where to return to. If the step was in_progress before it got blocked
       * the caller passes "in_progress"; if it was ready, "ready". The state
       * machine refuses anything else.
       */
      readonly returnTo: "ready" | "in_progress";
    }
  | {
      readonly kind: "flag_issue";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly code: string;
      readonly severity: IssueSeverity;
      readonly description: string;
    }
  | {
      readonly kind: "log_rework";
      readonly stepId: WorkOrderStepId;
      readonly workOrderId: WorkOrderId;
      readonly rootCause: string;
      readonly minutesAdded: number;
      readonly recoveryNotes?: string;
    };

// ---------- Errors ----------

export type TaskFlowErrorCode =
  /** Transition isn't allowed from the current state. */
  | "invalid_transition"
  /** Step is pending and its dependsOn are not all completed yet. */
  | "dependencies_not_satisfied"
  /** A required field on the command is missing or malformed (e.g. empty reason). */
  | "invalid_command"
  /** Command's workOrderId doesn't match the snapshot's workOrderId. */
  | "work_order_mismatch"
  /** Command's stepId doesn't match the snapshot's stepId. */
  | "step_mismatch";

export interface TaskFlowError {
  readonly code: TaskFlowErrorCode;
  readonly message: string;
  readonly stepId: WorkOrderStepId;
  readonly fromState?: StepState;
  readonly commandKind?: AdvanceStepCommand["kind"];
}

// ---------- Event payloads (§16) ----------

export interface StepReadyPayload {
  readonly stepId: WorkOrderStepId;
}

export interface StepStartedPayload {
  readonly stepId: WorkOrderStepId;
  readonly operatorId?: string;
}

export interface StepPausedPayload {
  readonly stepId: WorkOrderStepId;
  readonly reason?: string;
  readonly activeMinutesAtPause: number;
}

export interface StepResumedPayload {
  readonly stepId: WorkOrderStepId;
  /** How many times the step has been paused-then-resumed (incl. this resume). */
  readonly pauseCount: number;
}

export interface StepCompletedPayload {
  readonly stepId: WorkOrderStepId;
  readonly totalActiveMinutes: number;
  readonly outputNotes?: string;
}

export interface StepBlockedPayload {
  readonly stepId: WorkOrderStepId;
  readonly reason: string;
  readonly fromState: StepState;
}

export interface StepIssueFlaggedPayload {
  readonly stepId: WorkOrderStepId;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly description: string;
}

export interface StepReworkLoggedPayload {
  readonly stepId: WorkOrderStepId;
  readonly rootCause: string;
  readonly minutesAdded: number;
  readonly recoveryNotes?: string;
}

// ---------- Snapshot constructor helper (for tests + bootstrap) ----------

/**
 * Build an initial snapshot for a fresh step. Callers pass this into the
 * use case on first transition. Default state is `pending`; if the step has
 * no dependencies the caller may pre-advance it to `ready` via `mark_ready`.
 */
export interface InitialStepSnapshotInput {
  readonly stepId: WorkOrderStepId;
  readonly workOrderId: WorkOrderId;
  readonly dependsOn?: ReadonlyArray<WorkOrderStepId>;
}
