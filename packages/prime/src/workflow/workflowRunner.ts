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
import {
  WorkflowConflictError,
  createDenyAllGovernance,
  isPermitted,
  isTransient,
  newCorrelationId,
} from "@proworks-hub/contracts";
import type { Governance } from "@proworks-hub/contracts";

import { createPrimeNexus, type CandidateStep, type PrimeNexus } from "../nexus/nexus.js";
import { primeExecutionContextSchema, type PrimeExecutionContext } from "../context.js";
import { createPrimePulse, type ContinuityStore, type PrimePulse } from "../pulse/pulse.js";
import { createEngineRegistry, type EngineOutcome, type EngineRegistry } from "../routing/ports.js";
import { createPrimeEvidence, type PrimeEvidence } from "../evidence/evidence.js";

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
   * Routes this step to a bound capability instead of running a closure.
   *
   * A workflow written this way names WHAT must happen and leaves WHO does it
   * to the host's bindings, which is the difference between a workflow Prime
   * can run for any shop and one compiled against a particular set of engines.
   *
   * `run` remains for steps that are genuinely local. A step that declares
   * both is a definition error and is refused rather than resolved by
   * precedence — picking one silently would make the behaviour depend on which
   * line somebody read first.
   */
  readonly routeTo?: string;
  /**
   * Does the work. Whatever it returns is merged into the workflow context and
   * persisted, so a resumed run can skip it rather than repeat it.
   */
  run?(ctx: WorkflowStepContext): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
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
  /**
   * The continuity chamber, which owns every claim this runner takes.
   *
   * Defaulted from the store when the store states its durability. A store
   * that does not is not a continuity store, and recovery then refuses rather
   * than falling back to an unchecked `store.claim` — the fallback would be
   * the second recovery path this change exists to remove.
   */
  pulse?: PrimePulse;
  /**
   * Capabilities the host has bound engines to.
   *
   * Empty by default, which means every `routeTo` step is refused. That is the
   * correct default: an unconfigured host should not silently run workflows
   * with their engine steps skipped.
   */
  engines?: EngineRegistry;
  /**
   * Where decisions and continuity transitions are recorded.
   *
   * Defaults to a no-op. Writing nothing is a legitimate configuration — a
   * shop without an audit backend still needs to run — but `evidence.enabled`
   * says which it is, so "no records" and "records going nowhere" are
   * distinguishable.
   */
  evidence?: PrimeEvidence;
  /**
   * Governance, consulted before a step that requires authorization.
   *
   * Nexus checks that an `authorizationRef` is PRESENT; it cannot check that
   * it is valid, because `next()` is synchronous and `Governance.authorize` is
   * not — and `authorize` is one of the eight operations that may never be
   * performed asynchronously, so it must be awaited before the step runs.
   *
   * That is the division: Nexus decides on the declared state, and the runner
   * is where the asking happens. Without it, "an authorization reference
   * exists" was silently standing in for "authorization happened", which is
   * the same field-declared-but-unread shape that produced four defects
   * elsewhere in this repository.
   *
   * Defaults to deny-all, so a step that requires authorization is refused
   * until a host binds real Governance.
   */
  governance?: Governance;
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
  /**
   * Resumes one workflow.
   *
   * `context` is optional and matters: supplied, Pulse enforces the caller's
   * tenant scope against the workflow's. Omitted, it is derived from the
   * instance and the scope check is trivially satisfied.
   */
  resume(
    workflowId: string,
    definition: WorkflowDefinition,
    context?: PrimeExecutionContext,
  ): Promise<WorkflowInstance>;
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
  const engines = options.engines ?? createEngineRegistry();
  const evidence = options.evidence ?? createPrimeEvidence();
  const governance = options.governance ?? createDenyAllGovernance();
  // Built from the store when it declares durability. `createInMemoryWorkflowStateStore`
  // does; a host's own store must too, or it does not get recovery.
  const pulse =
    options.pulse ??
    ("durability" in store
      ? createPrimePulse({ store: store as ContinuityStore, ...(options.now ? { now: options.now } : {}) })
      : null);

  const requirePulse = (): PrimePulse => {
    if (!pulse) {
      throw new Error(
        "Recovery needs a continuity chamber. The store supplied to this runner does not state its " +
          "durability, so it is not a ContinuityStore. Supply `pulse`, or a store that says what it survives.",
      );
    }
    return pulse;
  };
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
   * Turns a normalized engine outcome into what this runner does next.
   *
   * Written as one function so the mapping is in a single readable place
   * rather than spread across a switch inside the execution loop. Every arm is
   * a deliberate choice about whether work stops, retries, or is undone:
   *
   *   completed              continue, merging the output
   *   degraded               continue. The work succeeded; a notification did
   *                          not. Failing a manufactured order because an
   *                          email bounced would be the wrong trade — but it
   *                          is recorded, because dropping it silently is how
   *                          nobody finds out.
   *   refused / waiting /    stop where we are. Nothing is compensated,
   *   validation-required    because nothing happened.
   *   retryable-failure      throw. Compensation runs and Pulse may resume.
   *   non-retryable-failure  throw. Compensation runs; Pulse refuses to retry.
   */
  const applyOutcome = (
    outcome: EngineOutcome,
  ): {
    stop: boolean;
    reason: string;
    output?: Record<string, unknown>;
    error?: Error;
  } => {
    switch (outcome.kind) {
      case "completed":
        return { stop: false, reason: "completed", ...(outcome.output ? { output: outcome.output } : {}) };
      case "degraded":
        return {
          stop: false,
          reason: outcome.detail,
          output: { degraded: outcome.detail },
        };
      case "refused":
        return { stop: true, reason: outcome.reason };
      case "waiting":
        return {
          stop: true,
          reason: `Waiting on ${outcome.on}${outcome.detail ? `: ${outcome.detail}` : ""}.`,
        };
      case "validation-required":
        return {
          stop: true,
          reason: `A synchronous validation by ${outcome.validator} must run before this step is judged.`,
        };
      case "retryable-failure":
        return { stop: false, reason: outcome.reason, error: new Error(outcome.reason) };
      case "non-retryable-failure":
        return {
          stop: false,
          reason: outcome.reason,
          // Marked so Pulse refuses it. An irreversible failure retried is one
          // effect happening twice.
          error: Object.assign(new Error(outcome.reason), { retryable: false }),
        };
    }
  };

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

      // Recorded before it is acted on, so a decision that stops the workflow
      // leaves the same trail as one that advances it. Evidence written only
      // on the happy path answers "what worked" and not "what happened".
      await evidence.nexusDecided(decision);

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

      // ── The asking ────────────────────────────────────────────────────
      //
      // Nexus already confirmed a reference is present. This is where it is
      // checked against Governance, and it happens HERE rather than in Nexus
      // because `authorize` is synchronous-only: the answer must be in hand
      // before the step runs, and Nexus cannot await.
      //
      // Only for steps that declare they require it. A workflow of ordinary
      // steps asks Governance nothing, which is correct — Governance decides
      // whether consequential activity is permitted, not whether every
      // function may be called.
      if (step.requiresAuthorization === true) {
        const envelope = {
          requestId: `${current.workflowId}.${step.stepId}`,
          actorId: instanceId,
          tenant: current.tenant ?? { organizationId: "system", roles: [] },
          purpose: `Run step ${step.stepId} of ${definition.workflowType}.`,
          requestedAction: step.routeTo ?? step.stepId,
          delegationChain: [],
          riskClass: "routine" as const,
          trace: current.trace,
          issuedAt: now().toISOString(),
        };

        let permitted = false;
        let refusal = "";
        try {
          const verdict = await governance.authorize(envelope);
          permitted = isPermitted(verdict);
          refusal = `Governance ${verdict.decision}: ${verdict.reason}`;
        } catch (cause) {
          // Unreachable Governance is a refusal. An authorization check that
          // reads "I could not ask" as "yes" fails open exactly when the
          // system is already in trouble.
          refusal = `Governance could not be reached, so nothing is authorized: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        }

        if (!permitted) {
          options.onStepBlocked?.({
            workflowId: current.workflowId,
            outcome: "blocked",
            reason: refusal,
            evidence: [`governance: ${step.stepId}`],
          });
          return persist(
            {
              ...current,
              context: { ...current.context, nexusOutcome: "blocked", nexusReason: refusal },
            },
            current.version,
          );
        }
      }

      const ctx: WorkflowStepContext = {
        context: current.context,
        workflowId: current.workflowId,
        ...(current.tenant ? { tenant: current.tenant } : {}),
        trace: current.trace,
      };

      const startedAt = now().toISOString();
      try {
        // ── Route, or run ────────────────────────────────────────────────
        //
        // A step that declares both is refused. Resolving it by precedence
        // would make the behaviour depend on which line somebody read first,
        // and a workflow whose meaning depends on that is not a contract.
        if (step.routeTo !== undefined && step.run !== undefined) {
          throw new Error(
            `Step ${step.stepId} declares both routeTo and run. It must do exactly one.`,
          );
        }
        if (step.routeTo === undefined && step.run === undefined) {
          throw new Error(`Step ${step.stepId} declares neither routeTo nor run.`);
        }

        let output: Record<string, unknown> | void;

        if (step.routeTo !== undefined) {
          const outcome = await engines.route(step.routeTo, {
            context: executionContextFor(current, definition),
            stepId: step.stepId,
            input: current.context,
          });

          const handled = applyOutcome(outcome);
          if (handled.stop) {
            // Refused, waiting, or a validation is required. The workflow
            // stops where it is and nothing is compensated, because from the
            // workflow's point of view the step did not happen.
            options.onStepBlocked?.({
              workflowId: current.workflowId,
              outcome: outcome.kind,
              reason: handled.reason,
              evidence: [`capability ${step.routeTo}`],
            });
            return persist(
              {
                ...current,
                context: {
                  ...current.context,
                  nexusOutcome: outcome.kind,
                  nexusReason: handled.reason,
                },
              },
              current.version,
            );
          }
          if (handled.error) throw handled.error;
          output = handled.output;
        } else {
          output = await step.run!(ctx);
        }
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

    // ── Every claim goes through Pulse ───────────────────────────────────
    //
    // Both of these used to call `store.claim` directly, which meant the
    // runner had its own recovery path running beside the continuity chamber
    // that was built to own one. Two recovery paths that do not know about
    // each other is worse than one, because the checks each performs are the
    // ones the other is missing.
    //
    // Pulse adds what the raw claim never did: it distinguishes "no such
    // execution" from "somebody else holds it", refuses a resume under an
    // authorization that has changed, and reports honestly whether the state
    // it recovered ever survived anything.
    async resume(workflowId, definition, context) {
      const chamber = requirePulse();
      const existing = await store.load(workflowId);
      if (!existing) throw new Error(`No workflow ${workflowId} to resume.`);

      // A caller may supply its own context, and when it does the scope check
      // is load-bearing: Pulse refuses a resume from the wrong tenant. Derived
      // from the instance it is not — the scopes match by construction. Said
      // plainly rather than counted as protection it does not give.
      const verdict = await chamber.resume({
        context: context ?? executionContextFor(existing, definition),
        workflowId,
        owner: instanceId,
        leaseMs,
      });

      await evidence.pulseTransitioned(
        context ?? executionContextFor(existing, definition),
        workflowId,
        verdict,
      );

      if (verdict.outcome !== "resumed") {
        throw new Error(`Cannot resume ${workflowId}: ${verdict.reason}`);
      }
      const claimed = verdict.instance!;
      if (claimed.status !== "running") return claimed;
      return advance(claimed, definition);
    },

    async recoverAbandoned(definitions, limit = 10) {
      const chamber = requirePulse();
      const byType = new Map(definitions.map((d) => [d.workflowType, d]));
      const candidates = await store.listResumable(limit);
      const recovered: WorkflowInstance[] = [];

      for (const candidate of candidates) {
        const definition = byType.get(candidate.workflowType);
        if (!definition) continue;

        // A sweep acts on behalf of the system, so the context is derived from
        // the candidate and the scope comparison inside Pulse is satisfied by
        // construction. What Pulse still contributes here is the exclusive
        // lease and the authority check — a sweep must not resume work whose
        // authorization changed while it was abandoned.
        const verdict = await chamber.resume({
          context: executionContextFor(candidate, definition),
          workflowId: candidate.workflowId,
          owner: instanceId,
          leaseMs,
        });
        // Recorded whether or not it was recovered. A sweep that skipped an
        // execution is as much a fact as one that resumed it, and the skips
        // are what somebody investigating a stalled workflow needs to see.
        await evidence.pulseTransitioned(
          executionContextFor(candidate, definition),
          candidate.workflowId,
          verdict,
        );

        // Another instance got there first, or the work is not recoverable.
        // Not an error — it is the lease doing exactly what it exists for.
        if (verdict.outcome !== "resumed") continue;

        try {
          recovered.push(await advance(verdict.instance!, definition));
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
