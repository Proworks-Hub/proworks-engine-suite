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
import type { TentativeStep } from "../../template/templateTypes";
import type {
  RoutingAssignedPayload,
  Station,
} from "../routingTypes";
import { createInMemoryStationRegistry } from "../inMemoryStationRegistry";
import { createRouteStepsUseCase } from "../routeStepsUseCase";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

function tentative(partial: Partial<TentativeStep> & Pick<TentativeStep, "id">): TentativeStep {
  return {
    id: partial.id,
    lineItemId: partial.lineItemId ?? "li-1",
    templateId: partial.templateId ?? "tpl-1",
    templateStepId: partial.templateStepId ?? "ts-1",
    label: partial.label ?? "Do thing",
    workstationClass: partial.workstationClass ?? "laser",
    requiredSkillTags: partial.requiredSkillTags ?? [],
    estimatedDurationMinutes: partial.estimatedDurationMinutes,
    dependsOn: partial.dependsOn ?? [],
    optional: partial.optional ?? false,
  };
}

function station(partial: Partial<Station> & Pick<Station, "id">): Station {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    workstationClass: partial.workstationClass ?? "laser",
    availableSkillTags: partial.availableSkillTags ?? [],
    status: partial.status ?? "available",
    queueDepth: partial.queueDepth ?? 0,
  };
}

// ============================================================
//  InMemoryStationRegistry
// ============================================================

describe("createInMemoryStationRegistry", () => {
  it("returns stations matching class", async () => {
    const reg = createInMemoryStationRegistry({
      stations: [
        station({ id: "laser-a" }),
        station({ id: "laser-b" }),
        station({ id: "cnc-a", workstationClass: "cnc" }),
      ],
    });
    const result = await reg.listEligibleStations({
      workstationClass: "laser",
      requiredSkillTags: [],
    });
    expect(result.map((s) => s.id).sort()).toEqual(["laser-a", "laser-b"]);
  });

  it("filters out stations missing required skills", async () => {
    const reg = createInMemoryStationRegistry({
      stations: [
        station({ id: "laser-a", availableSkillTags: ["large-bed-capable"] }),
        station({ id: "laser-b", availableSkillTags: [] }),
      ],
    });
    const result = await reg.listEligibleStations({
      workstationClass: "laser",
      requiredSkillTags: ["large-bed-capable"],
    });
    expect(result.map((s) => s.id)).toEqual(["laser-a"]);
  });

  it("filters out down and maintenance stations", async () => {
    const reg = createInMemoryStationRegistry({
      stations: [
        station({ id: "laser-up", status: "available" }),
        station({ id: "laser-busy", status: "busy" }),
        station({ id: "laser-down", status: "down" }),
        station({ id: "laser-maint", status: "maintenance" }),
      ],
    });
    const result = await reg.listEligibleStations({
      workstationClass: "laser",
      requiredSkillTags: [],
    });
    expect(result.map((s) => s.id).sort()).toEqual(["laser-busy", "laser-up"]);
  });

  it("getById returns the station or null", async () => {
    const reg = createInMemoryStationRegistry({
      stations: [station({ id: "laser-a" })],
    });
    expect((await reg.getById("laser-a"))?.id).toBe("laser-a");
    expect(await reg.getById("nope")).toBeNull();
  });
});

// ============================================================
//  routeStepsUseCase
// ============================================================

describe("routeStepsUseCase", () => {
  let log: EventLog;

  beforeEach(() => {
    log = createInMemoryEventLog();
  });

  const useCase = (stations: ReadonlyArray<Station>) =>
    createRouteStepsUseCase({
      eventLog: log,
      stationRegistry: createInMemoryStationRegistry({ stations }),
    });

  it("routes a single step to the only eligible station (reason: only_eligible_station)", async () => {
    const uc = useCase([station({ id: "laser-a" })]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [tentative({ id: "s-1" })],
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routedSteps).toHaveLength(1);
    expect(result.routedSteps[0].stationId).toBe("laser-a");
    expect(result.routedSteps[0].routingReason).toBe("only_eligible_station");
  });

  it("picks the shortest-queue station among multiple eligible (reason: shortest_queue)", async () => {
    const uc = useCase([
      station({ id: "laser-a", queueDepth: 5 }),
      station({ id: "laser-b", queueDepth: 1 }),
      station({ id: "laser-c", queueDepth: 3 }),
    ]);
    const result = await uc.execute(
      { workOrderId: "wo-1", tentativeSteps: [tentative({ id: "s-1" })] },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routedSteps[0].stationId).toBe("laser-b");
    expect(result.routedSteps[0].routingReason).toBe("shortest_queue");
  });

  it("breaks ties on station id for determinism", async () => {
    const uc = useCase([
      station({ id: "laser-z", queueDepth: 2 }),
      station({ id: "laser-a", queueDepth: 2 }),
      station({ id: "laser-m", queueDepth: 2 }),
    ]);
    const result = await uc.execute(
      { workOrderId: "wo-1", tentativeSteps: [tentative({ id: "s-1" })] },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routedSteps[0].stationId).toBe("laser-a");
  });

  it("emits exactly one work_order.routing.assigned event with station load summary", async () => {
    const uc = useCase([
      station({ id: "laser-a" }),
      station({ id: "laser-b" }),
    ]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [
          tentative({ id: "s-1" }),
          tentative({ id: "s-2" }),
          tentative({ id: "s-3" }),
        ],
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await log.listByType("work_order.routing.assigned");
    expect(events).toHaveLength(1);
    expect(events[0].workOrderId).toBe("wo-1");
    expect(events[0].actor).toEqual(SUPERVISOR);
    const payload = events[0].payload as RoutingAssignedPayload;
    expect(payload.stepCount).toBe(3);
    // All three steps pick laser-a (same queueDepth 0, lower id wins). Summary reflects that.
    expect(payload.stationLoadSummary).toEqual([
      { stationId: "laser-a", stepCount: 3 },
    ]);
  });

  it("fails with no_eligible_station when no station matches class", async () => {
    const uc = useCase([station({ id: "cnc-a", workstationClass: "cnc" })]);
    const result = await uc.execute(
      { workOrderId: "wo-1", tentativeSteps: [tentative({ id: "s-1", workstationClass: "laser" })] },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("no_eligible_station");
    expect(await log.size()).toBe(0);
  });

  it("fails when class matches but required skill is absent from every station", async () => {
    const uc = useCase([
      station({ id: "laser-a", availableSkillTags: [] }),
      station({ id: "laser-b", availableSkillTags: ["small-bed"] }),
    ]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [
          tentative({ id: "s-1", requiredSkillTags: ["large-bed-capable"] }),
        ],
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("no_eligible_station");
  });

  it("excludes down/maintenance stations from eligibility", async () => {
    const uc = useCase([
      station({ id: "laser-down", status: "down" }),
      station({ id: "laser-maint", status: "maintenance" }),
    ]);
    const result = await uc.execute(
      { workOrderId: "wo-1", tentativeSteps: [tentative({ id: "s-1" })] },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("no_eligible_station");
  });

  it("honors manual override when the target station is eligible", async () => {
    const uc = useCase([
      station({ id: "laser-a", queueDepth: 0 }),
      station({ id: "laser-b", queueDepth: 5 }),
    ]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [tentative({ id: "s-1" })],
        manualOverrides: new Map([["s-1", "laser-b"]]),
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routedSteps[0].stationId).toBe("laser-b");
    expect(result.routedSteps[0].routingReason).toBe("manual_pick");
  });

  it("rejects manual override when target is ineligible (down)", async () => {
    const uc = useCase([
      station({ id: "laser-a", queueDepth: 0 }),
      station({ id: "laser-b", status: "down" }),
    ]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [tentative({ id: "s-1" })],
        manualOverrides: new Map([["s-1", "laser-b"]]),
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("manual_override_ineligible");
    expect(result.errors[0].attemptedStationId).toBe("laser-b");
    expect(await log.size()).toBe(0);
  });

  it("rejects manual override when target station doesn't exist", async () => {
    const uc = useCase([station({ id: "laser-a" })]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [tentative({ id: "s-1" })],
        manualOverrides: new Map([["s-1", "ghost"]]),
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe("manual_override_ineligible");
  });

  it("does not emit when ANY step fails to route (all-or-nothing)", async () => {
    const uc = useCase([station({ id: "laser-a" })]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [
          tentative({ id: "s-1" }),
          tentative({ id: "s-2", workstationClass: "cnc" }),
        ],
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].tentativeStepId).toBe("s-2");
    expect(await log.size()).toBe(0);
  });

  it("preserves dependsOn unchanged on routed steps", async () => {
    const uc = useCase([station({ id: "laser-a" })]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [
          tentative({ id: "s-1" }),
          tentative({ id: "s-2", dependsOn: ["s-1"] }),
        ],
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routedSteps[1].dependsOn).toEqual(["s-1"]);
  });

  it("freezes routed steps", async () => {
    const uc = useCase([station({ id: "laser-a" })]);
    const result = await uc.execute(
      { workOrderId: "wo-1", tentativeSteps: [tentative({ id: "s-1" })] },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.routedSteps[0])).toBe(true);
    expect(() => {
      (result.routedSteps[0] as any).stationId = "mutated";
    }).toThrow();
  });

  it("summarizes station load with one row per station used", async () => {
    const uc = useCase([
      station({ id: "laser-a", queueDepth: 0 }),
      station({ id: "laser-b", queueDepth: 10 }),
    ]);
    const result = await uc.execute(
      {
        workOrderId: "wo-1",
        tentativeSteps: [
          tentative({ id: "s-1" }),
          tentative({ id: "s-2" }),
        ],
        manualOverrides: new Map([["s-2", "laser-b"]]),
      },
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await log.listByType("work_order.routing.assigned");
    const payload = events[0].payload as RoutingAssignedPayload;
    expect(payload.stationLoadSummary).toEqual([
      { stationId: "laser-a", stepCount: 1 },
      { stationId: "laser-b", stepCount: 1 },
    ]);
  });
});
