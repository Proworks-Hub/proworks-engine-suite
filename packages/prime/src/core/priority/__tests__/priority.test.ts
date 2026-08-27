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
import type { RoutedStep } from "../../routing/routingTypes.js";
import type {
  PriorityAssignedPayload,
  PrioritizedStep,
  PriorityLevel,
} from "../priorityTypes.js";
import {
  calculatePriorityColor,
  calculatePriorityScore,
  orderStepsByPriority,
  pickScoreTotal,
} from "../priorityScore.js";
import { createAssignPriorityUseCase } from "../assignPriorityUseCase.js";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

function routed(
  partial: Partial<RoutedStep> & Pick<RoutedStep, "tentativeStepId">
): RoutedStep {
  return {
    tentativeStepId: partial.tentativeStepId,
    stationId: partial.stationId ?? "laser-a",
    lineItemId: partial.lineItemId ?? "li-1",
    templateId: partial.templateId ?? "tpl-1",
    templateStepId: partial.templateStepId ?? "ts-1",
    label: partial.label ?? "Do thing",
    workstationClass: partial.workstationClass ?? "laser",
    requiredSkillTags: partial.requiredSkillTags ?? [],
    estimatedDurationMinutes: partial.estimatedDurationMinutes,
    dependsOn: partial.dependsOn ?? [],
    optional: partial.optional ?? false,
    routingReason: partial.routingReason ?? "shortest_queue",
  };
}

function prioritized(
  partial: Partial<PrioritizedStep> & Pick<PrioritizedStep, "tentativeStepId">
): PrioritizedStep {
  return {
    tentativeStepId: partial.tentativeStepId,
    workOrderId: partial.workOrderId ?? "wo-1",
    stationId: partial.stationId ?? "laser-a",
    lineItemId: partial.lineItemId ?? "li-1",
    templateId: partial.templateId ?? "tpl-1",
    templateStepId: partial.templateStepId ?? "ts-1",
    label: partial.label ?? "Do thing",
    dependsOn: partial.dependsOn ?? [],
    optional: partial.optional ?? false,
    estimatedDurationMinutes: partial.estimatedDurationMinutes,
    priorityLevel: partial.priorityLevel ?? "medium",
    priorityScore: partial.priorityScore ?? 100,
    priorityColor: partial.priorityColor ?? "green",
    priorityScoreBreakdown: partial.priorityScoreBreakdown ?? {
      base: 100,
      agingBump: 0,
      dueDateUrgency: 0,
      total: 100,
    },
    dueDate: partial.dueDate,
  };
}

const NOW = new Date("2026-04-22T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// ============================================================
//  calculatePriorityScore
// ============================================================

describe("calculatePriorityScore", () => {
  it("returns the base score when there's no age and no due date", () => {
    const result = calculatePriorityScore("medium", NOW, null, NOW);
    expect(result).toEqual({
      base: 100,
      agingBump: 0,
      dueDateUrgency: 0,
      total: 100,
    });
  });

  it("orders the four levels rush > high > medium > low at day zero", () => {
    const levels: PriorityLevel[] = ["rush", "high", "medium", "low"];
    const totals = levels.map(
      (l) => calculatePriorityScore(l, NOW, null, NOW).total
    );
    expect(totals[0]).toBeGreaterThan(totals[1]);
    expect(totals[1]).toBeGreaterThan(totals[2]);
    expect(totals[2]).toBeGreaterThan(totals[3]);
  });

  it("adds an aging bump scaled by level (rush ages fastest)", () => {
    const createdAt = new Date(NOW.getTime() - 4 * DAY);
    const rush = calculatePriorityScore("rush", createdAt, null, NOW);
    const low = calculatePriorityScore("low", createdAt, null, NOW);
    // rush: 4 days * 5 = 20. low: 4 days * 0.5 = 2.
    expect(rush.agingBump).toBe(20);
    expect(low.agingBump).toBe(2);
  });

  it("floors negative ages to zero (created in the future never subtracts)", () => {
    const createdAt = new Date(NOW.getTime() + DAY);
    const result = calculatePriorityScore("high", createdAt, null, NOW);
    expect(result.agingBump).toBe(0);
  });

  it("adds 300 urgency when overdue", () => {
    const dueDate = new Date(NOW.getTime() - DAY);
    const result = calculatePriorityScore("medium", NOW, dueDate, NOW);
    expect(result.dueDateUrgency).toBe(300);
  });

  it("adds 200 urgency when due within 24h", () => {
    const dueDate = new Date(NOW.getTime() + DAY / 2);
    const result = calculatePriorityScore("medium", NOW, dueDate, NOW);
    expect(result.dueDateUrgency).toBe(200);
  });

  it("adds 50 urgency when due within 72h", () => {
    const dueDate = new Date(NOW.getTime() + 2 * DAY);
    const result = calculatePriorityScore("medium", NOW, dueDate, NOW);
    expect(result.dueDateUrgency).toBe(50);
  });

  it("adds no urgency when due date is far away", () => {
    const dueDate = new Date(NOW.getTime() + 10 * DAY);
    const result = calculatePriorityScore("medium", NOW, dueDate, NOW);
    expect(result.dueDateUrgency).toBe(0);
  });

  it("sums base + aging + urgency into total", () => {
    const createdAt = new Date(NOW.getTime() - 2 * DAY);
    const dueDate = new Date(NOW.getTime() + 2 * DAY);
    const result = calculatePriorityScore("high", createdAt, dueDate, NOW);
    // base 500 + aging (2*3)=6 + urgency 50 = 556
    expect(result.total).toBe(556);
    expect(pickScoreTotal(result)).toBe(556);
  });
});

// ============================================================
//  calculatePriorityColor
// ============================================================

describe("calculatePriorityColor", () => {
  it("returns red for rush regardless of due date", () => {
    expect(calculatePriorityColor("rush", null, NOW)).toBe("red");
    expect(
      calculatePriorityColor("rush", new Date(NOW.getTime() + 30 * DAY), NOW)
    ).toBe("red");
  });

  it("returns red for overdue non-rush levels", () => {
    const dueDate = new Date(NOW.getTime() - DAY);
    expect(calculatePriorityColor("medium", dueDate, NOW)).toBe("red");
  });

  it("returns red when due within 24h", () => {
    const dueDate = new Date(NOW.getTime() + DAY / 4);
    expect(calculatePriorityColor("medium", dueDate, NOW)).toBe("red");
  });

  it("returns yellow when due within 72h (regardless of level)", () => {
    const dueDate = new Date(NOW.getTime() + 2 * DAY);
    expect(calculatePriorityColor("low", dueDate, NOW)).toBe("yellow");
  });

  it("returns yellow for high priority without a near due date", () => {
    expect(calculatePriorityColor("high", null, NOW)).toBe("yellow");
  });

  it("returns green for medium/low without urgent due date", () => {
    expect(calculatePriorityColor("medium", null, NOW)).toBe("green");
    expect(calculatePriorityColor("low", null, NOW)).toBe("green");
    expect(
      calculatePriorityColor("medium", new Date(NOW.getTime() + 10 * DAY), NOW)
    ).toBe("green");
  });
});

// ============================================================
//  orderStepsByPriority
// ============================================================

describe("orderStepsByPriority", () => {
  it("sorts by priorityScore descending", () => {
    const a = prioritized({ tentativeStepId: "a", priorityScore: 100 });
    const b = prioritized({ tentativeStepId: "b", priorityScore: 500 });
    const c = prioritized({ tentativeStepId: "c", priorityScore: 1000 });
    const out = orderStepsByPriority([a, b, c]);
    expect(out.map((s) => s.tentativeStepId)).toEqual(["c", "b", "a"]);
  });

  it("breaks score ties by due date ascending (earlier due first)", () => {
    const a = prioritized({
      tentativeStepId: "a",
      priorityScore: 500,
      dueDate: "2026-05-01T00:00:00.000Z",
    });
    const b = prioritized({
      tentativeStepId: "b",
      priorityScore: 500,
      dueDate: "2026-04-25T00:00:00.000Z",
    });
    const out = orderStepsByPriority([a, b]);
    expect(out.map((s) => s.tentativeStepId)).toEqual(["b", "a"]);
  });

  it("puts steps without a due date after steps with one (on score tie)", () => {
    const a = prioritized({ tentativeStepId: "a", priorityScore: 500 });
    const b = prioritized({
      tentativeStepId: "b",
      priorityScore: 500,
      dueDate: "2026-04-30T00:00:00.000Z",
    });
    const out = orderStepsByPriority([a, b]);
    expect(out.map((s) => s.tentativeStepId)).toEqual(["b", "a"]);
  });

  it("breaks remaining ties by tentativeStepId ascending (deterministic)", () => {
    const a = prioritized({ tentativeStepId: "step-b", priorityScore: 500 });
    const b = prioritized({ tentativeStepId: "step-a", priorityScore: 500 });
    const out = orderStepsByPriority([a, b]);
    expect(out.map((s) => s.tentativeStepId)).toEqual(["step-a", "step-b"]);
  });

  it("does not mutate the input array", () => {
    const a = prioritized({ tentativeStepId: "a", priorityScore: 10 });
    const b = prioritized({ tentativeStepId: "b", priorityScore: 1000 });
    const input = [a, b];
    orderStepsByPriority(input);
    expect(input.map((s) => s.tentativeStepId)).toEqual(["a", "b"]);
  });
});

// ============================================================
//  assignPriority use case
// ============================================================

describe("createAssignPriorityUseCase", () => {
  let eventLog: EventLog;
  const clock = () => NOW;

  beforeEach(() => {
    eventLog = createInMemoryEventLog();
  });

  it("assigns priority to every routed step and returns a PrioritizedStep per input", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        priorityLevel: "high",
        createdAt: NOW.toISOString(),
        routedSteps: [
          routed({ tentativeStepId: "s1" }),
          routed({ tentativeStepId: "s2", stationId: "cnc-a" }),
        ],
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prioritizedSteps).toHaveLength(2);
    // Every step shares the WO's score, color, level.
    for (const s of result.prioritizedSteps) {
      expect(s.priorityLevel).toBe("high");
      expect(s.priorityScore).toBe(500);
      expect(s.priorityColor).toBe("yellow");
      expect(s.workOrderId).toBe("wo-1");
    }
  });

  it("promotes workOrderId onto each step (Priority is the first cross-WO layer)", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        workOrderId: "wo-42",
        priorityLevel: "medium",
        createdAt: NOW.toISOString(),
        routedSteps: [routed({ tentativeStepId: "s1" })],
      },
      SUPERVISOR
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.prioritizedSteps[0]!.workOrderId).toBe("wo-42");
  });

  it("emits exactly one work_order.priority.assigned event with a compact payload", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    await useCase.execute(
      {
        workOrderId: "wo-1",
        priorityLevel: "rush",
        createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
        dueDate: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(),
        routedSteps: [
          routed({ tentativeStepId: "s1" }),
          routed({ tentativeStepId: "s2" }),
          routed({ tentativeStepId: "s3" }),
        ],
      },
      SUPERVISOR
    );

    const events = await eventLog.listByWorkOrder("wo-1");
    const priorityEvents = events.filter(
      (e) => e.type === "work_order.priority.assigned"
    );
    expect(priorityEvents).toHaveLength(1);

    const payload = priorityEvents[0]!.payload as PriorityAssignedPayload;
    expect(payload.priorityLevel).toBe("rush");
    expect(payload.priorityColor).toBe("red");
    expect(payload.stepCount).toBe(3);
    // rush base 1000 + aging (2*5)=10 + urgency 200 (<24h) = 1210
    expect(payload.priorityScore).toBe(1210);
    expect(payload.scoreBreakdown.total).toBe(1210);
    expect(payload.scoreBreakdown.base).toBe(1000);
    expect(payload.scoreBreakdown.agingBump).toBe(10);
    expect(payload.scoreBreakdown.dueDateUrgency).toBe(200);
  });

  it("handles no due date gracefully (urgency = 0, no dueDate on the payload)", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        priorityLevel: "low",
        createdAt: NOW.toISOString(),
        routedSteps: [routed({ tentativeStepId: "s1" })],
      },
      SUPERVISOR
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.prioritizedSteps[0]!.dueDate).toBeUndefined();
    expect(result.prioritizedSteps[0]!.priorityScore).toBe(10);
    expect(result.prioritizedSteps[0]!.priorityColor).toBe("green");

    const events = await eventLog.listByWorkOrder("wo-1");
    const payload = events[0]!.payload as PriorityAssignedPayload;
    expect(payload.dueDate).toBeUndefined();
  });

  it("uses the injected clock so replays are deterministic", async () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const useCase = createAssignPriorityUseCase({
      eventLog,
      clock: () => fixed,
    });
    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        // createdAt equals the clock → no aging bump even if wall time advances
        priorityLevel: "medium",
        createdAt: fixed.toISOString(),
        routedSteps: [routed({ tentativeStepId: "s1" })],
      },
      SUPERVISOR
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.prioritizedSteps[0]!.priorityScoreBreakdown.agingBump).toBe(0);
  });

  it("accepts an empty routed-steps list (edge: template resolved a WO with no work)", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        workOrderId: "wo-empty",
        priorityLevel: "medium",
        createdAt: NOW.toISOString(),
        routedSteps: [],
      },
      SUPERVISOR
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.prioritizedSteps).toHaveLength(0);

    const events = await eventLog.listByWorkOrder("wo-empty");
    const payload = events[0]!.payload as PriorityAssignedPayload;
    expect(payload.stepCount).toBe(0);
  });

  it("preserves dependsOn topology from the routed step into the prioritized step", async () => {
    const useCase = createAssignPriorityUseCase({ eventLog, clock });
    const result = await useCase.execute(
      {
        workOrderId: "wo-1",
        priorityLevel: "medium",
        createdAt: NOW.toISOString(),
        routedSteps: [
          routed({ tentativeStepId: "s1" }),
          routed({ tentativeStepId: "s2", dependsOn: ["s1"] }),
        ],
      },
      SUPERVISOR
    );
    if (!result.ok) throw new Error("expected ok");
    expect(result.prioritizedSteps[1]!.dependsOn).toEqual(["s1"]);
  });
});
