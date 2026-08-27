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
import type { EventActor } from "../../../models/events";
import { createInMemoryEventLog } from "../../logging/inMemoryEventLog";
import type { EventLog } from "../../logging/eventLog";
import type { StepState } from "../../taskflow/taskFlowTypes";
import type { TrackedStep } from "../../tracking/trackingTypes";
import type {
  CancellationReasonCode,
  WorkOrderCancelledPayload,
  WorkOrderCompletedPayload,
} from "../terminalTypes";
import {
  canCancel,
  canComplete,
  summarizeSteps,
} from "../terminalRules";
import { createTerminalUseCase } from "../terminalUseCase";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

const FIXED_NOW = new Date("2026-04-22T12:00:00Z");

function step(
  id: string,
  state: StepState,
  overrides: Partial<TrackedStep> = {}
): TrackedStep {
  return {
    stepId: id,
    state,
    optional: overrides.optional ?? false,
    estimatedDurationMinutes: overrides.estimatedDurationMinutes,
    accumulatedActiveMinutes: overrides.accumulatedActiveMinutes ?? 0,
    dependsOn: overrides.dependsOn ?? [],
    workstationClass: overrides.workstationClass,
  };
}

let eventLog: EventLog;

beforeEach(() => {
  eventLog = createInMemoryEventLog({
    clock: () => FIXED_NOW,
    idGenerator: (() => {
      let n = 0;
      return () => `evt-${++n}`;
    })(),
  });
});

// ==========================================================================
// canComplete
// ==========================================================================

describe("canComplete", () => {
  it("returns ok when every required step is completed", () => {
    const result = canComplete([
      step("s1", "completed"),
      step("s2", "completed"),
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns ok when required steps are completed and optional remain open", () => {
    const result = canComplete([
      step("s1", "completed"),
      step("opt1", "ready", { optional: true }),
      step("opt2", "in_progress", { optional: true }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("returns the list of incomplete required stepIds on failure", () => {
    const result = canComplete([
      step("s1", "completed"),
      step("s2", "in_progress"),
      step("s3", "ready"),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.incompleteStepIds).toEqual(["s2", "s3"]);
  });

  it("returns ok on an empty step list (vacuously complete)", () => {
    expect(canComplete([]).ok).toBe(true);
  });

  it("ignores optional steps when deciding completability", () => {
    const result = canComplete([
      step("s1", "completed"),
      step("opt1", "blocked", { optional: true }),
    ]);
    expect(result.ok).toBe(true);
  });
});

// ==========================================================================
// canCancel
// ==========================================================================

describe("canCancel", () => {
  it("allows cancellation from any non-completed milestone", () => {
    expect(canCancel("intake")).toBe(true);
    expect(canCancel("routed")).toBe(true);
    expect(canCancel("in_production")).toBe(true);
    expect(canCancel("quality_check")).toBe(true);
    expect(canCancel("ready_for_pickup")).toBe(true);
  });

  it("refuses cancellation once the WO reached completed milestone", () => {
    expect(canCancel("completed")).toBe(false);
  });
});

// ==========================================================================
// summarizeSteps
// ==========================================================================

describe("summarizeSteps", () => {
  it("counts required vs optional completed vs skipped", () => {
    const summary = summarizeSteps([
      step("s1", "completed"),
      step("s2", "completed"),
      step("s3", "ready"),
      step("opt1", "completed", { optional: true }),
      step("opt2", "ready", { optional: true }),
      step("opt3", "blocked", { optional: true }),
    ]);
    expect(summary.completedRequiredCount).toBe(2);
    expect(summary.incompleteRequiredCount).toBe(1);
    expect(summary.completedOptionalCount).toBe(1);
    expect(summary.skippedOptionalCount).toBe(2);
  });

  it("sums accumulated active minutes across all steps", () => {
    const summary = summarizeSteps([
      step("s1", "completed", { accumulatedActiveMinutes: 30 }),
      step("s2", "completed", { accumulatedActiveMinutes: 45 }),
      step("opt1", "completed", {
        optional: true,
        accumulatedActiveMinutes: 15,
      }),
    ]);
    expect(summary.totalActiveMinutes).toBe(90);
  });

  it("returns zero counts on empty step list", () => {
    const summary = summarizeSteps([]);
    expect(summary).toEqual({
      completedRequiredCount: 0,
      incompleteRequiredCount: 0,
      completedOptionalCount: 0,
      skippedOptionalCount: 0,
      totalActiveMinutes: 0,
    });
  });
});

// ==========================================================================
// complete use case
// ==========================================================================

describe("createTerminalUseCase — complete", () => {
  it("completes a WO when all required steps are done", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [
          step("s1", "completed", { accumulatedActiveMinutes: 30 }),
          step("s2", "completed", { accumulatedActiveMinutes: 15 }),
        ],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.terminalState).toBe("completed");
    expect(result.snapshot.reachedAt).toEqual(FIXED_NOW);
    expect(result.snapshot.reachedBy).toBe("u-supervisor-1");
    expect(result.snapshot.finalMilestone).toBe("ready_for_pickup");
    expect(result.snapshot.stepSummary.completedRequiredCount).toBe(2);
    expect(result.snapshot.stepSummary.totalActiveMinutes).toBe(45);
    expect(result.snapshot.cancellationReasonCode).toBeUndefined();

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.completed");
    const payload = events[0].payload as WorkOrderCompletedPayload;
    expect(payload.finalMilestone).toBe("ready_for_pickup");
    expect(payload.completedRequiredCount).toBe(2);
    expect(payload.totalActiveMinutes).toBe(45);
    expect(payload.completedBy).toBe("u-supervisor-1");
  });

  it("rejects completion with not_all_required_steps_completed when a required step is open", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "in_production",
        trackedSteps: [
          step("s1", "completed"),
          step("s2", "ready"),
        ],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_all_required_steps_completed");
    expect(result.error.incompleteStepIds).toEqual(["s2"]);
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects completion when WO is already terminal", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "completed",
        currentTerminalState: "completed",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_terminal");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects completion with empty workOrderId / completedBy", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const emptyWo = await useCase.complete(
      {
        workOrderId: "  ",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [],
      },
      SUPERVISOR
    );
    expect(emptyWo.ok).toBe(false);
    if (!emptyWo.ok) expect(emptyWo.error.code).toBe("invalid_command");

    const emptyBy = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [],
      },
      SUPERVISOR
    );
    expect(emptyBy.ok).toBe(false);
    if (!emptyBy.ok) expect(emptyBy.error.code).toBe("invalid_command");

    expect(await eventLog.size()).toBe(0);
  });

  it("uses injected clock for reachedAt", async () => {
    const frozen = new Date("2027-03-15T10:30:00Z");
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => frozen,
    });

    const result = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.reachedAt).toEqual(frozen);
  });

  it("emits exactly one event on successful completion", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );

    expect(await eventLog.size()).toBe(1);
  });

  it("records optional-skipped counts in the completed payload", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [
          step("s1", "completed"),
          step("opt1", "completed", { optional: true }),
          step("opt2", "ready", { optional: true }),
          step("opt3", "ready", { optional: true }),
        ],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    const events = await eventLog.listByWorkOrder("wo-1");
    const payload = events[0].payload as WorkOrderCompletedPayload;
    expect(payload.completedOptionalCount).toBe(1);
    expect(payload.skippedOptionalCount).toBe(2);
  });
});

// ==========================================================================
// cancel use case
// ==========================================================================

describe("createTerminalUseCase — cancel", () => {
  it("cancels a WO with a coded reason", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        reasonCode: "customer_request",
        trackedSteps: [
          step("s1", "completed", { accumulatedActiveMinutes: 20 }),
          step("s2", "in_progress", { accumulatedActiveMinutes: 15 }),
        ],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.terminalState).toBe("cancelled");
    expect(result.snapshot.cancellationReasonCode).toBe("customer_request");
    expect(result.snapshot.finalMilestone).toBe("in_production");
    expect(result.snapshot.stepSummary.completedRequiredCount).toBe(1);
    expect(result.snapshot.stepSummary.incompleteRequiredCount).toBe(1);
    expect(result.snapshot.stepSummary.totalActiveMinutes).toBe(35);

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.cancelled");
    const payload = events[0].payload as WorkOrderCancelledPayload;
    expect(payload.reasonCode).toBe("customer_request");
    expect(payload.cancelledAtMilestone).toBe("in_production");
    expect(payload.completedRequiredCount).toBe(1);
    expect(payload.incompleteRequiredCount).toBe(1);
    expect(payload.cancelledBy).toBe("u-supervisor-1");
  });

  it("accepts every non-'other' reasonCode without requiring reasonDetail", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const codes: ReadonlyArray<CancellationReasonCode> = [
      "customer_request",
      "unable_to_fulfill",
      "quality_failure",
      "duplicate_order",
      "superseded_by_change_order",
    ];

    let seq = 0;
    for (const reasonCode of codes) {
      seq += 1;
      const result = await useCase.cancel(
        {
          workOrderId: `wo-${seq}`,
          cancelledBy: "u-supervisor-1",
          currentMilestone: "routed",
          reasonCode,
          trackedSteps: [step("s1", "ready")],
        },
        SUPERVISOR
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.snapshot.cancellationReasonCode).toBe(reasonCode);
    }

    expect(await eventLog.size()).toBe(codes.length);
  });

  it("requires reasonDetail when reasonCode is 'other'", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const missing = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        reasonCode: "other",
        trackedSteps: [step("s1", "ready")],
      },
      SUPERVISOR
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe("reason_detail_required");

    const blank = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        reasonCode: "other",
        reasonDetail: "   ",
        trackedSteps: [step("s1", "ready")],
      },
      SUPERVISOR
    );
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.error.code).toBe("reason_detail_required");

    expect(await eventLog.size()).toBe(0);
  });

  it("accepts 'other' with a reasonDetail and records it on the event", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        reasonCode: "other",
        reasonDetail: "Shop fire, entire batch scrapped",
        trackedSteps: [step("s1", "in_progress")],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    const events = await eventLog.listByWorkOrder("wo-1");
    const payload = events[0].payload as WorkOrderCancelledPayload;
    expect(payload.reasonCode).toBe("other");
    expect(payload.reasonDetail).toBe("Shop fire, entire batch scrapped");
  });

  it("refuses to cancel a WO already at 'completed' milestone", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "completed",
        reasonCode: "customer_request",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("refuses cancel when WO is already terminal (already_terminal)", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        currentTerminalState: "cancelled",
        reasonCode: "customer_request",
        trackedSteps: [step("s1", "ready")],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_terminal");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects cancel with empty workOrderId / cancelledBy", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const emptyWo = await useCase.cancel(
      {
        workOrderId: "",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "in_production",
        reasonCode: "customer_request",
        trackedSteps: [],
      },
      SUPERVISOR
    );
    expect(emptyWo.ok).toBe(false);
    if (!emptyWo.ok) expect(emptyWo.error.code).toBe("invalid_command");

    const emptyBy = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: " ",
        currentMilestone: "in_production",
        reasonCode: "customer_request",
        trackedSteps: [],
      },
      SUPERVISOR
    );
    expect(emptyBy.ok).toBe(false);
    if (!emptyBy.ok) expect(emptyBy.error.code).toBe("invalid_command");

    expect(await eventLog.size()).toBe(0);
  });

  it("allows cancellation from intake with no steps yet", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "intake",
        reasonCode: "duplicate_order",
        trackedSteps: [],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.stepSummary.completedRequiredCount).toBe(0);
    expect(result.snapshot.stepSummary.incompleteRequiredCount).toBe(0);
    expect(result.snapshot.stepSummary.totalActiveMinutes).toBe(0);
  });

  it("emits exactly one event on successful cancel", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: "routed",
        reasonCode: "duplicate_order",
        trackedSteps: [step("s1", "ready")],
      },
      SUPERVISOR
    );

    expect(await eventLog.size()).toBe(1);
  });
});

// ==========================================================================
// End-to-end
// ==========================================================================

describe("terminal — end-to-end", () => {
  it("complete then subsequent cancel-call rejects with already_terminal", async () => {
    const useCase = createTerminalUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const completed = await useCase.complete(
      {
        workOrderId: "wo-1",
        completedBy: "u-supervisor-1",
        currentMilestone: "ready_for_pickup",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;

    const cancel = await useCase.cancel(
      {
        workOrderId: "wo-1",
        cancelledBy: "u-supervisor-1",
        currentMilestone: completed.snapshot.finalMilestone,
        currentTerminalState: completed.snapshot.terminalState,
        reasonCode: "customer_request",
        trackedSteps: [step("s1", "completed")],
      },
      SUPERVISOR
    );

    expect(cancel.ok).toBe(false);
    if (cancel.ok) return;
    expect(cancel.error.code).toBe("already_terminal");

    // Still only the one completed event on the log.
    expect(await eventLog.size()).toBe(1);
  });
});
