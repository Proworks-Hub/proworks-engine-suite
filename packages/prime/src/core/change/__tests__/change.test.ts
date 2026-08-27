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
import { createInMemoryStationRegistry } from "../../routing/inMemoryStationRegistry.js";
import type { Station } from "../../routing/routingTypes.js";
import type {
  ChangeOrder,
  ChangeOrderApprovedPayload,
  ChangeOrderCreatedPayload,
  ChangeOrderRejectedPayload,
  ExecuteRerouteInput,
  RerouteExecutedPayload,
} from "../changeOrderTypes.js";
import { createChangeOrderUseCase } from "../changeOrderUseCase.js";
import { createExecuteRerouteUseCase } from "../executeRerouteUseCase.js";

// ---------- Fixtures ----------

const SUPERVISOR: EventActor = {
  kind: "user",
  userId: "u-supervisor-1",
  role: "supervisor",
};

const PRE_PROD: EventActor = {
  kind: "user",
  userId: "u-preprod-1",
  role: "pre_production",
};

const CUSTOMER: EventActor = {
  kind: "customer",
  customerId: "cust-1",
};

const FIXED_NOW = new Date("2026-04-22T12:00:00Z");

function makeStation(partial: Partial<Station> & Pick<Station, "id">): Station {
  return {
    id: partial.id,
    label: partial.label ?? partial.id,
    workstationClass: partial.workstationClass ?? "laser",
    availableSkillTags: partial.availableSkillTags ?? ["acrylic"],
    status: partial.status ?? "available",
    queueDepth: partial.queueDepth ?? 0,
  };
}

function pendingChangeOrder(overrides: Partial<ChangeOrder> = {}): ChangeOrder {
  return {
    id: overrides.id ?? "co-1",
    workOrderId: overrides.workOrderId ?? "wo-1",
    kind: overrides.kind ?? "expedite",
    description: overrides.description ?? "Customer needs this by Friday",
    requestedBy: overrides.requestedBy ?? "cust-1",
    requestedAt: overrides.requestedAt ?? new Date("2026-04-20T08:00:00Z"),
    status: overrides.status ?? "pending",
    reviewer: overrides.reviewer,
    decisionAt: overrides.decisionAt,
    rejectionReason: overrides.rejectionReason,
  };
}

function baseReroute(
  partial: Partial<ExecuteRerouteInput> = {}
): ExecuteRerouteInput {
  return {
    workOrderId: partial.workOrderId ?? "wo-1",
    stepId: partial.stepId ?? "step-1",
    fromStationId: partial.fromStationId ?? "laser-a",
    toStationId: partial.toStationId ?? "laser-b",
    reason: partial.reason ?? "laser-a went down",
    currentStepState: partial.currentStepState ?? "ready",
    workstationClass: partial.workstationClass ?? "laser",
    requiredSkillTags: partial.requiredSkillTags ?? ["acrylic"],
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
// Change Order — create
// ==========================================================================

describe("createChangeOrderUseCase — create", () => {
  it("creates a pending change order and emits change_order.created", async () => {
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.create(
      {
        id: "co-1",
        workOrderId: "wo-1",
        kind: "expedite",
        description: "Customer needs by Friday",
        requestedBy: "cust-1",
      },
      CUSTOMER
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeOrder.status).toBe("pending");
    expect(result.changeOrder.requestedAt).toEqual(FIXED_NOW);
    expect(result.changeOrder.reviewer).toBeUndefined();
    expect(result.changeOrder.decisionAt).toBeUndefined();

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.change_order.created");
    const payload = events[0].payload as ChangeOrderCreatedPayload;
    expect(payload.changeOrderId).toBe("co-1");
    expect(payload.kind).toBe("expedite");
    expect(payload.description).toBe("Customer needs by Friday");
    expect(payload.requestedBy).toBe("cust-1");
    expect(events[0].actor).toEqual(CUSTOMER);
  });

  it("uses injected clock for requestedAt", async () => {
    const frozen = new Date("2027-01-01T00:00:00Z");
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => frozen,
    });

    const result = await useCase.create(
      {
        id: "co-2",
        workOrderId: "wo-2",
        kind: "add_item",
        description: "Add matching lid",
        requestedBy: "u-preprod-1",
      },
      PRE_PROD
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeOrder.requestedAt).toEqual(frozen);
  });

  it("rejects missing id with invalid_command and emits no event", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });
    const result = await useCase.create(
      {
        id: "  ",
        workOrderId: "wo-1",
        kind: "modify_spec",
        description: "Change color to matte black",
        requestedBy: "cust-1",
      },
      CUSTOMER
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects missing workOrderId / description / requestedBy", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const cases = [
      { id: "co-1", workOrderId: "", kind: "expedite" as const, description: "x", requestedBy: "u" },
      { id: "co-1", workOrderId: "wo-1", kind: "expedite" as const, description: "", requestedBy: "u" },
      { id: "co-1", workOrderId: "wo-1", kind: "expedite" as const, description: "x", requestedBy: "" },
    ];

    for (const input of cases) {
      const result = await useCase.create(input, CUSTOMER);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("invalid_command");
    }
    expect(await eventLog.size()).toBe(0);
  });
});

// ==========================================================================
// Change Order — approve
// ==========================================================================

describe("createChangeOrderUseCase — approve", () => {
  it("moves pending → approved and emits change_order.approved", async () => {
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const co = pendingChangeOrder();
    const result = await useCase.approve(
      { changeOrder: co, reviewer: "u-supervisor-1" },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeOrder.status).toBe("approved");
    expect(result.changeOrder.reviewer).toBe("u-supervisor-1");
    expect(result.changeOrder.decisionAt).toEqual(FIXED_NOW);
    expect(result.changeOrder.rejectionReason).toBeUndefined();

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.change_order.approved");
    const payload = events[0].payload as ChangeOrderApprovedPayload;
    expect(payload.changeOrderId).toBe("co-1");
    expect(payload.kind).toBe("expedite");
    expect(payload.reviewer).toBe("u-supervisor-1");
  });

  it("rejects approval when status is already approved (already_decided)", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const result = await useCase.approve(
      {
        changeOrder: pendingChangeOrder({
          status: "approved",
          reviewer: "u-supervisor-1",
          decisionAt: FIXED_NOW,
        }),
        reviewer: "u-supervisor-1",
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_decided");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects approval when status is rejected (already_decided)", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const result = await useCase.approve(
      {
        changeOrder: pendingChangeOrder({
          status: "rejected",
          reviewer: "u-supervisor-1",
          decisionAt: FIXED_NOW,
          rejectionReason: "out of scope",
        }),
        reviewer: "u-supervisor-1",
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_decided");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects approval with empty reviewer string", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const result = await useCase.approve(
      { changeOrder: pendingChangeOrder(), reviewer: "   " },
      SUPERVISOR
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });
});

// ==========================================================================
// Change Order — reject
// ==========================================================================

describe("createChangeOrderUseCase — reject", () => {
  it("moves pending → rejected and emits change_order.rejected with reason", async () => {
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const result = await useCase.reject(
      {
        changeOrder: pendingChangeOrder(),
        reviewer: "u-supervisor-1",
        rejectionReason: "Out of scope for current run",
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeOrder.status).toBe("rejected");
    expect(result.changeOrder.reviewer).toBe("u-supervisor-1");
    expect(result.changeOrder.rejectionReason).toBe("Out of scope for current run");
    expect(result.changeOrder.decisionAt).toEqual(FIXED_NOW);

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.change_order.rejected");
    const payload = events[0].payload as ChangeOrderRejectedPayload;
    expect(payload.changeOrderId).toBe("co-1");
    expect(payload.reviewer).toBe("u-supervisor-1");
    expect(payload.rejectionReason).toBe("Out of scope for current run");
  });

  it("rejects reject with empty rejectionReason", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const result = await useCase.reject(
      {
        changeOrder: pendingChangeOrder(),
        reviewer: "u-supervisor-1",
        rejectionReason: "   ",
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects reject when status is already approved (already_decided)", async () => {
    const useCase = createChangeOrderUseCase({ eventLog, clock: () => FIXED_NOW });

    const result = await useCase.reject(
      {
        changeOrder: pendingChangeOrder({
          status: "approved",
          reviewer: "u-supervisor-1",
          decisionAt: FIXED_NOW,
        }),
        reviewer: "u-supervisor-1",
        rejectionReason: "changed our mind",
      },
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_decided");
    expect(await eventLog.size()).toBe(0);
  });
});

// ==========================================================================
// Execute Reroute
// ==========================================================================

describe("createExecuteRerouteUseCase", () => {
  function makeRegistry(stations: ReadonlyArray<Station>) {
    return createInMemoryStationRegistry({ stations });
  }

  it("reroutes a ready step to an eligible station and emits reroute.executed", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(baseReroute(), SUPERVISOR);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reroute.fromStationId).toBe("laser-a");
    expect(result.reroute.toStationId).toBe("laser-b");
    expect(result.reroute.stepStateAtReroute).toBe("ready");

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("work_order.reroute.executed");
    expect(events[0].stepId).toBe("step-1");
    const payload = events[0].payload as RerouteExecutedPayload;
    expect(payload.fromStationId).toBe("laser-a");
    expect(payload.toStationId).toBe("laser-b");
    expect(payload.reason).toBe("laser-a went down");
    expect(payload.stepStateAtReroute).toBe("ready");
  });

  it("allows rerouting a paused step", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ currentStepState: "paused" }),
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
  });

  it("allows rerouting a blocked step", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ currentStepState: "blocked" }),
      SUPERVISOR
    );
    expect(result.ok).toBe(true);
  });

  it("rejects reroute of in_progress step (step_not_reroutable)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      // cast: the type restricts to reroutable states, but we test the
      // runtime guard as well for defense-in-depth.
      baseReroute({
        currentStepState: "in_progress" as unknown as "ready",
      }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("step_not_reroutable");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects reroute of completed step (step_not_reroutable)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({
        currentStepState: "completed" as unknown as "ready",
      }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("step_not_reroutable");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when target station is unknown (station_not_found)", async () => {
    const registry = makeRegistry([makeStation({ id: "laser-a" })]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ toStationId: "laser-ghost" }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("station_not_found");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when target station class mismatches (station_not_eligible)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({
        id: "router-a",
        workstationClass: "cnc_router",
        availableSkillTags: ["acrylic"],
      }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ toStationId: "router-a" }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("station_not_eligible");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when target station is missing a required skill", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b", availableSkillTags: [] }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(baseReroute(), SUPERVISOR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("station_not_eligible");
    expect(result.error.message).toContain("acrylic");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when target station is down (station_not_eligible)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b", status: "down" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(baseReroute(), SUPERVISOR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("station_not_eligible");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when target station is in maintenance (station_not_eligible)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b", status: "maintenance" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(baseReroute(), SUPERVISOR);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("station_not_eligible");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects when from and to station ids are the same (invalid_command)", async () => {
    const registry = makeRegistry([makeStation({ id: "laser-a" })]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ fromStationId: "laser-a", toStationId: "laser-a" }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("rejects with empty reason (invalid_command)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    const result = await useCase.execute(
      baseReroute({ reason: "   " }),
      SUPERVISOR
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_command");
    expect(await eventLog.size()).toBe(0);
  });

  it("emits exactly one event on success (single-event guarantee)", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    await useCase.execute(baseReroute(), SUPERVISOR);
    expect(await eventLog.size()).toBe(1);
  });

  it("carries workOrderId and stepId onto the emitted event record", async () => {
    const registry = makeRegistry([
      makeStation({ id: "laser-a" }),
      makeStation({ id: "laser-b" }),
    ]);
    const useCase = createExecuteRerouteUseCase({
      eventLog,
      stationRegistry: registry,
    });

    await useCase.execute(
      baseReroute({ workOrderId: "wo-42", stepId: "step-99" }),
      SUPERVISOR
    );

    const events = await eventLog.listByWorkOrder("wo-42");
    expect(events).toHaveLength(1);
    expect(events[0].workOrderId).toBe("wo-42");
    expect(events[0].stepId).toBe("step-99");
  });
});

// ==========================================================================
// End-to-end lifecycle
// ==========================================================================

describe("change module — end-to-end", () => {
  it("supports create → approve producing two events in order", async () => {
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const created = await useCase.create(
      {
        id: "co-e2e",
        workOrderId: "wo-1",
        kind: "change_quantity",
        description: "Increase to 50 units",
        requestedBy: "cust-1",
      },
      CUSTOMER
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const approved = await useCase.approve(
      { changeOrder: created.changeOrder, reviewer: "u-supervisor-1" },
      SUPERVISOR
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.changeOrder.status).toBe("approved");

    const events = await eventLog.listByWorkOrder("wo-1");
    expect(events.map((e) => e.type)).toEqual([
      "work_order.change_order.created",
      "work_order.change_order.approved",
    ]);
  });

  it("supports create → reject producing two events in order", async () => {
    const useCase = createChangeOrderUseCase({
      eventLog,
      clock: () => FIXED_NOW,
    });

    const created = await useCase.create(
      {
        id: "co-e2e-2",
        workOrderId: "wo-2",
        kind: "remove_item",
        description: "Drop the extra SKU",
        requestedBy: "cust-2",
      },
      CUSTOMER
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rejected = await useCase.reject(
      {
        changeOrder: created.changeOrder,
        reviewer: "u-supervisor-1",
        rejectionReason: "Already cut; can't remove post-cut",
      },
      SUPERVISOR
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.changeOrder.status).toBe("rejected");

    const events = await eventLog.listByWorkOrder("wo-2");
    expect(events.map((e) => e.type)).toEqual([
      "work_order.change_order.created",
      "work_order.change_order.rejected",
    ]);
  });
});
