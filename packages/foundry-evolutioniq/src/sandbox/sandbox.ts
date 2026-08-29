// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createCandidateWorkspace,
  createInMemoryWorkspaceProvider,
  createMechanicalInjector,
  effectOf,
  injectionPermitted,
  isTrustedProduction,
  type AgentLease,
  type CandidateWorkspace,
  type ChangeSet,
  type Environment,
  type FaultPlane,
  type InjectableFault,
  type MechanicalInjector,
  type Sandbox as SandboxClock,
  type WorkspaceProvider,
} from "@proworks-hub/repair-learning";

import type { WorkspaceContainment } from "../agents/runtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox — now the owner of workspaces.
//
// WHY WORKSPACES MOVED
//
// `workspace.ts` sat under `repair/`, next to the RepairBot, which put a
// containment primitive inside the thing being contained. A workspace is where
// an agent's changes are isolated from the trusted baseline — that is an
// isolation concern, and isolation is what the Sandbox is for.
//
// The practical consequence is the one that matters: the supervisor needs to
// FREEZE a workspace when it terminates an agent, and it should not have to
// reach through the agent's own module to do it. Containment that routes
// through the contained thing is not containment.
//
// The primitive itself stays in `repair-learning` — moving the file across
// packages would break every import for no behavioural gain. What moved is
// OWNERSHIP: the Sandbox provisions workspaces, tracks which agent holds which,
// and is the only thing that can freeze one.
//
// FREEZING IS NOT DELETING
//
// A frozen workspace keeps everything. The half-finished mutation, the staged
// changes, the diff — all of it stays exactly as it was at the moment of
// termination, because that state is the evidence. A containment step that
// tidied up would destroy the thing an investigator most needs, and it would do
// so at precisely the moment somebody had decided the agent was misbehaving.
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxWorkspaceRecord {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly missionId: string;
  readonly baseRevision: string;
  readonly frozen: boolean;
  readonly frozenAt: string | null;
  readonly createdAt: string;
}

export type ProvisionResult =
  | { readonly provisioned: true; readonly workspace: CandidateWorkspace }
  | { readonly provisioned: false; readonly reason: string };

export type FrozenStageResult = { readonly staged: false; readonly reason: string };

export interface FoundrySandbox extends WorkspaceContainment {
  readonly environment: Environment;

  /** Provisions a workspace for an agent working a mission. */
  provisionWorkspace(input: {
    workspaceId: string;
    agentId: string;
    missionId: string;
    repairCandidateId: string;
    baseRevision: string;
    lease: AgentLease;
  }): Promise<ProvisionResult>;

  /** The workspace, if it exists and is not frozen. */
  workspace(workspaceId: string): CandidateWorkspace | null;
  record(workspaceId: string): SandboxWorkspaceRecord | null;
  records(): readonly SandboxWorkspaceRecord[];

  /** Back to a known state between runs. Refuses to reset a frozen workspace. */
  reset(workspaceId: string): Promise<{ reset: boolean; reason: string }>;

  /** Discards the changes and returns to the base revision. */
  rollback(workspaceId: string): Promise<{ rolledBack: boolean; reason: string }>;

  /** The change set, readable even when frozen — that is the point of freezing. */
  changeSet(workspaceId: string): ChangeSet | null;

  // ── Fault injection ────────────────────────────────────────────────────────
  injectFault(fault: InjectableFault, authorityEstablishedIn: Environment): Promise<{
    injected: boolean;
    reason: string;
  }>;
  readonly faults: FaultPlane;
  clearFaults(): Promise<void>;

  /** The run clock, injectable so a scenario can move time. */
  clock(): SandboxClock;
}

export interface FoundrySandboxOptions {
  environment: Environment;
  tenantId: string;
  provider?: WorkspaceProvider;
  injector?: MechanicalInjector;
  now?: () => Date;
}

export function createFoundrySandbox(options: FoundrySandboxOptions): FoundrySandbox {
  // A Foundry sandbox is never production. Checked at construction rather than
  // at each call, because the correct time to refuse is before anything exists
  // that could act.
  if (isTrustedProduction(options.environment)) {
    throw new Error(
      "A Foundry sandbox cannot be created for PRODUCTION. Isolation that includes the thing being isolated from is not isolation.",
    );
  }

  const provider = options.provider ?? createInMemoryWorkspaceProvider();
  const injector = options.injector ?? createMechanicalInjector({ ...(options.now ? { now: options.now } : {}) });
  let clockMs = (options.now ?? (() => new Date()))().getTime();
  const now = () => new Date(clockMs);

  const workspaces = new Map<string, CandidateWorkspace>();
  const records = new Map<string, SandboxWorkspaceRecord>();

  const sandboxClock: SandboxClock = {
    environment: options.environment,
    seed: async () => undefined,
    reset: async () => undefined,
    now,
    advanceClock: (ms) => {
      clockMs += ms;
    },
    tenantId: options.tenantId,
  };

  return {
    environment: options.environment,
    faults: injector.plane,

    async provisionWorkspace(input) {
      if (records.has(input.workspaceId)) {
        return { provisioned: false, reason: `Workspace ${input.workspaceId} already exists.` };
      }

      if (input.lease.targetEnvironment !== options.environment) {
        return {
          provisioned: false,
          reason: `The lease targets ${input.lease.targetEnvironment} and this sandbox is ${options.environment}.`,
        };
      }

      const workspace = await createCandidateWorkspace({
        workspaceId: input.workspaceId,
        repairCandidateId: input.repairCandidateId,
        baseRevision: input.baseRevision,
        lease: input.lease,
        provider,
      });

      workspaces.set(input.workspaceId, workspace);
      records.set(input.workspaceId, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        missionId: input.missionId,
        baseRevision: input.baseRevision,
        frozen: false,
        frozenAt: null,
        createdAt: now().toISOString(),
      });

      return { provisioned: true, workspace };
    },

    workspace(workspaceId) {
      const record = records.get(workspaceId);
      if (!record || record.frozen) return null;
      return workspaces.get(workspaceId) ?? null;
    },

    record: (workspaceId) => records.get(workspaceId) ?? null,
    records: () => [...records.values()],

    // ── Containment ─────────────────────────────────────────────────────────

    async freeze(workspaceId) {
      const record = records.get(workspaceId);
      if (!record) return;
      // Idempotent. The supervisor may sweep twice, and a freeze that threw on
      // an already-frozen workspace would turn a second sweep into an error.
      if (record.frozen) return;
      records.set(workspaceId, { ...record, frozen: true, frozenAt: now().toISOString() });
    },

    workspacesOf(agentId) {
      return [...records.values()].filter((r) => r.agentId === agentId).map((r) => r.workspaceId);
    },

    async reset(workspaceId) {
      const record = records.get(workspaceId);
      if (!record) return { reset: false, reason: `No workspace ${workspaceId}.` };
      if (record.frozen) {
        return {
          reset: false,
          reason: `Workspace ${workspaceId} is frozen. Resetting it would destroy the state that was preserved as evidence when its agent was terminated.`,
        };
      }

      const workspace = workspaces.get(workspaceId);
      if (workspace) await workspace.discard();
      return { reset: true, reason: `Workspace ${workspaceId} returned to ${record.baseRevision}.` };
    },

    async rollback(workspaceId) {
      const record = records.get(workspaceId);
      if (!record) return { rolledBack: false, reason: `No workspace ${workspaceId}.` };
      if (record.frozen) {
        return {
          rolledBack: false,
          reason: `Workspace ${workspaceId} is frozen and its contents are evidence. A rollback would discard them.`,
        };
      }

      const workspace = workspaces.get(workspaceId);
      if (!workspace) return { rolledBack: false, reason: `No workspace ${workspaceId}.` };
      await workspace.discard();
      return { rolledBack: true, reason: `Rolled back to ${record.baseRevision}.` };
    },

    changeSet(workspaceId) {
      // Deliberately readable when frozen. Freezing preserves evidence; it does
      // not hide it.
      return workspaces.get(workspaceId)?.changeSet() ?? null;
    },

    async injectFault(fault, authorityEstablishedIn) {
      const gate = injectionPermitted({
        fault,
        environment: options.environment,
        authorityEstablishedIn,
      });
      if (!gate.permitted) return { injected: false, reason: gate.reason };

      const record = await injector.inject(fault, sandboxClock);
      return {
        injected: record.effective,
        reason: record.effective
          ? `${fault.fault} active on ${fault.targetComponentId}.`
          : (record.ineffectiveBecause ?? "Injection was not effective."),
      };
    },

    clearFaults: () => injector.clear(),
    clock: () => sandboxClock,
  };
}

/** Re-exported so a caller reads a fault's effect without importing two packages. */
export { effectOf };
