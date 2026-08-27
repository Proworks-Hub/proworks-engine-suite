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
 * PRIME Engine — Task Flow rules (pure state machine)
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.5.
 *
 * This module is deliberately I/O-free. It answers three questions:
 *   1. Is a given command legal from the current state?
 *   2. What should the new snapshot look like after applying it?
 *   3. Which pending steps in a set have just become ready?
 *
 * The use case layer wraps these with event-log emission and clock injection.
 */

import type {
  AdvanceStepCommand,
  InitialStepSnapshotInput,
  StepSnapshot,
  StepState,
  TaskFlowError,
} from "./taskFlowTypes.js";

// ---------- Constants ----------

const MS_PER_MINUTE = 60 * 1000;

// ---------- Transition matrix ----------

/**
 * Allowed state → state transitions. `log_rework` and `flag_issue` are NOT in
 * this table because they don't change state; they're annotations.
 */
const TRANSITIONS: Record<
  AdvanceStepCommand["kind"],
  ReadonlyArray<StepState> | "any"
> = {
  mark_ready: ["pending"],
  start: ["ready"],
  pause: ["in_progress"],
  resume: ["paused"],
  complete: ["in_progress"],
  block: ["ready", "in_progress", "paused"],
  unblock: ["blocked"],
  flag_issue: "any",
  log_rework: "any",
};

// ---------- Initial snapshot ----------

export function buildInitialSnapshot(
  input: InitialStepSnapshotInput
): StepSnapshot {
  return Object.freeze({
    stepId: input.stepId,
    workOrderId: input.workOrderId,
    state: "pending" as const,
    dependsOn: Object.freeze([...(input.dependsOn ?? [])]),
    accumulatedActiveMinutes: 0,
    pauseCount: 0,
    issueFlags: Object.freeze([]),
    reworkEntries: Object.freeze([]),
  });
}

// ---------- Validation ----------

/**
 * Pure validation. Returns the first error that applies, or `null` if the
 * command is legal from the given snapshot.
 *
 * `depsSatisfied` lets the caller inject the dependency answer so this module
 * stays ignorant of other steps.
 */
export function validateTransition(
  snapshot: StepSnapshot,
  command: AdvanceStepCommand,
  depsSatisfied: boolean
): TaskFlowError | null {
  if (command.workOrderId !== snapshot.workOrderId) {
    return {
      code: "work_order_mismatch",
      message: `Command targets workOrder '${command.workOrderId}' but snapshot is for '${snapshot.workOrderId}'`,
      stepId: snapshot.stepId,
      fromState: snapshot.state,
      commandKind: command.kind,
    };
  }
  if (command.stepId !== snapshot.stepId) {
    return {
      code: "step_mismatch",
      message: `Command targets step '${command.stepId}' but snapshot is for '${snapshot.stepId}'`,
      stepId: snapshot.stepId,
      fromState: snapshot.state,
      commandKind: command.kind,
    };
  }

  const allowedFrom = TRANSITIONS[command.kind];
  if (allowedFrom !== "any" && !allowedFrom.includes(snapshot.state)) {
    return {
      code: "invalid_transition",
      message: `Cannot '${command.kind}' from state '${snapshot.state}'`,
      stepId: snapshot.stepId,
      fromState: snapshot.state,
      commandKind: command.kind,
    };
  }

  if (command.kind === "mark_ready" && !depsSatisfied) {
    return {
      code: "dependencies_not_satisfied",
      message: `Step '${snapshot.stepId}' has pending dependencies`,
      stepId: snapshot.stepId,
      fromState: snapshot.state,
      commandKind: command.kind,
    };
  }

  if (command.kind === "block" && !isNonEmptyString(command.reason)) {
    return {
      code: "invalid_command",
      message: "block requires a non-empty reason",
      stepId: snapshot.stepId,
      fromState: snapshot.state,
      commandKind: command.kind,
    };
  }

  if (command.kind === "flag_issue") {
    if (
      !isNonEmptyString(command.code) ||
      !isNonEmptyString(command.description)
    ) {
      return {
        code: "invalid_command",
        message: "flag_issue requires code and description",
        stepId: snapshot.stepId,
        fromState: snapshot.state,
        commandKind: command.kind,
      };
    }
  }

  if (command.kind === "log_rework") {
    if (!isNonEmptyString(command.rootCause)) {
      return {
        code: "invalid_command",
        message: "log_rework requires a non-empty rootCause",
        stepId: snapshot.stepId,
        fromState: snapshot.state,
        commandKind: command.kind,
      };
    }
    if (!Number.isFinite(command.minutesAdded) || command.minutesAdded < 0) {
      return {
        code: "invalid_command",
        message: "log_rework.minutesAdded must be >= 0",
        stepId: snapshot.stepId,
        fromState: snapshot.state,
        commandKind: command.kind,
      };
    }
  }

  return null;
}

// ---------- Apply ----------

/**
 * Apply a validated command. Callers MUST call `validateTransition` first —
 * this function trusts the command and will produce incorrect snapshots if
 * fed an invalid one.
 */
export function applyTransition(
  snapshot: StepSnapshot,
  command: AdvanceStepCommand,
  now: Date
): StepSnapshot {
  const nowIso = now.toISOString();

  switch (command.kind) {
    case "mark_ready":
      return freezeSnapshot({
        ...snapshot,
        state: "ready",
        readyAt: snapshot.readyAt ?? nowIso,
      });

    case "start":
      return freezeSnapshot({
        ...snapshot,
        state: "in_progress",
        startedAt: nowIso,
        lastResumedAt: nowIso,
        assignedOperatorId: command.operatorId ?? snapshot.assignedOperatorId,
      });

    case "pause": {
      const flushed = flushActiveChunk(snapshot, now);
      return freezeSnapshot({
        ...flushed,
        state: "paused",
        lastResumedAt: undefined,
        pauseCount: snapshot.pauseCount + 1,
      });
    }

    case "resume":
      return freezeSnapshot({
        ...snapshot,
        state: "in_progress",
        lastResumedAt: nowIso,
      });

    case "complete": {
      const flushed = flushActiveChunk(snapshot, now);
      return freezeSnapshot({
        ...flushed,
        state: "completed",
        lastResumedAt: undefined,
        completedAt: nowIso,
      });
    }

    case "block": {
      // If the step was actively running, flush the in-flight chunk so we
      // don't lose the time the operator already put in.
      const flushed =
        snapshot.state === "in_progress"
          ? flushActiveChunk(snapshot, now)
          : snapshot;
      return freezeSnapshot({
        ...flushed,
        state: "blocked",
        lastResumedAt: undefined,
        blockerReason: command.reason,
      });
    }

    case "unblock": {
      const next: StepSnapshot = {
        ...snapshot,
        state: command.returnTo,
        blockerReason: undefined,
        lastResumedAt:
          command.returnTo === "in_progress" ? nowIso : snapshot.lastResumedAt,
      };
      return freezeSnapshot(next);
    }

    case "flag_issue":
      return freezeSnapshot({
        ...snapshot,
        issueFlags: Object.freeze([
          ...snapshot.issueFlags,
          {
            flaggedAt: nowIso,
            code: command.code,
            severity: command.severity,
            description: command.description,
          },
        ]),
      });

    case "log_rework":
      return freezeSnapshot({
        ...snapshot,
        reworkEntries: Object.freeze([
          ...snapshot.reworkEntries,
          {
            loggedAt: nowIso,
            rootCause: command.rootCause,
            minutesAdded: command.minutesAdded,
            recoveryNotes: command.recoveryNotes,
          },
        ]),
      });

    default: {
      // Exhaustiveness check — new command kinds must be handled above.
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

// ---------- Readiness (dependency fan) ----------

/**
 * Given the full set of snapshots for a work order, return the stepIds of
 * every `pending` step whose dependencies have all reached `completed`.
 *
 * Callers typically turn each returned id into a `mark_ready` command.
 * Idempotent: calling twice returns the same ids (nothing has been mutated).
 */
export function computeNewlyReadyStepIds(
  snapshots: ReadonlyArray<StepSnapshot>
): ReadonlyArray<string> {
  const byId = new Map<string, StepSnapshot>();
  for (const s of snapshots) byId.set(s.stepId, s);

  const out: string[] = [];
  for (const s of snapshots) {
    if (s.state !== "pending") continue;
    const allDepsDone = s.dependsOn.every(
      (depId) => byId.get(depId)?.state === "completed"
    );
    if (allDepsDone) out.push(s.stepId);
  }
  return out;
}

/**
 * True when every dep for `stepId` in the given set is completed. Used by the
 * use case to check before issuing `mark_ready`.
 */
export function areDependenciesSatisfied(
  snapshot: StepSnapshot,
  allSnapshots: ReadonlyArray<StepSnapshot>
): boolean {
  if (snapshot.dependsOn.length === 0) return true;
  const byId = new Map<string, StepSnapshot>();
  for (const s of allSnapshots) byId.set(s.stepId, s);
  return snapshot.dependsOn.every(
    (depId) => byId.get(depId)?.state === "completed"
  );
}

// ---------- Helpers ----------

function flushActiveChunk(snapshot: StepSnapshot, now: Date): StepSnapshot {
  if (!snapshot.lastResumedAt) return snapshot;
  const chunkMs = now.getTime() - new Date(snapshot.lastResumedAt).getTime();
  const chunkMinutes = Math.max(0, chunkMs / MS_PER_MINUTE);
  return {
    ...snapshot,
    accumulatedActiveMinutes:
      snapshot.accumulatedActiveMinutes + chunkMinutes,
  };
}

function freezeSnapshot(s: StepSnapshot): StepSnapshot {
  return Object.freeze({
    ...s,
    dependsOn: Object.freeze([...s.dependsOn]),
    issueFlags: Object.freeze([...s.issueFlags]),
    reworkEntries: Object.freeze([...s.reworkEntries]),
  });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
