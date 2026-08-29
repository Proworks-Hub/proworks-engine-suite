// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

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
  type IntakeInput,
} from "@proworks-hub/workorderiq";

// ─────────────────────────────────────────────────────────────────────────────
// Cross-engine idempotency — E2E-03 end to end.
//
// The gate scenario is not "WorkOrderIQ dedupes" or "InventoryIQ dedupes". It
// is: create a work order twice with one key, reserve against it, and end with
// ONE work order holding FOUR sheets.
//
// Testing each engine alone would pass while the pair still double-reserved:
// two work orders each reserving four is four sheets per work order and eight
// held, and every per-engine test would be green. This is the test that
// actually fails if the two halves do not fit.
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "ksix";
const MATERIAL = "corten-18";
const LOCATION = "main-rack";
const BOM = { amount: 4, unit: "each" as const };

const actor: EventActor = { kind: "system", source: "e2e" };

const intake = (over: Partial<IntakeInput> = {}): IntakeInput => ({
  customerId: "cus_1",
  customerName: "KSix Designs",
  source: "manual",
  lineItems: [{ id: "li_1", label: '24" fire pit', quantity: 1 }],
  ...over,
});

function shopFloor() {
  const ledger = createInMemoryStockLedger([
    {
      materialId: MATERIAL,
      organizationId: ORG,
      locationId: LOCATION,
      onHand: { amount: 20, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    },
  ]);
  const reservations = createInMemoryReservationStore();
  let rsv = 0;
  let wo = 0;

  return {
    ledger,
    reserve: createReserveMaterialUseCase({
      stock: ledger,
      reservations,
      now: () => new Date("2026-08-29T10:00:00.000Z"),
      generateId: () => `rsv_${(rsv += 1)}`,
    }),
    createWorkOrder: createCreateWorkOrderUseCase({
      eventLog: createInMemoryEventLog(),
      workOrderIdGenerator: () => `wo_${(wo += 1)}`,
      clock: () => new Date("2026-08-29T10:00:00.000Z"),
      idempotencyStore: createInMemoryIdempotencyStore(),
    }),
    position: () => ledger.all().find((p) => p.organizationId === ORG)!,
  };
}

/** The full operation: create the work order, then reserve its BOM. */
async function placeJob(
  floor: ReturnType<typeof shopFloor>,
  key: string,
  input: IntakeInput = intake(),
): Promise<{ workOrderId: string | null }> {
  const created = await floor.createWorkOrder.execute(input, actor, {
    organizationId: ORG,
    key,
  });
  if (!created.ok) return { workOrderId: null };

  await floor.reserve.execute({
    organizationId: ORG,
    materialId: MATERIAL,
    locationId: LOCATION,
    workOrderId: created.draft.workOrderId,
    quantity: BOM,
  });

  return { workOrderId: created.draft.workOrderId };
}

describe("E2E-03 — one key, one work order, one reservation set", () => {
  it("repeating the whole operation reserves exactly 4", async () => {
    const floor = shopFloor();
    const first = await placeJob(floor, "order-388");
    const second = await placeJob(floor, "order-388");
    const third = await placeJob(floor, "order-388");

    expect(second.workOrderId).toBe(first.workOrderId);
    expect(third.workOrderId).toBe(first.workOrderId);

    // The acceptance condition.
    expect(floor.position().reserved.amount).toBe(4);
    expect(floor.position().onHand.amount).toBe(20);
  });

  it("running the whole operation concurrently reserves exactly 4", async () => {
    const floor = shopFloor();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => placeJob(floor, "order-388")),
    );

    const ids = new Set(results.map((r) => r.workOrderId));
    expect(ids.size).toBe(1);
    expect(floor.position().reserved.amount).toBe(4);
    expect(floor.position().onHand.amount).toBe(20);
  });

  it("still creates two jobs for two different keys", async () => {
    // The guarantee must not collapse distinct work into one.
    const floor = shopFloor();
    const a = await placeJob(floor, "order-388");
    const b = await placeJob(floor, "order-389");

    expect(b.workOrderId).not.toBe(a.workOrderId);
    expect(floor.position().reserved.amount).toBe(8);
  });

  it("refuses the second job when the key is reused with a different payload", async () => {
    // And, critically, reserves nothing for the refused one.
    const floor = shopFloor();
    await placeJob(floor, "order-388");

    const conflicting = await placeJob(
      floor,
      "order-388",
      intake({ lineItems: [{ id: "li_1", label: '30" fire pit', quantity: 2 }] }),
    );

    expect(conflicting.workOrderId).toBeNull();
    expect(floor.position().reserved.amount).toBe(4);
  });

  it("holds when creation and reservation interleave", async () => {
    // A duplicate arriving mid-flight is the shape a retry actually takes: the
    // second request starts before the first has finished reserving.
    const floor = shopFloor();

    const slow = placeJob(floor, "order-388");
    const fast = placeJob(floor, "order-388");
    const [a, b] = await Promise.all([slow, fast]);

    expect(b.workOrderId).toBe(a.workOrderId);
    expect(floor.position().reserved.amount).toBe(4);
  });
});

describe("the two engines stay independent", () => {
  it("InventoryIQ still deduplicates without WorkOrderIQ involved", async () => {
    // The inventory guarantee does not depend on the work-order one. A host
    // that reserves against an externally-created work order gets the same
    // protection.
    const floor = shopFloor();
    for (let i = 0; i < 3; i += 1) {
      await floor.reserve.execute({
        organizationId: ORG,
        materialId: MATERIAL,
        locationId: LOCATION,
        workOrderId: "wo_external",
        quantity: BOM,
      });
    }
    expect(floor.position().reserved.amount).toBe(4);
  });

  it("WorkOrderIQ still deduplicates without InventoryIQ involved", async () => {
    const floor = shopFloor();
    const first = await floor.createWorkOrder.execute(intake(), actor, {
      organizationId: ORG,
      key: "k",
    });
    const second = await floor.createWorkOrder.execute(intake(), actor, {
      organizationId: ORG,
      key: "k",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.draft.workOrderId).toBe(first.draft.workOrderId);
    // Nothing was reserved, because nothing asked to be.
    expect(floor.position().reserved.amount).toBe(0);
  });
});
