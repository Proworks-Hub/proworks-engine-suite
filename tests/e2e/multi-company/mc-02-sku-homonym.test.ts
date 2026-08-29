// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import {
  SEED,
  assertMustFailDidNotHappen,
  buildWorld,
  pass,
  printReport,
  runJob,
  scenario,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-02 — sku-homonym. ksix and brighton-signs share the string ACRYLIC-3MM.
//
//   startingState  both seed ACRYLIC-3MM different on-hand (ksix=50, brighton=3)
//   inject         ksix reserves 10; brighton queries the same sku string
//   mustPass       brighton on-hand=3, ksix reserved=10
//   mustFail       sku used as global primary key
//
// A homonym, not a mistake. Two shops legitimately stock a material they both
// call ACRYLIC-3MM, and nothing about either is wrong. The string is a name in
// a tenant's vocabulary, never an identity in the Hive's.
//
// Run on ONE ledger. On separate ledgers a SKU cannot collide with anything,
// so the scenario would be untestable by construction.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const SKU = "ACRYLIC-3MM";

describe("MC-02 — SKU homonym", () => {
  it("keeps two shops' ACRYLIC-3MM apart", async () => {
    const s = scenario("MC-02");

    // The corpus states the on-hand figures: ksix 50, brighton 3. The seeds
    // carry them. An earlier version of this test overrode both to 10, which
    // is the one arrangement where the assertions cannot distinguish a
    // partitioned ledger from a pooled one -- with equal stock, a leak and a
    // correct answer look identical.
    expect(SEED[KSIX]).toBe(50);
    expect(SEED[BRIGHTON]).toBe(3);

    const world = buildWorld({ sharedLedger: true });

    // Two rows for one SKU string, before anything happens. This is the
    // premise; if it does not hold, every assertion below is meaningless.
    const seeded = world.sharedLedger!.all().filter((p) => p.materialId === SKU);
    expect(
      seeded.length,
      "expected ksix and brighton to hold SEPARATE rows for the same SKU string",
    ).toBe(2);
    expect(seeded.map((p) => p.organizationId).sort()).toEqual([BRIGHTON, KSIX]);

    // ── inject: ksix reserves 10 ──────────────────────────────────────────
    const job = await runJob(world.tenant(KSIX), { quantity: 10 });
    expect(job.reservationId).not.toBeNull();

    // ── mustPass: ksix reserved = 10 ──────────────────────────────────────
    const ksix = world.tenant(KSIX).position()!;
    expect(ksix.reserved.amount).toBe(10);
    expect(ksix.onHand.amount).toBe(50);

    // ── mustPass: brighton on-hand = 3 ────────────────────────────────────
    //
    // Ten is more than brighton's entire holding. If the ledger keyed on the
    // SKU string, ksix's reservation would have eaten brighton's three sheets
    // outright and this is where it shows.
    const brighton = world.tenant(BRIGHTON).position()!;
    expect(brighton.onHand.amount).toBe(3);
    expect(brighton.reserved.amount).toBe(0);

    // brighton querying the same sku string sees its own three, not fifty-three.
    const brightonQuery = world
      .tenant(BRIGHTON)
      .visiblePositions()
      .filter((p) => p.materialId === SKU && p.organizationId === BRIGHTON);
    expect(brightonQuery).toHaveLength(1);
    expect(brightonQuery[0]!.onHand.amount).toBe(3);

    // ── mustFail: sku used as a global primary key ────────────────────────
    //
    // Checked structurally rather than by totals. One row for the string would
    // mean the SKU IS the key, whatever the numbers happened to add up to.
    const rows = world.sharedLedger!.all().filter((p) => p.materialId === SKU);
    assertMustFailDidNotHappen(s, "sku used as global primary key", rows.length !== 2);

    // And the two rows are genuinely different holdings, not one value copied.
    const amounts = rows.map((p) => p.onHand.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([3, 50]);

    pass(s, "one SKU string, two owners: ksix 50/10 reserved, brighton 3 untouched");
  });
});

afterAll(() => printReport());
