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
 * PRIME Engine — Terminal use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.8.
 *
 * Factory with two methods: `complete` and `cancel`. Each method:
 *   1. Validates the command (non-empty ids, reason-detail when required).
 *   2. Refuses if the WO is already in a terminal state.
 *   3. For `complete`: refuses if any required step isn't `completed`.
 *      For `cancel`: refuses if the WO is already at the `completed`
 *      milestone (business rule — use a different action for post-completion).
 *   4. Builds a `WorkOrderTerminalSnapshot`, emits exactly one event
 *      (`work_order.completed` or `work_order.cancelled`), returns the
 *      snapshot.
 *
 * Stateless — the caller owns the WO projection. The event log is the
 * source of truth; the returned snapshot is a convenience so callers can
 * update whatever denormalized view they maintain.
 *
 * Same philosophy as Template / Routing / Priority / Task Flow / Change /
 * Tracking: a failed terminal transition must NOT show up in the event log.
 */

import type {
  EventActor,
  WorkOrderEventType,
} from "../../models/events";
import type {
  Clock,
  EventLog,
} from "../logging/eventLog";
import type {
  CancelWorkOrderInput,
  CompleteWorkOrderInput,
  TerminalError,
  WorkOrderCancelledPayload,
  WorkOrderCompletedPayload,
  WorkOrderTerminalSnapshot,
} from "./terminalTypes";
import {
  canCancel,
  canComplete,
  summarizeSteps,
} from "./terminalRules";

// ---------- Public surface ----------

export type CompleteWorkOrderResult =
  | { readonly ok: true; readonly snapshot: WorkOrderTerminalSnapshot }
  | { readonly ok: false; readonly error: TerminalError };

export type CancelWorkOrderResult =
  | { readonly ok: true; readonly snapshot: WorkOrderTerminalSnapshot }
  | { readonly ok: false; readonly error: TerminalError };

export interface TerminalUseCaseDeps {
  readonly eventLog: EventLog;
  /** Injected for deterministic tests. Defaults to wall clock. */
  readonly clock?: Clock;
}

export interface TerminalUseCase {
  complete(
    input: CompleteWorkOrderInput,
    actor: EventActor
  ): Promise<CompleteWorkOrderResult>;

  cancel(
    input: CancelWorkOrderInput,
    actor: EventActor
  ): Promise<CancelWorkOrderResult>;
}

// ---------- Factory ----------

export function createTerminalUseCase(
  deps: TerminalUseCaseDeps
): TerminalUseCase {
  const { eventLog } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async complete(input, actor) {
      // ---- Field validation ----
      const fieldError = validateCompleteFields(input);
      if (fieldError) return { ok: false, error: fieldError };

      // ---- Terminal guard ----
      if (input.currentTerminalState !== undefined) {
        return {
          ok: false,
          error: {
            code: "already_terminal",
            message: `Work order '${input.workOrderId}' is already '${input.currentTerminalState}'`,
          },
        };
      }

      // ---- Completability guard ----
      const completability = canComplete(input.trackedSteps);
      if (!completability.ok) {
        return {
          ok: false,
          error: {
            code: "not_all_required_steps_completed",
            message: `Cannot complete work order '${input.workOrderId}': ${completability.incompleteStepIds.length} required step(s) not completed`,
            incompleteStepIds: completability.incompleteStepIds,
          },
        };
      }

      const now = clock();
      const summary = summarizeSteps(input.trackedSteps);

      const snapshot: WorkOrderTerminalSnapshot = Object.freeze({
        workOrderId: input.workOrderId,
        terminalState: "completed" as const,
        reachedAt: now,
        reachedBy: input.completedBy,
        finalMilestone: input.currentMilestone,
        stepSummary: summary,
      });

      await appendTerminalEvent<WorkOrderCompletedPayload>(
        eventLog,
        input.workOrderId,
        "work_order.completed",
        actor,
        {
          finalMilestone: input.currentMilestone,
          completedRequiredCount: summary.completedRequiredCount,
          completedOptionalCount: summary.completedOptionalCount,
          skippedOptionalCount: summary.skippedOptionalCount,
          totalActiveMinutes: summary.totalActiveMinutes,
          completedBy: input.completedBy,
        }
      );

      return { ok: true, snapshot };
    },

    async cancel(input, actor) {
      // ---- Field validation ----
      const fieldError = validateCancelFields(input);
      if (fieldError) return { ok: false, error: fieldError };

      // ---- Terminal guard ----
      if (input.currentTerminalState !== undefined) {
        return {
          ok: false,
          error: {
            code: "already_terminal",
            message: `Work order '${input.workOrderId}' is already '${input.currentTerminalState}'`,
          },
        };
      }

      // ---- Cancellability guard ----
      if (!canCancel(input.currentMilestone)) {
        return {
          ok: false,
          error: {
            code: "invalid_command",
            message: `Cannot cancel work order '${input.workOrderId}': milestone is '${input.currentMilestone}'`,
          },
        };
      }

      const now = clock();
      const summary = summarizeSteps(input.trackedSteps);

      const snapshot: WorkOrderTerminalSnapshot = Object.freeze({
        workOrderId: input.workOrderId,
        terminalState: "cancelled" as const,
        reachedAt: now,
        reachedBy: input.cancelledBy,
        finalMilestone: input.currentMilestone,
        stepSummary: summary,
        cancellationReasonCode: input.reasonCode,
        cancellationReasonDetail: input.reasonDetail,
      });

      await appendTerminalEvent<WorkOrderCancelledPayload>(
        eventLog,
        input.workOrderId,
        "work_order.cancelled",
        actor,
        {
          reasonCode: input.reasonCode,
          reasonDetail: input.reasonDetail,
          cancelledAtMilestone: input.currentMilestone,
          completedRequiredCount: summary.completedRequiredCount,
          incompleteRequiredCount: summary.incompleteRequiredCount,
          totalActiveMinutes: summary.totalActiveMinutes,
          cancelledBy: input.cancelledBy,
        }
      );

      return { ok: true, snapshot };
    },
  };
}

// ---------- Field validation ----------

function validateCompleteFields(
  input: CompleteWorkOrderInput
): TerminalError | null {
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "complete: workOrderId must be a non-empty string",
    };
  }
  if (!input.completedBy || input.completedBy.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "complete: completedBy must be a non-empty string",
    };
  }
  return null;
}

function validateCancelFields(
  input: CancelWorkOrderInput
): TerminalError | null {
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "cancel: workOrderId must be a non-empty string",
    };
  }
  if (!input.cancelledBy || input.cancelledBy.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "cancel: cancelledBy must be a non-empty string",
    };
  }
  if (!input.reasonCode) {
    return {
      code: "invalid_command",
      message: "cancel: reasonCode must be supplied",
    };
  }
  if (
    input.reasonCode === "other" &&
    (!input.reasonDetail || input.reasonDetail.trim().length === 0)
  ) {
    return {
      code: "reason_detail_required",
      message:
        "cancel: reasonDetail is required when reasonCode is 'other'",
    };
  }
  return null;
}

// ---------- Event emission ----------

async function appendTerminalEvent<T>(
  eventLog: EventLog,
  workOrderId: string,
  type: WorkOrderEventType,
  actor: EventActor,
  payload: T
): Promise<void> {
  await eventLog.append<T>({
    workOrderId,
    type,
    actor,
    payload,
  });
}
