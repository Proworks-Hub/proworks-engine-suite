// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import {
  EVENT_TYPES,
  PermanentError,
  TransientError,
  WorkflowConflictError,
  newCorrelationId,
} from "@proworks-hub/contracts";
import {
  createInMemoryDeadLetterQueue,
  createInMemoryEventBus,
  createInMemoryProcessedEventLedger,
} from "@proworks-hub/platform-events";
import { createInMemoryJobQueue } from "@proworks-hub/platform-runtime";
import {
  createInMemoryWorkflowStateStore,
  createWorkflowRunner,
} from "@proworks-hub/prime";
import { createReceiptIqEngine } from "@proworks-hub/receiptiq";

// ─────────────────────────────────────────────────────────────────────────────
// Failure testing.
//
// The question is not whether these components work. It is whether they fail
// PREDICTABLY — because the alternative to a predictable failure is not success,
// it is corrupted state that nobody notices for a fortnight.
//
// Each of these simulates something that will genuinely happen in production:
// a dependency down, an event delivered twice, a worker dying mid-job, two
// processes racing, a consumer that will never succeed.
// ─────────────────────────────────────────────────────────────────────────────

const trace = () => ({ correlationId: newCorrelationId() });
const tenant = { organizationId: "acme", roles: [] };
const source = { service: "test" };
const noSleep = () => Promise.resolve();

const ingested = () => ({
  eventType: EVENT_TYPES.receiptIngested,
  source,
  tenant,
  trace: trace(),
  payload: { fingerprint: "f", source: "photo" as const, extractor: "x", lineCount: 1 },
});

describe("a downstream engine is unavailable", () => {
  it("does not fail the engine that produced the fact", async () => {
    const onPublishError = vi.fn();
    const engine = createReceiptIqEngine({
      eventBus: { publish: () => Promise.reject(new TransientError("bus down")), subscribe: () => () => {} },
      onPublishError,
    });

    const receipt = await engine.read(
      { kind: "text", text: "HOME DEPOT\nBrighton, CO\n08/26/2026\nBolt 4.50\nTotal 4.50" },
      { ownerRef: "o1", ownership: "tenant-private" },
    );

    // The receipt was read. The bus being down does not un-read it.
    expect(receipt.merchantName).toBe("Home Depot");
    await new Promise((r) => setTimeout(r, 0));
    expect(onPublishError).toHaveBeenCalled();
  });

  it("keeps serving the consumers that are healthy", async () => {
    const healthy = vi.fn();
    const bus = createInMemoryEventBus();
    bus.subscribe("*", () => { throw new TransientError("costiq down"); }, { consumer: "costiq" });
    bus.subscribe("*", healthy, { consumer: "audit" });

    await bus.publish(ingested());
    expect(healthy).toHaveBeenCalledOnce();
  });
});

describe("an event is delivered twice", () => {
  it("is handled once, so nothing is double-counted", async () => {
    const ledger = createInMemoryProcessedEventLedger();
    const bus = createInMemoryEventBus({ ledger, generateId: () => "evt_same" });
    let inventoryAdded = 0;
    bus.subscribe("*", () => { inventoryAdded += 10; }, { consumer: "inventory" });

    await bus.publish(ingested());
    await bus.publish(ingested()); // the redelivery every transport eventually does

    // The whole reason the ledger exists: stock counted once, not twice.
    expect(inventoryAdded).toBe(10);
  });
});

describe("a consumer will never succeed", () => {
  it("is dead-lettered immediately rather than retried forever", async () => {
    const deadLetters = createInMemoryDeadLetterQueue();
    const handler = vi.fn(() => {
      throw new PermanentError("references a material that does not exist");
    });
    const bus = createInMemoryEventBus({
      resilience: { deadLetters, sleep: noSleep },
    });
    bus.subscribe("*", handler, { consumer: "inventory" });

    await bus.publish(ingested());

    expect(handler).toHaveBeenCalledOnce();
    const letters = await deadLetters.list();
    expect(letters[0]).toMatchObject({ classification: "permanent", attempts: 1 });
    // The event survives, whole, so it can be replayed once the cause is fixed.
    expect(letters[0]!.event).toBeDefined();
  });

  it("keeps the correlation, so a dead letter ties back to the work", async () => {
    const deadLetters = createInMemoryDeadLetterQueue();
    const correlationId = newCorrelationId();
    const bus = createInMemoryEventBus({ resilience: { deadLetters, sleep: noSleep } });
    bus.subscribe("*", () => { throw new PermanentError("no"); }, { consumer: "c" });

    await bus.publish({ ...ingested(), trace: { correlationId } });

    const [letter] = await deadLetters.list();
    expect(letter!.trace.correlationId).toBe(correlationId);
  });
});

describe("a worker dies mid-job", () => {
  it("the work returns to the queue rather than being lost", () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const q = createInMemoryJobQueue({ now: () => clock });
    q.enqueue({ jobType: "receipt.parse", trace: trace(), jobId: "j1" });

    q.claim(["receipt.parse"], "worker-that-dies", 1_000);
    expect(q.get("j1")?.status).toBe("running");

    // The process is gone; nothing will ever complete or fail this job.
    clock = new Date(clock.getTime() + 30_000);

    const recovered = q.claim(["receipt.parse"], "worker-b", 30_000);
    expect(recovered?.jobId).toBe("j1");
    // Attempts accumulate across owners, so a job that keeps killing workers
    // eventually stops rather than cycling forever.
    expect(recovered?.attempts).toBe(2);
  });
});

describe("PRIME restarts mid-workflow", () => {
  it("another instance continues it without repeating completed work", async () => {
    const store = createInMemoryWorkflowStateStore();
    const expensive = vi.fn(() => ({ planId: "plan_1" }));
    let dead = true;

    const definition = {
      workflowType: "quote",
      steps: [
        { stepId: "plan", run: expensive },
        { stepId: "cost", run: () => { if (dead) throw new Error("process died"); return { cents: 1 }; } },
      ],
    };

    await createWorkflowRunner({ store, instanceId: "prime-1" }).start({
      definition,
      trace: trace(),
      workflowId: "wf_1",
    });

    const stored = (await store.load("wf_1"))!;
    await store.save({ ...stored, status: "running", claimedBy: undefined, claimedUntil: undefined }, stored.version);

    dead = false;
    const resumed = await createWorkflowRunner({ store, instanceId: "prime-2" }).resume("wf_1", definition);

    expect(resumed.status).toBe("completed");
    expect(expensive).toHaveBeenCalledOnce();
  });

  it("two instances racing produce a conflict, not silent data loss", async () => {
    const store = createInMemoryWorkflowStateStore();
    await createWorkflowRunner({ store, instanceId: "p1" }).start({
      definition: { workflowType: "t", steps: [{ stepId: "a", run: () => ({}) }] },
      trace: trace(),
      workflowId: "wf_1",
    });

    const readByBoth = (await store.load("wf_1"))!;
    await store.save({ ...readByBoth, context: { by: "first" } }, readByBoth.version);

    expect(() => store.save({ ...readByBoth, context: { by: "second" } }, readByBoth.version)).toThrow(
      WorkflowConflictError,
    );
    // The first instance's work is intact. Losing it silently is the failure
    // mode this whole mechanism exists to prevent.
    expect((await store.load("wf_1"))!.context).toEqual({ by: "first" });
  });
});

describe("a flood in one engine", () => {
  it("does not stop another engine's work", () => {
    const q = createInMemoryJobQueue();
    for (let i = 0; i < 500; i += 1) q.enqueue({ jobType: "receipt.parse", trace: trace() });
    q.enqueue({ jobType: "forgeiq.nest", trace: trace(), jobId: "nest_1" });

    // The bulkhead: manufacturing is unaffected by a receipt backlog.
    expect(q.claim(["forgeiq.nest"], "forge", 30_000)?.jobId).toBe("nest_1");
    expect(q.stats(["receipt.parse"]).queued).toBe(500);
    expect(q.stats(["forgeiq.nest"]).queued).toBe(0);
  });
});

describe("bad input at a trust boundary", () => {
  it("a malformed payload is refused at publish, not at a consumer later", async () => {
    const bus = createInMemoryEventBus();
    const consumer = vi.fn();
    bus.subscribe("*", consumer, { consumer: "c" });

    await expect(
      bus.publish({
        eventType: EVENT_TYPES.receiptNormalized,
        source,
        tenant,
        trace: trace(),
        payload: { fingerprint: "missing everything else" },
      }),
    ).rejects.toThrow();

    // Nothing was delivered, so no consumer had to defend itself.
    expect(consumer).not.toHaveBeenCalled();
  });

  it("a tenant on canonical knowledge is refused outright", async () => {
    const bus = createInMemoryEventBus();
    await expect(
      bus.publish({
        eventType: EVENT_TYPES.materialPurchaseDetected,
        source,
        tenant,
        trace: trace(),
        payload: {
          observation: {
            ownership: "canonical",
            itemKey: "steel",
            itemName: "Steel",
            merchantKey: "m",
            merchantName: "M",
            price: { cents: 100, currency: "USD" },
            quantity: 1,
            unit: "each",
            unitPrice: { cents: 100, currency: "USD" },
            onSale: false,
            saleType: null,
            observedOn: "2026-08-26",
            source: "receipt",
            confidence: 0.8,
            fingerprint: "fp",
          },
        },
      }),
    ).rejects.toThrow(/without a tenant/i);
  });
});
