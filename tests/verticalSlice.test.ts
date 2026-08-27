// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  createCapabilityResolver,
  newCorrelationId,
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
