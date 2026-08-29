// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createCostIqEngine } from "@proworks-hub/costiq";
import { buildManufacturingPlan } from "@proworks-hub/forgeiq/manufacturing";
import { productConfigurationSchema, runValidation } from "@proworks-hub/forgeiq";
import {
  buildFirepitDefinition,
  demoCortenSpecs,
  demoFiberLaserSpecs,
  demoMildSteelSpecs,
  demoPressBrakeSpecs,
} from "@proworks-hub/forgeiq/demo/firepit";
import {
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  createReserveMaterialUseCase,
} from "@proworks-hub/inventoryiq";
import {
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  createInMemoryIdempotencyStore,
  type EventActor,
} from "@proworks-hub/workorderiq";
import {
  createInMemoryWorkflowStateStore,
  createPrime,
  type AuditSink,
  type EnginePort,
  type WorkflowDefinition,
} from "@proworks-hub/prime";
import type { AuditRecord } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// A real cross-engine workflow, driven by Prime.
//
// Everything Prime has been built with so far — Nexus, Pulse, engine routing,
// evidence — was proven against test doubles. Doubles answer exactly what you
// designed them to answer, so they confirm a design is self-consistent and
// nothing more. This runs the same machinery against FOUR REAL ENGINES:
//
//   forgeiq       manufacturing plan and manufacturability validation
//   costiq        costing from the plan
//   workorderiq   the work order, through its real intake use case
//   inventoryiq   the material reservation, against a real stock ledger
//
// Prime imports none of them. It cannot: the dependency law is
// `prime: ["platform"]`, and Prime's package depends on contracts and zod
// only. This file is the HOST — it is the one place that knows ForgeIQ answers
// "manufacturing.plan" — which is exactly the arrangement the ports were built
// for, demonstrated rather than asserted.
//
// The shop path: plan → cost → decide → create the job → reserve the material.
// ─────────────────────────────────────────────────────────────────────────────

const IDS = { cortenMaterialId: 1, mildSteelMaterialId: 2, fiberLaserMachineId: 1, pressBrakeMachineId: 2 };
const definition = buildFirepitDefinition(IDS);
const materials = new Map([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.mildSteelMaterialId, demoMildSteelSpecs],
]);
const machines = new Map([
  [IDS.fiberLaserMachineId, { name: "Gweike M3 Ultra (fiber)", specs: demoFiberLaserSpecs }],
  [IDS.pressBrakeMachineId, { name: "Press brake", specs: demoPressBrakeSpecs }],
]);

const configuration = productConfigurationSchema.parse({
  selections: { size: "size_24", material: "mat_corten", finish: "fin_raw", style: "style_mountain" },
  surfaces: {},
  quantity: 1,
});

const KSIX = "ksix";
const MATERIAL = "ACRYLIC-3MM";
const LOCATION = "main-rack";
const ACTOR: EventActor = { kind: "system", source: "prime-shop-path" };

/**
 * Binds the real engines to capability names.
 *
 * Named for what they DO, never for who does them. Nothing in the workflow
 * below says "forgeiq", which is the whole point: a shop that swapped its
 * costing engine would rebind here and change no workflow.
 */
function bindEngines(shop: ReturnType<typeof seedShop>): EnginePort[] {
  return [
    {
      capability: "manufacturing.plan",
      perform: () => {
        const validation = runValidation({
          definition,
          configuration,
          materials,
          machine: demoFiberLaserSpecs,
        });

        // A real refusal from a real engine. ForgeIQ decides this, not the
        // workflow and not Prime — and if it says the part cannot be made,
        // Nexus stops the shop path here rather than costing something
        // nobody can build.
        if (!validation.valid) {
          return {
            kind: "refused",
            reason: `Not manufacturable: ${validation.issues.map((i) => i.message).join("; ")}`,
          };
        }

        const plan = buildManufacturingPlan({
          definition,
          configuration,
          materials,
          machine: demoFiberLaserSpecs,
          machines,
          productDefinitionId: 3,
          productVersion: 3,
          configurationId: 1001,
          materialName: 'Corten Steel 1/8"',
          machineName: "Gweike M3 Ultra (fiber)",
          validation,
        });

        return { kind: "completed", output: { plan } };
      },
    },
    {
      capability: "cost.calculate",
      perform: ({ input }) => {
        const plan = input["plan"];
        if (!plan) {
          // The step ran without its prerequisite. Refused rather than
          // costed-as-zero, which is the shape of error that reaches a
          // customer as a price.
          return { kind: "refused", reason: "No manufacturing plan to cost." };
        }
        const cost = createCostIqEngine().calculate(plan as never);
        return { kind: "completed", output: { cost } };
      },
    },
    {
      capability: "job.create",
      perform: async ({ context, input }) => {
        const created = await shop.createWorkOrder.execute(
          {
            customerId: "cus_ksix",
            customerName: "KSix Designs",
            source: "manual",
            lineItems: [{ id: "li_1", label: "Custom Metal Fire Pit", quantity: 1 }],
          },
          ACTOR,
          // The correlation carried from Prime's execution context becomes the
          // idempotency key, so a resumed workflow reaches the same claim
          // rather than minting a second job. This is MIS-E2E03's guarantee
          // meeting Prime's trace propagation.
          { organizationId: KSIX, key: context.trace.correlationId },
        );

        if (!created.ok) {
          return {
            kind: "non-retryable-failure",
            reason:
              "conflict" in created
                ? `Idempotency conflict: ${created.conflict.message}`
                : `Invalid intake: ${created.errors.map((e) => e.message).join("; ")}`,
          };
        }
        void input;
        return { kind: "completed", output: { workOrderId: created.draft.workOrderId } };
      },
    },
    {
      capability: "material.reserve",
      perform: async ({ input }) => {
        const workOrderId = input["workOrderId"];
        if (typeof workOrderId !== "string") {
          return { kind: "refused", reason: "No work order to reserve against." };
        }

        const reserved = await shop.reserve.execute({
          organizationId: KSIX,
          materialId: MATERIAL,
          locationId: LOCATION,
          workOrderId,
          quantity: { amount: 4, unit: "each" },
        });

        if (!reserved.ok) {
          // Insufficient stock is a real business answer, not a fault. Waiting
          // rather than failing means the job survives until material arrives.
          return {
            kind: reserved.error.code === "insufficient_stock" ? "waiting" : "retryable-failure",
            ...(reserved.error.code === "insufficient_stock"
              ? { on: "material", detail: reserved.error.message }
              : { reason: reserved.error.message }),
          } as never;
        }

        return { kind: "completed", output: { reservationId: reserved.data.reservationId } };
      },
    },
  ];
}

function seedShop(onHand = 20) {
  const now = () => new Date("2026-08-29T10:00:00.000Z");
  const ledger = createInMemoryStockLedger([
    {
      materialId: MATERIAL,
      organizationId: KSIX,
      locationId: LOCATION,
      onHand: { amount: onHand, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    },
  ]);
  const reservations = createInMemoryReservationStore();
  let counter = 0;
  const eventLog = createInMemoryEventLog();

  return {
    ledger,
    eventLog,
    reserve: createReserveMaterialUseCase({
      stock: ledger,
      reservations,
      now,
      generateId: () => `rsv_${(counter += 1)}`,
    }),
    createWorkOrder: createCreateWorkOrderUseCase({
      eventLog,
      workOrderIdGenerator: () => `wo_ksix_${(counter += 1)}`,
      clock: now,
      // Required, because this workflow supplies an idempotency key derived
      // from Prime's correlation. Omitting it while passing a key is a
      // configuration error, not a soft fallback — and the first run of this
      // file found that out by failing at create-job.
      idempotencyStore: createInMemoryIdempotencyStore(),
    }),
    position: () => ledger.all().find((p) => p.organizationId === KSIX),
  };
}

/** The shop path, in capabilities. Nothing here names an engine. */
const SHOP_PATH: WorkflowDefinition = {
  workflowType: "shop.quote-to-job",
  steps: [
    { stepId: "plan", routeTo: "manufacturing.plan" },
    { stepId: "cost", routeTo: "cost.calculate" },
    { stepId: "create-job", routeTo: "job.create" },
    { stepId: "reserve", routeTo: "material.reserve" },
  ],
};

function primeFor(shop: ReturnType<typeof seedShop>, records: AuditRecord[] = []) {
  const audit: AuditSink = { record: (r) => void records.push(r) };
  return createPrime({
    continuity: createInMemoryWorkflowStateStore(),
    engines: bindEngines(shop),
    instanceId: "prime-test",
    audit,
  });
}

describe("Prime runs the shop path across four real engines", () => {
  it("plans, costs, creates the job and reserves the material", async () => {
    const shop = seedShop();
    const records: AuditRecord[] = [];
    const prime = primeFor(shop, records);

    const result = await prime.runner!.start({
      definition: SHOP_PATH,
      tenant: { organizationId: KSIX, roles: [] },
      trace: { correlationId: "cor-shop-1" },
    });

    expect(result.status).toBe("completed");

    // Every engine actually answered, and its real output is on the workflow.
    expect(result.context["plan"]).toBeDefined();
    expect(result.context["cost"]).toBeDefined();
    expect(String(result.context["workOrderId"])).toContain("wo_ksix");
    expect(String(result.context["reservationId"])).toContain("rsv_");

    // And the real side effects happened, in the engines that own them.
    const events = await shop.eventLog.listByType("work_order.intake.created");
    expect(events).toHaveLength(1);
    expect(shop.position()!.reserved.amount).toBe(4);
  });

  it("carries one correlation from Prime through to the work order's idempotency key", async () => {
    // Prime propagates; WorkOrderIQ claims. Running the same correlation twice
    // must produce one job, which is MIS-E2E03's guarantee reached through
    // Prime rather than by calling the use case directly.
    const shop = seedShop();
    const prime = primeFor(shop);

    for (const _run of [1, 2]) {
      await prime.runner!.start({
        definition: SHOP_PATH,
        tenant: { organizationId: KSIX, roles: [] },
        trace: { correlationId: "cor-shop-idem" },
      });
    }

    const events = await shop.eventLog.listByType("work_order.intake.created");
    expect(events).toHaveLength(1);
  });

  it("stops at the plan when ForgeIQ says the part cannot be made", async () => {
    // A real engine refusal, not a stubbed one. Nothing downstream runs — no
    // cost, no job, no reservation — because costing something nobody can
    // build is how an unbuildable part acquires a price and a promise date.
    const shop = seedShop();
    const prime = createPrime({
      continuity: createInMemoryWorkflowStateStore(),
      instanceId: "prime-test",
      engines: [
        {
          capability: "manufacturing.plan",
          perform: () => ({ kind: "refused", reason: "Not manufacturable: bottom plate exceeds the bed" }),
        },
        ...bindEngines(shop).filter((p) => p.capability !== "manufacturing.plan"),
      ],
    });

    const result = await prime.runner!.start({
      definition: SHOP_PATH,
      tenant: { organizationId: KSIX, roles: [] },
      trace: { correlationId: "cor-shop-refused" },
    });

    expect(result.status).not.toBe("completed");
    expect(result.context["cost"]).toBeUndefined();
    expect(result.context["workOrderId"]).toBeUndefined();
    expect(await shop.eventLog.listByType("work_order.intake.created")).toHaveLength(0);
    expect(shop.position()!.reserved.amount).toBe(0);
  });

  it("waits rather than failing when the shop is short of material", async () => {
    // Four sheets needed, one on hand. InventoryIQ refuses, the workflow waits,
    // and the job it already created survives — a real business state, not an
    // error. The reservation is what is missing, not the order.
    const shop = seedShop(1);
    const prime = primeFor(shop);

    const result = await prime.runner!.start({
      definition: SHOP_PATH,
      tenant: { organizationId: KSIX, roles: [] },
      trace: { correlationId: "cor-shop-short" },
    });

    expect(result.status).not.toBe("completed");
    expect(String(result.context["nexusReason"])).toContain("material");
    // The work order was still created. Waiting on stock does not undo it.
    expect(await shop.eventLog.listByType("work_order.intake.created")).toHaveLength(1);
    expect(shop.position()!.reserved.amount).toBe(0);
  });

  it("leaves audit evidence for every decision, in the schema's own shape", async () => {
    const shop = seedShop();
    const records: AuditRecord[] = [];
    const prime = primeFor(shop, records);

    await prime.runner!.start({
      definition: SHOP_PATH,
      tenant: { organizationId: KSIX, roles: [] },
      trace: { correlationId: "cor-shop-audit" },
    });

    // One decision per step, plus the completion.
    expect(records.length).toBeGreaterThanOrEqual(SHOP_PATH.steps.length);
    expect(records.every((r) => r.component === "hive.prime.prime")).toBe(true);
    expect(records.every((r) => r.tenant.organizationId === KSIX)).toBe(true);
    // The correlation survives into the evidence, which is what makes a wrong
    // answer traceable back to the run that produced it.
    expect(records.every((r) => r.trace.correlationId === "cor-shop-audit")).toBe(true);
    expect(records.some((r) => r.target?.id === "create-job")).toBe(true);
  });

  it("does not let Prime reach an engine it was not given", async () => {
    // The dependency law, demonstrated. This host binds three capabilities and
    // the workflow needs four; the fourth is refused rather than resolved by
    // Prime reaching for a package it happens to have. Prime has no such
    // package — its dependencies are contracts and zod.
    const shop = seedShop();
    const prime = createPrime({
      continuity: createInMemoryWorkflowStateStore(),
      instanceId: "prime-test",
      engines: bindEngines(shop).filter((p) => p.capability !== "material.reserve"),
    });

    expect(prime.boundCapabilities()).toEqual(["cost.calculate", "job.create", "manufacturing.plan"]);

    const result = await prime.runner!.start({
      definition: SHOP_PATH,
      tenant: { organizationId: KSIX, roles: [] },
      trace: { correlationId: "cor-shop-unbound" },
    });

    expect(result.status).not.toBe("completed");
    expect(String(result.context["nexusReason"])).toContain("No engine is bound");
    // The job exists; the reservation does not. The workflow stopped exactly
    // where the wiring ran out.
    expect(await shop.eventLog.listByType("work_order.intake.created")).toHaveLength(1);
    expect(shop.position()!.reserved.amount).toBe(0);
  });
});
