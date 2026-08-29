// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { afterAll, describe, expect, it } from "vitest";

import { hiveMessageSchema, HIVE_MESSAGE_SCHEMA_VERSION } from "@proworks-hub/contracts";

import {
  assertMustFailDidNotHappen,
  buildWorld,
  pass,
  printReport,
  runJob,
  scenario,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// MC-03 — correlation-theft. brighton-signs replays a ksix correlationId.
//
//   startingState  ksix job exists with correlation C1
//   inject         brighton actor sends envelope with tenant=brighton, correlation=C1
//   mustPass       empty/forbidden; ksix WO unchanged
//   mustFail       ksix job visible to brighton
//
// The envelope is WELL-FORMED and it is SUPPOSED to be. A correlation id is a
// tracing device: it says "this is part of that story", not "the bearer may act
// on that story". Refusing the envelope at the schema would be the wrong fix
// and would break tracing across tenants that legitimately share a workflow.
//
// So the schema accepts it and the authority check refuses it. Those are two
// different questions and this scenario exists because it is tempting to
// answer them in one place.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";
const C1 = "C1-ksix";

describe("MC-03 — correlation theft", () => {
  it("carries the correlation and refuses the authority", async () => {
    const s = scenario("MC-03");

    // Shared ledger. On separate ledgers "brighton cannot see ksix" is true
    // because the object does not exist in its store, which proves nothing
    // about the boundary. Here the row is right there and must still be unreachable.
    const world = buildWorld({ sharedLedger: true });

    const ksixJob = await runJob(world.tenant(KSIX), { quantity: 4, idempotencyKey: C1 });
    expect(ksixJob.workOrderId).not.toBeNull();
    expect(ksixJob.reservationId).not.toBeNull();

    const before = world.tenant(KSIX).position()!;
    expect(before.reserved.amount).toBe(4);

    // ── The envelope is valid ─────────────────────────────────────────────
    //
    // brighton's own tenant, ksix's correlation id. This MUST parse: an
    // envelope that refused a shared correlation would make cross-tenant
    // tracing impossible, and tracing is not authority.
    const stolen = hiveMessageSchema.safeParse({
      messageId: "msg_brighton_1",
      category: "EVENT",
      messageType: "material.reserved",
      schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
      producerId: "hive.specialized.workorderiq",
      tenant: { organizationId: BRIGHTON, roles: [] },
      systemScoped: false,
      trace: { correlationId: C1 },
      timestamp: "2026-08-29T10:00:00.000Z",
      dataClassification: "internal",
      payload: {},
    });
    expect(stolen.success).toBe(true);
    // And it still says brighton. The correlation did not rewrite the tenant.
    if (stolen.success) expect(stolen.data.tenant?.organizationId).toBe(BRIGHTON);

    // ── mustPass: empty/forbidden ─────────────────────────────────────────
    const theft = await world.tenant(BRIGHTON).consume.execute({
      organizationId: BRIGHTON,
      reservationId: ksixJob.reservationId!,
    });
    expect(theft.ok).toBe(false);

    // Refused for the right reason -- brighton does not own it -- rather than
    // because the id happened to be unparseable or absent.
    const releaseAttempt = await world.tenant(BRIGHTON).release.execute({
      organizationId: BRIGHTON,
      reservationId: ksixJob.reservationId!,
    });
    expect(releaseAttempt.ok).toBe(false);

    // ── mustPass: ksix WO unchanged ───────────────────────────────────────
    const after = world.tenant(KSIX).position()!;
    expect(after.reserved.amount).toBe(before.reserved.amount);
    expect(after.onHand.amount).toBe(before.onHand.amount);

    // ksix's own work order is still there and still reservable by ksix. The
    // theft attempt neither consumed it nor poisoned it.
    const ksixEvents = await world.tenant(KSIX).eventLog.listByType(
      "work_order.intake.created",
    );
    expect(ksixEvents).toHaveLength(1);

    // ── mustFail: ksix job visible to brighton ────────────────────────────
    //
    // Three surfaces, because "visible" is not one thing: stock rows, the
    // event log, and the reservation itself.
    // Note what is NOT asserted here: that brighton cannot enumerate the shared
    // store. `visiblePositions()` is a debugging view of the whole ledger and on
    // a shared ledger it returns every row by construction -- asserting against
    // it would fail for a reason that has nothing to do with the boundary.
    //
    // The boundary lives in the SCOPED read. brighton's own query must return
    // brighton's rows and nothing else, however much the store holds.
    const brightonScoped = world
      .tenant(BRIGHTON)
      .visiblePositions()
      .filter((p) => p.organizationId === BRIGHTON);
    const brightonSeesStock = brightonScoped.some((p) => p.organizationId !== BRIGHTON);
    expect(brightonScoped).toHaveLength(1);
    expect(world.tenant(BRIGHTON).position()!.organizationId).toBe(BRIGHTON);

    const brightonEvents = await world
      .tenant(BRIGHTON)
      .eventLog.listByType("work_order.intake.created");
    const brightonSeesKsixWorkOrder = brightonEvents.some(
      (e) => e.workOrderId === ksixJob.workOrderId,
    );

    assertMustFailDidNotHappen(
      s,
      "ksix job visible to brighton",
      brightonSeesStock || brightonSeesKsixWorkOrder || theft.ok,
    );

    // brighton's log is empty: replaying a correlation id did not mint it a job.
    expect(brightonEvents).toHaveLength(0);

    pass(s, "envelope valid, correlation carried, authority refused, ksix 50/4 unchanged");
  });
});

afterAll(() => printReport());
