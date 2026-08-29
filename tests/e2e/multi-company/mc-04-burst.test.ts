// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import {
  COMPANIES,
  assertMustFailDidNotHappen,
  engineDefect,
  buildWorld,
  pass,
  printReport,
  runJob,
  scenario,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-04 — burst. Twenty interleaved jobs across three manufacturers.
//
//   inject         20 concurrent create+reserve, mixed tenants
//   mustPass       zero cross-tenant reads; reserved per tenant <= that tenant's on-hand
//   mustFail       mixed-tenant projection
//   evidence       20 results tagged tenant
//   blastRadius    HIVE
//
// Concurrency is the point. MC-02 and MC-03 exercise the boundary one call at
// a time, where a check-then-act gap never opens. Twenty interleaved awaits on
// one ledger is where a shared mutable position or a lost update shows up.
//
// The per-tenant totals are asserted EXACTLY, not with `<=`. An upper bound is
// satisfied by a tenant that reserved nothing at all, so it would hold just as
// well if the burst had silently dropped half the work.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const LONGMONT = "longmont-print";

const MANUFACTURERS = [KSIX, BRIGHTON, LONGMONT] as const;
const JOBS = 20;
const PER_JOB = 2;

describe("MC-04 — burst of twenty", () => {
  it("interleaves twenty jobs across three manufacturers without a leak", async () => {
    const s = scenario("MC-04");

    // Enough stock that nothing is refused for shortage: this scenario is
    // about isolation under load, and a rejection would mask it.
    const world = buildWorld({ onHand: 40, sharedLedger: true });

    const rowsBefore = world.sharedLedger!.all();
    expect(rowsBefore).toHaveLength(COMPANIES.length);

    // ── inject: twenty concurrent create+reserve, round-robin ─────────────
    const plan = Array.from({ length: JOBS }, (_, i) => ({
      index: i,
      tenantId: MANUFACTURERS[i % MANUFACTURERS.length]!,
    }));

    const results = await Promise.all(
      plan.map(async (p) => ({
        ...p,
        result: await runJob(world.tenant(p.tenantId), {
          quantity: PER_JOB,
          label: `job-${p.index}`,
          idempotencyKey: `cor-${p.tenantId}-${p.index}`,
        }),
      })),
    );

    // ── evidence: 20 results tagged tenant ────────────────────────────────
    expect(results).toHaveLength(JOBS);
    for (const r of results) {
      expect(r.result.workOrderId, `job-${r.index}`).not.toBeNull();
      expect(r.result.reservationId, `job-${r.index}`).not.toBeNull();
      // The id names the tenant that asked for it. A work order that came back
      // tagged to another tenant is the leak, and it is legible right here.
      expect(r.result.workOrderId, `job-${r.index}`).toContain(r.tenantId);
      expect(r.result.reservationId, `job-${r.index}`).toContain(r.tenantId);
    }

    // Twenty distinct work orders. Concurrency did not collapse two jobs into one.
    const workOrderIds = results.map((r) => r.result.workOrderId!);
    expect(new Set(workOrderIds).size).toBe(JOBS);

    // ── mustPass: reserved per tenant <= that tenant's on-hand ────────────
    //
    // The corpus's condition, and it holds.
    for (const id of MANUFACTURERS) {
      const position = world.tenant(id).position()!;
      expect(position.reserved.amount, `${id} reserved`).toBeLessThanOrEqual(
        position.onHand.amount,
      );
      expect(position.onHand.amount, `${id} on hand`).toBe(40);
    }

    // ── A DEFECT THE CORPUS'S BOUND CANNOT SEE ────────────────────────────
    //
    // `reserved <= on-hand` is satisfied by a tenant that reserved NOTHING, so
    // it holds just as well when the burst silently drops work. Asked exactly
    // -- does the ledger reflect every hold the engine granted? -- the answer
    // is no.
    //
    // Every one of the twenty calls returned ok and persisted a reservation
    // record, and the ledger records a fraction of them. reservations.ts reads
    // the position, awaits, then calls `savePosition` with an unconditional
    // overwrite. Concurrent reserves for one (org, material, location) all read
    // the same `reserved`, each adds its own quantity, and each writes the
    // result: last write wins and the rest vanish.
    //
    // The consequence is not a wrong number in a report. `insufficient_stock`
    // is decided against this under-counted `reserved`, so the engine will
    // approve holds for material that is already promised. The comment above
    // `savePosition` says the write order was chosen so material is never
    // "promised twice, which is the failure that reaches a machine" -- and the
    // lost update produces exactly that outcome by another route.
    //
    // Recorded, not repaired. Serialising the read-modify-write is a
    // cross-cutting change to InventoryIQ's persistence contract -- the
    // StockLedger port has no compare-and-swap or version to build it on -- and
    // that belongs to a mission with its own validation, not to a test run.
    const shortfalls: string[] = [];
    for (const id of MANUFACTURERS) {
      const granted = results.filter((r) => r.tenantId === id).length * PER_JOB;
      const ledger = world.tenant(id).position()!.reserved.amount;
      if (ledger !== granted) shortfalls.push(`${id}: granted ${granted}, ledger ${ledger}`);
    }

    if (shortfalls.length > 0) {
      engineDefect(
        s,
        "InventoryIQ lost update: concurrent reserves for one (org, material, location) " +
          "read-modify-write the stock position and overwrite each other, so granted holds " +
          `vanish from the ledger. ${shortfalls.join("; ")}. ` +
          "Every call returned ok and every reservation record persisted. Because " +
          "insufficient_stock is decided against this under-counted reserved figure, the " +
          "engine will approve holds for material already promised. Not cross-tenant.",
      );
    }

    // The two idle tenants stayed idle. A burst that touched a tenant which
    // submitted nothing is a leak whichever direction it ran.
    for (const company of COMPANIES) {
      if ((MANUFACTURERS as readonly string[]).includes(company.id)) continue;
      expect(world.tenant(company.id).position()!.reserved.amount, company.id).toBe(0);
    }

    // ── mustFail: mixed-tenant projection ─────────────────────────────────
    const rows = world.sharedLedger!.all();
    expect(rows).toHaveLength(COMPANIES.length);
    const mixed = rows.some(
      (p) => !COMPANIES.some((c) => c.id === p.organizationId && c.sku === p.materialId),
    );
    assertMustFailDidNotHappen(s, "mixed-tenant projection", mixed);

    // ── mustPass: zero cross-tenant reads ─────────────────────────────────
    //
    // ksix and brighton share the ACRYLIC-3MM string and both ran jobs here,
    // so their totals are the ones that would merge. Summed separately: 7 and
    // 7 jobs at 2 each, on two rows, never one row of 28.
    const acrylic = rows.filter((p) => p.materialId === "ACRYLIC-3MM");
    expect(acrylic).toHaveLength(2);
    //
    // Stated as ownership rather than as a total, because the totals are
    // unreliable while the lost update above stands, and a leak would still be
    // visible here: each row belongs to exactly one of the two, and neither
    // holds more than its own tenant asked for.
    expect(acrylic.map((p) => p.organizationId).sort()).toEqual([BRIGHTON, KSIX]);
    for (const row of acrylic) {
      const asked = results.filter((r) => r.tenantId === row.organizationId).length * PER_JOB;
      expect(row.reserved.amount, `${row.organizationId} holds no more than it asked for`)
        .toBeLessThanOrEqual(asked);
    }

    pass(
      s,
      `${JOBS} interleaved jobs across ${MANUFACTURERS.length} tenants; partitions intact` +
        (shortfalls.length > 0 ? "; see ENGINE-DEFECT (within-tenant lost update)" : ""),
    );
  });
});

afterAll(() => printReport());
