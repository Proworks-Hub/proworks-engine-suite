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
import { costPerItemGrowth, formatResult, measure, scalingProfile, workCountProfile } from "./harness.js";

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
  it("stays linear as the log grows — measured deterministically", async () => {
    // ── NO CLOCK. THIS COUNTS WORK. ──────────────────────────────────────
    //
    // This assertion used a wall-clock scaling ratio against a 2.5 limit and
    // flaked: I observed ×3.06 on a loaded machine and green on every quiet
    // run. A previous fix had already increased the sample size rather than
    // relax the threshold, which was the right instinct and still left the
    // measurement dependent on how busy the box was.
    //
    // Raising the limit would have been the easy fix and the wrong one: it
    // would weaken a real requirement to accommodate a measurement problem.
    // What the test actually wants to know is whether cost per work order is
    // constant as the log grows — a property of the algorithm. That is
    // countable.
    //
    // The event log is an injected port, so a counting wrapper sees every read
    // the use case performs. If appending were secretly O(n) in log size it
    // would have to read the log, and reads-per-item would climb. Nothing else
    // can move that number: not GC, not the scheduler, not another process.
    const profile = await workCountProfile(async (size, countOperation) => {
      const inner = createInMemoryEventLog();
      // Spread rather than hand-listing: the interface has optional members
      // (`subscribe` is not on the in-memory implementation), and a wrapper
      // that enumerated methods would break whenever one was added.
      const counting = {
        ...inner,
        // Appends are counted too. Counting only reads measured nothing here:
        // creating a work order appends and never reads, so the counter stayed
        // at zero and the test passed while proving nothing.
        async append(...args: Parameters<typeof inner.append>) {
          countOperation();
          return inner.append(...args);
        },
        async listByWorkOrder(...args: Parameters<typeof inner.listByWorkOrder>) {
          countOperation();
          return inner.listByWorkOrder(...args);
        },
        async listByType(...args: Parameters<typeof inner.listByType>) {
          countOperation();
          return inner.listByType(...args);
        },
        async listSince(...args: Parameters<typeof inner.listSince>) {
          countOperation();
          return inner.listSince(...args);
        },
        async size() {
          countOperation();
          return inner.size();
        },
      };

      const create = createCreateWorkOrderUseCase({ eventLog: counting });
      for (let i = 0; i < size; i += 1) await create.execute(intake("org-a", i), actor);
    }, [500, 1000, 2000]);

    for (const row of profile) {
      console.log(
        `  ${row.size} work orders: ${row.operations} port operations (${row.operationsPerItem.toFixed(3)} per item)`,
      );
    }

    // Exactly flat. These are integer call counts, so linear work gives 1.0 and
    // anything super-linear gives a number that grows with every doubling. The
    // bound is 1.5 rather than 2.5 because it can be — there is no machine
    // noise to absorb.
    // The baseline is asserted first. A counter that recorded nothing would
    // make the growth ratio meaningless, and this is the check that would have
    // caught my own vacuous first version.
    expect(profile[0]!.operations).toBeGreaterThan(0);
    expect(profile[0]!.operationsPerItem).toBeCloseTo(1, 1);

    expect(costPerItemGrowth(profile)).toBeLessThan(1.5);
  });

  it("reports wall-clock alongside, as a benchmark rather than a gate", async () => {
    // Kept because a human reading CI output wants to know it is milliseconds
    // and not minutes. It asserts only that the work completed — the
    // complexity requirement is enforced by the deterministic test above, so
    // nothing here can flake the suite.
    const profile = await scalingProfile(
      async (size) => {
        const log = createInMemoryEventLog();
        const create = createCreateWorkOrderUseCase({ eventLog: log });
        for (let i = 0; i < size; i += 1) await create.execute(intake("org-a", i), actor);
      },
      [2000, 4000, 8000],
      "work-order creation",
    );

    for (const row of profile) {
      console.log(
        `  ${row.size} work orders: ${row.totalMs.toFixed(0)}ms ` +
          `(${row.msPerItem.toFixed(3)}ms each, scaling ×${row.scalingFactor.toFixed(2)})`,
      );
    }
    expect(profile).toHaveLength(3);
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
      // Raised for the same reason as work-order creation above: the ratio has
      // to be taken over samples large enough to survive scheduler noise.
      [4000, 8000, 16000],
      "claim against a deep queue",
    );

    for (const row of profile) {
      console.log(`  queue of ${row.size}: ${row.totalMs.toFixed(0)}ms (scaling ×${row.scalingFactor.toFixed(2)})`);
    }

    const worst = Math.max(...profile.slice(1).map((r) => r.scalingFactor));
    expect(worst).toBeLessThan(2.5);
  });
});
