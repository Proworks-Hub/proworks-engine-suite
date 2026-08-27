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
 * PRIME Engine — WorkOrderSummary reducer tests
 *
 * Pure-function tests: we fabricate event records directly (no use cases, no
 * event log) so each case exercises exactly one fold in isolation. This keeps
 * the reducer's contract observable independent of upstream emitters.
 */

import { describe, it, expect } from "vitest";

import type {
  EventActor,
  WorkOrderEvent,
  WorkOrderEventType,
} from "../../models/events";
import type { IntakeCreatedPayload } from "../../core/intake/intakeTypes";

import {
  foldEvents,
  reduceWorkOrderSummary,
} from "../workOrderSummaryReducer";
import type { WorkOrderSummary } from "../workOrderSummaryTypes";

// ---------- Fixture helpers ----------

const WO = "wo-1";
const T0 = "2026-04-01T09:00:00.000Z";

const OPERATOR: EventActor = {
  kind: "user",
  userId: "u-operator-1",
  role: "operator",
};

let _seq = 0;
let _evt = 0;

function resetCounters() {
  _seq = 0;
  _evt = 0;
}

function evt<T>(
  type: WorkOrderEventType,
  payload: T,
  overrides: Partial<WorkOrderEvent<T>> = {}
): WorkOrderEvent<T> {
  return {
    id: `evt-${++_evt}`,
    sequenceNumber: ++_seq,
    workOrderId: WO,
    type,
    actor: OPERATOR,
    timestamp: T0,
    payload,
    ...overrides,
  };
}

function intake(
  overrides: Partial<IntakeCreatedPayload> = {}
): WorkOrderEvent<IntakeCreatedPayload> {
  return evt("work_order.intake.created", {
    source: "manual",
    customerId: "cust-1",
    customerName: "Acme Co",
    priority: "medium",
    lineItemCount: 1,
    dueDate: "2026-04-15",
    ...overrides,
  });
}

function bootstrap(): WorkOrderSummary {
  resetCounters();
  const s = reduceWorkOrderSummary(null, intake());
  expect(s).not.toBeNull();
  return s as WorkOrderSummary;
}

// ---------- Bootstrap ----------

describe("reduceWorkOrderSummary — bootstrap", () => {
  it("returns null for pre-intake events", () => {
    resetCounters();
    const e = evt("work_order.routing.assigned", {
      stepCount: 4,
      stationLoadSummary: [],
    });
    expect(reduceWorkOrderSummary(null, e)).toBeNull();
  });

  it("bootstraps from intake.created with customer, priority, dueDate", () => {
    const s = bootstrap();
    expect(s.workOrderId).toBe(WO);
    expect(s.customerId).toBe("cust-1");
    expect(s.customerName).toBe("Acme Co");
    expect(s.intakePriority).toBe("medium");
    expect(s.milestone).toBe("intake");
    expect(s.milestoneEnteredAt).toBe(T0);
    expect(s.totalSteps).toBeNull();
    expect(s.priorityLevel).toBeNull();
    expect(s.terminalState).toBeNull();
    expect(s.dueDate).toBe("2026-04-15");
    expect(s.lineItemCount).toBe(1);
    expect(s.lastEventSequence).toBe(1);
  });

  it("freezes the returned summary", () => {
    const s = bootstrap();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.stepStates)).toBe(true);
    expect(Object.isFrozen(s.eta)).toBe(true);
    expect(Object.isFrozen(s.openChangeOrderIds)).toBe(true);
  });
});

// ---------- Routing / priority ----------

describe("reduceWorkOrderSummary — routing + priority", () => {
  it("routing.assigned sets totalSteps", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.routing.assigned", {
        stepCount: 4,
        stationLoadSummary: [],
      })
    ) as WorkOrderSummary;
    expect(s.totalSteps).toBe(4);
  });

  it("priority.assigned sets level / score / color", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.priority.assigned", {
        priorityLevel: "high",
        priorityScore: 72,
        priorityColor: "yellow",
        scoreBreakdown: { base: 60, agingBump: 0, dueDateUrgency: 12, total: 72 },
        stepCount: 4,
      })
    ) as WorkOrderSummary;
    expect(s.priorityLevel).toBe("high");
    expect(s.priorityScore).toBe(72);
    expect(s.priorityColor).toBe("yellow");
  });
});

// ---------- Step lifecycle ----------

describe("reduceWorkOrderSummary — step lifecycle", () => {
  it("tracks state through ready → started → completed", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("step.ready", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("ready");
    expect(s.readyStepCount).toBe(1);

    s = reduceWorkOrderSummary(
      s,
      evt("step.started", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("in_progress");
    expect(s.activeStepCount).toBe(1);
    expect(s.readyStepCount).toBe(0);

    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.completed",
        { stepId: "s1", totalActiveMinutes: 42 },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("completed");
    expect(s.completedStepCount).toBe(1);
    expect(s.activeStepCount).toBe(0);
  });

  it("pause increments pauseCount and transitions state; resume returns to in_progress", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("step.ready", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      evt("step.started", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.paused",
        { stepId: "s1", activeMinutesAtPause: 10 },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("paused");
    expect(s.pausedStepCount).toBe(1);
    expect(s.pauseCount).toBe(1);

    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.resumed",
        { stepId: "s1", pauseCount: 1 },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("in_progress");
    expect(s.pausedStepCount).toBe(0);
    expect(s.activeStepCount).toBe(1);
    // pauseCount is cumulative across pauses; doesn't decrement on resume.
    expect(s.pauseCount).toBe(1);
  });

  it("block transitions state to blocked without changing pauseCount", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("step.ready", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.blocked",
        { stepId: "s1", reason: "missing material", fromState: "ready" },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.stepStates.s1).toBe("blocked");
    expect(s.blockedStepCount).toBe(1);
    expect(s.pauseCount).toBe(0);
  });

  it("issue_flagged and rework.logged are annotations, not state changes", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("step.ready", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      evt("step.started", { stepId: "s1" }, { stepId: "s1" })
    ) as WorkOrderSummary;

    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.issue_flagged",
        {
          stepId: "s1",
          code: "fit_off",
          severity: "major",
          description: "panel gap",
        },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.issueFlagCount).toBe(1);
    expect(s.stepStates.s1).toBe("in_progress");

    s = reduceWorkOrderSummary(
      s,
      evt(
        "step.rework.logged",
        { stepId: "s1", rootCause: "bad cut", minutesAdded: 20 },
        { stepId: "s1" }
      )
    ) as WorkOrderSummary;
    expect(s.reworkCount).toBe(1);
    expect(s.stepStates.s1).toBe("in_progress");
  });
});

// ---------- Change orders ----------

describe("reduceWorkOrderSummary — change orders", () => {
  it("created adds to openChangeOrderIds; approved/rejected removes + counts", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.change_order.created", {
        changeOrderId: "co-1",
        kind: "modify_spec",
        description: "swap color",
        requestedBy: "cust-1",
      })
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.change_order.created", {
        changeOrderId: "co-2",
        kind: "expedite",
        description: "rush",
        requestedBy: "cust-1",
      })
    ) as WorkOrderSummary;
    expect(s.openChangeOrderIds).toEqual(["co-1", "co-2"]);

    s = reduceWorkOrderSummary(
      s,
      evt("work_order.change_order.approved", {
        changeOrderId: "co-1",
        kind: "modify_spec",
        reviewer: "u-supervisor-1",
      })
    ) as WorkOrderSummary;
    expect(s.openChangeOrderIds).toEqual(["co-2"]);
    expect(s.approvedChangeOrderCount).toBe(1);

    s = reduceWorkOrderSummary(
      s,
      evt("work_order.change_order.rejected", {
        changeOrderId: "co-2",
        kind: "expedite",
        reviewer: "u-supervisor-1",
        rejectionReason: "capacity",
      })
    ) as WorkOrderSummary;
    expect(s.openChangeOrderIds).toEqual([]);
    expect(s.rejectedChangeOrderCount).toBe(1);
  });
});

// ---------- Milestone + ETA ----------

describe("reduceWorkOrderSummary — milestone + ETA", () => {
  it("milestone.advanced updates milestone and milestoneEnteredAt", () => {
    let s = bootstrap();
    const laterTs = "2026-04-01T10:00:00.000Z";
    s = reduceWorkOrderSummary(
      s,
      evt(
        "work_order.milestone.advanced",
        {
          fromMilestone: "intake",
          toMilestone: "routed",
          completedStepCount: 0,
          totalStepCount: 4,
          percentComplete: 0,
        },
        { timestamp: laterTs }
      )
    ) as WorkOrderSummary;
    expect(s.milestone).toBe("routed");
    expect(s.milestoneEnteredAt).toBe(laterTs);
  });

  it("eta.updated sets estimatedCompletionAt + confidence; firm clears reasons", () => {
    let s = bootstrap();
    // First raise risk...
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.eta.at_risk", {
        riskReason: "dependency_blocked",
        minutesOverBaseline: 0,
        currentMilestone: "in_production",
      })
    ) as WorkOrderSummary;
    expect(s.eta.atRisk).toBe(true);
    expect(s.eta.riskReasons).toEqual(["dependency_blocked"]);
    // ... then send a firm update — reasons should clear.
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.eta.updated", {
        newEtaAt: "2026-04-16T17:00:00.000Z",
        driftMinutes: -30,
        confidence: "firm",
      })
    ) as WorkOrderSummary;
    expect(s.eta.estimatedCompletionAt).toBe("2026-04-16T17:00:00.000Z");
    expect(s.eta.confidence).toBe("firm");
    expect(s.eta.atRisk).toBe(false);
    expect(s.eta.riskReasons).toEqual([]);
  });

  it("eta.at_risk accumulates unique reasons (dedupe)", () => {
    let s = bootstrap();
    const mkRisk = (reason: "overdue_step" | "dependency_blocked") =>
      evt("work_order.eta.at_risk", {
        riskReason: reason,
        minutesOverBaseline: 10,
        currentMilestone: "in_production",
      });
    s = reduceWorkOrderSummary(s, mkRisk("overdue_step")) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      mkRisk("dependency_blocked")
    ) as WorkOrderSummary;
    s = reduceWorkOrderSummary(
      s,
      mkRisk("overdue_step") // duplicate
    ) as WorkOrderSummary;
    expect(s.eta.riskReasons).toEqual([
      "overdue_step",
      "dependency_blocked",
    ]);
  });
});

// ---------- Terminal ----------

describe("reduceWorkOrderSummary — terminal", () => {
  it("work_order.completed freezes terminalState + reachedBy", () => {
    let s = bootstrap();
    const ts = "2026-04-05T17:00:00.000Z";
    s = reduceWorkOrderSummary(
      s,
      evt(
        "work_order.completed",
        {
          finalMilestone: "ready_for_pickup",
          completedRequiredCount: 4,
          completedOptionalCount: 0,
          skippedOptionalCount: 0,
          totalActiveMinutes: 100,
          completedBy: "u-supervisor-1",
        },
        { timestamp: ts }
      )
    ) as WorkOrderSummary;
    expect(s.terminalState).toBe("completed");
    expect(s.terminalReachedAt).toBe(ts);
    expect(s.terminalReachedBy).toBe("u-supervisor-1");
  });

  it("work_order.cancelled freezes terminalState = cancelled", () => {
    let s = bootstrap();
    s = reduceWorkOrderSummary(
      s,
      evt("work_order.cancelled", {
        reasonCode: "customer_request",
        cancelledAtMilestone: "routed",
        completedRequiredCount: 0,
        incompleteRequiredCount: 4,
        totalActiveMinutes: 0,
        cancelledBy: "u-supervisor-1",
      })
    ) as WorkOrderSummary;
    expect(s.terminalState).toBe("cancelled");
    expect(s.terminalReachedBy).toBe("u-supervisor-1");
  });
});

// ---------- Mismatch + fold ----------

describe("reduceWorkOrderSummary — mismatch handling", () => {
  it("foreign workOrderId leaves summary unchanged", () => {
    const s = bootstrap();
    const foreign = evt(
      "work_order.routing.assigned",
      { stepCount: 99, stationLoadSummary: [] },
      { workOrderId: "wo-other" }
    );
    const after = reduceWorkOrderSummary(s, foreign) as WorkOrderSummary;
    expect(after).toBe(s); // same reference
    expect(after.totalSteps).toBeNull();
  });
});

describe("foldEvents", () => {
  it("folds a full stream into a coherent summary", () => {
    resetCounters();
    const events: WorkOrderEvent[] = [
      intake(),
      evt("work_order.routing.assigned", {
        stepCount: 2,
        stationLoadSummary: [],
      }),
      evt("work_order.priority.assigned", {
        priorityLevel: "medium",
        priorityScore: 50,
        priorityColor: "green",
        scoreBreakdown: { base: 50, agingBump: 0, dueDateUrgency: 0, total: 50 },
        stepCount: 2,
      }),
      evt("step.ready", { stepId: "s1" }, { stepId: "s1" }),
      evt("step.started", { stepId: "s1" }, { stepId: "s1" }),
      evt(
        "step.completed",
        { stepId: "s1", totalActiveMinutes: 20 },
        { stepId: "s1" }
      ),
      evt("step.ready", { stepId: "s2" }, { stepId: "s2" }),
      evt("step.started", { stepId: "s2" }, { stepId: "s2" }),
      evt(
        "step.completed",
        { stepId: "s2", totalActiveMinutes: 15 },
        { stepId: "s2" }
      ),
      evt("work_order.completed", {
        finalMilestone: "ready_for_pickup",
        completedRequiredCount: 2,
        completedOptionalCount: 0,
        skippedOptionalCount: 0,
        totalActiveMinutes: 35,
        completedBy: "u-supervisor-1",
      }),
    ];
    const { summary, errors } = foldEvents(events);
    expect(errors).toEqual([]);
    expect(summary).not.toBeNull();
    const s = summary as WorkOrderSummary;
    expect(s.totalSteps).toBe(2);
    expect(s.completedStepCount).toBe(2);
    expect(s.priorityColor).toBe("green");
    expect(s.terminalState).toBe("completed");
  });

  it("records pre_intake_event error but continues folding", () => {
    resetCounters();
    const events: WorkOrderEvent[] = [
      evt("work_order.routing.assigned", {
        stepCount: 4,
        stationLoadSummary: [],
      }),
      intake(),
    ];
    const { summary, errors } = foldEvents(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("pre_intake_event");
    expect(summary).not.toBeNull();
    expect((summary as WorkOrderSummary).workOrderId).toBe(WO);
  });

  it("records invalid_event error for step event without stepId", () => {
    resetCounters();
    const events: WorkOrderEvent[] = [
      intake(),
      evt("step.ready", { stepId: "s1" }), // no top-level stepId override
    ];
    const { errors } = foldEvents(events);
    expect(errors.some((e) => e.code === "invalid_event")).toBe(true);
  });

  it("records work_order_mismatch and skips foreign events", () => {
    resetCounters();
    const events: WorkOrderEvent[] = [
      intake(),
      evt(
        "work_order.routing.assigned",
        { stepCount: 99, stationLoadSummary: [] },
        { workOrderId: "wo-other" }
      ),
    ];
    const { summary, errors } = foldEvents(events);
    expect(errors.some((e) => e.code === "work_order_mismatch")).toBe(true);
    expect((summary as WorkOrderSummary).totalSteps).toBeNull();
  });
});
