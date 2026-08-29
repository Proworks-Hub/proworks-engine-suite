// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { SYNCHRONOUS_ONLY, workflowInstanceSchema } from "@proworks-hub/contracts";

import {
  chamberCreatesAuthority,
  chambersAreSovereignEngines,
  createPrime,
  createPrimeNexus,
  createPrimePulse,
  primeExecutionContextSchema,
  scopeKeyOf,
  createInMemoryWorkflowStateStore,
  type PrimeExecutionContext,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prime Phase 1 — the chamber split, enforced.
//
// Every test here exists because the corresponding rule is easy to state and
// easy to lose. A chamber boundary that lives only in a comment is a boundary
// that survives exactly until the first inconvenient afternoon.
// ─────────────────────────────────────────────────────────────────────────────

const KSIX = "ksix";
const BRIGHTON = "brighton-signs";

const ctx = (over: Partial<Record<string, unknown>> = {}): PrimeExecutionContext =>
  primeExecutionContextSchema.parse({
    executionId: "exe_1",
    workflowType: "shop.job",
    tenant: { organizationId: KSIX, roles: [] },
    actor: { kind: "system", id: "host" },
    authorizationRef: "gd-1",
    trace: { correlationId: "cor_1" },
    ...over,
  });

const instance = (over: Record<string, unknown> = {}) =>
  workflowInstanceSchema.parse({
    workflowId: "wf_1",
    workflowType: "shop.job",
    status: "running",
    tenant: { organizationId: KSIX, roles: [] },
    trace: { correlationId: "cor_1" },
    context: { authorizationRef: "gd-1" },
    createdAt: "2026-08-29T10:00:00.000Z",
    updatedAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

// ── Composition and ownership ────────────────────────────────────────────────

describe("Prime is one engine composed of two chambers", () => {
  it("exposes both chambers under one name", () => {
    const prime = createPrime({ continuity: createInMemoryWorkflowStateStore() });
    expect(prime.name).toBe("prime");
    expect(prime.nexus.chamber).toBe("nexus");
    expect(prime.pulse?.chamber).toBe("pulse");
  });

  it("neither chamber is a sovereign engine, and neither creates authority", () => {
    expect(chambersAreSovereignEngines()).toBe(false);
    expect(chamberCreatesAuthority()).toBe(false);
  });

  it("reports no continuity chamber rather than a pretend one", () => {
    // A no-op Pulse would report healthy and preserve nothing. Null is the only
    // answer that lets a caller tell "not configured" from "working".
    const prime = createPrime();
    expect(prime.pulse).toBeNull();
  });

  it("has no general-purpose execution or persistence surface", () => {
    // The prohibitions are structural: the facade holds no store, no registry
    // and no engine handles, so there is nothing to call.
    const prime = createPrime({ continuity: createInMemoryWorkflowStateStore() });
    const surface = Object.keys(prime).sort();
    expect(surface).toEqual(["decide", "name", "nexus", "pulse"]);
    for (const forbidden of ["execute", "run", "save", "persist", "store", "engines"]) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it("keeps the original decide surface working", () => {
    // Phase 1 must not break what Prime already did for its twelve callers.
    const prime = createPrime();
    const result = prime.decide({
      contextVersion: 1,
      subject: { type: "order", reference: "ord_1" },
    } as never);
    expect(["proceed", "review", "blocked"]).toContain(result.status);
  });
});

// ── Execution context ────────────────────────────────────────────────────────

describe("the execution context refuses to let a boundary go missing", () => {
  it("refuses an execution that names neither a tenant nor systemScoped", () => {
    // The whole point: forgetting and deliberately-absent must not look alike.
    const parsed = primeExecutionContextSchema.safeParse({
      executionId: "exe_1",
      workflowType: "shop.job",
      actor: { kind: "system", id: "host" },
      trace: { correlationId: "cor_1" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("systemScoped");
    }
  });

  it("accepts a system-scoped execution that says so", () => {
    const parsed = primeExecutionContextSchema.safeParse({
      executionId: "exe_sys",
      workflowType: "maintenance.sweep",
      systemScoped: true,
      actor: { kind: "system", id: "foundry" },
      trace: { correlationId: "cor_sys" },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an execution claiming to be both system-scoped and a tenant's", () => {
    const parsed = primeExecutionContextSchema.safeParse({
      executionId: "exe_1",
      workflowType: "shop.job",
      systemScoped: true,
      tenant: { organizationId: KSIX, roles: [] },
      actor: { kind: "system", id: "host" },
      trace: { correlationId: "cor_1" },
    });
    expect(parsed.success).toBe(false);
  });

  it("derives the scope key rather than accepting one", () => {
    expect(scopeKeyOf(ctx())).toBe(`tenant:${KSIX}`);
    expect(scopeKeyOf(ctx({ tenant: { organizationId: BRIGHTON, roles: [] } }))).toBe(
      `tenant:${BRIGHTON}`,
    );
  });
});

// ── Nexus ────────────────────────────────────────────────────────────────────

describe("Prime Nexus commands, and does not permit", () => {
  const nexus = createPrimeNexus();

  it("selects the next step when every prerequisite is satisfied", () => {
    const decision = nexus.next({
      context: ctx(),
      steps: [{ stepId: "plan", dependsOn: [{ stepId: "intake", satisfied: true }] }],
    });
    expect(decision.outcome).toBe("proceed");
    expect(decision.stepId).toBe("plan");
    expect(decision.evidence.join()).toContain("intake: satisfied");
  });

  it("blocks a step that requires authorization when the context carries none", () => {
    const decision = nexus.next({
      context: ctx({ authorizationRef: undefined }),
      steps: [{ stepId: "promote", requiresAuthorization: true }],
    });
    expect(decision.outcome).toBe("blocked");
    expect(decision.stepId).toBeNull();
    expect(decision.reason).toContain("does not create it");
  });

  it("treats an unrun validation exactly as it treats a failed one", () => {
    // The quiet failure: `null` meaning "not checked" collapsing into "fine".
    const notRun = nexus.next({
      context: ctx(),
      steps: [{ stepId: "cut", validationPassed: null }],
    });
    const failed = nexus.next({
      context: ctx(),
      steps: [{ stepId: "cut", validationPassed: false }],
    });
    expect(notRun.outcome).toBe("blocked");
    expect(failed.outcome).toBe("blocked");
    expect(notRun.reason).toContain("was not run");
  });

  it("waits on a dependency it could not evaluate, rather than proceeding", () => {
    // Unchecked is not satisfied. An engine being unreachable is not consent.
    const decision = nexus.next({
      context: ctx(),
      steps: [
        {
          stepId: "reserve",
          dependsOn: [{ stepId: "stock-check", satisfied: null, detail: "InventoryIQ unreachable" }],
        },
      ],
    });
    expect(decision.outcome).toBe("waiting");
    expect(decision.reason).toContain("could not be evaluated");
    expect(decision.evidence.join()).toContain("UNKNOWN");
  });

  it("refuses every one of the eight synchronous-only operations as an async step", () => {
    // The canonical list, imported rather than restated. If an operation is
    // added to it, this test covers it the same day.
    expect(SYNCHRONOUS_ONLY).toHaveLength(8);
    for (const operation of SYNCHRONOUS_ONLY) {
      const decision = nexus.next({
        context: ctx(),
        steps: [{ stepId: `step_${operation}`, operation, asynchronous: true }],
      });
      expect(decision.outcome, operation).toBe("refused");
      expect(decision.reason, operation).toContain("may never be performed asynchronously");
      expect(nexus.mayRunAsynchronously({ stepId: "s", operation }), operation).toBe(false);
    }
  });

  it("refuses the synchronous-only step before considering anything else about it", () => {
    // Ordering matters: refused late would mean the other checks had already
    // treated it as a legitimate candidate.
    const decision = nexus.next({
      context: ctx({ authorizationRef: undefined }),
      steps: [
        {
          stepId: "sneaky",
          operation: "authorize",
          asynchronous: true,
          requiresAuthorization: true,
          validationPassed: false,
        },
      ],
    });
    expect(decision.outcome).toBe("refused");
    expect(decision.reason).toContain("authorize");
  });

  it("allows an ordinary operation to run asynchronously", () => {
    // The rule is a wall around eight operations, not a ban on asynchrony.
    expect(nexus.mayRunAsynchronously({ stepId: "notify", operation: "notify.customer" })).toBe(true);
  });

  it("is deterministic for identical authorized state", () => {
    const input = {
      context: ctx(),
      steps: [
        { stepId: "a", dependsOn: [{ stepId: "x", satisfied: true }] },
        { stepId: "b" },
      ],
    };
    expect(nexus.next(input)).toEqual(nexus.next(input));
  });

  it("does not reorder work to find something runnable", () => {
    // Choosing a different step because the authorized one is blocked is
    // choosing a different workflow and calling it progress.
    const decision = nexus.next({
      context: ctx(),
      steps: [
        { stepId: "first", dependsOn: [{ stepId: "gate", satisfied: false }] },
        { stepId: "second" },
      ],
    });
    expect(decision.outcome).toBe("waiting");
    expect(decision.stepId).toBeNull();
  });

  it("propagates tenant, actor, authority, correlation and idempotency unchanged", () => {
    const context = ctx({ idempotencyKey: "idem_1", missionId: "MIS-X" });
    const decision = nexus.next({ context, steps: [{ stepId: "go" }] });
    expect(decision.context.tenant?.organizationId).toBe(KSIX);
    expect(decision.context.actor).toEqual(context.actor);
    expect(decision.context.authorizationRef).toBe("gd-1");
    expect(decision.context.trace.correlationId).toBe("cor_1");
    expect(decision.context.idempotencyKey).toBe("idem_1");
    expect(decision.context.missionId).toBe("MIS-X");
    // Only the step id is added — Nexus propagates, it does not enrich.
    expect(decision.context.stepId).toBe("go");
  });

  it("reports completion when nothing remains", () => {
    const decision = nexus.next({
      context: ctx(),
      steps: [{ stepId: "a" }],
      completedStepIds: ["a"],
    });
    expect(decision.outcome).toBe("completed");
  });
});

// ── Pulse ────────────────────────────────────────────────────────────────────

describe("Prime Pulse preserves, and does not re-permit", () => {
  const pulseWith = () => {
    const store = createInMemoryWorkflowStateStore();
    return { store, pulse: createPrimePulse({ store }) };
  };

  it("reports in-memory continuity as degraded, not healthy", () => {
    // The lie this chamber must not tell. "Healthy" would be read as "recovery
    // survives a restart", which this configuration cannot keep.
    const { pulse } = pulseWith();
    const health = pulse.health();
    expect(health.state).toBe("degraded");
    expect(health.durability).toBe("in-memory");
    expect(health.detail).toContain("lost on restart");
  });

  it("refuses a checkpoint whose scope does not match the instance", async () => {
    const { store, pulse } = pulseWith();
    const wf = instance();
    await store.create(wf);

    const result = await pulse.checkpoint({
      context: ctx({ tenant: { organizationId: BRIGHTON, roles: [] } }),
      instance: wf,
      expectedVersion: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("wrong scope");
  });

  it("refuses to resume another tenant's execution", async () => {
    // Brighton knows the workflow id — it is in the same process. Knowing an
    // identifier is not authority to resume it.
    const { store, pulse } = pulseWith();
    await store.create(instance());

    const verdict = await pulse.resume({
      context: ctx({ tenant: { organizationId: BRIGHTON, roles: [] } }),
      workflowId: "wf_1",
      owner: "brighton-worker",
    });
    expect(verdict.outcome).toBe("refused");
    expect(verdict.reason).toContain("Knowing a workflow id is not authority");
  });

  it("refuses a second concurrent recovery of the same execution", async () => {
    // Duplicate effect prevention, through the store's lease rather than by
    // convention.
    const { store, pulse } = pulseWith();
    await store.create(instance());

    const first = await pulse.resume({ context: ctx(), workflowId: "wf_1", owner: "worker-a" });
    const second = await pulse.resume({ context: ctx(), workflowId: "wf_1", owner: "worker-b" });

    expect(first.outcome).toBe("resumed");
    expect(second.outcome).toBe("already-recovering");
    expect(second.instance).toBeNull();
  });

  it("refuses to resume under an authorization that has changed", async () => {
    // Recovery is where a refused action gets a second, unexamined chance.
    const { store, pulse } = pulseWith();
    await store.create(instance());

    const verdict = await pulse.resume({
      context: ctx(),
      workflowId: "wf_1",
      owner: "worker-a",
      authorizationRef: "gd-DIFFERENT",
    });
    expect(verdict.outcome).toBe("refused");
    expect(verdict.reason).toContain("does not re-permit");
  });

  it("does not retry a non-retryable failure, and does not take a lease trying", async () => {
    const { store, pulse } = pulseWith();
    await store.create(instance());

    const verdict = await pulse.resume({
      context: ctx(),
      workflowId: "wf_1",
      owner: "worker-a",
      retryable: false,
    });
    expect(verdict.outcome).toBe("not-recoverable");

    // The execution was never claimed, so a legitimate recovery can still run.
    const legitimate = await pulse.resume({ context: ctx(), workflowId: "wf_1", owner: "worker-b" });
    expect(legitimate.outcome).toBe("resumed");
  });

  it("stops when attempts are exhausted", async () => {
    const { store, pulse } = pulseWith();
    await store.create(instance());
    const verdict = await pulse.resume({
      context: ctx(),
      workflowId: "wf_1",
      owner: "w",
      attempts: 3,
      maxAttempts: 3,
    });
    expect(verdict.outcome).toBe("exhausted");
  });

  it("never claims durability it does not have, even on success", async () => {
    const { store, pulse } = pulseWith();
    await store.create(instance());
    const verdict = await pulse.resume({ context: ctx(), workflowId: "wf_1", owner: "w" });
    expect(verdict.outcome).toBe("resumed");
    expect(verdict.durable).toBe(false);
    expect(verdict.reason).toContain("IN-MEMORY");
  });

  it("does not pretend state survived a restart", async () => {
    // A fresh store is a restarted process. Nothing is there, and Pulse says so
    // rather than reporting a clean recovery of nothing.
    const { store, pulse } = pulseWith();
    await store.create(instance());
    await pulse.resume({ context: ctx(), workflowId: "wf_1", owner: "w" });

    const afterRestart = createInMemoryWorkflowStateStore();
    const restarted = createPrimePulse({ store: afterRestart });
    const verdict = await restarted.resume({ context: ctx(), workflowId: "wf_1", owner: "w" });

    // "not-recoverable", NOT "already-recovering". The first draft returned the
    // latter, because claim() answers null both for "somebody holds it" and for
    // "there is nothing there" — which told a restarted process that its lost
    // execution was being recovered by someone. Reassuring, and false.
    expect(verdict.outcome).toBe("not-recoverable");
    expect(verdict.reason).toContain("never persisted at all");
    expect(verdict.instance).toBeNull();
  });

  it("surfaces a version conflict rather than overwriting", async () => {
    const { store, pulse } = pulseWith();
    const wf = instance();
    await store.create(wf);
    await store.save(wf, 0);

    const stale = await pulse.checkpoint({ context: ctx(), instance: wf, expectedVersion: 0 });
    expect(stale.ok).toBe(false);
    expect(stale.reason).toContain("changed underneath");
  });
});

// ── Chamber separation ───────────────────────────────────────────────────────

describe("the chambers stay in their lanes", () => {
  it("Nexus holds nothing it could persist through", () => {
    // Structural, not a rule: there is no store on the chamber to reach.
    const nexus = createPrimeNexus() as unknown as Record<string, unknown>;
    for (const key of ["store", "continuity", "save", "checkpoint", "resume"]) {
      expect(nexus[key]).toBeUndefined();
    }
  });

  it("Pulse cannot select a next step", () => {
    const pulse = createPrimePulse({
      store: createInMemoryWorkflowStateStore(),
    }) as unknown as Record<string, unknown>;
    for (const key of ["next", "decide", "select", "route"]) {
      expect(pulse[key]).toBeUndefined();
    }
  });
});

// ── The WorkOrderIQ boundary ─────────────────────────────────────────────────

describe("Prime does not take back what WorkOrderIQ owns", () => {
  it("declares no dependency on any specialized engine", async () => {
    const pkg = await import("../../package.json", { with: { type: "json" } });
    const deps = Object.keys((pkg.default as { dependencies: Record<string, string> }).dependencies);
    expect(deps.sort()).toEqual(["@proworks-hub/contracts", "zod"]);
    for (const engine of ["workorderiq", "inventoryiq", "costiq", "forgeiq", "receiptiq"]) {
      expect(deps.join()).not.toContain(engine);
    }
  });

  it("exposes nothing that could create or number a work order", () => {
    const prime = createPrime({ continuity: createInMemoryWorkflowStateStore() });
    const surface = [...Object.keys(prime), ...Object.keys(prime.nexus), ...Object.keys(prime.pulse!)];
    for (const forbidden of ["createWorkOrder", "reserve", "price", "workOrderNumber", "status"]) {
      expect(surface).not.toContain(forbidden);
    }
  });
});
