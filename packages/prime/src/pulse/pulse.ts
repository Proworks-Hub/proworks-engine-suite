// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { WorkflowInstance, WorkflowStateStore } from "@proworks-hub/contracts";

import { scopeKeyOf, type PrimeExecutionContext } from "../context.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRIME PULSE — the continuity chamber.
//
// Pulse keeps ALREADY-AUTHORIZED work alive across a failure. It preserves,
// checkpoints and resumes. It does not decide what work should exist, and it
// does not decide that work may proceed.
//
// THE FAILURE THIS CHAMBER IS SHAPED AROUND
//
// Recovery is where authority quietly gets manufactured. The step failed
// because Governance said no; the retry runs anyway. The mission was
// terminated; recovery resurrects it. The payload was rejected; recovery
// adjusts it until it is accepted. Each of those is a system that has decided,
// during cleanup, that the original answer was negotiable.
//
// So every resume below re-checks the authority it is resuming under, and
// refuses when it has changed. Pulse resumes work; it does not re-permit it.
//
// DURABILITY IS REPORTED, NOT ASSUMED
//
// `durability` is a value on the store, not a comment above it. An in-memory
// adapter that claimed durable recovery would be believed by exactly the code
// that most needs the truth — the code deciding whether it is safe to restart.
// A comment cannot be checked by a test; this can.
// ─────────────────────────────────────────────────────────────────────────────

/** How much a continuity store actually survives. */
export type Durability =
  /** Lost on restart. Correct for development and tests; never a recovery guarantee. */
  | "in-memory"
  /** Survives process restart. */
  | "durable";

/**
 * The continuity port.
 *
 * Deliberately `WorkflowStateStore` plus one honest field rather than a new
 * port. That interface already carries versioned compare-and-set saves, an
 * exclusive `claim` lease, and an `abandoned` listing — which is exactly what
 * overlapping-recovery protection requires. Inventing a second port would have
 * meant two things to keep correct and one of them eventually wrong.
 */
export interface ContinuityStore extends WorkflowStateStore {
  /** What this store survives. Read by Pulse, and told the truth to callers. */
  readonly durability: Durability;
}

export type RecoveryOutcome =
  | "resumed"
  | "refused"
  | "already-recovering"
  | "not-recoverable"
  | "exhausted";

export interface RecoveryVerdict {
  readonly outcome: RecoveryOutcome;
  readonly reason: string;
  readonly instance: WorkflowInstance | null;
  /** False whenever the backing store cannot survive a restart. */
  readonly durable: boolean;
}

export interface PulseHealth {
  readonly chamber: "pulse";
  /**
   * `degraded` whenever continuity is in memory.
   *
   * Not an error — an in-memory store is the right choice in development. It
   * is degraded because the guarantee callers would infer from "healthy" is one
   * this configuration cannot keep.
   */
  readonly state: "healthy" | "degraded";
  readonly durability: Durability;
  readonly detail: string;
}

export interface PrimePulse {
  readonly chamber: "pulse";

  /** Honest health, including whether recovery would actually survive anything. */
  health(): PulseHealth;

  /**
   * Records a checkpoint for authorized work.
   *
   * Refuses a context whose scope does not match the instance's. A checkpoint
   * filed under the wrong tenant is not a bookkeeping error — it is the
   * mechanism by which one tenant's execution later resumes as another's.
   */
  checkpoint(input: {
    context: PrimeExecutionContext;
    instance: WorkflowInstance;
    expectedVersion: number;
  }): Promise<{ ok: boolean; reason: string }>;

  /**
   * Resumes an execution, under the authority it was authorized with.
   *
   * `owner` identifies the recovering instance so the lease can exclude a
   * second one. Two sweeps over the same execution is the duplicate-effect
   * bug, and it is prevented by the store's lease rather than by convention.
   */
  resume(input: {
    context: PrimeExecutionContext;
    workflowId: string;
    owner: string;
    leaseMs?: number;
    /** The authorization the work is being resumed under. Compared, not assumed. */
    authorizationRef?: string;
    /** Whether the failure is retryable at all. */
    retryable?: boolean;
    /** Attempts already made, and the ceiling. */
    attempts?: number;
    maxAttempts?: number;
  }): Promise<RecoveryVerdict>;
}

export interface PrimePulseOptions {
  readonly store: ContinuityStore;
  readonly now?: () => Date;
}

export function createPrimePulse(options: PrimePulseOptions): PrimePulse {
  const { store } = options;
  const durable = store.durability === "durable";

  return {
    chamber: "pulse",

    health() {
      return {
        chamber: "pulse",
        state: durable ? "healthy" : "degraded",
        durability: store.durability,
        detail: durable
          ? "Continuity state survives a restart."
          : "Continuity state is held in memory and is lost on restart. Recovery is available within this " +
            "process only; nothing here survives the process that recorded it.",
      };
    },

    async checkpoint({ context, instance, expectedVersion }) {
      // ── Scope before state ────────────────────────────────────────────
      //
      // Compared before the write, and compared on the DERIVED key rather than
      // on a field the caller supplied. Same discipline as MC-12's tenant gate:
      // the boundary is computed from identity, not accepted from the reader.
      const contextScope = scopeKeyOf(context);
      const instanceScope = instance.tenant
        ? `tenant:${instance.tenant.organizationId}`
        : "system";

      if (contextScope !== instanceScope) {
        return {
          ok: false,
          reason:
            `Refused: the execution context is scoped to ${contextScope} and the workflow instance to ${instanceScope}. ` +
            "A checkpoint filed under the wrong scope is how one tenant's work later resumes as another's.",
        };
      }

      try {
        await store.save(instance, expectedVersion);
        return { ok: true, reason: `Checkpointed ${instance.workflowId} at version ${expectedVersion}.` };
      } catch (error) {
        // A conflict is not a failure to record — it means somebody else moved
        // first, and the caller must reload rather than retry this write.
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async resume(input) {
      const { context, workflowId, owner } = input;

      // ── Retryability, before anything is claimed ──────────────────────
      //
      // Asked first so an irreversible failure never takes a lease. Claiming
      // and then discovering the work must not be retried leaves the execution
      // locked by a recovery that was never going to happen.
      if (input.retryable === false) {
        return {
          outcome: "not-recoverable",
          reason:
            "Refused: the failure is marked non-retryable. Pulse preserves authorized work; it does not " +
            "convert an irreversible failure into retryable work to make recovery succeed.",
          instance: null,
          durable,
        };
      }

      if (
        input.attempts !== undefined &&
        input.maxAttempts !== undefined &&
        input.attempts >= input.maxAttempts
      ) {
        return {
          outcome: "exhausted",
          reason: `Refused: ${input.attempts} of ${input.maxAttempts} attempts already made.`,
          instance: null,
          durable,
        };
      }

      // ── Does it exist at all? ─────────────────────────────────────────
      //
      // Asked before claiming, and asked separately, because `claim` returns
      // null for two completely different situations: somebody else holds the
      // lease, and there is nothing there. Collapsing them told a caller whose
      // in-memory store had just restarted that its lost execution was "already
      // being recovered" — reassuring, and false. A restart loses everything,
      // and the honest answer is that the work is gone.
      const existing = await store.load(workflowId);
      if (!existing) {
        return {
          outcome: "not-recoverable",
          reason: durable
            ? `Refused: no execution ${workflowId} exists to resume.`
            : `Refused: no execution ${workflowId} exists to resume. Continuity is IN-MEMORY, so if this ` +
              "process restarted, the execution was not lost in transit — it was never persisted at all.",
          instance: null,
          durable,
        };
      }

      // ── Scope, checked BEFORE the lease is taken ──────────────────────
      //
      // Deliberately before `claim`. Checking afterwards would let an impostor
      // take a lease on another tenant's execution and hold it for the lease
      // duration — a refusal that still denies the rightful owner their work is
      // not much of a refusal.
      const contextScope = scopeKeyOf(context);
      const instanceScope = existing.tenant ? `tenant:${existing.tenant.organizationId}` : "system";

      if (contextScope !== instanceScope) {
        return {
          outcome: "refused",
          reason:
            `Refused: ${workflowId} belongs to ${instanceScope} and the resuming context is ${contextScope}. ` +
            "Knowing a workflow id is not authority to resume it.",
          instance: null,
          durable,
        };
      }

      // ── The exclusive lease ───────────────────────────────────────────
      //
      // Now that the execution exists and belongs to this caller, `claim`
      // returning null means one thing only: another recovery holds it. That is
      // the overlapping-recovery protection, and it lives in the store because
      // a guarantee depending on every caller remembering is not a guarantee.
      const claimed = await store.claim(workflowId, owner, input.leaseMs ?? 30_000);
      if (!claimed) {
        return {
          outcome: "already-recovering",
          reason:
            `Refused: ${workflowId} is already claimed by another recovery. ` +
            "A second sweep over one execution is how a recovered effect happens twice.",
          instance: null,
          durable,
        };
      }

      // ── The authority it was authorized under ─────────────────────────
      //
      // Recovery is where a refused action gets a second, unexamined chance.
      // If the authorization has changed, the work resuming is not the work
      // that was permitted.
      const recordedAuthorization = (claimed.context as Record<string, unknown>)["authorizationRef"];
      if (
        input.authorizationRef !== undefined &&
        typeof recordedAuthorization === "string" &&
        recordedAuthorization !== input.authorizationRef
      ) {
        return {
          outcome: "refused",
          reason:
            `Refused: ${workflowId} was authorized under ${recordedAuthorization} and resumption offers ` +
            `${input.authorizationRef}. Pulse resumes work under its original authority; it does not re-permit it.`,
          instance: null,
          durable,
        };
      }

      return {
        outcome: "resumed",
        reason: durable
          ? `Resumed ${workflowId} under its original authorization.`
          : `Resumed ${workflowId} under its original authorization, from IN-MEMORY continuity — ` +
            "this state did not survive any restart and must not be reported as if it had.",
        instance: claimed,
        durable,
      };
    },
  };
}
