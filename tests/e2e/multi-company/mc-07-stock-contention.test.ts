// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import {
  assertMustFailDidNotHappen,
  buildWorld,
  engineDefect,
  pass,
  printReport,
  runJob,
  scenario,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-07 — stock-contention-same-tenant-only.
//
//   startingState  ksix acrylic=10; brighton acrylic=10; two ksix jobs need 8
//   inject         two ksix reserves concurrent; brighton idle
//   mustPass       ksix reserved<=10; brighton reserved=0 on-hand=10
//   mustFail       brighton stock used to fill ksix
//
// Eight and eight against ten. The arithmetic is deliberate and it admits
// exactly one answer: one job gets its material and the other is refused. Not
// "roughly one" -- there is no split that satisfies both, and a run where both
// succeed has promised sixteen sheets of a ten-sheet stock.
//
// Brighton is idle throughout and holds the same SKU string at the same
// quantity. It is the control: whatever pressure ksix is under, none of it may
// reach the shop next door.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const ON_HAND = 10;
const NEEDS = 8;

describe("MC-07 — contention does not borrow the other shop", () => {
  it("fights over ksix acrylic and never touches brighton's", async () => {
    const s = scenario("MC-07");

    // The corpus fixes both at 10 here. Unlike MC-02, the discriminator in this
    // scenario is contention rather than the homonym, so equal stock is what it
    // asks for -- but the partition is still checked before anything runs, so a
    // pooled ledger fails by name instead of by a confusing total.
    const world = buildWorld({ onHand: ON_HAND, sharedLedger: true });

    const acrylicRows = world
      .sharedLedger!.all()
      .filter((p) => p.materialId === "ACRYLIC-3MM");
    expect(
      acrylicRows.length,
      "expected ksix and brighton to hold separate ACRYLIC-3MM rows",
    ).toBe(2);

    // ── inject: two ksix jobs, each needing 8, concurrently ───────────────
    const [a, b] = await Promise.all([
      runJob(world.tenant(KSIX), { quantity: NEEDS, label: "job-a", idempotencyKey: "cor-ksix-a" }),
      runJob(world.tenant(KSIX), { quantity: NEEDS, label: "job-b", idempotencyKey: "cor-ksix-b" }),
    ]);

    // Two different work orders. This is contention, not a duplicate.
    expect(a.workOrderId).not.toBe(b.workOrderId);

    const granted = [a, b].filter((j) => j.reservationId !== null);

    // ── mustPass: brighton untouched ──────────────────────────────────────
    //
    // The scenario's real subject. Checked first, because it is the one that
    // must hold regardless of how the contention itself resolves.
    const brighton = world.tenant(BRIGHTON).position()!;
    expect(brighton.onHand.amount).toBe(ON_HAND);
    expect(brighton.reserved.amount).toBe(0);

    // ── mustFail: brighton stock used to fill ksix ────────────────────────
    const ksix = world.tenant(KSIX).position()!;
    assertMustFailDidNotHappen(
      s,
      "brighton stock used to fill ksix",
      brighton.reserved.amount > 0 || brighton.onHand.amount !== ON_HAND,
    );

    // ── mustPass: ksix reserved <= 10 ─────────────────────────────────────
    expect(ksix.reserved.amount).toBeLessThanOrEqual(ON_HAND);
    expect(ksix.onHand.amount).toBe(ON_HAND);

    // ── What the bound cannot see ─────────────────────────────────────────
    //
    // `reserved <= 10` is a statement about the LEDGER FIGURE, and the ledger
    // figure is written by the same read-modify-write MC-04 records. Two
    // concurrent reserves of 8 both read reserved=0, both find 8 <= 10
    // available, and both write 8 -- so the ledger reads 8, inside its bound,
    // while two work orders each hold 8 of a 10-sheet stock.
    //
    // The question the bound cannot ask: how many jobs were GRANTED material
    // that does not exist?
    const totalGranted = granted.length * NEEDS;
    if (totalGranted > ON_HAND) {
      engineDefect(
        s,
        `Oversell within one tenant: ${granted.length} concurrent reservations of ${NEEDS} were ` +
          `both granted against ${ON_HAND} on hand (${totalGranted} promised), while the ledger ` +
          `reports reserved=${ksix.reserved.amount} and so stays inside "reserved <= on-hand". ` +
          "The insufficient_stock check reads a position that a concurrent reserve is about to " +
          "overwrite, so it approves both. Same root cause as the MC-04 lost update; here it " +
          "produces material promised twice rather than holds that merely vanish. Not cross-tenant.",
      );
    } else {
      // The correct outcome: exactly one job wins, deterministically.
      expect(granted).toHaveLength(1);
      expect(ksix.reserved.amount).toBe(NEEDS);
    }

    // Whatever happened inside ksix, the shop next door is untouched. Asserted
    // again after the contention, not only before it.
    const brightonAfter = world.tenant(BRIGHTON).position()!;
    expect(brightonAfter.onHand.amount).toBe(ON_HAND);
    expect(brightonAfter.reserved.amount).toBe(0);

    pass(
      s,
      `ksix granted ${granted.length}x${NEEDS} of ${ON_HAND}, ledger reserved ${ksix.reserved.amount}; ` +
        `brighton ${ON_HAND}/0 untouched` +
        (totalGranted > ON_HAND ? "; see ENGINE-DEFECT (same-tenant oversell)" : ""),
    );
  });
});

afterAll(() => printReport());
