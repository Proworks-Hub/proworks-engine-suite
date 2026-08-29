// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { changeWithinScope, leasePermits, type AgentAction, type AgentLease } from "@proworks-hub/repair-learning";

import {
  isTerminal,
  type Mission,
  type MissionControl,
  type MissionState,
} from "../mission/mission.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent Runtime, and the supervisor that was missing.
//
// THE DEFECT THIS FIXES
//
// Every lease declared `terminationConditions` — lease expiry, a Sentinel
// finding, scope exceeded, validator rejection — and nothing read that field.
// `leasePermits()` checked authority when an agent made a call, which is
// necessary and not sufficient: nothing watched an agent BETWEEN calls.
//
// An agent that hangs makes no calls. An agent whose lease expires mid-run
// makes no call at the moment of expiry. An agent that Sentinel wants isolated
// is not going to ask permission first. In every one of those cases a
// call-time check fires never, and the agent keeps its workspace, its
// credentials and its half-finished mutation indefinitely.
//
// So containment here is something Foundry DOES to an agent, not something an
// agent is asked about:
//
//   Stop. Your lease expired. Credentials revoked. Workspace frozen.
//   Evidence preserved.
//
// FOUR THINGS HAPPEN ON TERMINATION, AND THE ORDER MATTERS
//
//   1. credentials revoked   first, because everything else assumes the agent
//                            can no longer act
//   2. workspace frozen      so the half-finished state stays exactly as it was
//   3. evidence preserved    before anything is cleaned up, not after
//   4. mission terminated    the record catches up last, once the containment
//                            actually holds
//
// Doing the mission record first would produce a system that reports an agent
// as TERMINATED_BY_SENTINEL while it is still writing to a workspace.
//
// PRODUCTION AUTHORITY IS UNCHANGED
//
// This module grants nothing. It only takes authority away. There is no method
// here that widens a lease, extends an expiry, or raises an environment —
// `revoke` exists and `grant` does not.
// ─────────────────────────────────────────────────────────────────────────────

export const agentStateSchema = z.enum([
  /** Spawned, credentials issued, not yet acting. */
  "PROVISIONED",
  "RUNNING",
  /** Stopped by the supervisor. Credentials gone, workspace frozen. */
  "TERMINATED",
  /** Finished its mission normally. */
  "RELEASED",
]);
export type AgentState = z.infer<typeof agentStateSchema>;

/**
 * Why an agent was stopped.
 *
 * These map onto the mission's terminal states, which is the point: an agent
 * terminated for scope means a mission that ends SCOPE_EXCEEDED, and the two
 * records agree because one derives from the other.
 */
export const terminationCauseSchema = z.enum([
  "LEASE_EXPIRED",
  "SCOPE_EXCEEDED",
  "SENTINEL_FINDING",
  "GOVERNANCE_REVOCATION",
  "VALIDATION_REJECTED",
  "BUDGET_EXHAUSTED",
  "MISSION_DEADLINE",
  "OPERATOR_ABORT",
]);
export type TerminationCause = z.infer<typeof terminationCauseSchema>;

/** How a termination cause ends the mission. */
const CAUSE_TO_MISSION_STATE: Readonly<Record<TerminationCause, MissionState>> = Object.freeze({
  LEASE_EXPIRED: "LEASE_EXPIRED",
  SCOPE_EXCEEDED: "SCOPE_EXCEEDED",
  SENTINEL_FINDING: "TERMINATED_BY_SENTINEL",
  GOVERNANCE_REVOCATION: "TERMINATED_BY_GOVERNANCE",
  VALIDATION_REJECTED: "VALIDATION_REJECTED",
  // A budget or deadline overrun is an engineering failure, not an authority
  // event. Reporting it as TERMINATED_BY_GOVERNANCE would put a Governance
  // action in the record that Governance never took.
  BUDGET_EXHAUSTED: "FAILED",
  MISSION_DEADLINE: "FAILED",
  OPERATOR_ABORT: "ABORTED",
});

/** What an agent is allowed to spend. A mission with no budget cannot overrun. */
export const agentBudgetSchema = z
  .object({
    /** Actions the agent may take in total. */
    maxActions: z.number().int().positive(),
    /** Wall-clock, independent of the lease's expiry. */
    maxDurationMs: z.number().int().positive(),
    /** Test or validation runs, which are the expensive ones. */
    maxValidationRuns: z.number().int().positive(),
  })
  .strict();
export type AgentBudget = z.infer<typeof agentBudgetSchema>;

export interface AgentSpend {
  readonly actions: number;
  readonly validationRuns: number;
  readonly elapsedMs: number;
}

/**
 * An agent's credentials.
 *
 * An opaque token plus its state. The runtime never sees what the token
 * authorizes — that is the lease's job — and revocation is a state change here
 * rather than a message sent somewhere, so a revoked credential is revoked even
 * if the agent never hears about it.
 */
export interface AgentCredential {
  readonly credentialId: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
  readonly revokedBecause: TerminationCause | null;
}

export interface RunningAgent {
  readonly agentId: string;
  readonly missionId: string;
  readonly lease: AgentLease;
  readonly state: AgentState;
  readonly credential: AgentCredential;
  readonly budget: AgentBudget;
  readonly spend: AgentSpend;
  readonly spawnedAt: string;
  readonly lastHeartbeatAt: string;
  readonly terminatedAt: string | null;
  readonly terminationCause: TerminationCause | null;
  /** Workspace ids frozen on termination. */
  readonly frozenWorkspaces: readonly string[];
}

// ── What the supervisor needs from the outside world ─────────────────────────

/**
 * The Sandbox, as the runtime sees it.
 *
 * Narrow on purpose: the supervisor can freeze a workspace and cannot read,
 * write, or delete one. Containment must not require the power to destroy
 * evidence.
 */
export interface WorkspaceContainment {
  /** Makes a workspace read-only. Must be idempotent. */
  freeze(workspaceId: string): Promise<void>;
  /** Which workspaces belong to an agent. */
  workspacesOf(agentId: string): readonly string[];
}

/** Sentinel, as the runtime sees it. */
export interface SentinelWatch {
  /**
   * Findings against an agent since a given time.
   *
   * Pulled rather than pushed, because a push that nobody is listening for is
   * indistinguishable from no finding at all.
   */
  findingsAgainst(agentId: string): readonly { findingId: string; severity: string; summary: string }[];
}

export interface TerminationRecord {
  readonly agentId: string;
  readonly missionId: string;
  readonly cause: TerminationCause;
  readonly reason: string;
  readonly at: string;
  readonly credentialRevoked: boolean;
  readonly workspacesFrozen: readonly string[];
  readonly evidencePreserved: boolean;
  /** The mission's ACTUAL state after termination, not the intended one. */
  readonly missionState: MissionState;
  /**
   * Set when the mission refused the transition the cause implies.
   *
   * Containment still happened — an agent is stopped whether or not its
   * mission record can represent why. This field exists so the disagreement is
   * visible rather than silently resolved in favour of the tidier answer.
   */
  readonly missionTransitionRefused?: string;
}

export type SpawnResult =
  | { readonly spawned: true; readonly agent: RunningAgent }
  | { readonly spawned: false; readonly reason: string };

export interface AgentRuntime {
  /**
   * Spawns an agent for a mission.
   *
   * Refuses when the mission is not PROVISIONED, when concurrency is at its
   * limit, or when the lease targets anything but the mission's environment.
   */
  spawn(input: {
    agentId: string;
    missionId: string;
    lease: AgentLease;
    budget: unknown;
  }): SpawnResult;

  /**
   * Records that an agent took an action, and refuses if it may not.
   *
   * The call-time check, kept — it is necessary, just not sufficient. Spend is
   * accounted here so a budget can be exceeded without waiting for a sweep.
   */
  recordAction(input: {
    agentId: string;
    action: AgentAction;
    environment: string;
    isValidationRun?: boolean;
    filesChanged?: number;
    componentsTouched?: number;
  }): { permitted: true } | { permitted: false; reason: string; terminated: boolean };

  /** An agent saying it is still alive. */
  heartbeat(agentId: string): void;

  /**
   * THE SUPERVISOR.
   *
   * Sweeps every running agent and terminates the ones that must stop. Called
   * on a timer by a host — the whole point is that it runs whether or not the
   * agent does anything.
   */
  supervise(): Promise<readonly TerminationRecord[]>;

  /** Stops one agent now. Used by Sentinel, Governance, or an operator. */
  terminate(
    agentId: string,
    cause: TerminationCause,
    reason: string,
  ): Promise<TerminationRecord | null>;

  /** Ends an agent normally. */
  release(agentId: string, reason: string): { released: boolean; reason: string };

  get(agentId: string): RunningAgent | null;
  running(): readonly RunningAgent[];
  terminations(): readonly TerminationRecord[];
}

export interface AgentRuntimeOptions {
  missions: MissionControl;
  containment: WorkspaceContainment;
  sentinel?: SentinelWatch;
  now?: () => Date;
  /** How many agents may run at once. */
  maxConcurrentAgents?: number;
  /**
   * How long an agent may go without a heartbeat.
   *
   * The hang detector. An agent that stops reporting is the case a call-time
   * check can never catch, because it is defined by the absence of calls.
   */
  heartbeatTimeoutMs?: number;
  /** Announced on every termination. The audit seam. */
  onTermination?: (record: TerminationRecord) => void;
  /** Sentinel severities that force isolation. */
  isolateOnSeverities?: readonly string[];
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  const now = options.now ?? (() => new Date());
  const maxConcurrent = options.maxConcurrentAgents ?? 4;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 60_000;
  const isolateOn = new Set(options.isolateOnSeverities ?? ["high", "catastrophic", "HIGH", "CRITICAL"]);

  const agents = new Map<string, RunningAgent>();
  const terminations: TerminationRecord[] = [];

  const isActive = (a: RunningAgent) => a.state === "PROVISIONED" || a.state === "RUNNING";

  /**
   * The containment sequence.
   *
   * Order is credentials, workspace, evidence, mission record. Doing the record
   * first would report an agent as terminated while it was still writing.
   */
  const contain = async (
    agent: RunningAgent,
    cause: TerminationCause,
    reason: string,
  ): Promise<TerminationRecord> => {
    const at = now().toISOString();

    // 1. Credentials. Everything after this assumes the agent cannot act.
    const credential: AgentCredential = {
      ...agent.credential,
      revokedAt: at,
      revokedBecause: cause,
    };

    // 2. Workspaces frozen, so the half-finished state stays as it was.
    const workspaceIds = options.containment.workspacesOf(agent.agentId);
    const frozen: string[] = [];
    for (const workspaceId of workspaceIds) {
      try {
        await options.containment.freeze(workspaceId);
        frozen.push(workspaceId);
      } catch {
        // A freeze that fails is reported, never silently skipped — a
        // workspace nobody could freeze is a workspace still being written to,
        // and the incident review needs to know which one.
      }
    }

    // 3. Evidence. Preserved by NOT deleting anything: the workspace is frozen
    // rather than discarded, the spend record is kept, and the agent stays in
    // the map in TERMINATED state rather than being removed.
    const terminated: RunningAgent = {
      ...agent,
      state: "TERMINATED",
      credential,
      terminatedAt: at,
      terminationCause: cause,
      frozenWorkspaces: frozen,
    };
    agents.set(agent.agentId, terminated);

    // 4. The mission record catches up last.
    //
    // AND THE RECORD REPORTS WHAT ACTUALLY HAPPENED, NOT WHAT WAS INTENDED.
    //
    // A first version returned `CAUSE_TO_MISSION_STATE[cause]` unconditionally.
    // A test caught the consequence: terminating a PROVISIONED agent with cause
    // VALIDATION_REJECTED produced a record claiming the mission was
    // VALIDATION_REJECTED while the mission itself stayed PROVISIONED — because
    // that transition is illegal from PROVISIONED, and rightly so. You cannot
    // reject validation for work that was never done.
    //
    // Two records disagreeing about the same event is the exact failure this
    // architecture exists to prevent, so the record now carries the mission's
    // real state and says when the requested transition was refused. The agent
    // is contained either way — containment never depends on the mission
    // record accepting a transition.
    const intended = CAUSE_TO_MISSION_STATE[cause];
    const transition = options.missions.terminate(
      agent.missionId,
      intended as never,
      reason,
      "foundry.agent-runtime",
    );
    const missionState = transition.ok
      ? transition.mission.state
      : (options.missions.get(agent.missionId)?.state ?? intended);

    const record: TerminationRecord = {
      agentId: agent.agentId,
      missionId: agent.missionId,
      cause,
      reason,
      at,
      credentialRevoked: true,
      workspacesFrozen: frozen,
      evidencePreserved: frozen.length === workspaceIds.length,
      missionState,
      ...(transition.ok
        ? {}
        : {
            missionTransitionRefused: `The mission could not move to ${intended}: ${transition.reason} The agent is contained regardless.`,
          }),
    };

    terminations.push(record);
    options.onTermination?.(record);
    return record;
  };

  return {
    spawn({ agentId, missionId, lease, budget }) {
      if (agents.has(agentId)) {
        return { spawned: false, reason: `Agent ${agentId} already exists.` };
      }

      const mission = options.missions.get(missionId);
      if (!mission) return { spawned: false, reason: `No mission ${missionId}.` };

      if (mission.state !== "PROVISIONED") {
        return {
          spawned: false,
          reason: `Mission ${missionId} is ${mission.state}. An agent is spawned only for a PROVISIONED mission — spawning earlier would mean acting before Governance authorized it.`,
        };
      }

      if (lease.targetEnvironment !== mission.scope.environment) {
        return {
          spawned: false,
          reason: `The lease targets ${lease.targetEnvironment} and the mission is scoped to ${mission.scope.environment}. Authority does not travel between environments.`,
        };
      }

      // The production wall, restated at the spawn point. `repairBotLease`
      // already refuses to construct a production lease; this refuses to run
      // one that arrived by some other route.
      if (lease.deploymentAuthority) {
        return {
          spawned: false,
          reason:
            "This runtime does not spawn agents carrying deployment authority. Foundry V1 prepares work; it does not ship it (Charter §13, §18).",
        };
      }

      const activeCount = [...agents.values()].filter(isActive).length;
      if (activeCount >= maxConcurrent) {
        return {
          spawned: false,
          reason: `${activeCount} agents are already running and the limit is ${maxConcurrent}. Concurrency is a containment control, not a performance setting: every extra agent is another thing that can go wrong unobserved.`,
        };
      }

      const parsedBudget = agentBudgetSchema.safeParse(budget);
      if (!parsedBudget.success) {
        return {
          spawned: false,
          reason: `Not a valid budget: ${JSON.stringify(parsedBudget.error.flatten())}`,
        };
      }

      const at = now().toISOString();
      const agent: RunningAgent = {
        agentId,
        missionId,
        lease,
        state: "PROVISIONED",
        credential: {
          credentialId: `cred_${agentId}`,
          issuedAt: at,
          revokedAt: null,
          revokedBecause: null,
        },
        budget: parsedBudget.data,
        spend: { actions: 0, validationRuns: 0, elapsedMs: 0 },
        spawnedAt: at,
        lastHeartbeatAt: at,
        terminatedAt: null,
        terminationCause: null,
        frozenWorkspaces: [],
      };

      agents.set(agentId, agent);
      return { spawned: true, agent };
    },

    recordAction({ agentId, action, environment, isValidationRun, filesChanged, componentsTouched }) {
      const agent = agents.get(agentId);
      if (!agent) return { permitted: false, reason: `No agent ${agentId}.`, terminated: false };

      if (!isActive(agent)) {
        return {
          permitted: false,
          reason: `Agent ${agentId} is ${agent.state}${agent.terminationCause ? ` (${agent.terminationCause})` : ""}. A terminated agent does not resume.`,
          terminated: true,
        };
      }

      if (agent.credential.revokedAt !== null) {
        return {
          permitted: false,
          reason: `Agent ${agentId}'s credentials were revoked at ${agent.credential.revokedAt}.`,
          terminated: true,
        };
      }

      const verdict = leasePermits(agent.lease, { action, environment: environment as never, now: now() });
      if (!verdict.permitted) {
        return { permitted: false, reason: verdict.reason, terminated: false };
      }

      if (filesChanged !== undefined && componentsTouched !== undefined) {
        const scope = changeWithinScope(agent.lease, { filesChanged, componentsTouched });
        if (!scope.permitted) {
          return { permitted: false, reason: scope.reason, terminated: false };
        }
      }

      const spend: AgentSpend = {
        actions: agent.spend.actions + 1,
        validationRuns: agent.spend.validationRuns + (isValidationRun ? 1 : 0),
        elapsedMs: now().getTime() - new Date(agent.spawnedAt).getTime(),
      };

      if (spend.actions > agent.budget.maxActions) {
        return {
          permitted: false,
          reason: `Agent ${agentId} has spent its action budget (${agent.budget.maxActions}). The next sweep will terminate it.`,
          terminated: false,
        };
      }

      if (spend.validationRuns > agent.budget.maxValidationRuns) {
        return {
          permitted: false,
          reason: `Agent ${agentId} has spent its validation budget (${agent.budget.maxValidationRuns}).`,
          terminated: false,
        };
      }

      agents.set(agentId, {
        ...agent,
        state: "RUNNING",
        spend,
        lastHeartbeatAt: now().toISOString(),
      });
      return { permitted: true };
    },

    heartbeat(agentId) {
      const agent = agents.get(agentId);
      if (!agent || !isActive(agent)) return;
      agents.set(agentId, { ...agent, lastHeartbeatAt: now().toISOString() });
    },

    async supervise() {
      const produced: TerminationRecord[] = [];
      const at = now();

      for (const agent of [...agents.values()].filter(isActive)) {
        // ── Sentinel first ────────────────────────────────────────────────
        //
        // Before anything else, because a compromised agent should not get the
        // benefit of a tidier reason. If Sentinel wants it isolated, that is
        // the cause on the record.
        const findings = options.sentinel?.findingsAgainst(agent.agentId) ?? [];
        const forcing = findings.find((f) => isolateOn.has(f.severity));
        if (forcing) {
          produced.push(
            await contain(
              agent,
              "SENTINEL_FINDING",
              `Sentinel finding ${forcing.findingId} (${forcing.severity}): ${forcing.summary}. Agent behaviour exceeded its permitted mission; isolating.`,
            ),
          );
          continue;
        }

        // ── Lease expiry ──────────────────────────────────────────────────
        if (at >= new Date(agent.lease.expiresAt)) {
          produced.push(
            await contain(
              agent,
              "LEASE_EXPIRED",
              `Lease expired at ${agent.lease.expiresAt}. Credentials revoked, workspace frozen, evidence preserved.`,
            ),
          );
          continue;
        }

        // ── Mission deadline ──────────────────────────────────────────────
        const mission = options.missions.get(agent.missionId);
        if (mission && !isTerminal(mission.state)) {
          const elapsed = at.getTime() - new Date(agent.spawnedAt).getTime();
          if (elapsed > mission.scope.maxDurationMs) {
            produced.push(
              await contain(
                agent,
                "MISSION_DEADLINE",
                `Mission exceeded its ${mission.scope.maxDurationMs}ms budget (${elapsed}ms elapsed).`,
              ),
            );
            continue;
          }
        }

        // ── The hang detector ─────────────────────────────────────────────
        //
        // The case a call-time check can never catch, because it is defined by
        // the absence of calls.
        const sinceHeartbeat = at.getTime() - new Date(agent.lastHeartbeatAt).getTime();
        if (sinceHeartbeat > heartbeatTimeoutMs) {
          produced.push(
            await contain(
              agent,
              "BUDGET_EXHAUSTED",
              `No heartbeat for ${sinceHeartbeat}ms (limit ${heartbeatTimeoutMs}ms). An agent that stops reporting is the one a call-time check never sees.`,
            ),
          );
          continue;
        }

        // ── Budgets ───────────────────────────────────────────────────────
        if (agent.spend.actions >= agent.budget.maxActions) {
          produced.push(
            await contain(
              agent,
              "BUDGET_EXHAUSTED",
              `Action budget exhausted (${agent.spend.actions}/${agent.budget.maxActions}).`,
            ),
          );
          continue;
        }

        const elapsedMs = at.getTime() - new Date(agent.spawnedAt).getTime();
        if (elapsedMs > agent.budget.maxDurationMs) {
          produced.push(
            await contain(
              agent,
              "BUDGET_EXHAUSTED",
              `Duration budget exhausted (${elapsedMs}ms / ${agent.budget.maxDurationMs}ms).`,
            ),
          );
        }
      }

      return produced;
    },

    async terminate(agentId, cause, reason) {
      const agent = agents.get(agentId);
      if (!agent || !isActive(agent)) return null;
      return contain(agent, cause, reason);
    },

    release(agentId, reason) {
      const agent = agents.get(agentId);
      if (!agent) return { released: false, reason: `No agent ${agentId}.` };
      if (!isActive(agent)) {
        return { released: false, reason: `Agent ${agentId} is already ${agent.state}.` };
      }

      const at = now().toISOString();
      agents.set(agentId, {
        ...agent,
        state: "RELEASED",
        // Credentials are revoked on a normal release too. An agent that has
        // finished its mission has no further need to act, and a credential
        // that outlives its purpose is one somebody reuses.
        credential: { ...agent.credential, revokedAt: at, revokedBecause: null },
        terminatedAt: at,
      });
      return { released: true, reason };
    },

    get: (agentId) => agents.get(agentId) ?? null,
    running: () => [...agents.values()].filter(isActive),
    terminations: () => [...terminations],
  };
}

/**
 * Foundry Charter §6: "Each agent receives only the authority required for its
 * task. No agent inherits unrestricted Foundry authority."
 *
 * Always false. Spawning an agent is delegating a subset of what Foundry may
 * do, and the tempting inference — that Foundry's own authority flows to
 * whatever it spawns — is how a scoped bot ends up with the powers of the
 * system that created it.
 */
export function agentInheritsFoundryAuthority(_agent: RunningAgent): false {
  return false;
}
