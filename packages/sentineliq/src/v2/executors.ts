// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ActionRung, ContainmentAction } from "./actions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Containment executor adapters — directive §23 (DEC-028 increment 4).
//
// "Sentinel may request/trigger only chartered containment. EXECUTION BELONGS
// TO APPROPRIATE MECHANISMS: Security IQ, Neural Fabric, identity/security
// provider, host EDR, host firewall, sandbox controller, host adapter."
//
// So this module contains ports and a dispatcher, and NO executor. There is
// no function here that isolates a workload, revokes a credential or changes
// a route. Sentinel hands a chartered request to the mechanism owner and
// records what came back — including "nobody can do this", which is a real
// and important answer.
//
// THE FOUR PROPERTIES, each mutation-proven:
//
// 1. NO EXECUTOR IS SENTINEL. The executor vocabulary excludes it by type,
//    and a guard sweeps the source for a sentinel-executed path.
//
// 2. AN UNBOUND EXECUTOR IS A REFUSAL, NOT A SUCCESS. If nothing can carry
//    out a quarantine, the incident learns that the quarantine did NOT
//    happen. A containment believed-applied but never executed is worse than
//    no containment, because the response stops there.
//
// 3. EXECUTION IS IDEMPOTENT BY REQUEST ID. A retried request does not
//    double-apply, and a second attempt returns the first outcome.
//
// 4. EVERY OUTCOME CARRIES RESTORATION CRITERIA. §23 requires blast-radius
//    estimate and restoration criteria; an action nobody knows how to undo
//    is a permanent change made in an emergency.
// ─────────────────────────────────────────────────────────────────────────────

export const EXECUTORS = ["security-iq", "fabric", "host-adapter"] as const;
export type Executor = (typeof EXECUTORS)[number];

/** Which executor can carry which rung. A rung with no capable executor is
 * unexecutable in this deployment, and that is reported rather than hidden. */
export const RUNG_CAPABILITY: Readonly<Record<Exclude<ActionRung, "escalate">, readonly Executor[]>> = {
  observe: [],
  challenge: ["security-iq"],
  throttle: ["fabric", "host-adapter"],
  segment: ["fabric"],
  quarantine: ["fabric", "host-adapter"],
  revoke: ["security-iq"],
  recover: ["security-iq", "host-adapter"],
};

export interface ExecutionOutcome {
  readonly actionId: string;
  readonly executor: Executor;
  readonly applied: boolean;
  readonly detail: string;
  /** §23: how to undo it, and by when it lapses on its own. */
  readonly restorationCriteria: string;
  readonly expiresAt: string | null;
  readonly blastRadiusEstimate: string;
}

/** The port every mechanism owner implements. Sentinel calls it; it never
 * implements it. */
export interface ContainmentExecutorPort {
  readonly executor: Executor;
  /** Which rungs this binding can actually carry out right now. */
  readonly supportedRungs: readonly ActionRung[];
  apply(action: ContainmentAction): ExecutionOutcome;
  /** Undo. Present on the port because an action with no reverse is not
   * bounded, and §23 requires bounded actions. */
  release(actionId: string, reason: string): { released: boolean; detail: string };
}

export type DispatchResult =
  | { readonly state: "executed"; readonly outcome: ExecutionOutcome }
  | { readonly state: "already-applied"; readonly outcome: ExecutionOutcome }
  | {
      /** Nothing bound can carry this rung. The incident MUST learn this. */
      readonly state: "unexecutable";
      readonly rung: ActionRung;
      readonly reason: string;
      readonly capableExecutors: readonly Executor[];
      readonly boundExecutors: readonly Executor[];
    }
  | { readonly state: "refused-by-executor"; readonly executor: Executor; readonly detail: string };

export interface ExecutionLedger {
  readonly outcomes: ReadonlyMap<string, ExecutionOutcome>;
}

export const emptyLedger = (): ExecutionLedger => ({ outcomes: new Map() });

/**
 * Dispatch a chartered containment action to a bound executor.
 *
 * Selection is by declared capability, then by the order the host bound them
 * — deterministic, never "whichever answered first", because a containment
 * that lands on a different mechanism each time is not reproducible after an
 * incident.
 */
export function dispatchContainment(
  action: ContainmentAction,
  ports: readonly ContainmentExecutorPort[],
  ledger: ExecutionLedger,
): { result: DispatchResult; ledger: ExecutionLedger } {
  const existing = ledger.outcomes.get(action.actionId);
  if (existing !== undefined) {
    // Idempotent: a retry returns the first outcome and applies nothing.
    return { result: { state: "already-applied", outcome: existing }, ledger };
  }
  const capable = RUNG_CAPABILITY[action.rung as Exclude<ActionRung, "escalate">] ?? [];
  const bound = ports.filter((p) => capable.includes(p.executor) && p.supportedRungs.includes(action.rung));
  if (bound.length === 0) {
    return {
      result: {
        state: "unexecutable",
        rung: action.rung,
        reason:
          capable.length === 0
            ? `No executor class can carry "${action.rung}" — it is not a mechanism action.`
            : `No bound executor supports "${action.rung}". The containment did NOT happen; a believed-applied containment is worse than none.`,
        capableExecutors: capable,
        boundExecutors: ports.map((p) => p.executor),
      },
      ledger,
    };
  }
  const port = bound[0]!;
  const outcome = port.apply(action);
  if (!outcome.applied) {
    return { result: { state: "refused-by-executor", executor: port.executor, detail: outcome.detail }, ledger };
  }
  const next = new Map(ledger.outcomes);
  next.set(action.actionId, outcome);
  return { result: { state: "executed", outcome }, ledger: { outcomes: next } };
}

/** Release. An action that cannot be released is reported as such — the
 * operator learns the containment is standing, rather than believing it
 * lifted. */
export function releaseContainment(
  actionId: string,
  reason: string,
  ports: readonly ContainmentExecutorPort[],
  ledger: ExecutionLedger,
): { released: boolean; detail: string; ledger: ExecutionLedger } {
  const outcome = ledger.outcomes.get(actionId);
  if (outcome === undefined) return { released: false, detail: `No recorded execution for ${actionId}.`, ledger };
  const port = ports.find((p) => p.executor === outcome.executor);
  if (port === undefined) {
    return {
      released: false,
      detail: `Executor ${outcome.executor} is no longer bound; the containment is STILL IN FORCE and cannot be lifted from here.`,
      ledger,
    };
  }
  const result = port.release(actionId, reason);
  if (!result.released) return { released: false, detail: result.detail, ledger };
  const next = new Map(ledger.outcomes);
  next.delete(actionId);
  return { released: true, detail: result.detail, ledger: { outcomes: next } };
}

/** Which containments are standing, so an operator can see what the Hive is
 * currently doing to itself. */
export function standingContainments(ledger: ExecutionLedger): readonly ExecutionOutcome[] {
  return [...ledger.outcomes.values()].sort((a, b) => (a.actionId < b.actionId ? -1 : 1));
}

/**
 * Expiry sweep against an explicit instant. Returns what SHOULD lapse; it
 * does not lapse anything itself, because releasing is the executor's act.
 */
export function expiredContainments(ledger: ExecutionLedger, asOf: string): readonly ExecutionOutcome[] {
  const now = Date.parse(asOf);
  if (Number.isNaN(now)) return [];
  return standingContainments(ledger).filter((o) => {
    if (o.expiresAt === null) return false;
    const expiry = Date.parse(o.expiresAt);
    return !Number.isNaN(expiry) && expiry <= now;
  });
}
