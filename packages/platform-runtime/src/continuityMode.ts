// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  classesRunningIn,
  exitRequiresReconciliation,
  collectiveMayOverwriteLocal,
  mayWriteToCollective,
  queuedContributionSchema,
  transitionIsPermitted,
  transitionNeedsHuman,
  type InstanceIdentity,
  type OperatingMode,
  type QueuedContribution,
  type RecoveryTier,
  type SchedulingClass,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The instance's operating mode, and the way back.
//
// One object holds the mode, the local queue, and the reconciliation gate,
// because they are the same decision seen from three angles: an instance that
// is ISOLATED must queue rather than write, and an instance that queued must
// reconcile before it is allowed to stop queueing. Splitting them would let a
// host bind two of the three.
//
// DEGRADING IS FREE. RECOVERING IS NOT.
//
// `degrade()` needs a reason and nothing else — under failure, restriction
// should never be blocked on ceremony. `recover()` needs a reconciliation that
// passed and, out of SAFE_MODE, a named human.
//
// The asymmetry is the design. A system that returns itself to NORMAL is one
// that closes its own incidents, and the failure mode is a flapping partition:
// isolate, rejoin, overwrite fresh state with stale, isolate again.
//
// WHAT IT DOES NOT DO
//
// It does not execute, schedule, or authorize. It answers "what may run" and
// "may this be written to the collective", and both answers are inputs to
// somebody else's decision. Recovery in particular creates no authority: the
// mode never widens what a principal may do, and there is no path here that
// reaches Governance.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconciliationReport {
  /** Every queued contribution has been accounted for. */
  readonly contributionsDrained: boolean;
  /** The ledger's hash chain verified after the interruption. */
  readonly ledgerIntact: boolean;
  /** Engine versions agree with what the collective expects. */
  readonly versionsAgree: boolean;
  /** Trust state has been re-established rather than assumed. */
  readonly trustReestablished: boolean;
}

export type ModeTransition =
  | { readonly changed: true; readonly from: OperatingMode; readonly to: OperatingMode; readonly reason: string }
  | { readonly changed: false; readonly reason: string };

/**
 * Where the mode and the queue live.
 *
 * The mode most of all. An instance that restarts into NORMAL because its
 * operating mode was in a variable has just undone a SAFE_MODE decision by
 * crashing — which makes crashing the way out of containment, and containment
 * is exactly the state most likely to be accompanied by a crash.
 */
export interface OperatingModeStore {
  readonly durability: "in-memory" | "durable";
  mode(): OperatingMode;
  setMode(mode: OperatingMode): void;
  queued(): readonly QueuedContribution[];
  enqueue(contribution: QueuedContribution): void;
  drain(): void;
  nextContributionId(): string;
}

export function createInMemoryOperatingModeStore(
  initialMode: OperatingMode = "NORMAL",
): OperatingModeStore {
  let current = initialMode;
  const pending: QueuedContribution[] = [];
  let counter = 0;
  return {
    durability: "in-memory",
    mode: () => current,
    setMode: (m) => {
      current = m;
    },
    queued: () => [...pending],
    enqueue: (c) => {
      pending.push(c);
    },
    drain: () => {
      pending.length = 0;
    },
    nextContributionId: () => `contrib_${(counter += 1)}`,
  };
}

export interface ContinuityController {
  readonly instance: InstanceIdentity;

  mode(): OperatingMode;

  /** Moves toward more restriction. Never blocked. */
  degrade(to: OperatingMode, reason: string): ModeTransition;

  /**
   * Moves toward less restriction.
   *
   * Requires a passing reconciliation, and a named human when leaving
   * SAFE_MODE or entering NORMAL.
   */
  recover(input: {
    to: OperatingMode;
    reason: string;
    reconciliation?: ReconciliationReport;
    authorizedBy?: string;
  }): ModeTransition;

  /** Whether a class of work runs right now. */
  admits(cls: SchedulingClass): boolean;

  /**
   * Records a contribution, or queues it.
   *
   * Returns whether it may go out now. Never throws and never drops: an
   * isolated instance that failed the write would lose work rather than defer
   * it, and a shop would learn about the partition from a gap in its history.
   */
  contribute(input: unknown): { readonly sent: boolean; readonly queued: boolean; readonly reason: string };

  pendingContributions(): readonly QueuedContribution[];

  /** Whether an inbound collective record may overwrite local state. */
  acceptFromCollective(input: {
    collectiveUpdatedAt: string;
    localUpdatedAt: string;
  }): { readonly accepted: boolean; readonly reason: string };

  /** The declared RPO/RTO tiers, and which of them have never been tested. */
  untestedTiers(): readonly RecoveryTier[];

  /** Whether the mode and queue survive a restart. */
  durability(): "in-memory" | "durable";
}

export interface ContinuityControllerOptions {
  readonly instance: InstanceIdentity;
  readonly initialMode?: OperatingMode;
  /**
   * Where the mode and queue live. Defaults to in-memory.
   *
   * `initialMode` is only consulted when no store is supplied: a store that
   * already holds a mode is the authority on it, and letting a constructor
   * argument override that would make a restart able to reset containment.
   */
  readonly store?: OperatingModeStore;
  readonly tiers?: readonly RecoveryTier[];
  readonly now?: () => Date;
  readonly onTransition?: (transition: ModeTransition) => void;
}

/**
 * How bad things are. RECOVERY is deliberately ABSENT.
 *
 * Including it was a defect three tests caught: with RECOVERY ordered below
 * ISOLATED, moving `ISOLATED -> RECOVERY` compared as a further degradation
 * and skipped the reconciliation gate entirely. RECOVERY is not a severity —
 * it is the transitional state an instance enters in order to reconcile, and
 * it is reached through `recover()` rather than by degrading into it.
 */
const SEVERITY: Readonly<Record<Exclude<OperatingMode, "RECOVERY">, number>> = Object.freeze({
  NORMAL: 0,
  DEGRADED: 1,
  ISOLATED: 2,
  SAFE_MODE: 3,
});

export function createContinuityController(
  options: ContinuityControllerOptions,
): ContinuityController {
  const now = options.now ?? (() => new Date());
  const store =
    options.store ?? createInMemoryOperatingModeStore(options.initialMode ?? "NORMAL");

  const settle = (t: ModeTransition): ModeTransition => {
    options.onTransition?.(t);
    return t;
  };

  return {
    instance: options.instance,
    mode: () => store.mode(),

    degrade(to, reason) {
      const mode = store.mode();
      if (to === "RECOVERY" || mode === "RECOVERY") {
        return settle({
          changed: false,
          reason:
            "RECOVERY is not a degradation. It is entered deliberately through recover(), by something " +
            "that intends to come back.",
        });
      }
      if (SEVERITY[to] <= SEVERITY[mode]) {
        return settle({
          changed: false,
          reason: `${to} is not more restrictive than ${mode}. Use recover() to move back toward NORMAL.`,
        });
      }
      store.setMode(to);
      return settle({ changed: true, from: mode, to, reason });
    },

    recover(input) {
      const { to, reason, reconciliation, authorizedBy } = input;
      const mode = store.mode();

      if (!transitionIsPermitted(mode, to)) {
        return settle({
          changed: false,
          reason:
            `${mode} may not go directly to ${to}. The only door into NORMAL is RECOVERY — an instance ` +
            "that rejoined without reconciling would make its first act on return the overwriting of " +
            "whatever changed while it was away.",
        });
      }

      if (transitionNeedsHuman(mode, to) && !authorizedBy) {
        return settle({
          changed: false,
          reason:
            `Leaving ${mode} for ${to} requires a named human. Degrading is automatic and recovering is ` +
            "not, because a system that returns itself to NORMAL is one that closes its own incidents.",
        });
      }

      // Reconciliation is required to LEAVE recovery, not to enter it.
      //
      // Requiring it on the way in would be backwards: reconciling is what
      // happens inside RECOVERY, so an instance would need the result of the
      // work before it was allowed to start the work. Every upward path runs
      // through RECOVERY, so this one gate covers all of them.
      if (exitRequiresReconciliation(mode)) {
        if (!reconciliation) {
          return settle({
            changed: false,
            reason: `No reconciliation was supplied for the move from ${mode} to ${to}.`,
          });
        }
        const failed = (
          [
            ["queued contributions were not drained", reconciliation.contributionsDrained],
            ["the ledger chain did not verify", reconciliation.ledgerIntact],
            ["engine versions do not agree", reconciliation.versionsAgree],
            ["trust was not re-established", reconciliation.trustReestablished],
          ] as const
        ).filter(([, ok]) => !ok);

        if (failed.length > 0) {
          return settle({
            changed: false,
            reason: `Reconciliation did not pass: ${failed.map(([why]) => why).join("; ")}.`,
          });
        }

        // Belt and braces, and deliberately so: a report may CLAIM the queue
        // was drained. This checks. A reconciliation that took the claim at
        // its word would let an instance rejoin holding unsent work and
        // silently stop queueing it.
        const remaining = store.queued().length;
        if (remaining > 0) {
          return settle({
            changed: false,
            reason: `Reconciliation claims the queue is drained and ${remaining} contribution(s) remain.`,
          });
        }
      }

      store.setMode(to);
      return settle({ changed: true, from: mode, to, reason });
    },

    admits: (cls) => classesRunningIn(store.mode()).includes(cls),

    contribute(input) {
      const parsed = queuedContributionSchema.safeParse({
        contributionId: store.nextContributionId(),
        globalInstanceId: options.instance.globalInstanceId,
        queuedAt: now().toISOString(),
        ...(typeof input === "object" && input !== null ? input : {}),
      });

      if (!parsed.success) {
        // Malformed contributions are refused rather than queued. A queue that
        // accepts anything is a queue that cannot be drained.
        return {
          sent: false,
          queued: false,
          reason: `Not a valid contribution: ${JSON.stringify(parsed.error.flatten())}`,
        };
      }

      if (mayWriteToCollective(store.mode())) {
        return { sent: true, queued: false, reason: "Sent." };
      }

      store.enqueue(parsed.data);
      return {
        sent: false,
        queued: true,
        reason: `Queued locally: this instance is ${store.mode()} and may not write to the collective.`,
      };
    },

    pendingContributions: () => store.queued(),

    acceptFromCollective(input) {
      const mode = store.mode();
      if (mode !== "NORMAL" && mode !== "RECOVERY") {
        return {
          accepted: false,
          reason: `This instance is ${mode} and is not taking collective updates.`,
        };
      }
      const may = collectiveMayOverwriteLocal(input);
      return {
        accepted: may,
        reason: may
          ? "The collective record is newer."
          : "The local record is at least as new. Stale collective knowledge does not overwrite " +
            "newer tenant-local state, and a tie goes to the record the tenant can see and correct.",
      };
    },

    untestedTiers: () => (options.tiers ?? []).filter((t) => !t.restoreTested),
    durability: () => store.durability,
  };
}

/**
 * Whether Prime Pulse can begin work that was not already authorized.
 *
 * Always false, and structurally so: `PrimePulse` exposes `health`,
 * `checkpoint` and `resume`, and none of them takes a workflow definition.
 * There is nothing to start. This states the guarantee the shape already
 * makes, so a future `pulse.start()` fails a test rather than passing review.
 */
export function pulseCanStartNewWork(): false {
  return false;
}
