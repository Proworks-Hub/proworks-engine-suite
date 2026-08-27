// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { beforeEach, describe, expect, it } from "vitest";

import {
  UnitMismatchError,
  addQuantity,
  compareQuantity,
  quantity,
  subtractQuantity,
  sumQuantities,
  type StockPosition,
} from "../models.js";
import { computeAvailability, detectReorderSignals, detectShortages } from "../availability.js";
import {
  createConsumeMaterialUseCase,
  createReleaseReservationUseCase,
  createReserveMaterialUseCase,
} from "../reservations.js";
import {
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  type InMemoryReservationStore,
  type InMemoryStockLedger,
} from "../inMemory.js";
import type { InventoryDeps } from "../ports.js";

const position = (over: Partial<StockPosition> = {}): StockPosition => ({
  materialId: "mat-steel-18ga",
  organizationId: "org-a",
  locationId: "rack-1",
  onHand: quantity(100, "sq_ft"),
  reserved: quantity(0, "sq_ft"),
  updatedAt: "2026-08-27T12:00:00.000Z",
  ...over,
});

describe("quantities refuse to be mixed", () => {
  it("will not add square feet to linear feet", () => {
    // The bug this exists to make impossible: the number stays plausible for
    // months, and the shortage shows up at a machine.
    expect(() => addQuantity(quantity(10, "sq_ft"), quantity(4, "linear_ft"))).toThrow(
      UnitMismatchError,
    );
    expect(() => sumQuantities([quantity(1, "lb")], "kg")).toThrow(UnitMismatchError);
  });

  it("does not drift when a balance is worked over and over", () => {
    // 0.1 + 0.2 !== 0.3 in binary floats, and a stock level is added to and
    // subtracted from hundreds of times as reservations come and go. A balance
    // that should be zero reading 1e-14 answers "is there any left" with yes.
    let balance = quantity(0, "lb");
    for (let i = 0; i < 1000; i += 1) balance = addQuantity(balance, quantity(0.1, "lb"));
    for (let i = 0; i < 1000; i += 1) balance = subtractQuantity(balance, quantity(0.1, "lb"));

    expect(balance.amount).toBe(0);
    expect(compareQuantity(balance, quantity(0, "lb"))).toBe(0);
  });
});

describe("what is available is not what is on the shelf", () => {
  it("subtracts what is already promised", () => {
    const availability = computeAvailability("mat-steel-18ga", [
      position({ onHand: quantity(100, "sq_ft"), reserved: quantity(30, "sq_ft") }),
    ]);

    expect(availability.available.amount).toBe(70);
    expect(availability.oversold).toBe(false);
  });

  it("adds up every bin holding the material", () => {
    // A shop with material in two places has material. Answering from one bin
    // is how it decides it has none.
    const availability = computeAvailability("mat-steel-18ga", [
      position({ locationId: "rack-1", onHand: quantity(40, "sq_ft") }),
      position({ locationId: "rack-2", onHand: quantity(35, "sq_ft") }),
    ]);

    expect(availability.onHand.amount).toBe(75);
    expect(availability.locations).toHaveLength(2);
  });

  it("says so when more is promised than exists", () => {
    // A real state, not an impossible one: stock gets counted wrong, material
    // gets damaged, a delivery arrives short. Clamping to zero and saying
    // nothing turns it into a surprise at a machine.
    const availability = computeAvailability("mat-steel-18ga", [
      position({ onHand: quantity(10, "sq_ft"), reserved: quantity(25, "sq_ft") }),
    ]);

    expect(availability.oversold).toBe(true);
    expect(availability.available.amount).toBe(0);
    expect(availability.reserved.amount).toBe(25);
  });

  it("refuses to average two units into a plausible wrong number", () => {
    expect(() =>
      computeAvailability("mat-steel-18ga", [
        position({ locationId: "rack-1", onHand: quantity(40, "sq_ft") }),
        position({ locationId: "rack-2", onHand: quantity(35, "sheet") }),
      ]),
    ).toThrow(UnitMismatchError);
  });
});

describe("deciding whether a job can be made", () => {
  it("reports only what is missing", () => {
    const positions = [
      position({ materialId: "mat-a", onHand: quantity(100, "sq_ft") }),
      position({ materialId: "mat-b", onHand: quantity(2, "sq_ft") }),
    ];

    const shortages = detectShortages(
      [
        { materialId: "mat-a", required: quantity(50, "sq_ft") },
        { materialId: "mat-b", required: quantity(10, "sq_ft") },
      ],
      positions,
    );

    expect(shortages).toHaveLength(1);
    expect(shortages[0]).toMatchObject({ materialId: "mat-b", short: { amount: 8 } });
  });

  it("treats a material nobody stocks as short by everything", () => {
    // Distinct from "low", because the fix is different: one is a purchase
    // order, the other is a question about whether the material exists here.
    const shortages = detectShortages(
      [{ materialId: "mat-unknown", required: quantity(5, "sheet") }],
      [],
    );

    expect(shortages[0]?.unknownMaterial).toBe(true);
    expect(shortages[0]?.short.amount).toBe(5);
  });

  it("counts a reserved shelf as an empty one", () => {
    const shortages = detectShortages(
      [{ materialId: "mat-steel-18ga", required: quantity(20, "sq_ft") }],
      [position({ onHand: quantity(100, "sq_ft"), reserved: quantity(95, "sq_ft") })],
    );

    expect(shortages).toHaveLength(1);
    expect(shortages[0]?.available.amount).toBe(5);
  });
});

describe("knowing when to buy more", () => {
  it("looks at available, not at what is on the shelf", () => {
    // Ten sheets all promised to jobs is an empty shelf for the next job. A
    // reorder rule that watches on-hand notices when the shelf is bare, which
    // is a week late.
    const signals = detectReorderSignals([
      position({
        onHand: quantity(100, "sq_ft"),
        reserved: quantity(96, "sq_ft"),
        reorderPoint: quantity(20, "sq_ft"),
      }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.available.amount).toBe(4);
  });

  it("tops up to the reorder point when no quantity is configured", () => {
    const signals = detectReorderSignals([
      position({ onHand: quantity(5, "sq_ft"), reorderPoint: quantity(20, "sq_ft") }),
    ]);

    expect(signals[0]?.suggestedOrder.amount).toBe(15);
  });

  it("stays quiet about material with no reorder point set", () => {
    expect(detectReorderSignals([position({ onHand: quantity(0, "sq_ft") })])).toEqual([]);
  });
});

describe("promising material and then settling the promise", () => {
  let stock: InMemoryStockLedger;
  let reservations: InMemoryReservationStore;
  let deps: InventoryDeps;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    stock = createInMemoryStockLedger([position()]);
    reservations = createInMemoryReservationStore();
    deps = {
      stock,
      reservations,
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      generateId: () => `rsv_${++counter}`,
    };
  });

  const reserve = () => createReserveMaterialUseCase(deps);
  const release = () => createReleaseReservationUseCase(deps);
  const consume = () => createConsumeMaterialUseCase(deps);

  const held = (amount = 30) =>
    reserve().execute({
      organizationId: "org-a",
      materialId: "mat-steel-18ga",
      locationId: "rack-1",
      workOrderId: "wo_1",
      quantity: quantity(amount, "sq_ft"),
    });

  it("moves stock from available to reserved", async () => {
    const result = await held();

    expect(result.ok).toBe(true);
    const after = await stock.position("org-a", "mat-steel-18ga", "rack-1");
    expect(after?.reserved.amount).toBe(30);
    // On hand does not move. Nothing has been used yet.
    expect(after?.onHand.amount).toBe(100);
  });

  it("refuses to promise the same material twice", async () => {
    // The failure this whole engine exists to prevent: two jobs promised one
    // sheet, discovered at the machine with the second job already set up.
    await held(80);
    const second = await held(40);

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe("insufficient_stock");
    expect(second.ok === false && second.error.message).toMatch(/20 available/);
  });

  it("allows an oversell when somebody deliberately asks for one, and announces it", async () => {
    // Sometimes correct — the delivery lands this afternoon, the job runs
    // tomorrow. Never a default, and never silent.
    const result = await createReserveMaterialUseCase(deps).execute({
      organizationId: "org-a",
      materialId: "mat-steel-18ga",
      locationId: "rack-1",
      workOrderId: "wo_1",
      quantity: quantity(150, "sq_ft"),
      allowOversell: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.events.map((e) => e.type)).toContain("material.oversold");
  });

  it("refuses a request in the wrong unit rather than converting it", async () => {
    const result = await createReserveMaterialUseCase(deps).execute({
      organizationId: "org-a",
      materialId: "mat-steel-18ga",
      locationId: "rack-1",
      workOrderId: "wo_1",
      quantity: quantity(5, "sheet"),
    });

    expect(result.ok === false && result.error.code).toBe("unit_mismatch");
  });

  it("gives the material back when a reservation is released", async () => {
    const first = await held();
    if (!first.ok) throw new Error("setup failed");

    await release().execute({ organizationId: "org-a", reservationId: first.data.reservationId });

    const after = await stock.position("org-a", "mat-steel-18ga", "rack-1");
    expect(after?.reserved.amount).toBe(0);
    expect(after?.onHand.amount).toBe(100);
  });

  it("will not release the same reservation twice", async () => {
    // A retry after a timeout is the common case, not an exotic one. Crediting
    // the quantity back a second time invents material.
    const first = await held();
    if (!first.ok) throw new Error("setup failed");

    await release().execute({ organizationId: "org-a", reservationId: first.data.reservationId });
    const again = await release().execute({
      organizationId: "org-a",
      reservationId: first.data.reservationId,
    });

    expect(again.ok === false && again.error.code).toBe("already_settled");
    expect((await stock.position("org-a", "mat-steel-18ga", "rack-1"))?.reserved.amount).toBe(0);
  });

  it("will not release material that was already used", async () => {
    const first = await held();
    if (!first.ok) throw new Error("setup failed");

    await consume().execute({ organizationId: "org-a", reservationId: first.data.reservationId });
    const attempt = await release().execute({
      organizationId: "org-a",
      reservationId: first.data.reservationId,
    });

    expect(attempt.ok === false && attempt.error.code).toBe("already_settled");
    // The consumed stock stays consumed.
    expect((await stock.position("org-a", "mat-steel-18ga", "rack-1"))?.onHand.amount).toBe(70);
  });

  it("takes consumption off the shelf and clears the reservation", async () => {
    const first = await held();
    if (!first.ok) throw new Error("setup failed");

    await consume().execute({ organizationId: "org-a", reservationId: first.data.reservationId });

    const after = await stock.position("org-a", "mat-steel-18ga", "rack-1");
    expect(after?.onHand.amount).toBe(70);
    expect(after?.reserved.amount).toBe(0);
  });

  it("leaves no phantom reservation when less is used than planned", async () => {
    // Reserved drops by what was RESERVED; on-hand by what was USED. Using one
    // number for both strands the difference as a reservation nobody holds.
    const first = await held(30);
    if (!first.ok) throw new Error("setup failed");

    const result = await consume().execute({
      organizationId: "org-a",
      reservationId: first.data.reservationId,
      actual: quantity(22, "sq_ft"),
    });

    const after = await stock.position("org-a", "mat-steel-18ga", "rack-1");
    expect(after?.onHand.amount).toBe(78);
    expect(after?.reserved.amount).toBe(0);
    expect(result.ok && result.events[0]?.payload).toMatchObject({
      variance: { amount: -8 },
    });
  });

  it("records using more than planned rather than pretending otherwise", async () => {
    const first = await held(30);
    if (!first.ok) throw new Error("setup failed");

    const result = await consume().execute({
      organizationId: "org-a",
      reservationId: first.data.reservationId,
      actual: quantity(36, "sq_ft"),
    });

    expect((await stock.position("org-a", "mat-steel-18ga", "rack-1"))?.onHand.amount).toBe(64);
    // The variance is the shop's real waste rate — the number CostIQ needs to
    // stop estimating.
    expect(result.ok && result.events[0]?.payload).toMatchObject({ variance: { amount: 6 } });
  });

  it("keeps one organization out of another's reservations", async () => {
    const first = await held();
    if (!first.ok) throw new Error("setup failed");

    const stolen = await release().execute({
      organizationId: "org-b",
      reservationId: first.data.reservationId,
    });

    expect(stolen.ok === false && stolen.error.code).toBe("unknown_reservation");
  });

  it("returns the events instead of publishing them", async () => {
    // The engine cannot publish safely: reserving is two writes, and an event
    // that escapes while those roll back leaves every consumer believing in a
    // reservation that does not exist. Only the host owns the transaction.
    const result = await held();

    expect(result.ok && result.events).toHaveLength(1);
    expect(result.ok && result.events[0]?.type).toBe("material.reserved");
    expect(result.ok && result.events[0]?.payload).toMatchObject({
      workOrderId: "wo_1",
      remainingAvailable: { amount: 70 },
    });
  });
});
