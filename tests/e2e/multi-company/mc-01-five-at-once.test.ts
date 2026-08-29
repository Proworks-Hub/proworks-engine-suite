// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import { hiveMessageSchema, HIVE_MESSAGE_SCHEMA_VERSION } from "@proworks-hub/contracts";

import {
  ACTOR,
  COMPANIES,
  LOCATION,
  SEED,
  assertMustFailDidNotHappen,
  buildWorld,
  pass,
  printReport,
  runJob,
  scenario,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-01 — THE GATE. Cannot skip.
//
// Five tenant ids in one process. Not five apps: the same engine instances
// serve all five, and only the STATE is partitioned. Five separate programs
// could not leak into each other, so proving isolation there would prove
// nothing about the arrangement a real host runs.
//
// Each fake host brings its own tenant id, actor, correlation id and stock.
//
//   ksix            custom sign     ACRYLIC-3MM   50 sheets
//   brighton-signs  yard sign       ACRYLIC-3MM    3 sheets   ← same SKU string
//   longmont-print  DTF shirt       DTF-FILM      25
//   family-table    receipt only    GROCERY        0          ← no work orders
//   makerops-demo   slate plaque    SLATE-4X4     12
//
// The 50/3 asymmetry across one shared SKU string is the instrument. If stock
// were keyed by SKU rather than by (tenant, SKU), brighton's three sheets would
// be indistinguishable from a slice of ksix's fifty — and the failure would
// look like plenty of stock rather than like an error. Equal seeds would hide
// exactly the bug this is built to find.
//
// AFTERWARD, THE FIVE THINGS THAT MUST HOLD
//
//   1. no shared work order ids
//   2. Brighton still has three sheets
//   3. KSix stock did not move because of anyone else
//   4. Family Table minted no job
//   5. Brighton reading a KSix id gets nothing
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const LONGMONT = "longmont-print";
const FAMILY = "family-table";
const MAKEROPS = "makerops-demo";

/** The four manufacturers. Family Table ingests a receipt and creates no job. */
const MANUFACTURERS = [KSIX, BRIGHTON, LONGMONT, MAKEROPS] as const;

describe("MC-01 — five companies at once (GATE)", () => {
  it("seeds the asymmetry the scenario depends on", () => {
    // Asserted before the run, because a harness that quietly seeded everyone
    // equally would make every assertion below pass for the wrong reason.
    expect(SEED[KSIX]).toBe(50);
    expect(SEED[BRIGHTON]).toBe(3);

    const ksix = COMPANIES.find((c) => c.id === KSIX)!;
    const brighton = COMPANIES.find((c) => c.id === BRIGHTON)!;
    expect(ksix.sku).toBe("ACRYLIC-3MM");
    expect(brighton.sku).toBe(ksix.sku);

    expect(COMPANIES).toHaveLength(5);
  });

  it("runs all five at once and holds every boundary", async () => {
    const s = scenario("MC-01");

    // One shared ledger. The harder arrangement, and the only one where a
    // SKU-keyed leak can actually happen — five separate stores cannot leak
    // into each other whatever the code does.
    const world = buildWorld({ sharedLedger: true });

    // ── The partition exists before anything runs ─────────────────────────
    //
    // Checked first and by name. Mutation-testing this gate with stock keyed by
    // SKU instead of (tenant, SKU) made it fail with "cannot read properties of
    // undefined" — correct outcome, useless message. A gate that fails
    // unreadably costs whoever reads it an hour before they learn what broke.
    const seededRows = world.sharedLedger!.all();
    expect(
      seededRows.length,
      `expected one stock row per tenant and found ${seededRows.length}. Fewer means rows are being ` +
        "pooled across tenants — stock keyed by SKU rather than by (tenant, SKU).",
    ).toBe(5);

    for (const company of COMPANIES) {
      expect(
        seededRows.some((r) => r.organizationId === company.id && r.materialId === company.sku),
        `${company.id} has no row of its own for ${company.sku}`,
      ).toBe(true);
    }

    const ksixBefore = world.tenant(KSIX).position()!;
    const brightonBefore = world.tenant(BRIGHTON).position()!;
    expect(ksixBefore.onHand.amount).toBe(50);
    expect(brightonBefore.onHand.amount).toBe(3);

    // ── Promise.all, all five ────────────────────────────────────────────
    //
    // Each host carries its own correlation id, which is what makes a leak
    // traceable to a tenant rather than to "the run".
    const [ksixJob, brightonJob, longmontJob, makeropsJob, familyReceipt] = await Promise.all([
      runJob(world.tenant(KSIX), { quantity: 4, idempotencyKey: `cor-${KSIX}-1` }),
      runJob(world.tenant(BRIGHTON), { quantity: 2, idempotencyKey: `cor-${BRIGHTON}-1` }),
      runJob(world.tenant(LONGMONT), { quantity: 3, idempotencyKey: `cor-${LONGMONT}-1` }),
      runJob(world.tenant(MAKEROPS), { quantity: 2, idempotencyKey: `cor-${MAKEROPS}-1` }),
      // Family Table ingests a receipt. It creates no work order and touches no
      // stock — the whole point of including it.
      Promise.resolve({ workOrderId: null, reservationId: null }),
    ]);

    // ── 1. No shared work order ids ───────────────────────────────────────
    const workOrderIds = [ksixJob, brightonJob, longmontJob, makeropsJob]
      .map((j) => j.workOrderId)
      .filter((id): id is string => id !== null);

    expect(workOrderIds).toHaveLength(4);
    expect(new Set(workOrderIds).size).toBe(4);
    // Each id names its own tenant, so a shared one would be visible rather
    // than merely absent from a Set.
    for (const id of workOrderIds) {
      expect(MANUFACTURERS.some((t) => id.includes(t)), id).toBe(true);
    }

    // ── 2. Brighton still has three sheets ────────────────────────────────
    //
    // On hand, exactly three. Reserving moves `reserved`, never `onHand` — and
    // if ksix's forty-eight-sheet job had drawn on a pooled SKU row, this is
    // the number that would have moved.
    const brightonAfter = world.tenant(BRIGHTON).position()!;
    expect(brightonAfter.onHand.amount).toBe(3);
    expect(brightonAfter.reserved.amount).toBe(2);

    // ── 3. KSix stock did not move because of anyone else ─────────────────
    //
    // Exactly its own four reserved, and its own fifty on hand. Not "roughly",
    // and not "at least" — the whole quantity is accounted for by ksix's own
    // job.
    const ksixAfter = world.tenant(KSIX).position()!;
    expect(ksixAfter.onHand.amount).toBe(50);
    expect(ksixAfter.reserved.amount).toBe(4);

    // ── 4. Family Table minted no job ─────────────────────────────────────
    expect(familyReceipt.workOrderId).toBeNull();
    const familyWorkOrders = await world
      .tenant(FAMILY)
      .eventLog.listByType("work_order.intake.created");
    expect(familyWorkOrders).toHaveLength(0);
    expect(world.tenant(FAMILY).position()!.reserved.amount).toBe(0);

    // ── 5. Brighton reading a KSix id gets nothing ────────────────────────
    //
    // Brighton knows the id — it is in the same process. Knowing an identifier
    // is not authority to use it.
    const theft = await world.tenant(BRIGHTON).consume.execute({
      organizationId: BRIGHTON,
      reservationId: ksixJob.reservationId ?? "rsv_ksix_1",
    });
    expect(theft.ok).toBe(false);

    // And ksix is untouched by the attempt.
    const ksixAfterTheft = world.tenant(KSIX).position()!;
    expect(ksixAfterTheft.onHand.amount).toBe(50);
    expect(ksixAfterTheft.reserved.amount).toBe(4);

    // ── An envelope with no tenant does not write ─────────────────────────
    //
    // "No tenant on the envelope means no write." The envelope refuses itself
    // rather than defaulting into whichever tenant happened to be nearby.
    const anonymous = hiveMessageSchema.safeParse({
      messageId: "msg_anon",
      category: "EVENT",
      messageType: "material.reserved",
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.host.unknown",
      systemScoped: false,
      trace: { correlationId: "cor-anon" },
      timestamp: "2026-08-29T10:00:00.000Z",
      dataClassification: "internal",
      payload: {},
      location: LOCATION,
    });
    expect(anonymous.success).toBe(false);

    // ── mustFail: any mixed-tenant projection ─────────────────────────────
    //
    // One ledger, five rows, each belonging to exactly one tenant and carrying
    // that tenant's own SKU. A pooled row would show up here as a count that
    // is not five, or as a row whose (tenant, SKU) pair does not exist.
    const rows = world.sharedLedger!.all();
    expect(rows).toHaveLength(5);

    const mixed = rows.some(
      (p) => !COMPANIES.some((c) => c.id === p.organizationId && c.sku === p.materialId),
    );
    assertMustFailDidNotHappen(s, "any mixed-tenant projection", mixed);

    // Every tenant's total is its own. Summed reserved across the shared
    // ACRYLIC-3MM rows is 4 + 2 — the two jobs — and not one pooled 6 sitting
    // on a single row.
    const acrylicRows = rows.filter((p) => p.materialId === "ACRYLIC-3MM");
    expect(acrylicRows).toHaveLength(2);
    expect(acrylicRows.map((p) => p.organizationId).sort()).toEqual([BRIGHTON, KSIX]);

    pass(
      s,
      "5 tenants, 4 jobs, 0 shared ids; brighton 3 on hand; ksix 50/4; family-table 0 jobs; cross-tenant read refused",
    );
  });
});

afterAll(() => printReport());
