// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  TenantContext,
  TraceContext,
  WorkflowInstance,
  WorkflowStateStore,
  WorkflowStepRecord,
} from "@proworks-hub/contracts";
import { WorkflowConflictError, isTransient, newCorrelationId } from "@proworks-hub/contracts";

import { createPrimeNexus, type CandidateStep, type PrimeNexus } from "../nexus/nexus.js";
import { primeExecutionContextSchema, type PrimeExecutionContext } from "../context.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRIME's workflow runner.
//
// A workflow crosses several engines — a plan is generated, a cost is
// calculated, a job is created, materials are reserved — and the interesting
// question is not the happy path. It is what happens when step four fails after
// steps one to three already did real work.
//
// The answer is NOT to pretend they never happened. A quote that was calculated
// is still a useful quote; a plan that was generated is still valid. So each
// step may declare a compensation, and only what genuinely needs undoing gets
// undone, in reverse order. That is the saga pattern at the smallest size that
// is honest — a state machine and a stack, not a framework.
//
// Everything here is pure. State goes through the WorkflowStateStore port, so
// PRIME still opens no connections and the architecture guard still passes.
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowStepContext {
  /** Accumulated output of earlier steps. Read it; return additions to it. */
  readonly context: Readonly<Record<string, unknown>>;
  readonly workflowId: string;
  readonly tenant?: TenantContext;
  readonly trace: TraceContext;
}

export interface WorkflowStep {
  readonly stepId: string;
  /**
   * What Nexus needs to decide whether this step may run.
   *
   * All optional, and absent means "no constraint" rather than "unknown" —
   * which is the right default here and NOT the right default inside Nexus.
   * Nexus distinguishes `false` from `null` on a validation because there the
   * question has been asked; a step that never declares a validation has not
   * asked, and gating on a question nobody posed would stop every existing
   * workflow.
   */
  readonly dependsOn?: CandidateStep["dependsOn"];
  /** Maps this step to a named operation, checked against the synchronous-only eight. */
  readonly operation?: string;
  readonly asynchronous?: boolean;
  readonly requiresAuthorization?: boolean;
  /**
   * Does the work. Whatever it returns is merged into the workflow context and
   * persisted, so a resumed run can skip it rather than repeat it.
   */
  run(ctx: WorkflowStepContext): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  /**
   * Undoes it, if it needs undoing.
   *
   * Absent means nothing to undo — which is the common case and should not be
   * dressed up as an empty function. Only steps with real external effects
   * (a job created, stock reserved) need one.
   */
  compensate?(ctx: WorkflowStepContext): Promise<void> | void;
}

export interface WorkflowDefinition {
  readonly workflowType: string;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowRunnerOptions {
  /**
   * The command chamber. Defaulted rather than required, so every existing
   * caller keeps working — but the runner no longer chooses steps itself
   * either way. There is one selector now, and this is it.
   */
  nexus?: PrimeNexus;
  store: WorkflowStateStore;
  /** Identifies this process, so a lease says who holds it. */
  instanceId: string;
  /** How long a claim lasts before another instance may take over. */
  leaseMs?: number;
  now?: () => Date;
  generateId?: () => string;
  /**
   * A pass that ended without completing, because Nexus refused, blocked or
   * is waiting. Distinct from `onStepFailed`: nothing went wrong, the work is
   * simply not permitted to proceed yet.
   */
  onStepBlocked?: (info: {
    workflowId: string;
    outcome: string;
    reason: string;
    evidence: readonly string[];
  }) => void;
  onStepFailed?: (info: { workflowId: string; stepId: string; error: Error; willCompensate: boolean }) => void;
}

export interface StartWorkflowInput {
  definition: WorkflowDefinition;
  tenant?: TenantContext;
  trace?: TraceContext;
  context?: Record<string, unknown>;
  /**
   * Supplied by a caller that may retry. Two starts with the same key produce
   * one workflow — the difference between a customer double-clicking and a
   * shop making two of everything.
   */
  workflowId?: string;
}

const DEFAULT_LEASE_MS = 30_000;

export interface WorkflowRunner {
  start(input: StartWorkflowInput): Promise<WorkflowInstance>;
  /** Continues a workflow this process has claimed. */
  resume(workflowId: string, definition: WorkflowDefinition): Promise<WorkflowInstance>;
  /**
   * Picks up workflows abandoned by a crashed instance. Returns those it
   * actually claimed — another instance may have won the race, which is fine
   * and is why the claim exists.
   */
  recoverAbandoned(definitions: readonly WorkflowDefinition[], limit?: number): Promise<WorkflowInstance[]>;
}

export function createWorkflowRunner(options: WorkflowRunnerOptions): WorkflowRunner {
  const { store, instanceId } = options;
  const nexus = options.nexus ?? createPrimeNexus();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const now = options.now ?? (() => new Date());
  const generateId =
    options.generateId ??
    (() => {
      const g = globalThis as { crypto?: { randomUUID?: () => string } };
      return typeof g.crypto?.randomUUID === "function"
        ? `wf_${g.crypto.randomUUID()}`
        : `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const stepRecord = (instance: WorkflowInstance, stepId: string): WorkflowStepRecord | undefined =>
    instance.steps.find((s) => s.stepId === stepId);

  /**
   * The execution context Nexus decides against, derived from the instance.
   *
   * Derived, never accepted from a caller — the same rule Pulse applies to
   * scope keys. A workflow that could be handed a context claiming a different
   * tenant would be a workflow whose authorization is whatever the last caller
   * said it was.
   *
   * `authorizationRef` is read from the workflow's own accumulated context,
   * which is where a step that obtained an authorization puts it. Absent is a
   * real answer: Nexus blocks a step that requires one.
   */
  const executionContextFor = (
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
  ): PrimeExecutionContext => {
    const authorizationRef = instance.context["authorizationRef"];
    return primeExecutionContextSchema.parse({
      executionId: instance.workflowId,
      workflowType: definition.workflowType,
      ...(instance.tenant ? { tenant: instance.tenant } : { systemScoped: true }),
      actor: { kind: "system", id: instanceId },
      ...(typeof authorizationRef === "string" ? { authorizationRef } : {}),
      trace: instance.trace,
    });
  };

  async function persist(instance: WorkflowInstance, expectedVersion: number): Promise<WorkflowInstance> {
    const next = { ...instance, version: expectedVersion + 1, updatedAt: now().toISOString() };
    await store.save(next, expectedVersion);
    return next;
  }

  /**
   * Runs from wherever the instance currently is.
   *
   * Completed steps are skipped rather than repeated — that is the whole
   * benefit of persisting each step's output, and the difference between
   * resuming a workflow and starting it again.
   */
  async function advance(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
  ): Promise<WorkflowInstance> {
    let current = instance;

    // ── Nexus chooses. The runner executes. ──────────────────────────────
    //
    // This loop used to iterate `definition.steps` and skip completed ones,
    // which meant the runner was its own sequencer and Prime Nexus was a
    // second one that nothing called. Two sequencers with one set of rules
    // between them is how the rules stop applying.
    //
    // Now the runner asks which step is next and does what it is told. A
    // refusal, a block, or a wait ends the pass — the runner does not look for
    // something else it could run instead, because choosing a different step
    // than the authorized one is choosing a different workflow.
    for (;;) {
      const completedStepIds = current.steps
        .filter((r) => r.status === "completed")
        .map((r) => r.stepId);

      const candidates: CandidateStep[] = definition.steps.map((step) => ({
        stepId: step.stepId,
        ...(step.dependsOn ? { dependsOn: step.dependsOn } : {}),
        ...(step.operation !== undefined ? { operation: step.operation } : {}),
        ...(step.asynchronous !== undefined ? { asynchronous: step.asynchronous } : {}),
        ...(step.requiresAuthorization !== undefined
          ? { requiresAuthorization: step.requiresAuthorization }
          : {}),
      }));

      const decision = nexus.next({
        context: executionContextFor(current, definition),
        steps: candidates,
        completedStepIds,
      });

      if (decision.outcome === "completed") break;

      if (decision.outcome !== "proceed") {
        // Blocked, waiting or refused. The workflow stays where it is, with
        // the reason recorded, rather than being marked failed — none of these
        // is a failure, and compensating a workflow that is merely waiting
        // would undo work that is still wanted.
        options.onStepBlocked?.({
          workflowId: current.workflowId,
          outcome: decision.outcome,
          reason: decision.reason,
          evidence: decision.evidence,
        });
        return persist(
          { ...current, context: { ...current.context, nexusOutcome: decision.outcome, nexusReason: decision.reason } },
          current.version,
        );
      }

      const step = definition.steps.find((s) => s.stepId === decision.stepId);
      if (!step) {
        throw new Error(
          `Nexus selected step ${decision.stepId}, which is not in workflow ${definition.workflowType}.`,
        );
      }
      const record = stepRecord(current, step.stepId);

      const ctx: WorkflowStepContext = {
        context: current.context,
        workflowId: current.workflowId,
        ...(current.tenant ? { tenant: current.tenant } : {}),
        trace: current.trace,
      };

      const startedAt = now().toISOString();
      try {
        const output = await step.run(ctx);
        const merged = output && typeof output === "object" ? { ...current.context, ...output } : current.context;
        current = await persist(
          {
            ...current,
            context: merged,
            steps: upsertStep(current.steps, {
              stepId: step.stepId,
              status: "completed",
              attempts: (record?.attempts ?? 0) + 1,
              startedAt,
              completedAt: now().toISOString(),
              ...(output && typeof output === "object" ? { output } : {}),
            }),
          },
          current.version,
        );
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        // A conflict means another instance is working on this. Back off
        // rather than compensating — nothing is wrong, we simply lost a race.
        if (error instanceof WorkflowConflictError) throw error;

        options.onStepFailed?.({
          workflowId: current.workflowId,
          stepId: step.stepId,
          error,
          willCompensate: true,
        });

        current = await persist(
          {
            ...current,
            steps: upsertStep(current.steps, {
              stepId: step.stepId,
              status: "failed",
              attempts: (record?.attempts ?? 0) + 1,
              startedAt,
              error: error.message,
            }),
          },
          current.version,
        );

        return compensate(current, definition, error);
      }
    }

    return persist(
      {
        ...current,
        status: "completed",
        completedAt: now().toISOString(),
        ...(current.claimedBy ? { claimedBy: undefined, claimedUntil: undefined } : {}),
      },
      current.version,
    );
  }

  /**
   * Unwinds completed steps in reverse.
   *
   * Steps without a compensation are left alone deliberately. A generated plan
   * and a calculated cost are still true and still useful after a later step
   * failed; deleting them would destroy work to tidy up a status field.
   */
  async function compensate(
    instance: WorkflowInstance,
    definition: WorkflowDefinition,
    cause: Error,
  ): Promise<WorkflowInstance> {
    let current = instance;
    const completed = [...definition.steps]
      .reverse()
      .filter((s) => stepRecord(current, s.stepId)?.status === "completed");

    for (const step of completed) {
      if (!step.compensate) continue;
      const ctx: WorkflowStepContext = {
        context: current.context,
        workflowId: current.workflowId,
        ...(current.tenant ? { tenant: current.tenant } : {}),
        trace: current.trace,
      };
      try {
        await step.compensate(ctx);
        current = await persist(
          {
            ...current,
            steps: upsertStep(current.steps, {
              ...stepRecord(current, step.stepId)!,
              status: "compensated",
            }),
          },
          current.version,
        );
      } catch (compensationCause) {
        // Compensation failing is the genuinely bad case: the workflow is now
        // in a state nobody chose. It stops here and says so, rather than
        // continuing to unwind on top of a broken undo.
        const compError =
          compensationCause instanceof Error ? compensationCause : new Error(String(compensationCause));
        return persist(
          {
            ...current,
            status: "failed",
            completedAt: now().toISOString(),
            failureReason:
              `${cause.message} — and compensation for "${step.stepId}" also failed: ${compError.message}. ` +
              `This workflow needs a human.`,
          },
          current.version,
        );
      }
    }

    return persist(
      {
        ...current,
        status: "compensated",
        completedAt: now().toISOString(),
        failureReason: cause.message,
        ...(current.claimedBy ? { claimedBy: undefined, claimedUntil: undefined } : {}),
      },
      current.version,
    );
  }

  return {
    async start(input) {
      const timestamp = now().toISOString();
      const workflowId = input.workflowId ?? generateId();

      const existing = await store.load(workflowId);
      // An idempotency key that has already been used returns the original
      // rather than starting a second one.
      if (existing) return existing;

      const instance: WorkflowInstance = {
        workflowId,
        workflowType: input.definition.workflowType,
        status: "running",
        ...(input.tenant ? { tenant: input.tenant } : {}),
        trace: input.trace ?? { correlationId: newCorrelationId() },
        context: input.context ?? {},
        steps: [],
        version: 0,
        claimedBy: instanceId,
        claimedUntil: new Date(now().getTime() + leaseMs).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await store.create(instance);
      return advance(instance, input.definition);
    },

    async resume(workflowId, definition) {
      const claimed = await store.claim(workflowId, instanceId, leaseMs);
      if (!claimed) {
        throw new Error(
          `Workflow ${workflowId} is claimed by another instance. This is normal under ` +
            `concurrency — let the holder finish rather than forcing it.`,
        );
      }
      if (claimed.status !== "running") return claimed;
      return advance(claimed, definition);
    },

    async recoverAbandoned(definitions, limit = 10) {
      const byType = new Map(definitions.map((d) => [d.workflowType, d]));
      const candidates = await store.listResumable(limit);
      const recovered: WorkflowInstance[] = [];

      for (const candidate of candidates) {
        const definition = byType.get(candidate.workflowType);
        if (!definition) continue;
        const claimed = await store.claim(candidate.workflowId, instanceId, leaseMs);
        // Another instance got there first. Not an error — it is the lease
        // doing exactly what it exists for.
        if (!claimed) continue;
        try {
          recovered.push(await advance(claimed, definition));
        } catch (cause) {
          if (cause instanceof WorkflowConflictError || isTransient(cause)) continue;
          throw cause;
        }
      }
      return recovered;
    },
  };
}

function upsertStep(
  steps: readonly WorkflowStepRecord[],
  record: WorkflowStepRecord,
): WorkflowStepRecord[] {
  const index = steps.findIndex((s) => s.stepId === record.stepId);
  if (index === -1) return [...steps, record];
  const next = [...steps];
  next[index] = record;
  return next;
}
