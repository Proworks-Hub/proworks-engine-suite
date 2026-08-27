// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  assertNothingPrivateCrosses,
  collaborationRequestSchema,
  drainOutbox,
  newCorrelationId,
  validateCollaborationRequest,
} from "@proworks-hub/contracts";
import {
  buildSubcontractRequest,
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  toSubcontractView,
  type EventActor,
} from "@proworks-hub/workorderiq";
import { createInMemoryOutbox } from "@proworks-hub/platform-runtime";

const trace = { correlationId: "cor_1" };
const actor: EventActor = { kind: "user", userId: "op-1" };

// ─────────────────────────────────────────────────────────────────────────────
// Two shops transacting, and one shop working through an outage.
// ─────────────────────────────────────────────────────────────────────────────

const subcontract = () =>
  buildSubcontractRequest({
    collaborationId: "collab_1",
    from: { organizationId: "org-screenprint", displayName: "Denver Screen Printing" },
    toOrganizationId: "org-dtf",
    originatorRef: "WO-10284",
    lines: [
      {
        lineItemId: "line-1",
        description: "DTF transfers — left chest + full back",
        quantity: 50,
        specifications: { placement: "left chest + full back", substrate: "cotton" },
        fileRefs: ["art_smith_logo"],
      },
    ],
    dueDate: "2026-09-04",
    instructions: "Gang on one sheet if it saves film.",
    trace,
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  });

describe("one shop subcontracting another", () => {
  it("sends what the work needs", () => {
    const request = subcontract();
    expect(request.items[0]).toMatchObject({ quantity: 50 });
    expect(request.items[0]!.specifications["placement"]).toBe("left chest + full back");
    expect(request.dueDate).toBe("2026-09-04");
  });

  it("sends nothing about the originator's business", () => {
    const serialized = JSON.stringify(subcontract());
    // The list from the directive, checked rather than promised.
    for (const forbidden of ["margin", "cost", "customer", "Smith Plumbing", "utilization"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("refuses a private field, however deeply it is buried", () => {
    // The realistic leak: not a top-level `margin`, which nobody writes, but
    // something that arrived because an object was spread instead of named.
    expect(() =>
      assertNothingPrivateCrosses({ items: [{ meta: { internalCost: 1200 } }] }),
    ).toThrow(/private to the originating shop/);

    expect(() => assertNothingPrivateCrosses({ customerName: "Smith Plumbing" })).toThrow();
    expect(() => assertNothingPrivateCrosses({ shopNotes: "rush this one" })).toThrow();
  });

  it("refuses an unexpected field at the schema, before the guard is needed", () => {
    expect(() =>
      validateCollaborationRequest({ ...subcontract(), machineUtilization: 0.8 }),
    ).toThrow();
  });

  it("cannot be constructed unsafely in the first place", () => {
    // The builder validates before returning, so an unsafe request does not
    // exist to be sent — rather than existing and being rejected later.
    expect(() =>
      buildSubcontractRequest({
        ...({
          collaborationId: "c",
          from: { organizationId: "a", displayName: "A" },
          toOrganizationId: "b",
          originatorRef: "r",
          lines: [{ lineItemId: "l", description: "x", quantity: 1, specifications: { cost: "12.00" } }],
          trace,
        } as Parameters<typeof buildSubcontractRequest>[0]),
      }),
    ).toThrow(/private to the originating shop/);
  });

  it("shows the receiving shop a name, not an organization id", () => {
    const view = toSubcontractView(subcontract());
    expect(view.fromDisplayName).toBe("Denver Screen Printing");
    // An id it cannot resolve is an id somebody will eventually try to use.
    expect(JSON.stringify(view)).not.toContain("org-screenprint");
  });

  it("keeps the originator's reference opaque", () => {
    // It correlates a reply. It is not a key into a system the other shop
    // has no access to.
    expect(subcontract().originatorRef).toBe("WO-10284");
    expect(collaborationRequestSchema.parse(subcontract()).originatorRef).toBe("WO-10284");
  });
});

describe("a shop working through an outage", () => {
  it("creates work orders with no network at all", async () => {
    // The engines are pure and hold no connections, so this is true by
    // construction — but a claim nobody tests is a claim that stops being true.
    const log = createInMemoryEventLog();
    const createWorkOrder = createCreateWorkOrderUseCase({ eventLog: log });

    const result = await createWorkOrder.execute(
      {
        customerId: "c1",
        customerName: "Smith Plumbing",
        source: "manual",
        lineItems: [{ id: "l1", label: "Company Shirt", quantity: 50 }],
      },
      actor,
    );

    expect(result.ok).toBe(true);
    expect(await log.size()).toBeGreaterThan(0);
  });

  it("records what happened locally so nothing is lost", () => {
    const outbox = createInMemoryOutbox();
    outbox.record({ eventType: "production.started", payload: { step: 1 }, organizationId: "shop-a", trace });
    outbox.record({ eventType: "operation.completed", payload: { step: 1 }, organizationId: "shop-a", trace });

    expect(outbox.pendingCount()).toBe(2);
  });

  it("publishes in the order the shop produced them when it reconnects", async () => {
    const outbox = createInMemoryOutbox();
    for (const eventType of ["production.started", "operation.completed", "workorder.completed"]) {
      outbox.record({ eventType, payload: {}, organizationId: "shop-a", trace });
    }

    const published: string[] = [];
    const result = await drainOutbox(outbox, (entry) => void published.push(entry.eventType));

    // A completion must not arrive before the start it depends on.
    expect(published).toEqual(["production.started", "operation.completed", "workorder.completed"]);
    expect(result).toMatchObject({ published: 3, failed: 0, remaining: 0 });
  });

  it("stops at the first failure rather than delivering a gap", async () => {
    const outbox = createInMemoryOutbox();
    for (const eventType of ["a.started", "b.blocked", "c.completed"]) {
      outbox.record({ eventType, payload: {}, organizationId: "shop-a", trace });
    }

    const published: string[] = [];
    const result = await drainOutbox(outbox, (entry) => {
      if (entry.eventType === "b.blocked") throw new Error("broker refused");
      published.push(entry.eventType);
    });

    expect(published).toEqual(["a.started"]);
    expect(result.haltedOnFailure).toBe(true);
    // Being behind is recoverable. Delivering c before b is not, because a
    // consumer cannot tell a gap from an ordering error.
    expect(result.remaining).toBe(2);
  });

  it("keeps a failed entry pending rather than dropping it", async () => {
    const outbox = createInMemoryOutbox();
    outbox.record({ eventType: "a.started", payload: {}, organizationId: "shop-a", trace });

    await drainOutbox(outbox, () => {
      throw new Error("still offline");
    });

    // An outbox that discards after a few failures has reintroduced the data
    // loss it exists to prevent.
    expect(outbox.pendingCount()).toBe(1);
    expect(outbox.all()[0]!.attempts).toBe(1);
    expect(outbox.all()[0]!.lastError).toMatch(/still offline/);
  });

  it("drains what accumulated once the connection returns", async () => {
    const outbox = createInMemoryOutbox();
    let online = false;
    const publish = vi.fn(() => {
      if (!online) throw new Error("offline");
    });

    // A shift's work, recorded during the outage.
    for (let i = 0; i < 5; i += 1) {
      outbox.record({ eventType: "operation.completed", payload: { i }, organizationId: "shop-a", trace });
    }
    await drainOutbox(outbox, publish);
    expect(outbox.pendingCount()).toBe(5);

    online = true;
    const result = await drainOutbox(outbox, publish);
    expect(result.published).toBe(5);
    expect(outbox.pendingCount()).toBe(0);
  });

  it("carries the correlation through the outage", async () => {
    const outbox = createInMemoryOutbox();
    const correlationId = newCorrelationId();
    outbox.record({ eventType: "a.started", payload: {}, organizationId: "shop-a", trace: { correlationId } });

    const seen: string[] = [];
    await drainOutbox(outbox, (entry) => void seen.push(entry.trace.correlationId));
    // Work done offline is still traceable once it arrives.
    expect(seen).toEqual([correlationId]);
  });
});
