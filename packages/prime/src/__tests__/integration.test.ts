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
 * PRIME Engine — Phase 1 cross-module integration harness
 *
 * Spec: PRIME-ENGINE-SPEC.md §3 (all sub-modules) + §16 (event catalog).
 *
 * This file is the regression net that proves the 10 PRIME modules
 * compose correctly on top of a single shared event log. No new business
 * logic — every assertion is a consequence of contracts already covered
 * by per-module unit tests.
 *
 * Scenarios:
 *   1. Happy path — WO from intake through terminal.complete.
 *   2. Cancellation — WO cancelled mid-flight via terminal.cancel.
 *   3. Change order + reroute — mid-flight change order approval driving
 *      an executeReroute call.
 *
 * Assertions lean on the event log as the source of truth. Each scenario
 * grabs `eventLog.listByWorkOrder(woId)` and checks the event-type sequence.
 *
 * If one of these scenarios breaks in the future, it almost certainly
 * means a sub-module changed its event-emission contract — check the
 * offending module's own tests first.
 */

import { describe, expect, it } from "vitest";

import {
  createAdvanceMilestoneUseCase,
  createAdvanceStepUseCase,
  createAssignPriorityUseCase,
  createChangeOrderUseCase,
  createCreateWorkOrderUseCase,
  createExecuteRerouteUseCase,
  createResolveTemplateUseCase,
  createRouteStepsUseCase,
  createTerminalUseCase,
} from "../index.js";
import type {
  PrioritizedStep,
  RoutedStep,
  StepSnapshot,
  TrackedStep,
  WorkOrderEvent,
  WorkOrderEventType,
} from "../index.js";

import {
  OPERATOR,
  SUPERVISOR,
  SYSTEM,
  buildIntakeInput,
  buildIntegrationEnv,
  fixedClock,
  pendingSnapshot,
  sequentialIdGenerator,
} from "./_integrationHelpers.js";

// ===========================================================================
// Happy path — full lifecycle
// ===========================================================================

describe("PRIME Phase 1 integration: happy path", () => {
  it("takes a WO from intake through terminal.complete and emits the expected event stream", async () => {
    const env = buildIntegrationEnv();
    const clock = fixedClock();

    const intake = createCreateWorkOrderUseCase({
      eventLog: env.eventLog,
      workOrderIdGenerator: sequentialIdGenerator("wo"),
      clock,
    });
    const template = createResolveTemplateUseCase({
      eventLog: env.eventLog,
      library: env.templateLibrary,
      stepIdGenerator: sequentialIdGenerator("step"),
      clock,
    });
    const routing = createRouteStepsUseCase({
      eventLog: env.eventLog,
      stationRegistry: env.stationRegistry,
    });
    const priority = createAssignPriorityUseCase({
      eventLog: env.eventLog,
      clock,
    });
    const advanceStep = createAdvanceStepUseCase({
      eventLog: env.eventLog,
      clock,
    });
    const advanceMilestone = createAdvanceMilestoneUseCase({
      eventLog: env.eventLog,
      clock,
    });
    const terminal = createTerminalUseCase({
      eventLog: env.eventLog,
      clock,
    });

    // ---- 1. Intake ----
    const intakeRes = await intake.execute(buildIntakeInput(), OPERATOR);
    expect(intakeRes.ok).toBe(true);
    if (!intakeRes.ok) return;
    const woId = intakeRes.draft.workOrderId;

    // ---- 2. Template resolution ----
    const tplRes = await template.execute(intakeRes.draft, OPERATOR);
    expect(tplRes.ok).toBe(true);
    if (!tplRes.ok) return;
    expect(tplRes.tentativeSteps.length).toBe(4);

    // ---- 3. Routing ----
    const routedRes = await routing.execute(
      { workOrderId: woId, tentativeSteps: tplRes.tentativeSteps },
      OPERATOR
    );
    expect(routedRes.ok).toBe(true);
    if (!routedRes.ok) return;
    expect(routedRes.routedSteps.length).toBe(4);

    // ---- 4. Priority ----
    const priRes = await priority.execute(
      {
        workOrderId: woId,
        priorityLevel: "medium",
        createdAt: intakeRes.draft.createdAt,
        dueDate: intakeRes.draft.dueDate,
        routedSteps: routedRes.routedSteps,
      },
      OPERATOR
    );
    expect(priRes.ok).toBe(true);
    const prioritized = priRes.prioritizedSteps;

    // ---- 5. Initial milestone advance (intake → routed) ----
    const initialTracked = prioritized.map((ps) =>
      trackedStepFromPrioritized(ps, routedRes.routedSteps, "pending", 0)
    );
    const m1 = await advanceMilestone.execute(
      {
        workOrderId: woId,
        trackedSteps: initialTracked,
        hasRoutingEvent: true,
      },
      SYSTEM
    );
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    // ---- 6. Drive each step ready → start → complete in dependency order ----
    const snapshots = new Map<string, StepSnapshot>();
    for (const ps of prioritized) {
      snapshots.set(
        ps.tentativeStepId,
        pendingSnapshot(woId, ps.tentativeStepId, ps.dependsOn)
      );
    }

    const ordered = topoSort(prioritized);
    for (const ps of ordered) {
      const current = snapshots.get(ps.tentativeStepId);
      if (!current) throw new Error(`missing snapshot for ${ps.tentativeStepId}`);
      const others = [...snapshots.values()].filter(
        (s) => s.stepId !== ps.tentativeStepId
      );

      const readyRes = await advanceStep.execute(
        {
          currentSnapshot: current,
          command: {
            kind: "mark_ready",
            stepId: ps.tentativeStepId,
            workOrderId: woId,
          },
          otherSnapshots: others,
        },
        SYSTEM
      );
      expect(readyRes.ok).toBe(true);
      if (!readyRes.ok) return;
      snapshots.set(ps.tentativeStepId, readyRes.snapshot);

      const startRes = await advanceStep.execute(
        {
          currentSnapshot: readyRes.snapshot,
          command: {
            kind: "start",
            stepId: ps.tentativeStepId,
            workOrderId: woId,
            operatorId: "u-operator-1",
          },
        },
        OPERATOR
      );
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;
      snapshots.set(ps.tentativeStepId, startRes.snapshot);

      const doneRes = await advanceStep.execute(
        {
          currentSnapshot: startRes.snapshot,
          command: {
            kind: "complete",
            stepId: ps.tentativeStepId,
            workOrderId: woId,
          },
        },
        OPERATOR
      );
      expect(doneRes.ok).toBe(true);
      if (!doneRes.ok) return;
      snapshots.set(ps.tentativeStepId, doneRes.snapshot);
    }

    // ---- 7. Final milestone advance (→ completed) ----
    const finalTracked: TrackedStep[] = prioritized.map((ps) => {
      const snap = snapshots.get(ps.tentativeStepId);
      return trackedStepFromPrioritized(
        ps,
        routedRes.routedSteps,
        "completed",
        snap?.accumulatedActiveMinutes ?? 0
      );
    });
    const m2 = await advanceMilestone.execute(
      {
        workOrderId: woId,
        trackedSteps: finalTracked,
        hasRoutingEvent: true,
        previousProjection: m1.projection,
      },
      SYSTEM
    );
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;
    expect(m2.projection.currentMilestone).toBe("completed");

    // ---- 8. Terminal complete ----
    const termRes = await terminal.complete(
      {
        workOrderId: woId,
        completedBy: "u-supervisor-1",
        trackedSteps: finalTracked,
        currentMilestone: m2.projection.currentMilestone,
      },
      SUPERVISOR
    );
    expect(termRes.ok).toBe(true);
    if (!termRes.ok) return;
    expect(termRes.snapshot.terminalState).toBe("completed");

    // ---- 9. Event-stream assertions ----
    const events = await env.eventLog.listByWorkOrder(woId);
    const types = events.map((e) => e.type);

    // First event is always intake.created, last is work_order.completed.
    expect(types[0]).toBe<WorkOrderEventType>("work_order.intake.created");
    expect(types[types.length - 1]).toBe<WorkOrderEventType>(
      "work_order.completed"
    );

    // Each one-shot module event appears exactly once.
    expect(countType(types, "work_order.intake.created")).toBe(1);
    expect(countType(types, "work_order.template.resolved")).toBe(1);
    expect(countType(types, "work_order.routing.assigned")).toBe(1);
    expect(countType(types, "work_order.priority.assigned")).toBe(1);
    expect(countType(types, "work_order.completed")).toBe(1);

    // Step events: 4 steps × (ready + started + completed).
    expect(countType(types, "step.ready")).toBe(4);
    expect(countType(types, "step.started")).toBe(4);
    expect(countType(types, "step.completed")).toBe(4);

    // Milestone advanced twice: intake→routed (m1) and routed→completed (m2).
    expect(countType(types, "work_order.milestone.advanced")).toBe(2);

    // ETA updated at least once (initial baseline announcement). Exact count
    // depends on drift thresholds between m1 and m2 — relaxing to >= 1 keeps
    // the test robust to future threshold tuning.
    expect(countType(types, "work_order.eta.updated")).toBeGreaterThanOrEqual(1);

    // No rejection / failure events should ever surface on the happy path.
    expect(countType(types, "work_order.intake.validation_failed")).toBe(0);
    expect(countType(types, "work_order.cancelled")).toBe(0);
    expect(countType(types, "step.blocked")).toBe(0);

    // Cross-module payload consistency: intake → template → routing → priority
    // should all agree on line-item / step counts.
    const intakeEvt = findEvent(events, "work_order.intake.created");
    const tplEvt = findEvent(events, "work_order.template.resolved");
    const routeEvt = findEvent(events, "work_order.routing.assigned");
    const priEvt = findEvent(events, "work_order.priority.assigned");
    const completedEvt = findEvent(events, "work_order.completed");

    expect((intakeEvt.payload as { lineItemCount: number }).lineItemCount).toBe(
      1
    );
    expect(
      (tplEvt.payload as { lineItemCount: number; stepCount: number })
        .lineItemCount
    ).toBe(1);
    expect(
      (tplEvt.payload as { stepCount: number }).stepCount
    ).toBe(4);
    expect(
      (routeEvt.payload as { stepCount: number }).stepCount
    ).toBe(4);
    expect(
      (priEvt.payload as { stepCount: number }).stepCount
    ).toBe(4);
    expect(
      (completedEvt.payload as { completedRequiredCount: number })
        .completedRequiredCount
    ).toBe(4);

    // Every event references the same workOrderId. Guards against a module
    // emitting events to the wrong WO during composition.
    for (const ev of events) {
      expect(ev.workOrderId).toBe(woId);
    }

    // Sequence numbers are strictly increasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequenceNumber).toBeGreaterThan(
        events[i - 1].sequenceNumber
      );
    }
  });
});

// ===========================================================================
// Cancellation mid-flight
// ===========================================================================

describe("PRIME Phase 1 integration: cancellation mid-flight", () => {
  it("cancels a routed WO and ends the stream with work_order.cancelled", async () => {
    const env = buildIntegrationEnv();
    const clock = fixedClock();

    const intake = createCreateWorkOrderUseCase({
      eventLog: env.eventLog,
      workOrderIdGenerator: sequentialIdGenerator("wo"),
      clock,
    });
    const template = createResolveTemplateUseCase({
      eventLog: env.eventLog,
      library: env.templateLibrary,
      stepIdGenerator: sequentialIdGenerator("step"),
      clock,
    });
    const routing = createRouteStepsUseCase({
      eventLog: env.eventLog,
      stationRegistry: env.stationRegistry,
    });
    const terminal = createTerminalUseCase({
      eventLog: env.eventLog,
      clock,
    });

    const intakeRes = await intake.execute(buildIntakeInput(), OPERATOR);
    expect(intakeRes.ok).toBe(true);
    if (!intakeRes.ok) return;
    const woId = intakeRes.draft.workOrderId;

    const tplRes = await template.execute(intakeRes.draft, OPERATOR);
    expect(tplRes.ok).toBe(true);
    if (!tplRes.ok) return;

    const routedRes = await routing.execute(
      { workOrderId: woId, tentativeSteps: tplRes.tentativeSteps },
      OPERATOR
    );
    expect(routedRes.ok).toBe(true);
    if (!routedRes.ok) return;

    // Nothing has started — every tracked step is still pending.
    const tracked: TrackedStep[] = routedRes.routedSteps.map((rs) => ({
      stepId: rs.tentativeStepId,
      state: "pending",
      optional: rs.optional,
      estimatedDurationMinutes: rs.estimatedDurationMinutes,
      accumulatedActiveMinutes: 0,
      dependsOn: rs.dependsOn,
      workstationClass: rs.workstationClass,
    }));

    const cancelRes = await terminal.cancel(
      {
        workOrderId: woId,
        cancelledBy: "u-supervisor-1",
        trackedSteps: tracked,
        currentMilestone: "routed",
        reasonCode: "customer_request",
      },
      SUPERVISOR
    );
    expect(cancelRes.ok).toBe(true);
    if (!cancelRes.ok) return;
    expect(cancelRes.snapshot.terminalState).toBe("cancelled");
    expect(cancelRes.snapshot.cancellationReasonCode).toBe("customer_request");

    const events = await env.eventLog.listByWorkOrder(woId);
    const types = events.map((e) => e.type);

    // Strict stream — cancellation path emits exactly 4 events.
    expect(types).toEqual<WorkOrderEventType[]>([
      "work_order.intake.created",
      "work_order.template.resolved",
      "work_order.routing.assigned",
      "work_order.cancelled",
    ]);

    const cancelledEvt = findEvent(events, "work_order.cancelled");
    const payload = cancelledEvt.payload as {
      reasonCode: string;
      cancelledAtMilestone: string;
      incompleteRequiredCount: number;
    };
    expect(payload.reasonCode).toBe("customer_request");
    expect(payload.cancelledAtMilestone).toBe("routed");
    expect(payload.incompleteRequiredCount).toBe(4);
  });
});

// ===========================================================================
// Change order + reroute
// ===========================================================================

describe("PRIME Phase 1 integration: change order + reroute", () => {
  it("creates, approves, and executes a reroute — events logged in order", async () => {
    const env = buildIntegrationEnv();
    const clock = fixedClock();

    const intake = createCreateWorkOrderUseCase({
      eventLog: env.eventLog,
      workOrderIdGenerator: sequentialIdGenerator("wo"),
      clock,
    });
    const template = createResolveTemplateUseCase({
      eventLog: env.eventLog,
      library: env.templateLibrary,
      stepIdGenerator: sequentialIdGenerator("step"),
      clock,
    });
    const routing = createRouteStepsUseCase({
      eventLog: env.eventLog,
      stationRegistry: env.stationRegistry,
    });
    const changeOrders = createChangeOrderUseCase({
      eventLog: env.eventLog,
      clock,
    });
    const reroute = createExecuteRerouteUseCase({
      eventLog: env.eventLog,
      stationRegistry: env.stationRegistry,
    });

    const intakeRes = await intake.execute(buildIntakeInput(), OPERATOR);
    expect(intakeRes.ok).toBe(true);
    if (!intakeRes.ok) return;
    const woId = intakeRes.draft.workOrderId;

    const tplRes = await template.execute(intakeRes.draft, OPERATOR);
    expect(tplRes.ok).toBe(true);
    if (!tplRes.ok) return;

    const routedRes = await routing.execute(
      { workOrderId: woId, tentativeSteps: tplRes.tentativeSteps },
      OPERATOR
    );
    expect(routedRes.ok).toBe(true);
    if (!routedRes.ok) return;

    // Find the assembly step — we have two assembly benches so we can
    // reroute between them.
    const assemblyStep = routedRes.routedSteps.find(
      (rs) => rs.workstationClass === "hand_assembly"
    );
    if (!assemblyStep) throw new Error("assembly step not routed");
    const targetStationId =
      assemblyStep.stationId === "station-assembly-1"
        ? "station-assembly-2"
        : "station-assembly-1";

    // ---- Create change order ----
    const createRes = await changeOrders.create(
      {
        id: "co-1",
        workOrderId: woId,
        kind: "modify_spec",
        description: "Customer wants matte finish instead of gloss",
        requestedBy: "cust-001",
      },
      SUPERVISOR
    );
    expect(createRes.ok).toBe(true);
    if (!createRes.ok) return;
    expect(createRes.changeOrder.status).toBe("pending");

    // ---- Approve change order ----
    const approveRes = await changeOrders.approve(
      {
        changeOrder: createRes.changeOrder,
        reviewer: "u-supervisor-1",
      },
      SUPERVISOR
    );
    expect(approveRes.ok).toBe(true);
    if (!approveRes.ok) return;
    expect(approveRes.changeOrder.status).toBe("approved");

    // ---- Execute reroute ----
    const rerouteRes = await reroute.execute(
      {
        workOrderId: woId,
        stepId: assemblyStep.tentativeStepId,
        fromStationId: assemblyStep.stationId,
        toStationId: targetStationId,
        reason: "Balance assembly bench load per approved change order",
        currentStepState: "ready",
        workstationClass: "hand_assembly",
        requiredSkillTags: ["assembly"],
      },
      SUPERVISOR
    );
    expect(rerouteRes.ok).toBe(true);
    if (!rerouteRes.ok) return;
    expect(rerouteRes.reroute.fromStationId).toBe(assemblyStep.stationId);
    expect(rerouteRes.reroute.toStationId).toBe(targetStationId);

    const events = await env.eventLog.listByWorkOrder(woId);
    const types = events.map((e) => e.type);

    // Strict stream — intake + template + routing + CO lifecycle + reroute.
    expect(types).toEqual<WorkOrderEventType[]>([
      "work_order.intake.created",
      "work_order.template.resolved",
      "work_order.routing.assigned",
      "work_order.change_order.created",
      "work_order.change_order.approved",
      "work_order.reroute.executed",
    ]);

    const createdEvt = findEvent(events, "work_order.change_order.created");
    expect((createdEvt.payload as { kind: string }).kind).toBe("modify_spec");

    const approvedEvt = findEvent(events, "work_order.change_order.approved");
    expect((approvedEvt.payload as { reviewer: string }).reviewer).toBe(
      "u-supervisor-1"
    );

    const rerouteEvt = findEvent(events, "work_order.reroute.executed");
    const reroutePayload = rerouteEvt.payload as {
      fromStationId: string;
      toStationId: string;
      stepStateAtReroute: string;
    };
    expect(reroutePayload.fromStationId).toBe(assemblyStep.stationId);
    expect(reroutePayload.toStationId).toBe(targetStationId);
    expect(reroutePayload.stepStateAtReroute).toBe("ready");
  });
});

// ===========================================================================
// Test-local helpers
// ===========================================================================

function countType(
  types: ReadonlyArray<WorkOrderEventType>,
  target: WorkOrderEventType
): number {
  let n = 0;
  for (const t of types) {
    if (t === target) n += 1;
  }
  return n;
}

function findEvent(
  events: ReadonlyArray<WorkOrderEvent>,
  type: WorkOrderEventType
): WorkOrderEvent {
  const found = events.find((e) => e.type === type);
  if (!found) {
    throw new Error(
      `expected event of type '${type}' to be present in stream; got: ${events
        .map((e) => e.type)
        .join(", ")}`
    );
  }
  return found;
}

/**
 * Assemble a `TrackedStep` for milestone/terminal input. Pulls the
 * `workstationClass` from the matching routed step (tracking uses it to
 * detect the QC phase) and takes state + accumulated minutes from the
 * caller.
 */
function trackedStepFromPrioritized(
  ps: PrioritizedStep,
  routedSteps: ReadonlyArray<RoutedStep>,
  state: TrackedStep["state"],
  accumulatedActiveMinutes: number
): TrackedStep {
  const routed = routedSteps.find((r) => r.tentativeStepId === ps.tentativeStepId);
  return {
    stepId: ps.tentativeStepId,
    state,
    optional: ps.optional,
    estimatedDurationMinutes: ps.estimatedDurationMinutes,
    accumulatedActiveMinutes,
    dependsOn: ps.dependsOn,
    workstationClass: routed?.workstationClass,
  };
}

/**
 * Dependency-order topological sort of prioritized steps. Given that
 * `dependsOn` is already a DAG keyed on `tentativeStepId`, a DFS-based
 * topo sort produces the only valid execution order for our happy-path
 * scenario.
 */
function topoSort(
  steps: ReadonlyArray<PrioritizedStep>
): ReadonlyArray<PrioritizedStep> {
  const byId = new Map<string, PrioritizedStep>();
  for (const s of steps) byId.set(s.tentativeStepId, s);

  const sorted: PrioritizedStep[] = [];
  const visited = new Set<string>();

  const visit = (s: PrioritizedStep) => {
    if (visited.has(s.tentativeStepId)) return;
    visited.add(s.tentativeStepId);
    for (const depId of s.dependsOn) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    sorted.push(s);
  };

  for (const s of steps) visit(s);
  return sorted;
}

