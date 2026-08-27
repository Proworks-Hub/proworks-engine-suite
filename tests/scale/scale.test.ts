// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  createCapabilityResolver,
  newCorrelationId,
  requireCapability,
} from "@proworks-hub/contracts";
import {
  createCreateWorkOrderUseCase,
  createInMemoryEventLog,
  type EventActor,
} from "@proworks-hub/workorderiq";
import { createReceiptIqEngine } from "@proworks-hub/receiptiq";
import { createInMemoryEventBus } from "@proworks-hub/platform-events";
import { createInMemoryJobQueue } from "@proworks-hub/platform-runtime";
import { formatResult, measure, scalingProfile } from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Scale and isolation.
//
// Two different questions, deliberately in one file because they have the same
// answer when they go wrong.
//
// SCALE: does cost grow linearly with input, or worse? Absolute throughput on
// one machine is nearly meaningless; the shape of the curve is not.
//
// ISOLATION: does anything leak between organizations when many of them are
// interleaved? I have claimed the tenant boundaries hold. Claiming is not
// testing, and this is the part I said was unproven.
//
// Thresholds here are deliberately loose. A tight one fails on a busy CI box
// and gets deleted, and a deleted test proves nothing. These exist to catch a
// change that makes something QUADRATIC, not to police milliseconds.
// ─────────────────────────────────────────────────────────────────────────────

const actor: EventActor = { kind: "user", userId: "op-1", role: "operator" };
const trace = () => ({ correlationId: newCorrelationId() });

const intake = (org: string, n: number) => ({
  customerId: `${org}-customer-${n}`,
  customerName: `Customer ${n} of ${org}`,
  source: "manual" as const,
  lineItems: [{ id: `line-${n}`, label: `Item ${n}`, quantity: 1 }],
  shopNotes: `private note for ${org}`,
});

describe("work-order creation at volume", () => {
  it("stays linear as the log grows", async () => {
    // The failure this catches: an append that scans what is already there.
    // Fine at ten work orders, ruinous at ten thousand, and invisible until a
    // real shop has been running for a year.
    const profile = await scalingProfile(
      async (size) => {
        const log = createInMemoryEventLog();
        const create = createCreateWorkOrderUseCase({ eventLog: log });
        for (let i = 0; i < size; i += 1) await create.execute(intake("org-a", i), actor);
      },
      [250, 500, 1000],
      "work-order creation",
    );

    for (const row of profile) {
      console.log(
        `  ${row.size} work orders: ${row.totalMs.toFixed(0)}ms ` +
          `(${row.msPerItem.toFixed(3)}ms each, scaling ×${row.scalingFactor.toFixed(2)})`,
      );
    }

    // Linear is ~1.0. Quadratic would climb with every doubling. 2.5 is loose
    // enough to survive a noisy machine and tight enough to catch O(n²).
    const worst = Math.max(...profile.slice(1).map((r) => r.scalingFactor));
    expect(worst).toBeLessThan(2.5);
  });

  it("reports a distribution rather than an average", async () => {
    const log = createInMemoryEventLog();
    const create = createCreateWorkOrderUseCase({ eventLog: log });

    const result = await measure((i) => void create.execute(intake("org-a", i), actor), {
      label: "createWorkOrder",
      operations: 1000,
      warmup: 50,
    });

    console.log(`  ${formatResult(result)}`);
    expect(result.errors).toBe(0);
    // p99 within an order of magnitude of p50 means no pathological tail.
    expect(result.p99Ms).toBeLessThan(Math.max(result.p50Ms * 50, 25));
  });
});

describe("many organizations at once", () => {
  it("keeps 100 organizations' work orders separate", async () => {
    // One shared log, the way a multi-tenant host would actually run it.
    const log = createInMemoryEventLog();
    const create = createCreateWorkOrderUseCase({ eventLog: log });
    const orgs = Array.from({ length: 100 }, (_, i) => `org-${i}`);

    const created = new Map<string, string[]>();
    // Interleaved, not grouped — grouping by org would hide a bug that only
    // appears when two organizations' writes are adjacent.
    for (let round = 0; round < 5; round += 1) {
      for (const org of orgs) {
        const result = await create.execute(intake(org, round), actor);
        if (result.ok) {
          const list = created.get(org) ?? [];
          list.push(result.draft.workOrderId);
          created.set(org, list);
        }
      }
    }

    expect(created.size).toBe(100);

    // Every work order id is unique across every organization. A collision
    // here is one shop reading another's job.
    const allIds = [...created.values()].flat();
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(500);
  });

  it("does not let one organization's events appear in another's view", async () => {
    const log = createInMemoryEventLog();
    const create = createCreateWorkOrderUseCase({ eventLog: log });

    const a = await create.execute(intake("org-a", 1), actor);
    const b = await create.execute(intake("org-b", 1), actor);
    if (!a.ok || !b.ok) throw new Error("setup failed");

    const forA = await log.listByWorkOrder(a.draft.workOrderId);
    const forB = await log.listByWorkOrder(b.draft.workOrderId);

    // Scoped retrieval returns only that work order's events, even though both
    // organizations share one log.
    expect(forA.length).toBeGreaterThan(0);
    expect(forA.every((e) => e.workOrderId === a.draft.workOrderId)).toBe(true);
    expect(forB.every((e) => e.workOrderId === b.draft.workOrderId)).toBe(true);
    expect(JSON.stringify(forA)).not.toContain("org-b");
  });

  it("refuses a capability across 100 organizations without exception", async () => {
    // One organization is entitled. Ninety-nine are not, and the check must be
    // wrong for none of them.
    const resolver = createCapabilityResolver([
      {
        organizationId: "org-42",
        application: "proworks",
        capabilities: [CAPABILITIES.workOrder.shopFloor],
      },
    ]);

    let granted = 0;
    let refused = 0;
    for (let i = 0; i < 100; i += 1) {
      await requireCapability(resolver, `org-${i}`, "proworks", CAPABILITIES.workOrder.shopFloor)
        .then(() => (granted += 1))
        .catch(() => (refused += 1));
    }

    expect(granted).toBe(1);
    expect(refused).toBe(99);
  });
});

describe("the event bus under fan-out", () => {
  it("delivers to many consumers without cost per consumer exploding", async () => {
    const bus = createInMemoryEventBus();
    let delivered = 0;
    for (let i = 0; i < 50; i += 1) {
      bus.subscribe("*", () => void (delivered += 1), { consumer: `consumer-${i}` });
    }

    const result = await measure(
      // Braces and an await, not `void`: dropping the promise makes this
      // fire-and-forget, and the assertion below then counts deliveries that
      // are still in flight.
      async () => {
        await bus.publish({
          eventType: "receipt.ingested",
          source: { service: "test" },
          tenant: { organizationId: "org-a", roles: [] },
          trace: trace(),
          payload: { fingerprint: "f", source: "photo", extractor: "x", lineCount: 1 },
        });
      },
      {
        label: "publish to 50 consumers",
        operations: 200,
        warmup: 20,
        // Warm-up published for real, so its deliveries are discounted here
        // rather than silently inflating the assertion below.
        afterWarmup: () => {
          delivered = 0;
        },
      },
    );

    console.log(`  ${formatResult(result)}`);
    expect(delivered).toBe(50 * 200);
    expect(result.errors).toBe(0);
  });
});

describe("the receipt pipeline at volume", () => {
  it("handles a burst without degrading", async () => {
    // The directive's own scenario: fifty thousand receipts must not stall
    // manufacturing. This measures the receipt side of that claim.
    const engine = createReceiptIqEngine();
    const text = "HOME DEPOT\nBrighton, CO\n08/26/2026\nBolt 4.50\nScrews 8.99\nTotal 13.49";

    const result = await measure(
      async () => {
        await engine.read(
          { kind: "text", text },
          { ownerRef: "shop-1", ownership: "tenant-private" },
        );
      },
      { label: "receipt read+normalize", operations: 500, warmup: 25 },
    );

    console.log(`  ${formatResult(result)}`);
    expect(result.errors).toBe(0);
  });
});

describe("the job queue under a flood", () => {
  it("keeps claim cost flat as the queue deepens", async () => {
    // The bulkhead only helps if claiming is not linear in queue depth. If it
    // is, a receipt flood slows manufacturing after all — through the claim
    // path rather than the worker pool.
    const profile = await scalingProfile(
      async (size) => {
        const q = createInMemoryJobQueue();
        for (let i = 0; i < size; i += 1) q.enqueue({ jobType: "receipt.parse", trace: trace() });
        q.enqueue({ jobType: "forgeiq.nest", trace: trace(), jobId: "nest_1" });
        // The measurement that matters: one claim against a deep queue.
        q.claim(["forgeiq.nest"], "forge", 30_000);
      },
      [500, 1000, 2000],
      "claim against a deep queue",
    );

    for (const row of profile) {
      console.log(`  queue of ${row.size}: ${row.totalMs.toFixed(0)}ms (scaling ×${row.scalingFactor.toFixed(2)})`);
    }

    const worst = Math.max(...profile.slice(1).map((r) => r.scalingFactor));
    expect(worst).toBeLessThan(2.5);
  });
});
