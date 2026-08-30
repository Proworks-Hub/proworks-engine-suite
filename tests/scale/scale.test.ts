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
  type AppendEventInput,
  type EventActor,
  type EventLog,
  type WorkOrderEvent,
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
      const counting: EventLog = {
        ...inner,
        // Appends are counted too. Counting only reads measured nothing here:
        // creating a work order appends and never reads, so the counter stayed
        // at zero and the test passed while proving nothing.
        //
        // Written generically rather than through `Parameters<typeof …>`,
        // which erases the type parameter to `unknown` and so does not satisfy
        // the port. The annotation on `counting` is what makes that a
        // compile error instead of a surprise at the call site.
        async append<TPayload = unknown>(
          input: AppendEventInput<TPayload>,
        ): Promise<WorkOrderEvent<TPayload>> {
          countOperation();
          return inner.append(input);
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

// ─────────────────────────────────────────────────────────────────────────────
// MIS-SCALE-QD — the queue-depth gate, deterministic.
//
// WHAT THE OLD GATE DID
//
// It timed a block containing `size` enqueues AND one claim, then required the
// elapsed-time ratio between doubling sizes to stay under 2.5. Two problems,
// and the second is worse than the flakiness that prompted this:
//
//   1. Wall clock. The ratio moved with whatever else the machine was doing;
//      it passed 5/5 in isolation and failed at 2.86 under worker contention.
//
//   2. It measured the wrong thing. At depth 16,000 the enqueue loop cost
//      ~98ms and the single claim inside the same block cost ~0.25ms. The
//      ratio was ~400:1 dominated by enqueue, so it tracked the linear cost of
//      the loop that SET UP the measurement, not the claim it named. A claim
//      that became quadratic would have moved that ratio by a fraction of a
//      percent.
//
// WHAT IS COUNTED NOW
//
// `observeClaimWork` fires once per job visited inside `claim`, and once per
// comparison while ordering survivors. Nothing else in the queue is observed,
// so the enqueue loop contributes zero and cannot mask the measurement again.
// The counts are integers produced by the algorithm: no clock, and no other
// process on the box can move them.
//
// THE FINDING THIS NOTE RECORDED HAS BEEN FIXED
//
// It said claim cost was LINEAR in total queue depth — two full passes over
// every job, regardless of type — and predicted that indexing the queue by
// jobType would make these assertions fail. It has been indexed. The claim now
// visits only the queued jobs of the requested type and only the jobs actually
// running, so a manufacturing worker pays nothing for a backlog of receipts.
// The assertions below were inverted rather than deleted, so the property is
// still pinned in both directions.
//
// One claim against a queue of N jobs costs exactly 2N units — one lease-sweep
// pass and one candidate-scan pass, both over EVERY job regardless of type.
// Measured at four depths, per-job work is 2.000 at all of them.
//
// WHAT THIS GATE PROTECTS, AND WHAT IT DOES NOT
//
// It holds the per-job constant at exactly 2 and the growth ratio at 1.0, so a
// third traversal or a quadratic scan fails immediately.
//
// It does NOT establish the property the old test was named for. "Keeps claim
// cost flat as the queue deepens" is false: one claim costs 2N, so it is linear
// in depth, and the bulkhead comment in inMemoryJobQueue.ts — "if fifty
// thousand receipts arrive, the receipt workers get busy and the manufacturing
// workers do not notice" — is not upheld by `claim`. A forgeiq.nest claim walks
// all fifty thousand receipts, twice.
//
// That is a queue behaviour change to fix (an index by jobType, so selection
// visits candidates rather than everything) and this mission is authorized to
// OBSERVE the queue, not to alter it. Recorded here, asserted below as the
// truth it is, and left for a separate decision.
// ─────────────────────────────────────────────────────────────────────────────

describe("the job queue under a flood", () => {
  /** One claim against a queue holding exactly `depth` jobs. */
  const claimAtDepth = (depth: number, countOperation: () => void): void => {
    const q = createInMemoryJobQueue({ observeClaimWork: () => countOperation() });
    // depth - 1 receipts plus the one nest job, so the queue holds exactly
    // `depth` jobs and per-job work is an exact integer ratio.
    for (let i = 0; i < depth - 1; i += 1) {
      q.enqueue({ jobType: "receipt.parse", trace: trace() });
    }
    q.enqueue({ jobType: "forgeiq.nest", trace: trace(), jobId: "nest_1" });
    // Enqueues are not observed. Only this line produces counts.
    const claimed = q.claim(["forgeiq.nest"], "forge", 30_000);
    if (claimed?.jobId !== "nest_1") {
      throw new Error(
        `the measured claim did not return the nest job (got ${claimed?.jobId ?? "null"})`,
      );
    }
  };

  it("costs the SAME work at every depth, now that the queue is indexed", async () => {
    // This test used to assert two work units per queued job and record that
    // as a finding. The note below said what would happen if somebody indexed
    // the queue by jobType — "this fails and should" — and somebody has. The
    // claim now visits only the jobs of the type being claimed and only the
    // jobs currently running, so a queue of 8,000 unrelated receipts costs a
    // manufacturing worker exactly nothing.
    const profile = await workCountProfile(
      async (size, countOperation) => claimAtDepth(size, countOperation),
      [1000, 2000, 4000, 8000],
    );

    for (const row of profile) {
      console.log(
        `  queue of ${row.size}: ${row.operations} claim work units (${row.operationsPerItem.toFixed(5)} per queued job)`,
      );
    }

    // ONE unit at every depth: the single job of the requested type. Nothing
    // is running, so the lease sweep visits nothing; one candidate means no
    // comparison. A regression that reintroduces a full pass takes this to
    // `size` and fails loudly.
    for (const row of profile) {
      expect(row.operations, `depth ${row.size}`).toBe(1);
    }

    // Cost per queued job now FALLS as the queue grows, because the cost is
    // constant and the divisor is not.
    expect(costPerItemGrowth(profile)).toBeLessThan(1);
  });

  it("counts nothing when the observer is absent, and the helper refuses to call that healthy", async () => {
    // The failure this whole rewrite exists to avoid. My first deterministic
    // replacement for the work-order gate counted only reads, recorded zero at
    // every size, and passed — "unmeasured" silently became "satisfied".
    //
    // Here: a queue built without the seam produces no counts, and the helper
    // throws rather than reporting healthy growth from no data.
    const unobserved = await workCountProfile(async (size) => {
      const q = createInMemoryJobQueue();
      for (let i = 0; i < size; i += 1) q.enqueue({ jobType: "receipt.parse", trace: trace() });
      q.claim(["receipt.parse"], "w", 30_000);
    }, [1000, 2000]);

    expect(unobserved[0]!.operations).toBe(0);
    expect(() => costPerItemGrowth(unobserved)).toThrow(/zero operations/);
  });

  it("catches a quadratic regression", () => {
    // A synthetic profile rather than a broken queue: the directive forbids
    // injecting a regression into production logic, and a shape is enough to
    // prove the assertion discriminates.
    const quadratic = [1000, 2000, 4000, 8000].map((size) => ({
      size,
      operations: 2 * size * size,
      operationsPerItem: 2 * size,
    }));

    expect(costPerItemGrowth(quadratic)).toBeGreaterThan(1.5);
    expect(() => expect(quadratic[0]!.operationsPerItem).toBe(2)).toThrow();
  });

  it("catches a constant-factor regression that leaves growth flat", () => {
    // Three passes instead of two. Growth stays at exactly 1.0, so the ratio
    // assertion alone would pass it — this is why the absolute constant is
    // asserted too.
    const thirdPass = [1000, 2000, 4000, 8000].map((size) => ({
      size,
      operations: 3 * size,
      operationsPerItem: 3,
    }));

    expect(costPerItemGrowth(thirdPass)).toBe(1);
    expect(() => expect(thirdPass[0]!.operationsPerItem).toBe(2)).toThrow();
  });

  it("is unaffected by machine speed", async () => {
    // The same depth measured twice returns identical integers. The old gate
    // could not make this claim about any two of its runs.
    const a = await workCountProfile(async (size, c) => claimAtDepth(size, c), [4000]);
    const b = await workCountProfile(async (size, c) => claimAtDepth(size, c), [4000]);
    expect(a[0]!.operations).toBe(b[0]!.operations);
    expect(a[0]!.operations).toBe(1);
  });

  it("records that claim cost is now FLAT in depth, which it was not", async () => {
    // The inverse of what this test asserted before, and the same discipline:
    // stated as an assertion so it cannot quietly become untrue in EITHER
    // direction. If somebody removes the type index, this fails and should.
    const shallow = await workCountProfile(async (size, c) => claimAtDepth(size, c), [1000]);
    const deep = await workCountProfile(async (size, c) => claimAtDepth(size, c), [8000]);

    expect(deep[0]!.operations).toBe(shallow[0]!.operations);

    console.log(
      `  one claim costs ${shallow[0]!.operations} unit at depth 1000 and ` +
        `${deep[0]!.operations} at depth 8000 — flat, not linear. See the MIS-SCALE-QD note above.`,
    );
  });

  it("completes a claim against a deep queue", async () => {
    // A benchmark, not a gate. It asserts completion and prints a duration for
    // whoever is curious; nothing here decides pass or fail on a clock.
    const result = await measure(
      () => {
        claimAtDepth(8000, () => {});
      },
      { label: "claim against a queue of 8000", operations: 5, warmup: 1 },
    );
    console.log(`  ${formatResult(result)}`);
    expect(result.errors).toBe(0);
  });
});
