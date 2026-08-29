// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  createConsumeMaterialUseCase,
  createInMemoryReservationStore,
  createInMemoryStockLedger,
  createReleaseReservationUseCase,
  createReserveMaterialUseCase,
} from "../index.js";
import type { StockPosition } from "../models.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reservation deduplication — the inventory half of the E2E-03 fix.
//
// The acceptance condition: a 4-sheet job reserves exactly 4 sheets after
// repeated and concurrent duplicate requests.
// ─────────────────────────────────────────────────────────────────────────────

const ORG = "ksix";
const OTHER = "other-shop";
const MATERIAL = "corten-18";
const LOCATION = "main-rack";

function shop(onHand = 20) {
  const positions: StockPosition[] = [
    {
      materialId: MATERIAL,
      organizationId: ORG,
      locationId: LOCATION,
      onHand: { amount: onHand, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    },
    {
      materialId: MATERIAL,
      organizationId: OTHER,
      locationId: LOCATION,
      onHand: { amount: onHand, unit: "each" },
      reserved: { amount: 0, unit: "each" },
      updatedAt: "2026-08-29T09:00:00.000Z",
    },
  ];

  const ledger = createInMemoryStockLedger(positions);
  const reservations = createInMemoryReservationStore();
  let n = 0;
  const deps = {
    stock: ledger,
    reservations,
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    generateId: () => `rsv_${(n += 1)}`,
  };

  return {
    ledger,
    reservations,
    reserve: createReserveMaterialUseCase(deps),
    release: createReleaseReservationUseCase(deps),
    consume: createConsumeMaterialUseCase(deps),
    position: (org = ORG) => ledger.all().find((p) => p.organizationId === org)!,
  };
}

const request = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  materialId: MATERIAL,
  locationId: LOCATION,
  workOrderId: "wo_1",
  quantity: { amount: 4, unit: "each" as const },
  ...over,
});

describe("a 4-sheet job reserves exactly 4 sheets", () => {
  it("after a repeated request", async () => {
    // The acceptance condition, stated literally.
    const s = shop(20);
    await s.reserve.execute(request());
    await s.reserve.execute(request());
    await s.reserve.execute(request());

    expect(s.position().reserved.amount).toBe(4);
    expect(s.position().onHand.amount).toBe(20);
  });

  it("after ten concurrent requests", async () => {
    const s = shop(20);
    await Promise.all(Array.from({ length: 10 }, () => s.reserve.execute(request())));

    expect(s.position().reserved.amount).toBe(4);
    expect(s.position().onHand.amount).toBe(20);
  });

  it("returns the same reservation each time", async () => {
    const s = shop(20);
    const first = await s.reserve.execute(request());
    const second = await s.reserve.execute(request());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.data.reservationId).toBe(first.data.reservationId);
  });

  it("emits material.reserved exactly once", async () => {
    // Not just "same id back". Emitting the event again would tell every
    // consumer a second hold was placed, which is the bug the early return
    // exists to avoid.
    const s = shop(20);
    const first = await s.reserve.execute(request());
    const second = await s.reserve.execute(request());

    expect(first.ok && first.events.some((e) => e.type === "material.reserved")).toBe(true);
    expect(second.ok && second.events).toEqual([]);
  });
});

describe("what counts as the same logical operation", () => {
  it("treats a different quantity as a new operation", async () => {
    // A repeat asking for a different amount is a different request. Treating
    // it as a repeat would silently ignore a changed BOM.
    const s = shop(20);
    await s.reserve.execute(request({ quantity: { amount: 4, unit: "each" } }));
    await s.reserve.execute(request({ quantity: { amount: 6, unit: "each" } }));

    expect(s.position().reserved.amount).toBe(10);
  });

  it("treats a different work order as a new operation", async () => {
    const s = shop(20);
    await s.reserve.execute(request({ workOrderId: "wo_1" }));
    await s.reserve.execute(request({ workOrderId: "wo_2" }));

    expect(s.position().reserved.amount).toBe(8);
  });

  it("treats a different material or location as a new operation", async () => {
    const s = shop(20);
    await s.reserve.execute(request());
    const elsewhere = await s.reserve.execute(request({ locationId: "back-shelf" }));

    // No stock record there, so it fails — but it was not deduplicated against
    // the first, which is the point.
    expect(elsewhere.ok).toBe(false);
    if (!elsewhere.ok) expect(elsewhere.error.code).toBe("unknown_material");
  });

  it("lets a reserve after a release proceed", async () => {
    // Only a live hold counts. Reserving again after releasing is a new
    // operation, not a repeat of a finished one.
    const s = shop(20);
    const first = await s.reserve.execute(request());
    if (!first.ok) throw new Error("expected a reservation");

    await s.release.execute({ organizationId: ORG, reservationId: first.data.reservationId });
    expect(s.position().reserved.amount).toBe(0);

    const again = await s.reserve.execute(request());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.reservationId).not.toBe(first.data.reservationId);
    expect(s.position().reserved.amount).toBe(4);
  });

  it("lets a reserve after a consume proceed", async () => {
    const s = shop(20);
    const first = await s.reserve.execute(request());
    if (!first.ok) throw new Error("expected a reservation");

    await s.consume.execute({ organizationId: ORG, reservationId: first.data.reservationId });
    const again = await s.reserve.execute(request());

    expect(again.ok).toBe(true);
    expect(s.position().onHand.amount).toBe(16);
    expect(s.position().reserved.amount).toBe(4);
  });
});

describe("deduplication obeys tenant boundaries", () => {
  it("does not deduplicate across tenants", async () => {
    // Two tenants may legitimately use the same work-order id. Deduplicating
    // across them would mean one tenant's reserve silently satisfying another's.
    const s = shop(20);
    await s.reserve.execute(request({ organizationId: ORG }));
    await s.reserve.execute(request({ organizationId: OTHER }));

    expect(s.position(ORG).reserved.amount).toBe(4);
    expect(s.position(OTHER).reserved.amount).toBe(4);
  });

  it("keeps concurrent cross-tenant reserves independent", async () => {
    const s = shop(20);
    await Promise.all([
      s.reserve.execute(request({ organizationId: ORG })),
      s.reserve.execute(request({ organizationId: OTHER })),
      s.reserve.execute(request({ organizationId: ORG })),
      s.reserve.execute(request({ organizationId: OTHER })),
    ]);

    expect(s.position(ORG).reserved.amount).toBe(4);
    expect(s.position(OTHER).reserved.amount).toBe(4);
  });
});

describe("existing invariants are unchanged", () => {
  it("still refuses to over-reserve without allowOversell", async () => {
    const s = shop(2);
    const result = await s.reserve.execute(request({ quantity: { amount: 4, unit: "each" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("insufficient_stock");
    expect(s.position().reserved.amount).toBe(0);
  });

  it("still oversells when explicitly allowed, and says so", async () => {
    const s = shop(2);
    const result = await s.reserve.execute(
      request({ quantity: { amount: 4, unit: "each" }, allowOversell: true }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.some((e) => e.type === "material.oversold")).toBe(true);
  });

  it("still refuses a unit mismatch", async () => {
    const s = shop(20);
    const result = await s.reserve.execute(request({ quantity: { amount: 4, unit: "sheet" } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unit_mismatch");
  });

  it("still never moves on-hand when reserving", async () => {
    const s = shop(20);
    await s.reserve.execute(request());
    await s.reserve.execute(request());
    expect(s.position().onHand.amount).toBe(20);
  });
});
