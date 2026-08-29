// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "@proworks-hub/contracts";

import {
  createOperationsCoordinator,
  createOperationsRegistry,
  orderIntakeSequence,
  type OperationsSpecialist,
} from "../operations.js";


import { createAllowAllGovernanceForTests } from "@proworks-hub/contracts";

// Allow-all Governance. These tests exercise coordination, not authorization;
// the authorization path is tested in tests/governedResolution.test.ts.
const testGovernance = createAllowAllGovernanceForTests({
  reason: "core coordination tests; authorization tested separately",
  env: {},
});

const context = {
  requestId: "req-1",
  tenant: { organizationId: "test-org", roles: [] },
  identity: { subject: "test-actor", kind: "user", roles: [], assertedCapabilities: [] },
  trace: { correlationId: "cor-1" },
  apiVersion: "v1",
  receivedAt: "2026-08-28T00:00:00.000Z",
} as unknown as RequestContext;

const specialist = (
  id: string,
  capabilities: OperationsSpecialist["capabilities"],
  handle: OperationsSpecialist["handle"],
  extra: Partial<OperationsSpecialist> = {},
): OperationsSpecialist => ({ id, capabilities, handle, ...extra });

/** The three specialists ProWorks actually has in this domain. */
const orderIngestion = () =>
  specialist("order-ingestion", ["normalize_order"], async (request) => ({
    normalized: true,
    from: request.input,
  }));

const workOrderIq = (over: Partial<OperationsSpecialist> = {}) =>
  specialist(
    "workorderiq",
    ["create_work_order", "route_work_order", "advance_work_order"],
    async (request) => {
      if (request.capability === "create_work_order") {
        return { workOrderId: "wo-1", createdFrom: request.input };
      }
      if (request.capability === "route_work_order") return { routedTo: "uv-station" };
      return { advanced: true };
    },
    over,
  );

const tracking = () =>
  specialist("tracking", ["locate_order"], async () => ({ stage: "in_production" }));

const sequenceInput = (steps: ReturnType<typeof orderIntakeSequence>) => ({
  steps,
  context,
  correlationId: "ord-7781",
});

describe("three specialists, one domain", () => {
  it("routes each question to whoever claims it", async () => {
    const registry = createOperationsRegistry([orderIngestion(), workOrderIq(), tracking()]);
    const coordinator = createOperationsCoordinator({ governance: testGovernance, registry });

    expect(registry.capabilities()).toEqual([
      "advance_work_order", "create_work_order", "locate_order", "normalize_order", "route_work_order",
    ]);

    const located = await coordinator.ask({
      capability: "locate_order", input: {}, context, correlationId: "c1",
    });
    expect(located.ok && located.answer.servedBy).toBe("tracking");
  });

  it("does not claim a capability nobody registered", async () => {
    // SchedulerIQ does not exist. Saying so beats failing obscurely.
    const coordinator = createOperationsCoordinator({ governance: testGovernance,
      registry: createOperationsRegistry([orderIngestion()]),
    });
    const outcome = await coordinator.ask({
      capability: "schedule_work", input: {}, context, correlationId: "c1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("no_specialist");
  });
});

describe("dependent steps, which finance does not have", () => {
  it("threads each output into the next step", async () => {
    // The reason sequences exist: an order must be normalized before a work
    // order can be created from it.
    const registry = createOperationsRegistry([orderIngestion(), workOrderIq()]);
    const coordinator = createOperationsCoordinator({ governance: testGovernance, registry });

    const result = await coordinator.sequence(
      sequenceInput(orderIntakeSequence({ externalId: "shopify-991" })),
    );

    expect(result.complete).toBe(true);
    expect(result.completed).toHaveLength(3);

    const created = result.completed.find((a) => a.capability === "create_work_order")!;
    // Proof the thread happened: the work order was built from the NORMALIZED
    // order, not from the raw one.
    expect(created.output).toMatchObject({
      createdFrom: { normalized: true, from: { externalId: "shopify-991" } },
    });
  });

  it("stops at a required failure rather than running the next step on undefined", async () => {
    const registry = createOperationsRegistry([
      specialist("order-ingestion", ["normalize_order"], async () => {
        throw new Error("malformed payload");
      }),
      workOrderIq(),
    ]);
    const create = vi.fn();

    const result = await createOperationsCoordinator({ governance: testGovernance, registry }).sequence(
      sequenceInput(orderIntakeSequence({ externalId: "bad" })),
    );

    expect(result.completed).toHaveLength(0);
    expect(result.refusals).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(result.state).toContain("Nothing was done");
  });

  it("names what already happened when a later step fails", async () => {
    // The field that matters. Step one created something; there is no rollback,
    // and "sequence failed" would hide the thing somebody has to reconcile.
    const registry = createOperationsRegistry([
      orderIngestion(),
      specialist("workorderiq", ["create_work_order"], async () => {
        throw new Error("database unreachable");
      }),
    ]);

    const result = await createOperationsCoordinator({ governance: testGovernance, registry }).sequence(
      sequenceInput(orderIntakeSequence({ externalId: "shopify-991" })),
    );

    expect(result.complete).toBe(false);
    expect(result.partiallyApplied).toBe(true);
    expect(result.state).toContain("normalize order completed");
    expect(result.state).toContain("create work order was refused");
    expect(result.state).toContain("Nothing was undone");
  });

  it("does not offer a rollback it cannot perform", async () => {
    // A Core cannot un-create a work order. Offering one would be a lie that
    // costs somebody a duplicate.
    const coordinator = createOperationsCoordinator({ governance: testGovernance,
      registry: createOperationsRegistry([orderIngestion(), workOrderIq()]),
    });
    expect("rollback" in coordinator).toBe(false);
    expect("undo" in coordinator).toBe(false);
  });

  it("carries on past an optional step", async () => {
    // An unrouted work order is a real, workable state — somebody routes it by
    // hand. Failing intake because routing is unavailable would lose the order.
    const registry = createOperationsRegistry([
      orderIngestion(),
      specialist("workorderiq", ["create_work_order"], async () => ({ workOrderId: "wo-1" })),
    ]);

    const result = await createOperationsCoordinator({ governance: testGovernance, registry }).sequence(
      sequenceInput(orderIntakeSequence({ externalId: "shopify-991" })),
    );

    expect(result.completed.map((a) => a.capability)).toEqual([
      "normalize_order", "create_work_order",
    ]);
    expect(result.refusals[0]?.capability).toBe("route_work_order");
    // The work order exists and is usable; this is not a partial failure needing
    // reconciliation.
    expect(result.partiallyApplied).toBe(false);
  });

  it("chains causation so a trace has an order to it", async () => {
    // Without this a trace shows several events at one instant with no
    // relationship between them.
    const seen: (string | undefined)[] = [];
    const registry = createOperationsRegistry([
      specialist("order-ingestion", ["normalize_order"], async (request) => {
        seen.push(request.causationId);
        return { normalized: true };
      }),
      specialist("workorderiq", ["create_work_order", "route_work_order"], async (request) => {
        seen.push(request.causationId);
        return { workOrderId: "wo-1" };
      }),
    ]);

    await createOperationsCoordinator({ governance: testGovernance, registry }).sequence(
      sequenceInput(orderIntakeSequence({ externalId: "x" })),
    );

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe("normalize_order");
    expect(seen[2]).toBe("create_work_order");
  });

  it("keeps one correlation id across every step", async () => {
    const seen: string[] = [];
    const registry = createOperationsRegistry([
      specialist("order-ingestion", ["normalize_order"], async (request) => {
        seen.push(request.correlationId);
        return {};
      }),
      specialist("workorderiq", ["create_work_order", "route_work_order"], async (request) => {
        seen.push(request.correlationId);
        return {};
      }),
    ]);

    await createOperationsCoordinator({ governance: testGovernance, registry }).sequence(
      sequenceInput(orderIntakeSequence({ externalId: "x" })),
    );
    expect(new Set(seen)).toEqual(new Set(["ord-7781"]));
  });
});

describe("the machinery inherited from core-kit still holds here", () => {
  it("times out a hung specialist", async () => {
    const registry = createOperationsRegistry([
      specialist("workorderiq", ["create_work_order"], () => new Promise(() => {})),
    ]);
    const outcome = await createOperationsCoordinator({ governance: testGovernance, registry, timeoutMs: 20 }).ask({
      capability: "create_work_order", input: {}, context, correlationId: "c1",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.failure).toBe("timeout");
  });

  it("reports its own domain in status", async () => {
    const status = await createOperationsCoordinator({ governance: testGovernance,
      registry: createOperationsRegistry([tracking()]),
    }).status();
    expect(status.core).toBe("operations");
  });

  it("distinguishes not-reporting from unhealthy", async () => {
    const registry = createOperationsRegistry([
      tracking(),
      specialist("workorderiq", ["create_work_order"], async () => ({}), {
        health: async () => ({ healthy: false, detail: "Event log unavailable." }),
      }),
    ]);
    const status = await createOperationsCoordinator({ governance: testGovernance, registry }).status();
    const byId = Object.fromEntries(status.specialists.map((s) => [s.id, s]));

    expect(byId["tracking"]!.healthy).toBeNull();
    expect(byId["workorderiq"]!.healthy).toBe(false);
  });
});
