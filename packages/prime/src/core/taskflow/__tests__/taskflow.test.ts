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

import { beforeEach, describe, expect, it } from "vitest";
import type { EventActor } from "../../../models/events.js";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog.js";
import type { EventLog } from "../../logging/eventLog.js";
import type {
  AdvanceStepCommand,
  StepBlockedPayload,
  StepCompletedPayload,
  StepIssueFlaggedPayload,
  StepPausedPayload,
  StepReworkLoggedPayload,
  StepSnapshot,
} from "../taskFlowTypes.js";
import {
  applyTransition,
  areDependenciesSatisfied,
  buildInitialSnapshot,
  computeNewlyReadyStepIds,
  validateTransition,
} from "../taskFlowRules.js";
import { createAdvanceStepUseCase } from "../advanceStepUseCase.js";

// ---------- Fixtures ----------

const OPERATOR: EventActor = {
  kind: "user",
  userId: "u-op-1",
  role: "operator",
};

const SYSTEM: EventActor = {
  kind: "system",
  source: "prime.taskflow",
};

const T0 = new Date("2026-04-22T08:00:00.000Z");
const MIN = 60 * 1000;

function snap(partial: Partial<StepSnapshot> & Pick<StepSnapshot, "stepId">): StepSnapshot {
  return Object.freeze({
    stepId: partial.stepId,
    workOrderId: partial.workOrderId ?? "wo-1",
    state: partial.state ?? "pending",
    dependsOn: partial.dependsOn ?? [],
    readyAt: partial.readyAt,
    startedAt: partial.startedAt,
    lastResumedAt: partial.lastResumedAt,
    accumulatedActiveMinutes: partial.accumulatedActiveMinutes ?? 0,
    pauseCount: partial.pauseCount ?? 0,
    blockerReason: partial.blockerReason,
    issueFlags: partial.issueFlags ?? [],
    reworkEntries: partial.reworkEntries ?? [],
    completedAt: partial.completedAt,
    assignedOperatorId: partial.assignedOperatorId,
  });
}

// ============================================================
//  buildInitialSnapshot
// ============================================================

describe("buildInitialSnapshot", () => {
  it("starts in pending with zero counters", () => {
    const s = buildInitialSnapshot({
      stepId: "s1",
      workOrderId: "wo-1",
      dependsOn: ["s0"],
    });
    expect(s.state).toBe("pending");
    expect(s.accumulatedActiveMinutes).toBe(0);
    expect(s.pauseCount).toBe(0);
    expect(s.dependsOn).toEqual(["s0"]);
    expect(s.issueFlags).toHaveLength(0);
    expect(s.reworkEntries).toHaveLength(0);
  });

  it("defaults dependsOn to empty when omitted", () => {
    const s = buildInitialSnapshot({ stepId: "s1", workOrderId: "wo-1" });
    expect(s.dependsOn).toEqual([]);
  });
});

// ============================================================
//  validateTransition
// ============================================================

describe("validateTransition", () => {
  it("rejects mark_ready when deps are not satisfied", () => {
    const s = snap({ stepId: "s1", state: "pending", dependsOn: ["s0"] });
    const err = validateTransition(
      s,
      { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
      false
    );
    expect(err?.code).toBe("dependencies_not_satisfied");
  });

  it("accepts mark_ready when deps are satisfied", () => {
    const s = snap({ stepId: "s1", state: "pending" });
    const err = validateTransition(
      s,
      { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
      true
    );
    expect(err).toBeNull();
  });

  it("rejects start from any state other than ready", () => {
    const s = snap({ stepId: "s1", state: "pending" });
    const err = validateTransition(
      s,
      { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      true
    );
    expect(err?.code).toBe("invalid_transition");
  });

  it("rejects resume from in_progress (can only resume paused)", () => {
    const s = snap({ stepId: "s1", state: "in_progress" });
    const err = validateTransition(
      s,
      { kind: "resume", stepId: "s1", workOrderId: "wo-1" },
      true
    );
    expect(err?.code).toBe("invalid_transition");
  });

  it("rejects complete from ready (must start first)", () => {
    const s = snap({ stepId: "s1", state: "ready" });
    const err = validateTransition(
      s,
      { kind: "complete", stepId: "s1", workOrderId: "wo-1" },
      true
    );
    expect(err?.code).toBe("invalid_transition");
  });

  it("allows block from ready, in_progress, or paused", () => {
    const states = ["ready", "in_progress", "paused"] as const;
    for (const state of states) {
      const s = snap({ stepId: "s1", state });
      const err = validateTransition(
        s,
        {
          kind: "block",
          stepId: "s1",
          workOrderId: "wo-1",
          reason: "missing material",
        },
        true
      );
      expect(err).toBeNull();
    }
  });

  it("rejects block without a reason", () => {
    const s = snap({ stepId: "s1", state: "ready" });
    const err = validateTransition(
      s,
      { kind: "block", stepId: "s1", workOrderId: "wo-1", reason: "" },
      true
    );
    expect(err?.code).toBe("invalid_command");
  });

  it("rejects commands whose workOrderId doesn't match", () => {
    const s = snap({ stepId: "s1", state: "pending" });
    const err = validateTransition(
      s,
      { kind: "mark_ready", stepId: "s1", workOrderId: "wo-other" },
      true
    );
    expect(err?.code).toBe("work_order_mismatch");
  });

  it("rejects commands whose stepId doesn't match", () => {
    const s = snap({ stepId: "s1", state: "pending" });
    const err = validateTransition(
      s,
      { kind: "mark_ready", stepId: "s-other", workOrderId: "wo-1" },
      true
    );
    expect(err?.code).toBe("step_mismatch");
  });

  it("allows flag_issue from any state", () => {
    const states = [
      "pending",
      "ready",
      "in_progress",
      "paused",
      "blocked",
      "completed",
    ] as const;
    for (const state of states) {
      const s = snap({ stepId: "s1", state });
      const err = validateTransition(
        s,
        {
          kind: "flag_issue",
          stepId: "s1",
          workOrderId: "wo-1",
          code: "color_drift",
          severity: "minor",
          description: "slight tint shift on left panel",
        },
        true
      );
      expect(err).toBeNull();
    }
  });

  it("rejects log_rework with negative minutesAdded", () => {
    const s = snap({ stepId: "s1", state: "completed" });
    const err = validateTransition(
      s,
      {
        kind: "log_rework",
        stepId: "s1",
        workOrderId: "wo-1",
        rootCause: "burr on edge",
        minutesAdded: -5,
      },
      true
    );
    expect(err?.code).toBe("invalid_command");
  });
});

// ============================================================
//  applyTransition — elapsed time + snapshot math
// ============================================================

describe("applyTransition", () => {
  it("sets readyAt the first time a step becomes ready", () => {
    const s = snap({ stepId: "s1", state: "pending" });
    const next = applyTransition(
      s,
      { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
      T0
    );
    expect(next.state).toBe("ready");
    expect(next.readyAt).toBe(T0.toISOString());
  });

  it("accumulates active minutes across pause / resume cycles", () => {
    // start @ T0, pause @ T0+30m (30 min chunk), resume @ T0+60m, complete @ T0+75m (15 min chunk)
    let s: StepSnapshot = snap({ stepId: "s1", state: "ready" });

    s = applyTransition(
      s,
      { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      T0
    );
    expect(s.state).toBe("in_progress");

    s = applyTransition(
      s,
      { kind: "pause", stepId: "s1", workOrderId: "wo-1" },
      new Date(T0.getTime() + 30 * MIN)
    );
    expect(s.state).toBe("paused");
    expect(s.accumulatedActiveMinutes).toBe(30);
    expect(s.lastResumedAt).toBeUndefined();
    expect(s.pauseCount).toBe(1);

    s = applyTransition(
      s,
      { kind: "resume", stepId: "s1", workOrderId: "wo-1" },
      new Date(T0.getTime() + 60 * MIN)
    );
    expect(s.state).toBe("in_progress");

    s = applyTransition(
      s,
      {
        kind: "complete",
        stepId: "s1",
        workOrderId: "wo-1",
        outputNotes: "looks good",
      },
      new Date(T0.getTime() + 75 * MIN)
    );
    expect(s.state).toBe("completed");
    expect(s.accumulatedActiveMinutes).toBe(45);
    expect(s.completedAt).toBe(new Date(T0.getTime() + 75 * MIN).toISOString());
  });

  it("flushes the active chunk when blocking mid-run (no lost time)", () => {
    let s: StepSnapshot = snap({ stepId: "s1", state: "ready" });
    s = applyTransition(
      s,
      { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      T0
    );
    s = applyTransition(
      s,
      {
        kind: "block",
        stepId: "s1",
        workOrderId: "wo-1",
        reason: "missing material",
      },
      new Date(T0.getTime() + 20 * MIN)
    );
    expect(s.state).toBe("blocked");
    expect(s.accumulatedActiveMinutes).toBe(20);
    expect(s.blockerReason).toBe("missing material");
    expect(s.lastResumedAt).toBeUndefined();
  });

  it("unblock back to in_progress restarts the active-chunk clock", () => {
    let s: StepSnapshot = snap({
      stepId: "s1",
      state: "blocked",
      accumulatedActiveMinutes: 10,
      blockerReason: "waiting on QA",
    });
    s = applyTransition(
      s,
      {
        kind: "unblock",
        stepId: "s1",
        workOrderId: "wo-1",
        returnTo: "in_progress",
      },
      T0
    );
    expect(s.state).toBe("in_progress");
    expect(s.blockerReason).toBeUndefined();
    expect(s.lastResumedAt).toBe(T0.toISOString());
  });

  it("flag_issue appends to issueFlags without changing state", () => {
    const s = snap({ stepId: "s1", state: "in_progress" });
    const next = applyTransition(
      s,
      {
        kind: "flag_issue",
        stepId: "s1",
        workOrderId: "wo-1",
        code: "color_drift",
        severity: "major",
        description: "blue is off",
      },
      T0
    );
    expect(next.state).toBe("in_progress");
    expect(next.issueFlags).toHaveLength(1);
    expect(next.issueFlags[0]!.code).toBe("color_drift");
    expect(next.issueFlags[0]!.flaggedAt).toBe(T0.toISOString());
  });

  it("log_rework appends to reworkEntries on a completed step (no reopen)", () => {
    const s = snap({ stepId: "s1", state: "completed" });
    const next = applyTransition(
      s,
      {
        kind: "log_rework",
        stepId: "s1",
        workOrderId: "wo-1",
        rootCause: "overcured edge",
        minutesAdded: 12,
        recoveryNotes: "buffed and re-inspected",
      },
      T0
    );
    expect(next.state).toBe("completed");
    expect(next.reworkEntries).toHaveLength(1);
    expect(next.reworkEntries[0]!.minutesAdded).toBe(12);
  });
});

// ============================================================
//  computeNewlyReadyStepIds
// ============================================================

describe("computeNewlyReadyStepIds", () => {
  it("marks no step ready if any dep is not completed", () => {
    const all = [
      snap({ stepId: "s0", state: "in_progress" }),
      snap({ stepId: "s1", state: "pending", dependsOn: ["s0"] }),
    ];
    expect(computeNewlyReadyStepIds(all)).toEqual([]);
  });

  it("marks a pending step ready when all deps are completed", () => {
    const all = [
      snap({ stepId: "s0", state: "completed" }),
      snap({ stepId: "s1", state: "pending", dependsOn: ["s0"] }),
      snap({ stepId: "s2", state: "pending", dependsOn: ["s0", "s1"] }),
    ];
    expect(computeNewlyReadyStepIds(all)).toEqual(["s1"]);
  });

  it("marks a step with no deps ready immediately", () => {
    const all = [snap({ stepId: "s0", state: "pending" })];
    expect(computeNewlyReadyStepIds(all)).toEqual(["s0"]);
  });

  it("is idempotent — already-ready/in_progress steps are not returned", () => {
    const all = [
      snap({ stepId: "s0", state: "completed" }),
      snap({ stepId: "s1", state: "ready", dependsOn: ["s0"] }),
    ];
    expect(computeNewlyReadyStepIds(all)).toEqual([]);
  });
});

describe("areDependenciesSatisfied", () => {
  it("returns true when dependsOn is empty", () => {
    const s = snap({ stepId: "s1" });
    expect(areDependenciesSatisfied(s, [])).toBe(true);
  });

  it("returns false when a dep snapshot is missing from the set", () => {
    const s = snap({ stepId: "s1", dependsOn: ["sX"] });
    expect(areDependenciesSatisfied(s, [])).toBe(false);
  });
});

// ============================================================
//  advanceStep use case
// ============================================================

describe("createAdvanceStepUseCase", () => {
  let eventLog: EventLog;
  const clock = () => T0;

  beforeEach(() => {
    eventLog = createInMemoryEventLog();
  });

  it("emits step.ready when transitioning pending → ready", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const current = snap({ stepId: "s1", state: "pending" });
    const result = await useCase.execute(
      {
        currentSnapshot: current,
        command: { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe("ready");

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("step.ready");
    expect(events[0]!.stepId).toBe("s1");
  });

  it("does NOT emit an event when the transition is invalid", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "pending" }),
        command: { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      },
      OPERATOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_transition");

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(0);
  });

  it("refuses mark_ready when otherSnapshots show deps are not completed", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const current = snap({
      stepId: "s1",
      state: "pending",
      dependsOn: ["s0"],
    });
    const other = snap({ stepId: "s0", state: "in_progress" });

    const result = await useCase.execute(
      {
        currentSnapshot: current,
        command: { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
        otherSnapshots: [other],
      },
      SYSTEM
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("dependencies_not_satisfied");
  });

  it("emits step.started with operatorId on start", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "ready" }),
        command: {
          kind: "start",
          stepId: "s1",
          workOrderId: "wo-1",
          operatorId: "u-op-1",
        },
      },
      OPERATOR
    );
    expect(result.ok).toBe(true);

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events[0]!.type).toBe("step.started");
    const payload = events[0]!.payload as { operatorId?: string };
    expect(payload.operatorId).toBe("u-op-1");
  });

  it("emits step.paused with activeMinutesAtPause derived from elapsed time", async () => {
    const eventLog2 = createInMemoryEventLog();
    // Arrange: use a clock that returns T0 for start, T0+15m for pause.
    let currentTick = T0;
    const advancingClock = () => currentTick;
    const useCase = createAdvanceStepUseCase({
      eventLog: eventLog2,
      clock: advancingClock,
    });

    const started = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "ready" }),
        command: { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      },
      OPERATOR
    );
    if (!started.ok) throw new Error("start failed");

    currentTick = new Date(T0.getTime() + 15 * MIN);
    const paused = await useCase.execute(
      {
        currentSnapshot: started.snapshot,
        command: {
          kind: "pause",
          stepId: "s1",
          workOrderId: "wo-1",
          reason: "shift change",
        },
      },
      OPERATOR
    );
    if (!paused.ok) throw new Error("pause failed");

    const events = await eventLog2.listByWorkOrder("wo-1");
    const pausedEvt = events.find((e) => e.type === "step.paused");
    expect(pausedEvt).toBeDefined();
    const payload = pausedEvt!.payload as StepPausedPayload;
    expect(payload.activeMinutesAtPause).toBe(15);
    expect(payload.reason).toBe("shift change");
  });

  it("emits step.completed with totalActiveMinutes", async () => {
    let currentTick = T0;
    const advancingClock = () => currentTick;
    const eventLog2 = createInMemoryEventLog();
    const useCase = createAdvanceStepUseCase({
      eventLog: eventLog2,
      clock: advancingClock,
    });

    const started = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "ready" }),
        command: { kind: "start", stepId: "s1", workOrderId: "wo-1" },
      },
      OPERATOR
    );
    if (!started.ok) throw new Error("start failed");

    currentTick = new Date(T0.getTime() + 45 * MIN);
    const completed = await useCase.execute(
      {
        currentSnapshot: started.snapshot,
        command: { kind: "complete", stepId: "s1", workOrderId: "wo-1" },
      },
      OPERATOR
    );
    if (!completed.ok) throw new Error("complete failed");

    const events = await eventLog2.listByWorkOrder("wo-1");
    const done = events.find((e) => e.type === "step.completed");
    expect(done).toBeDefined();
    const payload = done!.payload as StepCompletedPayload;
    expect(payload.totalActiveMinutes).toBe(45);
  });

  it("emits step.blocked with the previous state in the payload", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "ready" }),
        command: {
          kind: "block",
          stepId: "s1",
          workOrderId: "wo-1",
          reason: "vendor delay",
        },
      },
      OPERATOR
    );
    expect(result.ok).toBe(true);

    const events = await eventLog.listByWorkOrder("wo-1");
    const blocked = events[0]!;
    expect(blocked.type).toBe("step.blocked");
    const payload = blocked.payload as StepBlockedPayload;
    expect(payload.reason).toBe("vendor delay");
    expect(payload.fromState).toBe("ready");
  });

  it("unblock back to ready emits a fresh step.ready event", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({
          stepId: "s1",
          state: "blocked",
          blockerReason: "missing material",
        }),
        command: {
          kind: "unblock",
          stepId: "s1",
          workOrderId: "wo-1",
          returnTo: "ready",
        },
      },
      OPERATOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.blockerReason).toBeUndefined();

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events[0]!.type).toBe("step.ready");
  });

  it("emits step.issue_flagged without changing state", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({ stepId: "s1", state: "in_progress" }),
        command: {
          kind: "flag_issue",
          stepId: "s1",
          workOrderId: "wo-1",
          code: "alignment",
          severity: "major",
          description: "panel offset 2mm",
        },
      },
      OPERATOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe("in_progress");
    expect(result.snapshot.issueFlags).toHaveLength(1);

    const events = await eventLog.listByWorkOrder("wo-1");
    const flagged = events[0]!;
    expect(flagged.type).toBe("step.issue_flagged");
    const payload = flagged.payload as StepIssueFlaggedPayload;
    expect(payload.severity).toBe("major");
  });

  it("emits step.rework.logged on a completed step without reopening", async () => {
    const useCase = createAdvanceStepUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        currentSnapshot: snap({
          stepId: "s1",
          state: "completed",
          accumulatedActiveMinutes: 60,
          completedAt: T0.toISOString(),
        }),
        command: {
          kind: "log_rework",
          stepId: "s1",
          workOrderId: "wo-1",
          rootCause: "bad tolerance",
          minutesAdded: 10,
        },
      },
      OPERATOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.state).toBe("completed");
    expect(result.snapshot.reworkEntries).toHaveLength(1);
    // Base active minutes are untouched — rework is a separate accumulator.
    expect(result.snapshot.accumulatedActiveMinutes).toBe(60);

    const events = await eventLog.listByWorkOrder("wo-1");
    const rework = events[0]!;
    expect(rework.type).toBe("step.rework.logged");
    const payload = rework.payload as StepReworkLoggedPayload;
    expect(payload.minutesAdded).toBe(10);
  });

  it("works end-to-end: pending → ready → in_progress → paused → resumed → completed", async () => {
    let currentTick = T0;
    const advancingClock = () => currentTick;
    const eventLog2 = createInMemoryEventLog();
    const useCase = createAdvanceStepUseCase({
      eventLog: eventLog2,
      clock: advancingClock,
    });

    let s: StepSnapshot = snap({ stepId: "s1", state: "pending" });

    const run = async (command: AdvanceStepCommand, actor: EventActor) => {
      const r = await useCase.execute(
        { currentSnapshot: s, command },
        actor
      );
      if (!r.ok) throw new Error(`${command.kind} failed: ${r.error.code}`);
      s = r.snapshot;
    };

    await run(
      { kind: "mark_ready", stepId: "s1", workOrderId: "wo-1" },
      SYSTEM
    );
    expect(s.state).toBe("ready");

    currentTick = new Date(T0.getTime() + 5 * MIN);
    await run({ kind: "start", stepId: "s1", workOrderId: "wo-1" }, OPERATOR);
    expect(s.state).toBe("in_progress");

    currentTick = new Date(T0.getTime() + 20 * MIN);
    await run({ kind: "pause", stepId: "s1", workOrderId: "wo-1" }, OPERATOR);
    expect(s.state).toBe("paused");
    expect(s.accumulatedActiveMinutes).toBe(15);

    currentTick = new Date(T0.getTime() + 40 * MIN);
    await run({ kind: "resume", stepId: "s1", workOrderId: "wo-1" }, OPERATOR);
    expect(s.state).toBe("in_progress");

    currentTick = new Date(T0.getTime() + 70 * MIN);
    await run(
      { kind: "complete", stepId: "s1", workOrderId: "wo-1" },
      OPERATOR
    );
    expect(s.state).toBe("completed");
    expect(s.accumulatedActiveMinutes).toBe(45);

    const types = (await eventLog2.listByWorkOrder("wo-1")).map((e) => e.type);
    expect(types).toEqual([
      "step.ready",
      "step.started",
      "step.paused",
      "step.resumed",
      "step.completed",
    ]);
  });
});
