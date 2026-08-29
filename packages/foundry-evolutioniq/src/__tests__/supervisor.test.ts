// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { repairBotLease, type AgentLease } from "@proworks-hub/repair-learning";

import {
  agentInheritsFoundryAuthority,
  createAgentRuntime,
  createFoundrySandbox,
  createMissionControl,
  type MissionControl,
  type TerminationRecord,
  type WorkspaceContainment,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Agent Runtime supervisor.
//
// The defect: every lease declared `terminationConditions` and nothing read
// them. `leasePermits()` checked authority when an agent made a call — which is
// necessary and not sufficient, because nothing watched an agent BETWEEN calls.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = new Date("2026-08-29T10:00:00.000Z").getTime();

/** A clock the test moves by hand. */
const clock = () => {
  let ms = T0;
  return {
    now: () => new Date(ms),
    advance: (delta: number) => {
      ms += delta;
    },
  };
};

const lease = (over: Partial<Parameters<typeof repairBotLease>[0]> = {}): AgentLease =>
  repairBotLease({
    agentId: "bot_1",
    mission: "Restore idempotent intake.",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    governanceReference: "gd-4471",
    sentinelSession: "sen-991",
    ...over,
  });

const objective = {
  statement: "Make the work-order consumer idempotent.",
  derivedFrom: "dx_1",
  successCriteria: ["a duplicate delivery creates one work order"],
};

const scope = {
  components: ["hive.specialized.workorderiq"],
  repository: "proworks-engine-suite",
  environment: "SIMULATION" as const,
  maxFiles: 5,
  maxComponents: 1,
  maxDurationMs: 3_600_000,
};

/** A mission taken to PROVISIONED, ready for an agent. */
const provisionedMission = (missions: MissionControl, missionId = "mis_1") => {
  missions.propose({ missionId, objective, scope });
  missions.authorize(missionId, "gd-4471", "foundry");
  missions.provision(missionId, "bot_1", "foundry");
  return missions.get(missionId)!;
};

const containment = (workspaces: Record<string, string[]> = { bot_1: ["ws_1"] }) => {
  const frozen: string[] = [];
  const impl: WorkspaceContainment = {
    async freeze(workspaceId) {
      frozen.push(workspaceId);
    },
    workspacesOf: (agentId) => workspaces[agentId] ?? [],
  };
  return { impl, frozen };
};

const runtimeWith = (over: Partial<Parameters<typeof createAgentRuntime>[0]> = {}) => {
  const c = clock();
  const missions = createMissionControl({ now: c.now });
  const contain = containment();
  const runtime = createAgentRuntime({
    missions,
    containment: contain.impl,
    now: c.now,
    ...over,
  });
  return { c, missions, contain, runtime };
};

describe("the supervisor watches an agent that is not calling anything", () => {
  it("terminates an expired lease with no call from the agent", async () => {
    // THE DEFECT, DIRECTLY. An agent whose lease expires mid-run makes no call
    // at the moment of expiry, so a call-time check fires never.
    const { c, missions, runtime, contain } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    // Nothing happens for five hours. The agent makes no call.
    c.advance(5 * 60 * 60 * 1000);

    const terminated = await runtime.supervise();
    expect(terminated).toHaveLength(1);
    expect(terminated[0]!.cause).toBe("LEASE_EXPIRED");
    expect(terminated[0]!.reason).toContain("Credentials revoked, workspace frozen, evidence preserved");
    expect(contain.frozen).toEqual(["ws_1"]);
  });

  it("terminates a hung agent that stopped reporting", async () => {
    // The case a call-time check can never catch, because it is defined by the
    // absence of calls.
    const { c, missions, runtime } = runtimeWith({ heartbeatTimeoutMs: 30_000 });
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    c.advance(60_000);
    const terminated = await runtime.supervise();
    expect(terminated[0]!.cause).toBe("BUDGET_EXHAUSTED");
    expect(terminated[0]!.reason).toContain("a call-time check never sees");
  });

  it("leaves a healthy agent alone", async () => {
    const { c, missions, runtime } = runtimeWith({ heartbeatTimeoutMs: 30_000 });
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    c.advance(20_000);
    runtime.heartbeat("bot_1");
    c.advance(20_000);

    expect(await runtime.supervise()).toEqual([]);
    expect(runtime.running()).toHaveLength(1);
  });
});

describe("Sentinel can isolate an agent mid-mission", () => {
  it("terminates on a high-severity finding, before any other cause", async () => {
    // "Agent behavior exceeded its permitted mission. Isolate it."
    const { c, missions, runtime, contain } = runtimeWith({
      sentinel: {
        findingsAgainst: () => [
          { findingId: "fnd_9", severity: "catastrophic", summary: "reached outside its declared scope" },
        ],
      },
    });
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    const terminated = await runtime.supervise();
    expect(terminated[0]!.cause).toBe("SENTINEL_FINDING");
    expect(terminated[0]!.reason).toContain("exceeded its permitted mission");
    expect(terminated[0]!.missionState).toBe("TERMINATED_BY_SENTINEL");
    expect(contain.frozen).toEqual(["ws_1"]);
    expect(c.now).toBeDefined();
  });

  it("prefers the Sentinel cause over a simultaneous lease expiry", async () => {
    // A compromised agent should not get the benefit of a tidier reason.
    const { c, missions, runtime } = runtimeWith({
      sentinel: {
        findingsAgainst: () => [{ findingId: "fnd_9", severity: "high", summary: "privilege abuse" }],
      },
    });
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    c.advance(5 * 60 * 60 * 1000);
    const terminated = await runtime.supervise();
    expect(terminated[0]!.cause).toBe("SENTINEL_FINDING");
  });

  it("ignores a low-severity finding", async () => {
    const { missions, runtime } = runtimeWith({
      sentinel: {
        findingsAgainst: () => [{ findingId: "fnd_1", severity: "low", summary: "noisy logging" }],
      },
    });
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    expect(await runtime.supervise()).toEqual([]);
  });
});

describe("containment happens in the right order", () => {
  const terminateAndInspect = async (): Promise<{
    record: TerminationRecord;
    frozen: string[];
    runtime: ReturnType<typeof createAgentRuntime>;
  }> => {
    const { missions, runtime, contain } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });
    const record = (await runtime.terminate("bot_1", "OPERATOR_ABORT", "Operator stopped it."))!;
    return { record, frozen: contain.frozen, runtime };
  };

  it("revokes credentials", async () => {
    const { record, runtime } = await terminateAndInspect();
    expect(record.credentialRevoked).toBe(true);
    expect(runtime.get("bot_1")!.credential.revokedAt).not.toBeNull();
    expect(runtime.get("bot_1")!.credential.revokedBecause).toBe("OPERATOR_ABORT");
  });

  it("freezes the workspace", async () => {
    const { record, frozen } = await terminateAndInspect();
    expect(frozen).toEqual(["ws_1"]);
    expect(record.workspacesFrozen).toEqual(["ws_1"]);
  });

  it("preserves evidence rather than cleaning up", async () => {
    // The agent stays in the map in TERMINATED state. A containment step that
    // tidied up would destroy what an investigator most needs, at exactly the
    // moment somebody decided the agent was misbehaving.
    const { record, runtime } = await terminateAndInspect();
    expect(record.evidencePreserved).toBe(true);
    const agent = runtime.get("bot_1")!;
    expect(agent.state).toBe("TERMINATED");
    expect(agent.spawnedAt).toBeTruthy();
    expect(agent.spend).toBeDefined();
  });

  it("updates the mission record last, and consistently", async () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    await runtime.terminate("bot_1", "SCOPE_EXCEEDED", "The change outgrew its lease.");
    expect(missions.get("mis_1")!.state).toBe("SCOPE_EXCEEDED");
    expect(missions.get("mis_1")!.failureReason).toContain("outgrew its lease");
  });

  it("maps every termination cause to a mission state", async () => {
    // Seven causes, seven states, and they must agree — an agent terminated
    // for scope means a mission that ends SCOPE_EXCEEDED.
    const cases: [Parameters<ReturnType<typeof createAgentRuntime>["terminate"]>[1], string][] = [
      ["LEASE_EXPIRED", "LEASE_EXPIRED"],
      ["SCOPE_EXCEEDED", "SCOPE_EXCEEDED"],
      ["SENTINEL_FINDING", "TERMINATED_BY_SENTINEL"],
      ["GOVERNANCE_REVOCATION", "TERMINATED_BY_GOVERNANCE"],
      ["OPERATOR_ABORT", "ABORTED"],
      // A budget overrun is an engineering failure, not an authority event.
      // Reporting it as TERMINATED_BY_GOVERNANCE would put an action in the
      // record that Governance never took.
      ["BUDGET_EXHAUSTED", "FAILED"],
      ["MISSION_DEADLINE", "FAILED"],
    ];

    for (const [cause, expected] of cases) {
      const { missions, runtime } = runtimeWith();
      provisionedMission(missions, "mis_x");
      runtime.spawn({
        agentId: "bot_1",
        missionId: "mis_x",
        lease: lease(),
        budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
      });
      const record = await runtime.terminate("bot_1", cause, "test");
      expect(record!.missionState, cause).toBe(expected);
      expect(missions.get("mis_x")!.state, cause).toBe(expected);
    }
  });

  it("rejects validation only for a mission that reached validation", async () => {
    // VALIDATION_REJECTED means the work was done and was not good enough, so
    // it is illegal from PROVISIONED — you cannot reject validation for work
    // that never ran.
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions, "mis_v");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_v",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });
    missions.begin("mis_v", "TESTING", "foundry");
    missions.submitForValidation("mis_v", "foundry");

    const record = await runtime.terminate("bot_1", "VALIDATION_REJECTED", "Regressions appeared.");
    expect(record!.missionState).toBe("VALIDATION_REJECTED");
    expect(record!.missionTransitionRefused).toBeUndefined();
  });

  it("reports the mission's real state when the transition is refused", async () => {
    // The bug this caught: the record claimed VALIDATION_REJECTED while the
    // mission stayed PROVISIONED. Two records disagreeing about one event is
    // the failure this architecture exists to prevent — so the record now
    // carries the real state and says the transition was refused.
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions, "mis_p");
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_p",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    const record = await runtime.terminate("bot_1", "VALIDATION_REJECTED", "nonsensical here");
    expect(record!.missionState).toBe("PROVISIONED");
    expect(record!.missionTransitionRefused).toContain("not a legal transition");
    // Containment happened anyway. An agent is stopped whether or not its
    // mission record can represent why.
    expect(record!.credentialRevoked).toBe(true);
    expect(runtime.get("bot_1")!.state).toBe("TERMINATED");
  });

  it("is idempotent — a second sweep terminates nothing again", async () => {
    const { c, missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    c.advance(5 * 60 * 60 * 1000);
    expect(await runtime.supervise()).toHaveLength(1);
    expect(await runtime.supervise()).toHaveLength(0);
    expect(runtime.terminations()).toHaveLength(1);
  });
});

describe("a terminated agent cannot act", () => {
  it("refuses an action after termination", async () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    await runtime.terminate("bot_1", "SENTINEL_FINDING", "isolated");

    const result = runtime.recordAction({
      agentId: "bot_1",
      action: "modify_candidate_workspace",
      environment: "SIMULATION",
    });
    expect(result.permitted).toBe(false);
    if (!result.permitted) {
      expect(result.terminated).toBe(true);
      expect(result.reason).toContain("does not resume");
    }
  });

  it("still enforces the lease at call time", async () => {
    // The call-time check is kept. It was necessary; it was just not
    // sufficient.
    const { c, missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    const wrongEnv = runtime.recordAction({
      agentId: "bot_1",
      action: "modify_candidate_workspace",
      environment: "PRODUCTION",
    });
    expect(wrongEnv.permitted).toBe(false);

    c.advance(5 * 60 * 60 * 1000);
    const expired = runtime.recordAction({
      agentId: "bot_1",
      action: "run_tests",
      environment: "SIMULATION",
    });
    expect(expired.permitted).toBe(false);
  });

  it("refuses an action that would exceed the change scope", async () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease({ maxFiles: 3 }),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    const result = runtime.recordAction({
      agentId: "bot_1",
      action: "modify_candidate_workspace",
      environment: "SIMULATION",
      filesChanged: 40,
      componentsTouched: 1,
    });
    expect(result.permitted).toBe(false);
  });
});

describe("budgets and concurrency are containment, not tuning", () => {
  it("refuses to spawn beyond the concurrency limit", async () => {
    const { missions, runtime } = runtimeWith({ maxConcurrentAgents: 1 });
    provisionedMission(missions, "mis_a");
    provisionedMission(missions, "mis_b");

    expect(
      runtime.spawn({
        agentId: "bot_a",
        missionId: "mis_a",
        lease: lease({ agentId: "bot_a" }),
        budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
      }).spawned,
    ).toBe(true);

    const second = runtime.spawn({
      agentId: "bot_b",
      missionId: "mis_b",
      lease: lease({ agentId: "bot_b" }),
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });
    expect(second.spawned).toBe(false);
    if (!second.spawned) {
      expect(second.reason).toContain("another thing that can go wrong unobserved");
    }
  });

  it("terminates an agent that exhausts its action budget", async () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 2, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    runtime.recordAction({ agentId: "bot_1", action: "inspect", environment: "SIMULATION" });
    runtime.recordAction({ agentId: "bot_1", action: "inspect", environment: "SIMULATION" });

    const terminated = await runtime.supervise();
    expect(terminated[0]!.cause).toBe("BUDGET_EXHAUSTED");
  });

  it("refuses the action that would exceed the budget", async () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 1, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    expect(
      runtime.recordAction({ agentId: "bot_1", action: "inspect", environment: "SIMULATION" }).permitted,
    ).toBe(true);
    expect(
      runtime.recordAction({ agentId: "bot_1", action: "inspect", environment: "SIMULATION" }).permitted,
    ).toBe(false);
  });

  it("terminates a mission that overruns its own deadline", async () => {
    const { c, missions, runtime } = runtimeWith();
    missions.propose({ missionId: "mis_short", objective, scope: { ...scope, maxDurationMs: 1000 } });
    missions.authorize("mis_short", "gd-1", "foundry");
    missions.provision("mis_short", "bot_1", "foundry");

    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_short",
      lease: lease(),
      budget: { maxActions: 100, maxDurationMs: 86_400_000, maxValidationRuns: 10 },
    });

    c.advance(5000);
    runtime.heartbeat("bot_1");
    const terminated = await runtime.supervise();
    expect(terminated[0]!.cause).toBe("MISSION_DEADLINE");
  });
});

describe("the production wall holds at the spawn point too", () => {
  it("refuses to spawn an agent carrying deployment authority", () => {
    // `repairBotLease` already refuses to build one. This refuses to run one
    // that arrived by some other route.
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);

    const forged = { ...lease(), deploymentAuthority: true } as AgentLease;
    const result = runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: forged,
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });

    expect(result.spawned).toBe(false);
    if (!result.spawned) expect(result.reason).toContain("prepares work; it does not ship it");
  });

  it("refuses a lease whose environment differs from the mission's", () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    const result = runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease({ environment: "VALIDATION" }),
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });
    expect(result.spawned).toBe(false);
    if (!result.spawned) expect(result.reason).toContain("Authority does not travel between environments");
  });

  it("refuses to spawn for a mission that is not PROVISIONED", () => {
    // Spawning earlier would mean acting before Governance authorized it.
    const { missions, runtime } = runtimeWith();
    missions.propose({ missionId: "mis_new", objective, scope });

    const result = runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_new",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });
    expect(result.spawned).toBe(false);
    if (!result.spawned) expect(result.reason).toContain("before Governance authorized it");
  });

  it("grants an agent none of Foundry's own authority", () => {
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    const spawned = runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });
    if (!spawned.spawned) throw new Error("expected a spawn");
    expect(agentInheritsFoundryAuthority(spawned.agent)).toBe(false);
  });
});

describe("a normal release still revokes credentials", () => {
  it("revokes on release, not only on termination", () => {
    // A credential that outlives its purpose is one somebody reuses.
    const { missions, runtime } = runtimeWith();
    provisionedMission(missions);
    runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 10, maxDurationMs: 1000, maxValidationRuns: 1 },
    });

    expect(runtime.release("bot_1", "Mission complete.").released).toBe(true);
    const agent = runtime.get("bot_1")!;
    expect(agent.state).toBe("RELEASED");
    expect(agent.credential.revokedAt).not.toBeNull();
    // Not a termination cause: it finished normally.
    expect(agent.credential.revokedBecause).toBeNull();
  });
});

describe("the sandbox freeze the supervisor depends on", () => {
  it("freezes a real workspace and refuses to reset it afterwards", async () => {
    // Resetting a frozen workspace would destroy the state preserved as
    // evidence when its agent was terminated.
    const sandbox = createFoundrySandbox({ environment: "SIMULATION", tenantId: "ksix-synthetic" });

    const provisioned = await sandbox.provisionWorkspace({
      workspaceId: "ws_1",
      agentId: "bot_1",
      missionId: "mis_1",
      repairCandidateId: "rc_1",
      baseRevision: "abc123",
      lease: lease(),
    });
    expect(provisioned.provisioned).toBe(true);

    await sandbox.freeze("ws_1");
    expect(sandbox.record("ws_1")!.frozen).toBe(true);

    const reset = await sandbox.reset("ws_1");
    expect(reset.reset).toBe(false);
    expect(reset.reason).toContain("preserved as evidence");

    const rollback = await sandbox.rollback("ws_1");
    expect(rollback.rolledBack).toBe(false);
  });

  it("keeps a frozen workspace readable", async () => {
    // Freezing preserves evidence; it does not hide it.
    const sandbox = createFoundrySandbox({ environment: "SIMULATION", tenantId: "ksix-synthetic" });
    const provisioned = await sandbox.provisionWorkspace({
      workspaceId: "ws_1",
      agentId: "bot_1",
      missionId: "mis_1",
      repairCandidateId: "rc_1",
      baseRevision: "abc123",
      lease: lease(),
    });
    if (!provisioned.provisioned) throw new Error("expected provisioning");

    provisioned.workspace.stage({
      path: "packages/workorderiq/src/intake.ts",
      kind: "modified",
      componentId: "hive.specialized.workorderiq",
      linesAdded: 12,
      linesRemoved: 2,
    });

    await sandbox.freeze("ws_1");
    expect(sandbox.changeSet("ws_1")!.filesChanged).toBe(1);
    // But it can no longer be handed out for writing.
    expect(sandbox.workspace("ws_1")).toBeNull();
  });

  it("is idempotent, so a second sweep does not error", async () => {
    const sandbox = createFoundrySandbox({ environment: "SIMULATION", tenantId: "ksix-synthetic" });
    await sandbox.provisionWorkspace({
      workspaceId: "ws_1",
      agentId: "bot_1",
      missionId: "mis_1",
      repairCandidateId: "rc_1",
      baseRevision: "abc123",
      lease: lease(),
    });
    await sandbox.freeze("ws_1");
    const frozenAt = sandbox.record("ws_1")!.frozenAt;
    await sandbox.freeze("ws_1");
    expect(sandbox.record("ws_1")!.frozenAt).toBe(frozenAt);
  });

  it("cannot be created for production at all", () => {
    expect(() =>
      createFoundrySandbox({ environment: "PRODUCTION", tenantId: "ksix" }),
    ).toThrow(/cannot be created for PRODUCTION/);
  });

  it("reports which workspaces belong to an agent", async () => {
    const sandbox = createFoundrySandbox({ environment: "SIMULATION", tenantId: "ksix-synthetic" });
    for (const id of ["ws_1", "ws_2"]) {
      await sandbox.provisionWorkspace({
        workspaceId: id,
        agentId: "bot_1",
        missionId: "mis_1",
        repairCandidateId: "rc_1",
        baseRevision: "abc123",
        lease: lease(),
      });
    }
    expect([...sandbox.workspacesOf("bot_1")].sort()).toEqual(["ws_1", "ws_2"]);
    expect(sandbox.workspacesOf("bot_other")).toEqual([]);
  });
});
