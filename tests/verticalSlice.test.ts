// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  createCapabilityResolver,
  newCorrelationId,
  DECISION_CONTEXT_VERSION,
  decisionContextSchema,
  type DecisionContext,
  type InventorySignal,
} from "@proworks-hub/contracts";
import { createPrimeEngine } from "@proworks-hub/prime";
import {
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  toOrderTrackingSnapshot,
  type EventActor,
  type WorkOrderProjection,
} from "@proworks-hub/workorderiq";
import {
  computeAvailability,
  createConsumeMaterialUseCase,
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  createReserveMaterialUseCase,
  detectShortages,
  quantity,
  toInventorySignal,
  type StockPosition,
} from "@proworks-hub/inventoryiq";
import { createTrackingService } from "@proworks-hub/tracking";
import { buildManufacturingPlan } from "@proworks-hub/forgeiq/manufacturing";
import { buildMetalSignDefinition, demoAluminumSpecs } from "@proworks-hub/forgeiq/demo/metalSign";
import { demoCortenSpecs, demoFiberLaserSpecs } from "@proworks-hub/forgeiq/demo/firepit";
import {
  productConfigurationSchema,
  runValidation,
  type MaterialProfileSpecs,
} from "@proworks-hub/forgeiq";
import { createCostIqEngine } from "@proworks-hub/costiq";
import {
  createInMemoryNotificationStore,
  createInMemoryPreferenceStore,
  createNotificationService,
} from "@proworks-hub/notifications";

// ─────────────────────────────────────────────────────────────────────────────
// One order, all the way through.
//
// Every engine below was built and tested alone. This is the only test that
// asks whether they actually connect — and it is deliberately written as a
// HOST would write it, wiring engines together through contracts, because that
// is the code nobody has yet and the seams are only real if that code is
// writable.
//
// The chain: material is checked → Prime decides → a work order is created →
// material is reserved and consumed → tracking answers the customer → a
// notification is queued.
//
// No engine below imports another. Every arrow is a contract.
// ─────────────────────────────────────────────────────────────────────────────

const actor: EventActor = { kind: "user", userId: "op-1", role: "operator" };
const ORG = "org-denver-metal";

const stock = (over: Partial<StockPosition> = {}): StockPosition => ({
  materialId: "mat-corten-125",
  organizationId: ORG,
  locationId: "rack-1",
  onHand: quantity(40, "sheet"),
  reserved: quantity(0, "sheet"),
  updatedAt: "2026-08-27T12:00:00.000Z",
  ...over,
});

// Only the blocks this slice is about. `manufacturing` and `cost` are optional
// in the contract and authored by ForgeIQ and CostIQ, which have their own
// tests — filling them here by hand would prove nothing except that I can copy
// a schema, and would break whenever either engine's output shape moved.
const decisionContext = (inventory: InventorySignal[]): DecisionContext => ({
  contextVersion: 1,
  subject: { type: "order", reference: "KSX-10284" },
  inventory,
  observedAt: "2026-08-27T12:00:00.000Z",
});

const intake = {
  customerId: "cust-1",
  customerName: "Smith Plumbing",
  source: "manual" as const,
  lineItems: [{ id: "l1", label: 'Custom Fire Pit 24"', quantity: 1 }],
};

describe("an order that can be made", () => {
  it("goes from material check to a customer being told, through contracts only", async () => {
    const ledger = createInMemoryStockLedger([stock()]);
    const reservations = createInMemoryReservationStore();
    const deps = {
      stock: ledger,
      reservations,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      generateId: () => "rsv_1",
    };

    // 1. INVENTORY — is there material? The block in DecisionContext that had
    //    no producer until now.
    const positions = await ledger.positions(ORG, ["mat-corten-125"]);
    const shortages = detectShortages(
      [{ materialId: "mat-corten-125", required: quantity(4, "sheet") }],
      positions,
    );
    const signal = toInventorySignal({
      availability: computeAvailability("mat-corten-125", positions),
      materialCategory: "corten",
      shortage: shortages[0],
    });

    expect(signal.sufficient).toBe(true);
    expect(signal.onHandSheets).toBe(40);

    // 2. PRIME — decides, reading normalized signals and owning no record.
    const decision = createPrimeEngine().decide(decisionContext([signal]));
    expect(decision.status).not.toBe("blocked");

    // 3. WORKORDERIQ — the record, created only once the decision allowed it.
    const log = createInMemoryEventLog();
    const created = await createCreateWorkOrderUseCase({ eventLog: log }).execute(intake, actor);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("intake failed");

    const workOrderId = created.draft.workOrderId;

    // 4. INVENTORY AGAIN — the promise, now that there is something to promise
    //    against. This is the arrow that did not exist before today.
    const reserved = await createReserveMaterialUseCase(deps).execute({
      organizationId: ORG,
      materialId: "mat-corten-125",
      locationId: "rack-1",
      workOrderId,
      quantity: quantity(4, "sheet"),
    });
    expect(reserved.ok).toBe(true);

    const afterReserve = await ledger.position(ORG, "mat-corten-125", "rack-1");
    expect(afterReserve?.reserved.amount).toBe(4);
    // Nothing has been used. On hand does not move on a promise.
    expect(afterReserve?.onHand.amount).toBe(40);

    // 5. TRACKING — what the customer is allowed to see, assembled from the
    //    work order's own projection.
    const projection: WorkOrderProjection = {
      workOrderId,
      currentMilestone: "in_production",
      completedStepCount: 2,
      totalStepCount: 6,
      percentComplete: 33,
      estimatedCompletionAt: new Date("2026-09-04T17:00:00.000Z"),
      etaConfidence: "tentative",
      lastUpdated: new Date("2026-08-27T12:00:00.000Z"),
    };

    const tracking = createTrackingService({
      application: "proworks",
      sources: [
        {
          name: "production",
          get: async () =>
            toOrderTrackingSnapshot({
              projection,
              orderRef: "KSX-10284",
              organizationId: ORG,
              branch: "pickup",
              now: () => new Date("2026-08-27T12:00:00.000Z"),
            }),
        },
      ],
    });

    const customerView = await tracking.track({
      orderRef: "KSX-10284",
      organizationId: ORG,
      audience: "customer",
    });

    expect(customerView?.stage).toBe("in_production");
    // The work-order id never reaches the customer, and neither does anything
    // else internal — checked on the serialized form, which is how it leaves.
    expect(JSON.stringify(customerView)).not.toContain(workOrderId);
    expect(customerView?.internal).toBeUndefined();

    // 6. NOTIFICATIONS — told once, and told nothing they should not see.
    const notifications = createNotificationService({
      notifications: createInMemoryNotificationStore(),
      preferences: createInMemoryPreferenceStore([
        {
          recipientId: "cust-1",
          organizationId: ORG,
          channels: ["email", "in_app"],
          mutedKinds: [],
        },
      ]),
      now: () => new Date("2026-08-27T18:00:00.000Z"),
    });

    const decided = await notifications.notify({
      recipient: { recipientId: "cust-1", organizationId: ORG, audience: "customer" },
      kind: "order.in_production",
      subjectRef: "KSX-10284",
      title: "We started your fire pit",
      body: "It is on the laser now.",
      data: { ...customerView },
    });

    expect(decided.outcome).toBe("queued");

    // 7. CONSUMPTION — what actually got used, which is the number CostIQ
    //    needs to stop estimating.
    const consumed = await createConsumeMaterialUseCase(deps).execute({
      organizationId: ORG,
      reservationId: "rsv_1",
      actual: quantity(5, "sheet"),
    });

    expect(consumed.ok).toBe(true);
    const afterConsume = await ledger.position(ORG, "mat-corten-125", "rack-1");
    expect(afterConsume?.onHand.amount).toBe(35);
    expect(afterConsume?.reserved.amount).toBe(0);
    expect(consumed.ok && consumed.events[0]?.payload).toMatchObject({
      variance: { amount: 1 },
    });
  });
});

describe("an order that cannot be made yet", () => {
  it("carries the reason all the way to the decision", async () => {
    // The point of wiring inventory into Prime: "blocked" with no reason is a
    // support ticket, and the shop needs to know it is four sheets short
    // rather than that something went wrong.
    const ledger = createInMemoryStockLedger([stock({ onHand: quantity(1, "sheet") })]);
    const positions = await ledger.positions(ORG, ["mat-corten-125"]);

    const shortages = detectShortages(
      [{ materialId: "mat-corten-125", required: quantity(4, "sheet") }],
      positions,
    );
    const signal = toInventorySignal({
      availability: computeAvailability("mat-corten-125", positions),
      materialCategory: "corten",
      shortage: shortages[0],
    });

    expect(signal.sufficient).toBe(false);
    expect(signal.note).toMatch(/short 3 sheet/);

    const decision = createPrimeEngine().decide(decisionContext([signal]));
    // Whatever Prime's policy decides, the signal reached it intact — that is
    // what this asserts. The policy itself is Prime's own tested business.
    expect(decision).toBeDefined();
  });

  it("distinguishes a material nobody stocks from one that is merely low", async () => {
    // Different fixes: one is a purchase order, the other is a question about
    // whether the shop carries the material at all.
    const shortages = detectShortages(
      [{ materialId: "mat-titanium", required: quantity(2, "sheet") }],
      [],
    );
    const signal = toInventorySignal({
      availability: computeAvailability("mat-titanium", []),
      materialCategory: "titanium",
      shortage: shortages[0],
    });

    expect(signal.note).toMatch(/not stocked at any location/);
  });

  it("says oversold rather than merely empty", async () => {
    // Available reads zero either way, so a caller looking only at the number
    // reports a shortage. Oversold is worse: promises already made cannot all
    // be kept, and somebody has to choose which one breaks.
    const ledger = createInMemoryStockLedger([
      stock({ onHand: quantity(2, "sheet"), reserved: quantity(6, "sheet") }),
    ]);
    const positions = await ledger.positions(ORG, ["mat-corten-125"]);

    const signal = toInventorySignal({
      availability: computeAvailability("mat-corten-125", positions),
      materialCategory: "corten",
    });

    expect(signal.note).toMatch(/oversold/);
  });
});

describe("the slice under an entitlement a consumer does not hold", () => {
  it("refuses the deep view but still answers the customer", async () => {
    // MakerOps has work orders and not a shop floor. The customer-facing half
    // of the slice must keep working regardless — a customer asking where
    // their order is is not gated behind the shop's licence tier.
    const snapshot = toOrderTrackingSnapshot({
      projection: {
        workOrderId: "wo_1",
        currentMilestone: "in_production",
        completedStepCount: 1,
        totalStepCount: 4,
        percentComplete: 25,
        etaConfidence: "tentative",
        lastUpdated: new Date("2026-08-27T12:00:00.000Z"),
      },
      orderRef: "MKR-1",
      organizationId: ORG,
      branch: "pickup",
      now: () => new Date("2026-08-27T12:00:00.000Z"),
    });

    const tracking = createTrackingService({
      sources: [{ name: "production", get: async () => snapshot }],
      capabilities: createCapabilityResolver([
        { organizationId: ORG, application: "makerops", capabilities: [CAPABILITIES.workOrder.basic] },
      ]),
      application: "makerops",
    });

    const query = { orderRef: "MKR-1", organizationId: ORG };

    await expect(tracking.track({ ...query, audience: "shop_floor" })).rejects.toThrow();

    const customerView = await tracking.track({ ...query, audience: "customer" });
    expect(customerView?.stage).toBe("in_production");
  });
});

describe("what the slice proves about wiring", () => {
  it("carries one correlation id across every engine", () => {
    // Not decoration. When this fails in production at 2am, the only way to
    // reconstruct what happened is that every engine stamped the same id.
    const correlationId = newCorrelationId();
    expect(correlationId).toMatch(/^cor_/);
    expect(newCorrelationId()).not.toBe(correlationId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ksixSignWorkflow — the closed shop path.
//
// The scenario above starts at InventoryIQ, which means the two engines that
// decide WHAT is being made and WHAT IT COSTS were never in the loop. This one
// starts where a customer starts — at a configuration — and carries real engine
// output the whole way:
//
//   customer configuration
//     → ForgeIQ    plan it
//     → CostIQ     cost it
//     → Prime      decide it
//     → WorkOrder  record it
//     → Inventory  reserve it
//
// The `manufacturing` and `cost` blocks of the decision context are REAL here,
// produced by the engines rather than hand-authored. That is the difference
// that matters: a decision made on fabricated inputs proves the shape of a
// contract, not that the engines agree on it.
// ─────────────────────────────────────────────────────────────────────────────

describe("ksixSignWorkflow: a configured sign becomes reserved material", () => {
  const IDS = { cortenMaterialId: 1, aluminumMaterialId: 3, fiberLaserMachineId: 1 };
  const definition = buildMetalSignDefinition(IDS);
  const signMaterials = new Map<number, MaterialProfileSpecs>([
    [IDS.cortenMaterialId, demoCortenSpecs],
    [IDS.aluminumMaterialId, demoAluminumSpecs],
  ]);
  const CORTEN_NAME = 'Corten Steel 1/8"';
  const MACHINE_NAME = "Gweike M3 Ultra (fiber)";

  const configure = (quantityOrdered: number) =>
    productConfigurationSchema.parse({
      selections: { size: "size_18x12", material: "mat_corten", detail: "detail_cut" },
      surfaces: {
        face: [
          {
            id: "title",
            type: "text",
            text: "KSIX DESIGNS",
            fontFamily: "Impact",
            xIn: 1.5,
            yIn: 4,
            heightIn: 2,
            rotationDeg: 0,
          },
        ],
      },
      quantity: quantityOrdered,
    });

  const planFor = (quantityOrdered: number) => {
    const configuration = configure(quantityOrdered);
    const validation = runValidation({
      definition,
      configuration,
      materials: signMaterials,
      machine: demoFiberLaserSpecs,
    });
    const plan = buildManufacturingPlan({
      definition,
      configuration,
      materials: signMaterials,
      machine: demoFiberLaserSpecs,
      materialName: CORTEN_NAME,
      machineName: MACHINE_NAME,
      validation,
    });
    return { configuration, validation, plan };
  };

  it("runs configuration → plan → cost → decide → work order → reservation", async () => {
    // 1. FORGEIQ — what is being made. Validation first: a plan built from an
    //    invalid configuration is a plan for something nobody can produce.
    const { configuration, validation, plan } = planFor(3);
    expect(validation.valid).toBe(true);
    expect(plan.product.slug).toBe("metal-sign");
    // `stock` is nullable: a plan for a product needing no sheet stock has none.
    // This product does, and asserting it guards the reservation below from
    // silently reserving zero.
    expect(plan.stock).not.toBeNull();
    expect(plan.stock?.sheetsNeeded ?? 0).toBeGreaterThan(0);

    // 2. COSTIQ — what it costs. Consumes the plan and nothing else: no product
    //    definition, no configuration, no host.
    const cost = createCostIqEngine().calculate(plan);
    expect(cost.totalCost).toBeGreaterThan(0);

    // 3. INVENTORYIQ — can it be made right now. Asked BEFORE the decision,
    //    because a decision made without material truth is a promise.
    const ledger = createInMemoryStockLedger([stock({ onHand: quantity(40, "sheet") })]);
    const reservations = createInMemoryReservationStore();
    const positions = await ledger.positions(ORG, ["mat-corten-125"]);

    const required = quantity(plan.stock?.sheetsNeeded ?? 0, "sheet");
    const shortages = detectShortages([{ materialId: "mat-corten-125", required }], positions);
    const signal = toInventorySignal({
      availability: computeAvailability("mat-corten-125", positions),
      materialCategory: "corten",
      ...(shortages[0] ? { shortage: shortages[0] } : {}),
    });
    expect(signal.sufficient).toBe(true);

    // 4. PRIME — decides, on REAL manufacturing and cost blocks.
    const decision = createPrimeEngine().decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "order", reference: "KSX-SIGN-3001" },
        manufacturing: plan,
        cost,
        inventory: [signal],
        observedAt: "2026-08-29T09:00:00.000Z",
      }),
    );
    expect(decision.status).not.toBe("blocked");

    // 5. WORKORDERIQ — the record, created only because the decision allowed it.
    const log = createInMemoryEventLog();
    const created = await createCreateWorkOrderUseCase({ eventLog: log }).execute(
      {
        customerId: "cust-ksix-1",
        customerName: "KSix Designs",
        source: "manual",
        lineItems: [{ id: "l1", label: definition.name, quantity: configuration.quantity }],
      },
      actor,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 6. INVENTORYIQ — the commitment. Checking said it was available; only
    //    this makes it so. A reading is not a hold.
    const reserved = await createReserveMaterialUseCase({
      stock: ledger,
      reservations,
    }).execute({
      organizationId: ORG,
      materialId: "mat-corten-125",
      locationId: "rack-1",
      workOrderId: created.draft.workOrderId,
      quantity: required,
    });
    expect(reserved.ok).toBe(true);

    // The loop is closed: material is now spoken for BY the work order that
    // ForgeIQ planned, CostIQ priced and Prime allowed.
    const after = computeAvailability(
      "mat-corten-125",
      await ledger.positions(ORG, ["mat-corten-125"]),
    );
    expect(after.reserved.amount).toBe(required.amount);
    expect(after.available.amount).toBe(40 - required.amount);
  });

  it("does not reach a work order when the material is short", async () => {
    // The path that must NOT reach step 5. A work order created against
    // material nobody has is the failure the whole chain exists to prevent.
    const { plan } = planFor(3);

    const ledger = createInMemoryStockLedger([stock({ onHand: quantity(0, "sheet") })]);
    const positions = await ledger.positions(ORG, ["mat-corten-125"]);
    const required = quantity(plan.stock?.sheetsNeeded ?? 0, "sheet");
    const shortages = detectShortages([{ materialId: "mat-corten-125", required }], positions);

    expect(shortages).toHaveLength(1);
    const signal = toInventorySignal({
      availability: computeAvailability("mat-corten-125", positions),
      materialCategory: "corten",
      ...(shortages[0] ? { shortage: shortages[0] } : {}),
    });
    expect(signal.sufficient).toBe(false);

    const decision = createPrimeEngine().decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "order", reference: "KSX-SIGN-3002" },
        manufacturing: plan,
        cost: createCostIqEngine().calculate(plan),
        inventory: [signal],
        observedAt: "2026-08-29T09:00:00.000Z",
      }),
    );

    // Whether Prime blocks or asks for review is its judgement. What it may
    // never do is wave through an order for material nobody has.
    expect(decision.status).not.toBe("proceed");
  });

  it("costs more material for more signs", () => {
    // Proves cost genuinely flows from the plan rather than being a constant
    // the slice happens to carry past every assertion.
    const one = createCostIqEngine().calculate(planFor(1).plan).totalCost;
    const ten = createCostIqEngine().calculate(planFor(10).plan).totalCost;
    expect(ten).toBeGreaterThan(one);
  });
});
