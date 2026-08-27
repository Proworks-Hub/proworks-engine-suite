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
import type { StepState } from "../../taskflow/taskFlowTypes.js";
import type {
  EtaAtRiskPayload,
  EtaUpdatedPayload,
  MilestoneAdvancedPayload,
  TrackedStep,
  WorkOrderProjection,
} from "../trackingTypes.js";
import { MILESTONE_ORDER } from "../trackingTypes.js";
import {
  assessEtaRisk,
  computeProgress,
  deriveMilestone,
  estimateCompletionAt,
  isForwardTransition,
  milestoneIndex,
} from "../milestoneRules.js";
import { createAdvanceMilestoneUseCase } from "../advanceMilestoneUseCase.js";

// ---------- Fixtures ----------

const SYSTEM: EventActor = { kind: "system", source: "prime.tracking" };

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

function baseProjection(
  overrides: Partial<WorkOrderProjection> = {}
): WorkOrderProjection {
  return {
    workOrderId: overrides.workOrderId ?? "wo-1",
    currentMilestone: overrides.currentMilestone ?? "intake",
    completedStepCount: overrides.completedStepCount ?? 0,
    totalStepCount: overrides.totalStepCount ?? 0,
    percentComplete: overrides.percentComplete ?? 0,
    estimatedCompletionAt: overrides.estimatedCompletionAt,
    etaConfidence: overrides.etaConfidence ?? "firm",
    etaRiskReason: overrides.etaRiskReason,
    lastUpdated: overrides.lastUpdated ?? FIXED_NOW,
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
// deriveMilestone
// ==========================================================================

describe("deriveMilestone", () => {
  it("returns intake when no steps exist", () => {
    expect(deriveMilestone([], true)).toBe("intake");
  });

  it("returns intake when hasRoutingEvent is false regardless of steps", () => {
    const steps = [step("s1", "ready")];
    expect(deriveMilestone(steps, false)).toBe("intake");
  });

  it("returns routed when routed + nothing started", () => {
    const steps = [step("s1", "ready"), step("s2", "pending")];
    expect(deriveMilestone(steps, true)).toBe("routed");
  });

  it("returns in_production when any step has been started", () => {
    const steps = [step("s1", "in_progress"), step("s2", "pending")];
    expect(deriveMilestone(steps, true)).toBe("in_production");
  });

  it("returns in_production when any step is completed but others remain", () => {
    const steps = [step("s1", "completed"), step("s2", "ready")];
    expect(deriveMilestone(steps, true)).toBe("in_production");
  });

  it("returns quality_check when all non-QC required completed + QC step active", () => {
    const steps = [
      step("s1", "completed"),
      step("s2", "completed"),
      step("qc1", "in_progress", { workstationClass: "quality_check" }),
    ];
    expect(deriveMilestone(steps, true)).toBe("quality_check");
  });

  it("returns quality_check when QC step is ready after other steps complete", () => {
    const steps = [
      step("s1", "completed"),
      step("qc1", "ready", { workstationClass: "quality_check" }),
    ];
    expect(deriveMilestone(steps, true)).toBe("quality_check");
  });

  it("returns ready_for_pickup when all required completed (no QC), optional remains", () => {
    const steps = [
      step("s1", "completed"),
      step("s2", "completed"),
      step("opt1", "ready", { optional: true }),
    ];
    expect(deriveMilestone(steps, true)).toBe("ready_for_pickup");
  });

  it("returns ready_for_pickup when QC also completed, optional still remains", () => {
    const steps = [
      step("s1", "completed"),
      step("qc1", "completed", { workstationClass: "quality_check" }),
      step("opt1", "ready", { optional: true }),
    ];
    expect(deriveMilestone(steps, true)).toBe("ready_for_pickup");
  });

  it("returns completed when every step is completed", () => {
    const steps = [
      step("s1", "completed"),
      step("s2", "completed"),
      step("opt1", "completed", { optional: true }),
    ];
    expect(deriveMilestone(steps, true)).toBe("completed");
  });
});

// ==========================================================================
// computeProgress
// ==========================================================================

describe("computeProgress", () => {
  it("counts only required steps toward total", () => {
    const steps = [
      step("s1", "completed"),
      step("s2", "ready"),
      step("opt1", "completed", { optional: true }),
    ];
    const p = computeProgress(steps);
    expect(p.totalStepCount).toBe(2);
    expect(p.completedStepCount).toBe(1);
    expect(p.percentComplete).toBe(50);
  });

  it("returns 0/0/0 when no required steps exist", () => {
    const p = computeProgress([step("opt1", "ready", { optional: true })]);
    expect(p.totalStepCount).toBe(0);
    expect(p.completedStepCount).toBe(0);
    expect(p.percentComplete).toBe(0);
  });

  it("returns 100 percent when every required step is completed", () => {
    const p = computeProgress([
      step("s1", "completed"),
      step("s2", "completed"),
    ]);
    expect(p.percentComplete).toBe(100);
  });

  it("rounds percent correctly (1 of 3 = 33)", () => {
    const p = computeProgress([
      step("s1", "completed"),
      step("s2", "ready"),
      step("s3", "ready"),
    ]);
    expect(p.percentComplete).toBe(33);
  });
});

// ==========================================================================
// estimateCompletionAt
// ==========================================================================

describe("estimateCompletionAt", () => {
  it("sums remaining minutes for non-completed required steps", () => {
    const steps = [
      step("s1", "ready", { estimatedDurationMinutes: 30 }),
      step("s2", "ready", { estimatedDurationMinutes: 45 }),
    ];
    const { eta, tentative } = estimateCompletionAt(steps, FIXED_NOW);
    expect(tentative).toBe(false);
    expect(eta).toEqual(new Date(FIXED_NOW.getTime() + 75 * 60_000));
  });

  it("subtracts accumulated from estimate for in-progress steps", () => {
    const steps = [
      step("s1", "in_progress", {
        estimatedDurationMinutes: 60,
        accumulatedActiveMinutes: 20,
      }),
    ];
    const { eta } = estimateCompletionAt(steps, FIXED_NOW);
    expect(eta).toEqual(new Date(FIXED_NOW.getTime() + 40 * 60_000));
  });

  it("clamps remaining at 0 when accumulated exceeds estimate", () => {
    const steps = [
      step("s1", "in_progress", {
        estimatedDurationMinutes: 30,
        accumulatedActiveMinutes: 50,
      }),
    ];
    const { eta } = estimateCompletionAt(steps, FIXED_NOW);
    expect(eta).toEqual(FIXED_NOW);
  });

  it("returns tentative=true when any required step lacks an estimate", () => {
    const steps = [
      step("s1", "ready", { estimatedDurationMinutes: 30 }),
      step("s2", "ready"),
    ];
    const { eta, tentative } = estimateCompletionAt(steps, FIXED_NOW);
    expect(tentative).toBe(true);
    // ETA still returned as a lower bound.
    expect(eta).toEqual(new Date(FIXED_NOW.getTime() + 30 * 60_000));
  });

  it("returns no ETA when remaining required steps all lack estimates", () => {
    const steps = [step("s1", "ready"), step("s2", "ready")];
    const { eta, tentative } = estimateCompletionAt(steps, FIXED_NOW);
    expect(eta).toBeUndefined();
    expect(tentative).toBe(true);
  });

  it("returns now when all required are completed", () => {
    const steps = [step("s1", "completed", { estimatedDurationMinutes: 30 })];
    const { eta, tentative } = estimateCompletionAt(steps, FIXED_NOW);
    expect(tentative).toBe(false);
    expect(eta).toEqual(FIXED_NOW);
  });

  it("excludes optional steps from the remaining-minutes sum", () => {
    const steps = [
      step("s1", "ready", { estimatedDurationMinutes: 30 }),
      step("opt1", "ready", {
        optional: true,
        estimatedDurationMinutes: 999,
      }),
    ];
    const { eta } = estimateCompletionAt(steps, FIXED_NOW);
    expect(eta).toEqual(new Date(FIXED_NOW.getTime() + 30 * 60_000));
  });
});

// ==========================================================================
// assessEtaRisk
// ==========================================================================

describe("assessEtaRisk", () => {
  it("flags dependency_blocked when any step is blocked", () => {
    const r = assessEtaRisk([
      step("s1", "in_progress", { estimatedDurationMinutes: 30 }),
      step("s2", "blocked"),
    ]);
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("dependency_blocked");
    expect(r.minutesOverBaseline).toBe(0);
  });

  it("flags overdue_step when a running step exceeds estimate * 1.25", () => {
    const r = assessEtaRisk([
      step("s1", "in_progress", {
        estimatedDurationMinutes: 30,
        accumulatedActiveMinutes: 40, // 30 * 1.25 = 37.5; 40 > 37.5
      }),
    ]);
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("overdue_step");
    expect(r.minutesOverBaseline).toBe(10);
  });

  it("does not flag overdue when running step is within 1.25x estimate", () => {
    const r = assessEtaRisk([
      step("s1", "in_progress", {
        estimatedDurationMinutes: 30,
        accumulatedActiveMinutes: 35, // 30 * 1.25 = 37.5; 35 < 37.5
      }),
    ]);
    expect(r.atRisk).toBe(false);
  });

  it("flags pace_below_estimate on aggregate slippage > 20%", () => {
    const r = assessEtaRisk([
      step("s1", "completed", {
        estimatedDurationMinutes: 20,
        accumulatedActiveMinutes: 25,
      }),
      step("s2", "completed", {
        estimatedDurationMinutes: 20,
        accumulatedActiveMinutes: 25,
      }),
      // sum: actual=50, estimated=40; 40 * 1.2 = 48; 50 > 48 → over
    ]);
    expect(r.atRisk).toBe(true);
    expect(r.reason).toBe("pace_below_estimate");
    expect(r.minutesOverBaseline).toBe(10);
  });

  it("does not flag risk when everything is on pace", () => {
    const r = assessEtaRisk([
      step("s1", "in_progress", {
        estimatedDurationMinutes: 30,
        accumulatedActiveMinutes: 10,
      }),
      step("s2", "ready", { estimatedDurationMinutes: 30 }),
    ]);
    expect(r.atRisk).toBe(false);
  });

  it("prefers dependency_blocked over overdue when both present", () => {
    const r = assessEtaRisk([
      step("s1", "in_progress", {
        estimatedDurationMinutes: 30,
        accumulatedActiveMinutes: 100, // overdue
      }),
      step("s2", "blocked"),
    ]);
    expect(r.reason).toBe("dependency_blocked");
  });
});

// ==========================================================================
// milestone ordering helpers
// ==========================================================================

describe("milestone ordering", () => {
  it("indexes all milestones contiguously", () => {
    MILESTONE_ORDER.forEach((m, i) => {
      expect(milestoneIndex(m)).toBe(i);
    });
  });

  it("treats forward transitions as forward", () => {
    expect(isForwardTransition("intake", "routed")).toBe(true);
    expect(isForwardTransition("in_production", "completed")).toBe(true);
  });

  it("treats same-milestone as not forward", () => {
    expect(isForwardTransition("in_production", "in_production")).toBe(false);
  });

  it("treats backward transitions as not forward", () => {
    expect(isForwardTransition("completed", "in_production")).toBe(false);
  });
});

// ==========================================================================
// advanceMilestone use case
// ==========================================================================

describe("advanceMilestoneUseCase — event emission", () => {
  it("emits milestone.advanced + eta.updated on first call with active work", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "in_progress", {
            estimatedDurationMinutes: 60,
            accumulatedActiveMinutes: 15,
          }),
          step("s2", "ready", { estimatedDurationMinutes: 30 }),
        ],
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.currentMilestone).toBe("in_production");
    expect(result.emitted).toContain("work_order.milestone.advanced");
    expect(result.emitted).toContain("work_order.eta.updated");

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events.map((e) => e.type)).toEqual([
      "work_order.milestone.advanced",
      "work_order.eta.updated",
    ]);
    const msPayload = events[0].payload as MilestoneAdvancedPayload;
    expect(msPayload.fromMilestone).toBe("intake");
    expect(msPayload.toMilestone).toBe("in_production");
    expect(msPayload.totalStepCount).toBe(2);
  });

  it("emits nothing when projection is unchanged from previous (idempotent)", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const trackedSteps = [
      step("s1", "in_progress", {
        estimatedDurationMinutes: 60,
        accumulatedActiveMinutes: 15,
      }),
    ];
    const previous = baseProjection({
      currentMilestone: "in_production",
      completedStepCount: 0,
      totalStepCount: 1,
      percentComplete: 0,
      estimatedCompletionAt: new Date(FIXED_NOW.getTime() + 45 * 60_000),
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps,
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).toEqual([]);
    expect(await eventLog.size()).toBe(0);
  });

  it("emits eta.updated only when drift crosses threshold", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    // Previous ETA was 60 minutes out; new will be 63 minutes out (drift = 3, below 5-min threshold).
    const previous = baseProjection({
      currentMilestone: "in_production",
      completedStepCount: 0,
      totalStepCount: 1,
      estimatedCompletionAt: new Date(FIXED_NOW.getTime() + 60 * 60_000),
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "ready", { estimatedDurationMinutes: 63 }),
        ],
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).not.toContain("work_order.eta.updated");
    expect(await eventLog.size()).toBe(0);
  });

  it("emits eta.updated when drift >= threshold", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const previous = baseProjection({
      currentMilestone: "in_production",
      completedStepCount: 0,
      totalStepCount: 1,
      estimatedCompletionAt: new Date(FIXED_NOW.getTime() + 60 * 60_000),
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "ready", { estimatedDurationMinutes: 70 }),
        ],
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).toContain("work_order.eta.updated");

    const events = await eventLog.listByType("work_order.eta.updated");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as EtaUpdatedPayload;
    expect(payload.driftMinutes).toBe(10);
    expect(payload.confidence).toBe("firm");
  });

  it("emits eta.at_risk on false→true risk transition", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const previous = baseProjection({
      currentMilestone: "in_production",
      completedStepCount: 0,
      totalStepCount: 2,
      etaConfidence: "firm",
      estimatedCompletionAt: new Date(FIXED_NOW.getTime() + 30 * 60_000),
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "in_progress", { estimatedDurationMinutes: 30 }),
          step("s2", "blocked"),
        ],
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.etaConfidence).toBe("at_risk");
    expect(result.projection.etaRiskReason).toBe("dependency_blocked");
    expect(result.emitted).toContain("work_order.eta.at_risk");

    const events = await eventLog.listByType("work_order.eta.at_risk");
    expect(events).toHaveLength(1);
    const payload = events[0].payload as EtaAtRiskPayload;
    expect(payload.riskReason).toBe("dependency_blocked");
    expect(payload.currentMilestone).toBe("in_production");
  });

  it("does not re-emit eta.at_risk while still at risk (edge-triggered)", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const previous = baseProjection({
      currentMilestone: "in_production",
      completedStepCount: 0,
      totalStepCount: 2,
      etaConfidence: "at_risk",
      etaRiskReason: "dependency_blocked",
      estimatedCompletionAt: new Date(FIXED_NOW.getTime() + 30 * 60_000),
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "in_progress", { estimatedDurationMinutes: 30 }),
          step("s2", "blocked"),
        ],
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).not.toContain("work_order.eta.at_risk");
  });

  it("emits milestone.advanced + eta.updated + eta.at_risk together on first-call with blocked dep", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "in_progress", { estimatedDurationMinutes: 30 }),
          step("s2", "blocked"),
        ],
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).toEqual([
      "work_order.milestone.advanced",
      "work_order.eta.updated",
      "work_order.eta.at_risk",
    ]);
  });

  it("does not emit milestone.advanced on backward transition", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const previous = baseProjection({
      currentMilestone: "ready_for_pickup",
      completedStepCount: 2,
      totalStepCount: 2,
      percentComplete: 100,
    });

    // Regression: one step magically un-completes (shouldn't happen in real
    // life but tests the guard).
    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "completed"),
          step("s2", "ready"),
        ],
        previousProjection: previous,
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emitted).not.toContain("work_order.milestone.advanced");
  });

  it("rejects empty workOrderId with invalid_command", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "   ",
        hasRoutingEvent: true,
        trackedSteps: [],
      },
      SYSTEM
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects workOrderId mismatch between previousProjection and input", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [],
        previousProjection: baseProjection({ workOrderId: "wo-2" }),
      },
      SYSTEM
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("work_order_mismatch");
    expect(await eventLog.size()).toBe(0);
  });

  it("uses injected clock for lastUpdated + ETA", async () => {
    const frozen = new Date("2027-07-04T08:30:00Z");
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => frozen,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "ready", { estimatedDurationMinutes: 60 }),
        ],
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.lastUpdated).toEqual(frozen);
    expect(result.projection.estimatedCompletionAt).toEqual(
      new Date(frozen.getTime() + 60 * 60_000)
    );
  });

  it("marks confidence tentative when estimates are partial and no risk", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: true,
        trackedSteps: [
          step("s1", "ready", { estimatedDurationMinutes: 30 }),
          step("s2", "ready"), // missing estimate
        ],
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.etaConfidence).toBe("tentative");
  });

  it("returns baseline intake projection when nothing has routed yet", async () => {
    const useCase = createAdvanceMilestoneUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        hasRoutingEvent: false,
        trackedSteps: [],
      },
      SYSTEM
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.currentMilestone).toBe("intake");
    expect(result.projection.totalStepCount).toBe(0);
    expect(result.projection.percentComplete).toBe(0);
    // No previous, no active work → no events emitted.
    expect(result.emitted).toEqual([]);
    expect(await eventLog.size()).toBe(0);
  });
});
