// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import { WorkflowConflictError } from "@proworks-hub/contracts";
import { createInMemoryWorkflowStateStore } from "../inMemoryWorkflowStateStore.js";
import { createWorkflowRunner, type WorkflowDefinition } from "../workflowRunner.js";

const tenant = { organizationId: "acme", roles: [] };
const trace = { correlationId: "cor_1" };

/** The shape of a real cross-engine workflow, with the effects stubbed. */
function quoteWorkflow(effects: {
  onPlan?: () => void;
  onCost?: () => void;
  onJob?: () => void;
  onReserve?: () => void;
  cancelJob?: () => void;
  releaseStock?: () => void;
}): WorkflowDefinition {
  return {
    workflowType: "quote-to-job",
    steps: [
      {
        stepId: "generate-plan",
        run: () => {
          effects.onPlan?.();
          return { planId: "plan_1", partCount: 4 };
        },
        // No compensation: a generated plan is still true after a later
        // failure, and deleting it would destroy work to tidy a status field.
      },
      {
        stepId: "calculate-cost",
        run: () => {
          effects.onCost?.();
          return { totalCents: 29808 };
        },
      },
      {
        stepId: "create-job",
        run: () => {
          effects.onJob?.();
          return { jobId: "job_1" };
        },
        compensate: () => {
          effects.cancelJob?.();
        },
      },
      {
        stepId: "reserve-materials",
        run: () => {
          effects.onReserve?.();
          return { reserved: true };
        },
        compensate: () => {
          effects.releaseStock?.();
        },
      },
    ],
  };
}

const runnerFor = (store: ReturnType<typeof createInMemoryWorkflowStateStore>, instanceId = "prime-1") =>
  createWorkflowRunner({ store, instanceId });

describe("running a workflow", () => {
  it("runs every step and accumulates their output", async () => {
    const store = createInMemoryWorkflowStateStore();
    const result = await runnerFor(store).start({
      definition: quoteWorkflow({}),
      tenant,
      trace,
    });

    expect(result.status).toBe("completed");
    expect(result.context).toMatchObject({
      planId: "plan_1",
      totalCents: 29808,
      jobId: "job_1",
      reserved: true,
    });
    expect(result.steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("keeps the correlation, so the whole workflow is one thread to pull", async () => {
    const store = createInMemoryWorkflowStateStore();
    const result = await runnerFor(store).start({ definition: quoteWorkflow({}), tenant, trace });
    expect(result.trace.correlationId).toBe("cor_1");
  });

  it("returns the original rather than starting a second one for the same id", async () => {
    const store = createInMemoryWorkflowStateStore();
    const onPlan = vi.fn();
    const runner = runnerFor(store);
    const definition = quoteWorkflow({ onPlan });

    await runner.start({ definition, tenant, trace, workflowId: "wf_fixed" });
    await runner.start({ definition, tenant, trace, workflowId: "wf_fixed" });

    // A customer double-clicking must not make the shop build two.
    expect(onPlan).toHaveBeenCalledOnce();
    expect(store.size()).toBe(1);
  });
});

describe("compensation", () => {
  it("unwinds completed steps in reverse when a later one fails", async () => {
    const store = createInMemoryWorkflowStateStore();
    const order: string[] = [];
    const definition: WorkflowDefinition = {
      workflowType: "quote-to-job",
      steps: [
        ...quoteWorkflow({
          cancelJob: () => void order.push("cancel-job"),
        }).steps.slice(0, 3),
        {
          stepId: "reserve-materials",
          run: () => {
            throw new Error("insufficient stock");
          },
          compensate: () => void order.push("release-stock"),
        },
      ],
    };

    const result = await runnerFor(store).start({ definition, tenant, trace });

    expect(result.status).toBe("compensated");
    expect(result.failureReason).toMatch(/insufficient stock/);
    // Only the step that actually created something got undone. The failed
    // step never completed, so it has nothing to compensate.
    expect(order).toEqual(["cancel-job"]);
  });

  it("leaves work that is still valid alone", async () => {
    const store = createInMemoryWorkflowStateStore();
    const definition: WorkflowDefinition = {
      workflowType: "quote-to-job",
      steps: [
        ...quoteWorkflow({}).steps.slice(0, 2),
        { stepId: "create-job", run: () => { throw new Error("shop floor full"); } },
      ],
    };

    const result = await runnerFor(store).start({ definition, tenant, trace });

    expect(result.status).toBe("compensated");
    // The plan and the cost survive. They are still true, and a quote that was
    // calculated is still a useful quote.
    expect(result.context).toMatchObject({ planId: "plan_1", totalCents: 29808 });
  });

  it("stops and demands a human when compensation itself fails", async () => {
    const store = createInMemoryWorkflowStateStore();
    const definition: WorkflowDefinition = {
      workflowType: "quote-to-job",
      steps: [
        { stepId: "create-job", run: () => ({ jobId: "job_1" }), compensate: () => { throw new Error("cancel API down"); } },
        { stepId: "reserve", run: () => { throw new Error("insufficient stock"); } },
      ],
    };

    const result = await runnerFor(store).start({ definition, tenant, trace });

    // Not "compensated" — the undo failed, so the state is one nobody chose.
    expect(result.status).toBe("failed");
    expect(result.failureReason).toMatch(/insufficient stock/);
    expect(result.failureReason).toMatch(/cancel API down/);
    expect(result.failureReason).toMatch(/needs a human/);
  });
});

describe("surviving a restart", () => {
  it("resumes from where it stopped, without repeating completed work", async () => {
    const store = createInMemoryWorkflowStateStore();
    const onPlan = vi.fn();
    const onCost = vi.fn();

    // First process gets two steps in, then "crashes".
    let crash = true;
    const definition: WorkflowDefinition = {
      workflowType: "quote-to-job",
      steps: [
        { stepId: "generate-plan", run: () => { onPlan(); return { planId: "plan_1" }; } },
        { stepId: "calculate-cost", run: () => { onCost(); return { totalCents: 29808 }; } },
        {
          stepId: "create-job",
          run: () => {
            if (crash) throw new Error("process died");
            return { jobId: "job_1" };
          },
        },
      ],
    };

    const first = await runnerFor(store, "prime-1").start({ definition, tenant, trace, workflowId: "wf_1" });
    expect(first.status).toBe("compensated");

    // A different process, the same store. Reset the workflow to running as an
    // operator would after fixing the cause.
    const stored = (await store.load("wf_1"))!;
    await store.save({ ...stored, status: "running", claimedBy: undefined, claimedUntil: undefined }, stored.version);

    crash = false;
    const resumed = await runnerFor(store, "prime-2").resume("wf_1", definition);

    expect(resumed.status).toBe("completed");
    expect(resumed.context).toMatchObject({ planId: "plan_1", jobId: "job_1" });
    // The expensive early steps ran ONCE across both processes.
    expect(onPlan).toHaveBeenCalledOnce();
    expect(onCost).toHaveBeenCalledOnce();
  });

  it("recovers a workflow abandoned by a crashed instance", async () => {
    let clock = new Date("2026-08-27T00:00:00.000Z");
    const store = createInMemoryWorkflowStateStore({ now: () => clock });

    const definition: WorkflowDefinition = {
      workflowType: "quote-to-job",
      steps: [{ stepId: "only", run: () => ({ done: true }) }],
    };

    // An instance claims it and never finishes — the process died.
    const abandoned = {
      workflowId: "wf_abandoned",
      workflowType: "quote-to-job",
      status: "running" as const,
      trace,
      context: {},
      steps: [],
      version: 0,
      claimedBy: "prime-dead",
      // A live lease: the instance holding it has not died yet.
      claimedUntil: new Date(clock.getTime() + 30_000).toISOString(),
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    };
    await store.create(abandoned);

    // Nothing to recover while the lease still holds.
    expect(await store.listResumable()).toHaveLength(0);

    // The lease expires.
    clock = new Date("2026-08-27T00:01:00.000Z");
    expect(await store.listResumable()).toHaveLength(1);

    const recovered = await createWorkflowRunner({
      store,
      instanceId: "prime-2",
      now: () => clock,
    }).recoverAbandoned([definition]);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.status).toBe("completed");
  });
});

describe("two instances at once", () => {
  it("refuses a stale write rather than silently overwriting", async () => {
    const store = createInMemoryWorkflowStateStore();
    await runnerFor(store).start({
      definition: { workflowType: "t", steps: [{ stepId: "a", run: () => ({}) }] },
      trace,
      workflowId: "wf_1",
    });

    const readByBoth = (await store.load("wf_1"))!;
    await store.save({ ...readByBoth, context: { winner: "first" } }, readByBoth.version);

    // The second instance read the same version and is now behind.
    expect(() => store.save({ ...readByBoth, context: { winner: "second" } }, readByBoth.version)).toThrow(
      WorkflowConflictError,
    );
    expect((await store.load("wf_1"))!.context).toEqual({ winner: "first" });
  });

  it("grants a lease to one claimant only", async () => {
    const store = createInMemoryWorkflowStateStore();
    await runnerFor(store, "prime-1").start({
      definition: { workflowType: "t", steps: [{ stepId: "a", run: () => ({}) }] },
      trace,
      workflowId: "wf_1",
    });
    const stored = (await store.load("wf_1"))!;
    await store.save({ ...stored, status: "running", claimedBy: "prime-1", claimedUntil: new Date(Date.now() + 60_000).toISOString() }, stored.version);

    expect(await store.claim("wf_1", "prime-2", 30_000)).toBeNull();
    expect(await store.claim("wf_1", "prime-1", 30_000)).not.toBeNull();
  });

  it("does not let a caller mutate stored state through what it read", async () => {
    const store = createInMemoryWorkflowStateStore();
    await runnerFor(store).start({
      definition: { workflowType: "t", steps: [{ stepId: "a", run: () => ({ v: 1 }) }] },
      trace,
      workflowId: "wf_1",
    });
    const loaded = (await store.load("wf_1"))!;
    (loaded.context as Record<string, unknown>).v = 999;
    expect((await store.load("wf_1"))!.context).toMatchObject({ v: 1 });
  });
});
