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
 * PRIME Engine — advanceStep use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.5.
 *
 * Single entry point for all step lifecycle transitions. Takes the current
 * snapshot + a discriminated command, validates through taskFlowRules, and
 * — on success — emits exactly one step.* event and returns the new snapshot.
 *
 * Contract:
 * - Callers are responsible for persisting / updating the snapshot
 *   projection. The use case is stateless.
 * - `mark_ready` requires the caller to pass `otherSnapshots` so the rules
 *   module can verify all `dependsOn` are completed. For commands that don't
 *   need cross-step context, `otherSnapshots` may be omitted.
 * - Failure path returns `{ ok: false, error }` without emitting an event.
 *   Same philosophy as Template / Routing: a failed transition must not
 *   show up in the log.
 * - `flag_issue` and `log_rework` are annotations — they emit events but do
 *   not change state.
 */

import type {
  EventActor,
  WorkOrderEventType,
} from "../../models/events.js";
import type {
  Clock,
  EventLog,
} from "../logging/eventLog.js";
import type {
  AdvanceStepCommand,
  StepBlockedPayload,
  StepCompletedPayload,
  StepIssueFlaggedPayload,
  StepPausedPayload,
  StepReadyPayload,
  StepResumedPayload,
  StepReworkLoggedPayload,
  StepSnapshot,
  StepStartedPayload,
  TaskFlowError,
} from "./taskFlowTypes.js";
import {
  applyTransition,
  areDependenciesSatisfied,
  validateTransition,
} from "./taskFlowRules.js";

// ---------- Public surface ----------

export interface AdvanceStepInput {
  readonly currentSnapshot: StepSnapshot;
  readonly command: AdvanceStepCommand;
  /**
   * All OTHER step snapshots in the same work order. Only inspected for
   * `mark_ready` (where it drives dependency satisfaction). Safe to omit
   * for other command kinds.
   */
  readonly otherSnapshots?: ReadonlyArray<StepSnapshot>;
}

export type AdvanceStepResult =
  | { readonly ok: true; readonly snapshot: StepSnapshot }
  | { readonly ok: false; readonly error: TaskFlowError };

export interface AdvanceStepUseCaseDeps {
  readonly eventLog: EventLog;
  /** Injected for deterministic tests. Defaults to wall clock. */
  readonly clock?: Clock;
}

export interface AdvanceStepUseCase {
  execute(
    input: AdvanceStepInput,
    actor: EventActor
  ): Promise<AdvanceStepResult>;
}

// ---------- Factory ----------

export function createAdvanceStepUseCase(
  deps: AdvanceStepUseCaseDeps
): AdvanceStepUseCase {
  const { eventLog } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async execute(input, actor) {
      const { currentSnapshot, command, otherSnapshots = [] } = input;

      const depsSatisfied =
        command.kind === "mark_ready"
          ? areDependenciesSatisfied(currentSnapshot, otherSnapshots)
          : true;

      const validationError = validateTransition(
        currentSnapshot,
        command,
        depsSatisfied
      );
      if (validationError) {
        return { ok: false, error: validationError };
      }

      const now = clock();
      const nextSnapshot = applyTransition(currentSnapshot, command, now);

      await emitEventFor(
        eventLog,
        command,
        nextSnapshot,
        currentSnapshot,
        actor
      );

      return { ok: true, snapshot: nextSnapshot };
    },
  };
}

// ---------- Event emission ----------

async function emitEventFor(
  eventLog: EventLog,
  command: AdvanceStepCommand,
  next: StepSnapshot,
  prev: StepSnapshot,
  actor: EventActor
): Promise<void> {
  switch (command.kind) {
    case "mark_ready": {
      await append(eventLog, next, "step.ready", actor, {
        stepId: command.stepId,
      } satisfies StepReadyPayload);
      return;
    }
    case "start": {
      await append(eventLog, next, "step.started", actor, {
        stepId: command.stepId,
        operatorId: command.operatorId,
      } satisfies StepStartedPayload);
      return;
    }
    case "pause": {
      await append(eventLog, next, "step.paused", actor, {
        stepId: command.stepId,
        reason: command.reason,
        activeMinutesAtPause: next.accumulatedActiveMinutes,
      } satisfies StepPausedPayload);
      return;
    }
    case "resume": {
      await append(eventLog, next, "step.resumed", actor, {
        stepId: command.stepId,
        pauseCount: next.pauseCount,
      } satisfies StepResumedPayload);
      return;
    }
    case "complete": {
      await append(eventLog, next, "step.completed", actor, {
        stepId: command.stepId,
        totalActiveMinutes: next.accumulatedActiveMinutes,
        outputNotes: command.outputNotes,
      } satisfies StepCompletedPayload);
      return;
    }
    case "block": {
      await append(eventLog, next, "step.blocked", actor, {
        stepId: command.stepId,
        reason: command.reason,
        fromState: prev.state,
      } satisfies StepBlockedPayload);
      return;
    }
    case "unblock": {
      // No dedicated `step.unblocked` in §16 — unblocking re-emits the
      // appropriate state event so downstream consumers pick it up.
      if (command.returnTo === "in_progress") {
        await append(eventLog, next, "step.resumed", actor, {
          stepId: command.stepId,
          pauseCount: next.pauseCount,
        } satisfies StepResumedPayload);
      } else {
        await append(eventLog, next, "step.ready", actor, {
          stepId: command.stepId,
        } satisfies StepReadyPayload);
      }
      return;
    }
    case "flag_issue": {
      await append(eventLog, next, "step.issue_flagged", actor, {
        stepId: command.stepId,
        code: command.code,
        severity: command.severity,
        description: command.description,
      } satisfies StepIssueFlaggedPayload);
      return;
    }
    case "log_rework": {
      await append(eventLog, next, "step.rework.logged", actor, {
        stepId: command.stepId,
        rootCause: command.rootCause,
        minutesAdded: command.minutesAdded,
        recoveryNotes: command.recoveryNotes,
      } satisfies StepReworkLoggedPayload);
      return;
    }
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

async function append<T>(
  eventLog: EventLog,
  snapshot: StepSnapshot,
  type: WorkOrderEventType,
  actor: EventActor,
  payload: T
): Promise<void> {
  await eventLog.append<T>({
    workOrderId: snapshot.workOrderId,
    stepId: snapshot.stepId,
    type,
    actor,
    payload,
  });
}
