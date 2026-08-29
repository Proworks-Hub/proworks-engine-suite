// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Mission Control.
//
// A mission is a unit of authorized change: one objective, one scope, one
// lifecycle, owned by Foundry from proposal to completion.
//
// FOUNDRY OWNS THE STATE. THE BOT DOES NOT.
//
// This is the whole point of the module and it shapes every signature below.
// Nothing an agent can call sets a mission state directly — `MissionControl`
// exposes intent methods (`authorize`, `provision`, `begin`, `advance`) that
// validate the transition, and a bot holds no reference to the record it is
// working under.
//
// The alternative — a bot that reports its own state — has a specific failure:
// a misbehaving or hung agent is exactly the one that stops reporting, so the
// state most in need of being accurate is the one least likely to be.
//
// THE LIFECYCLE
//
//   PROPOSED → AUTHORIZED → PROVISIONED → RUNNING → AWAITING_VALIDATION
//                                                          → COMPLETED
//
//   RUNNING carries a phase: INSPECTING, DIAGNOSING, PLANNING, MUTATING,
//   TESTING. The phase is a second axis, not a state — a mission is RUNNING
//   and currently MUTATING, and asking "is it running?" must not require
//   knowing every phase name.
//
//   Terminal, alternate:
//     FAILED  ABORTED  TERMINATED_BY_SENTINEL  TERMINATED_BY_GOVERNANCE
//     LEASE_EXPIRED  SCOPE_EXCEEDED  VALIDATION_REJECTED
//
// WHY SEVEN FAILURE STATES AND NOT ONE
//
// They are seven different things that need seven different responses. FAILED
// is an engineering problem. ABORTED is a human deciding not to continue.
// LEASE_EXPIRED is an authority problem. SCOPE_EXCEEDED is a mission that grew.
// TERMINATED_BY_SENTINEL is a containment event and may indicate compromise.
// VALIDATION_REJECTED means the work was done and was not good enough.
// Collapsing them into `FAILED` would make the incident review start by
// reconstructing which one it was.
// ─────────────────────────────────────────────────────────────────────────────

export const missionStateSchema = z.enum([
  "PROPOSED",
  "AUTHORIZED",
  "PROVISIONED",
  "RUNNING",
  "AWAITING_VALIDATION",
  "COMPLETED",
  "FAILED",
  "ABORTED",
  "TERMINATED_BY_SENTINEL",
  "TERMINATED_BY_GOVERNANCE",
  "LEASE_EXPIRED",
  "SCOPE_EXCEEDED",
  "VALIDATION_REJECTED",
]);
export type MissionState = z.infer<typeof missionStateSchema>;

/** What a RUNNING mission is currently doing. A second axis, not a state. */
export const missionPhaseSchema = z.enum([
  "INSPECTING",
  "DIAGNOSING",
  "PLANNING",
  "MUTATING",
  "TESTING",
]);
export type MissionPhase = z.infer<typeof missionPhaseSchema>;

/** States from which nothing further happens. */
export const TERMINAL_STATES: readonly MissionState[] = Object.freeze([
  "COMPLETED",
  "FAILED",
  "ABORTED",
  "TERMINATED_BY_SENTINEL",
  "TERMINATED_BY_GOVERNANCE",
  "LEASE_EXPIRED",
  "SCOPE_EXCEEDED",
  "VALIDATION_REJECTED",
]);

/** Terminal states that are not success. */
export const FAILURE_STATES: readonly MissionState[] = Object.freeze(
  TERMINAL_STATES.filter((s) => s !== "COMPLETED"),
);

export function isTerminal(state: MissionState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * The legal forward transitions.
 *
 * Declared as data rather than as a switch, so the machine can be inspected,
 * tested exhaustively, and printed. A transition absent here is illegal, which
 * is the safe default: adding a state without deciding what may follow it
 * produces a state nothing can leave, not a state anything can reach.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<MissionState, readonly MissionState[]>> =
  Object.freeze({
    PROPOSED: ["AUTHORIZED", "ABORTED", "TERMINATED_BY_GOVERNANCE"],
    AUTHORIZED: ["PROVISIONED", "ABORTED", "FAILED"],
    PROVISIONED: ["RUNNING", "ABORTED", "FAILED"],
    RUNNING: ["AWAITING_VALIDATION", "FAILED", "ABORTED"],
    AWAITING_VALIDATION: ["COMPLETED", "VALIDATION_REJECTED", "FAILED"],
    COMPLETED: [],
    FAILED: [],
    ABORTED: [],
    TERMINATED_BY_SENTINEL: [],
    TERMINATED_BY_GOVERNANCE: [],
    LEASE_EXPIRED: [],
    SCOPE_EXCEEDED: [],
    VALIDATION_REJECTED: [],
  });

/**
 * States reachable from ANY non-terminal state.
 *
 * Containment and authority events do not wait for a mission to reach a
 * convenient point. A Sentinel isolation that could only fire from RUNNING
 * would be unable to stop a mission that hangs in PROVISIONED, which is
 * precisely where a stuck agent sits.
 */
export const INTERRUPT_STATES: readonly MissionState[] = Object.freeze([
  "TERMINATED_BY_SENTINEL",
  "TERMINATED_BY_GOVERNANCE",
  "LEASE_EXPIRED",
  "SCOPE_EXCEEDED",
]);

export interface TransitionCheck {
  readonly legal: boolean;
  readonly reason: string;
}

export function transitionAllowed(from: MissionState, to: MissionState): TransitionCheck {
  if (isTerminal(from)) {
    return {
      legal: false,
      reason: `${from} is terminal. A mission that ended cannot continue; raise a new mission that references this one.`,
    };
  }
  if (INTERRUPT_STATES.includes(to)) {
    return { legal: true, reason: `${to} may interrupt any non-terminal mission.` };
  }
  if (LEGAL_TRANSITIONS[from].includes(to)) {
    return { legal: true, reason: `${from} → ${to} is a declared transition.` };
  }
  return {
    legal: false,
    reason: `${from} → ${to} is not a legal transition. From ${from} a mission may go to: ${LEGAL_TRANSITIONS[from].join(", ") || "nowhere"}, or be interrupted.`,
  };
}

// ── The mission record ───────────────────────────────────────────────────────

export const missionObjectiveSchema = z
  .object({
    /** Plain-language statement of what this mission is for. */
    statement: z.string().min(1),
    /** The diagnosis or drift finding that motivated it. */
    derivedFrom: z.string().min(1),
    /** What must be true for the mission to have succeeded. */
    successCriteria: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type MissionObjective = z.infer<typeof missionObjectiveSchema>;

export const missionScopeSchema = z
  .object({
    components: z.array(z.string().min(1)).min(1),
    repository: z.string().min(1),
    /**
     * Where the mission runs.
     *
     * SIMULATION or VALIDATION only. Not a policy this module enforces alone —
     * Evolution Control owns the promotion boundary — but stated here so a
     * mission scoped to production cannot be constructed in the first place.
     */
    environment: z.enum(["SIMULATION", "VALIDATION"]),
    maxFiles: z.number().int().positive(),
    maxComponents: z.number().int().positive(),
    /** Wall-clock budget. A mission with no deadline is a mission that hangs. */
    maxDurationMs: z.number().int().positive(),
  })
  .strict();
export type MissionScope = z.infer<typeof missionScopeSchema>;

export const missionTransitionSchema = z
  .object({
    from: missionStateSchema,
    to: missionStateSchema,
    at: z.string().min(1),
    /** Who caused it. Foundry, Sentinel, Governance, a named human. */
    by: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type MissionTransition = z.infer<typeof missionTransitionSchema>;

export interface Mission {
  readonly missionId: string;
  readonly objective: MissionObjective;
  readonly scope: MissionScope;
  readonly state: MissionState;
  /** Present only while RUNNING. */
  readonly phase: MissionPhase | null;
  /** The Governance decision that authorized it. Absent while PROPOSED. */
  readonly governanceDecisionId: string | null;
  /** The agent working it. Absent until PROVISIONED. */
  readonly agentId: string | null;
  readonly proposedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly history: readonly MissionTransition[];
  /** Set on any failure state. Explains which of the seven, and why. */
  readonly failureReason: string | null;
}

export type MissionResult<T> =
  | { readonly ok: true; readonly mission: T }
  | { readonly ok: false; readonly reason: string };

export interface MissionControl {
  propose(input: {
    missionId: string;
    objective: unknown;
    scope: unknown;
  }): MissionResult<Mission>;

  /**
   * PROPOSED → AUTHORIZED.
   *
   * Requires a Governance decision reference. Foundry Charter §11: "Governance
   * determines whether Foundry's proposed actions are authorized... Foundry may
   * propose policy or Charter changes but shall not approve its own authority
   * expansion." A mission cannot authorize itself, so the decision id is
   * required rather than optional.
   */
  authorize(missionId: string, governanceDecisionId: string, by: string): MissionResult<Mission>;

  /** AUTHORIZED → PROVISIONED. Binds the agent that will do the work. */
  provision(missionId: string, agentId: string, by: string): MissionResult<Mission>;

  /** PROVISIONED → RUNNING, in an initial phase. */
  begin(missionId: string, phase: MissionPhase, by: string): MissionResult<Mission>;

  /** Moves the phase within RUNNING. Refuses when the mission is not running. */
  advance(missionId: string, phase: MissionPhase, by: string): MissionResult<Mission>;

  /** RUNNING → AWAITING_VALIDATION. */
  submitForValidation(missionId: string, by: string): MissionResult<Mission>;

  /** AWAITING_VALIDATION → COMPLETED or VALIDATION_REJECTED. */
  concludeValidation(
    missionId: string,
    outcome: { accepted: boolean; reason: string },
    by: string,
  ): MissionResult<Mission>;

  /**
   * Ends a mission in a failure state.
   *
   * One method for all seven, because they are one operation with different
   * causes — and because a separate method per state is how five of them end up
   * implemented and two forgotten.
   */
  terminate(
    missionId: string,
    state: (typeof FAILURE_STATES)[number],
    reason: string,
    by: string,
  ): MissionResult<Mission>;

  get(missionId: string): Mission | null;
  all(): readonly Mission[];
  /** Missions that have not ended. What the supervisor watches. */
  active(): readonly Mission[];
}

export interface MissionControlOptions {
  now?: () => Date;
  /** Announced on every transition. The audit seam. */
  onTransition?: (mission: Mission, transition: MissionTransition) => void;
}

export function createMissionControl(options: MissionControlOptions = {}): MissionControl {
  const now = options.now ?? (() => new Date());
  const missions = new Map<string, Mission>();

  const apply = (
    mission: Mission,
    to: MissionState,
    by: string,
    reason: string,
    extra: Partial<Mission> = {},
  ): MissionResult<Mission> => {
    const check = transitionAllowed(mission.state, to);
    if (!check.legal) return { ok: false, reason: check.reason };

    const at = now().toISOString();
    const transition: MissionTransition = { from: mission.state, to, at, by, reason };

    const updated: Mission = {
      ...mission,
      state: to,
      // The phase is cleared on leaving RUNNING. A mission that is
      // AWAITING_VALIDATION and still claims to be MUTATING is lying about one
      // of the two.
      phase: to === "RUNNING" ? (extra.phase ?? mission.phase) : null,
      history: [...mission.history, transition],
      endedAt: isTerminal(to) ? at : mission.endedAt,
      failureReason: FAILURE_STATES.includes(to) ? reason : mission.failureReason,
      ...extra,
    };

    missions.set(mission.missionId, updated);
    options.onTransition?.(updated, transition);
    return { ok: true, mission: updated };
  };

  const require_ = (missionId: string): Mission | null => missions.get(missionId) ?? null;

  return {
    propose({ missionId, objective, scope }) {
      if (missions.has(missionId)) {
        return { ok: false, reason: `Mission ${missionId} already exists.` };
      }

      const parsedObjective = missionObjectiveSchema.safeParse(objective);
      if (!parsedObjective.success) {
        return {
          ok: false,
          reason: `Not a valid objective: ${JSON.stringify(parsedObjective.error.flatten())}`,
        };
      }

      const parsedScope = missionScopeSchema.safeParse(scope);
      if (!parsedScope.success) {
        return { ok: false, reason: `Not a valid scope: ${JSON.stringify(parsedScope.error.flatten())}` };
      }

      const mission: Mission = {
        missionId,
        objective: parsedObjective.data,
        scope: parsedScope.data,
        state: "PROPOSED",
        phase: null,
        governanceDecisionId: null,
        agentId: null,
        proposedAt: now().toISOString(),
        startedAt: null,
        endedAt: null,
        history: [],
        failureReason: null,
      };

      missions.set(missionId, mission);
      return { ok: true, mission };
    },

    authorize(missionId, governanceDecisionId, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      if (!governanceDecisionId.trim()) {
        return {
          ok: false,
          reason:
            "Authorization requires a Governance decision reference. Foundry may propose but shall not approve its own authority (Charter §11).",
        };
      }
      return apply(mission, "AUTHORIZED", by, `Authorized by ${governanceDecisionId}.`, {
        governanceDecisionId,
      });
    },

    provision(missionId, agentId, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      return apply(mission, "PROVISIONED", by, `Agent ${agentId} provisioned.`, { agentId });
    },

    begin(missionId, phase, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      if (mission.agentId === null) {
        return { ok: false, reason: "A mission cannot begin without a provisioned agent." };
      }
      return apply(mission, "RUNNING", by, `Began in phase ${phase}.`, {
        phase,
        startedAt: now().toISOString(),
      });
    },

    advance(missionId, phase, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      if (mission.state !== "RUNNING") {
        return {
          ok: false,
          reason: `A phase applies only while RUNNING; this mission is ${mission.state}.`,
        };
      }

      const at = now().toISOString();
      const transition: MissionTransition = {
        from: "RUNNING",
        to: "RUNNING",
        at,
        by,
        reason: `Phase ${mission.phase ?? "none"} → ${phase}.`,
      };
      const updated: Mission = { ...mission, phase, history: [...mission.history, transition] };
      missions.set(missionId, updated);
      options.onTransition?.(updated, transition);
      return { ok: true, mission: updated };
    },

    submitForValidation(missionId, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      return apply(mission, "AWAITING_VALIDATION", by, "Work submitted for independent validation.");
    },

    concludeValidation(missionId, outcome, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      return outcome.accepted
        ? apply(mission, "COMPLETED", by, outcome.reason)
        : apply(mission, "VALIDATION_REJECTED", by, outcome.reason);
    },

    terminate(missionId, state, reason, by) {
      const mission = require_(missionId);
      if (!mission) return { ok: false, reason: `No mission ${missionId}.` };
      return apply(mission, state, by, reason);
    },

    get: (missionId) => missions.get(missionId) ?? null,
    all: () => [...missions.values()],
    active: () => [...missions.values()].filter((m) => !isTerminal(m.state)),
  };
}

/**
 * Whether a mission's own success criteria were met.
 *
 * Separate from the state machine on purpose. A mission can reach COMPLETED
 * because validation accepted the change, and still not have achieved what it
 * set out to do — the criteria are the objective's, and checking them is a
 * different question from checking the lifecycle.
 */
export function objectiveMet(
  mission: Mission,
  satisfiedCriteria: readonly string[],
): { met: boolean; unmet: readonly string[] } {
  const satisfied = new Set(satisfiedCriteria);
  const unmet = mission.objective.successCriteria.filter((c) => !satisfied.has(c));
  return { met: unmet.length === 0, unmet };
}
