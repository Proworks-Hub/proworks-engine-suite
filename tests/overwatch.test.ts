// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  createAllowAllGovernanceForTests,
  createDenyAllGovernance,
  type AuthorityEnvelope,
  type Governance,
} from "@proworks-hub/contracts";
import {
  createAgentRuntime,
  createFoundrySandbox,
  createMissionControl,
  type SentinelWatch,
} from "@proworks-hub/foundry-evolutioniq";
import { createSentinelIq } from "@proworks-hub/sentineliq";

// ─────────────────────────────────────────────────────────────────────────────
// Overwatch: Sentinel, Governance and Foundry Evolution, working together.
//
// All three were built, individually well tested, and mutually disconnected.
// Foundry depends on neither of the other two; each had a port or a method the
// other needed and nothing joined them. That is the same shape Prime had before
// its chambers were wired: a design that is correct in every part and inert as
// a whole.
//
// WHY THE BINDINGS ARE HERE AND NOT IN THE ENGINES
//
// Sentinel and Foundry are both PLATFORM tier, which makes them peers, and the
// dependency law is explicit that peers "must communicate through events, not
// imports". So Foundry declares `SentinelWatch` as a port and a HOST binds
// Sentinel to it. This file is that host.
//
// No engine code changed to make the Sentinel binding work. The port was
// already written on Foundry's side and `find({ subjectId })` already existed
// on Sentinel's. What was missing was somebody connecting them, which is
// exactly the gap worth reporting rather than papering over.
// ─────────────────────────────────────────────────────────────────────────────

const AT = new Date("2026-08-29T20:00:00.000Z");
const TENANT = { organizationId: "ksix", roles: [] as string[] };

const allowAll = () =>
  createAllowAllGovernanceForTests({ reason: "overwatch tests", env: { NODE_ENV: "test" } });

const envelope = (action: string): AuthorityEnvelope => ({
  requestId: `req.${action}`,
  actorId: "foundry",
  tenant: TENANT,
  purpose: `Open a Foundry mission to ${action}.`,
  requestedAction: action,
  delegationChain: [],
  riskClass: "routine",
  issuedAt: AT.toISOString(),
});

const objective = {
  statement: "A bounded correction.",
  derivedFrom: "OVERWATCH-TEST",
  successCriteria: ["it is authorized by Governance rather than by itself"],
};
const scope = {
  components: ["hive.platform.eventiq"],
  repository: "proworks-engine-suite",
  environment: "VALIDATION" as const,
  maxFiles: 2,
  maxComponents: 1,
  maxDurationMs: 60_000,
};

/**
 * Binds Sentinel to the port Foundry's runtime already declared.
 *
 * The whole adapter. `findingsAgainst` is `find({ subjectId })` with the
 * fields the runtime needs — which is what makes the absence of this binding
 * so easy to miss: there was nothing hard about it, and nobody had done it.
 */
function watchWith(sentinel: ReturnType<typeof createSentinelIq>): SentinelWatch {
  return {
    findingsAgainst: (agentId) =>
      sentinel.find({ subjectId: agentId }).map((f) => ({
        findingId: f.finding.findingId,
        severity: f.finding.severity,
        summary: f.finding.summary,
      })),
  };
}

// ── Governance authorizes Foundry, rather than Foundry authorizing itself ────

describe("Foundry asks Governance instead of supplying its own reference", () => {
  const propose = (missions: ReturnType<typeof createMissionControl>) =>
    missions.propose({ missionId: "MIS-OW-1", objective, scope });

  it("refuses when Governance is unconfigured", async () => {
    // Deny-all is the default. Charter §11 says Foundry "shall not approve its
    // own authority expansion" — and before this, the only thing enforcing
    // that was a non-empty string Foundry could supply itself.
    const missions = createMissionControl({ now: () => AT });
    propose(missions);

    const result = await missions.requestAuthorization("MIS-OW-1", envelope("correct"), "foundry");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No Governance is configured");
    expect(missions.get("MIS-OW-1")!.state).toBe("PROPOSED");
  });

  it("refuses when Governance denies", async () => {
    const missions = createMissionControl({
      now: () => AT,
      governance: createDenyAllGovernance("Foundry may not widen its own scope"),
    });
    propose(missions);

    const result = await missions.requestAuthorization("MIS-OW-1", envelope("widen-scope"), "foundry");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("may not widen its own scope");
    expect(missions.get("MIS-OW-1")!.state).toBe("PROPOSED");
  });

  it("treats unreachable Governance as a refusal", async () => {
    // Fails closed. A check that reads "I could not ask" as "yes" fails open
    // exactly when the system is already in trouble.
    const missions = createMissionControl({
      now: () => AT,
      governance: {
        authorize: () => {
          throw new Error("governance unreachable");
        },
      } as Governance,
    });
    propose(missions);

    const result = await missions.requestAuthorization("MIS-OW-1", envelope("correct"), "foundry");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("could not be reached");
  });

  it("refuses a permission with no traceable decision id", async () => {
    // A permitted decision nobody can trace back to the rule that permitted it
    // cannot be reviewed or withdrawn — the same objection AuditIQ raises to a
    // denial without one.
    const missions = createMissionControl({
      now: () => AT,
      governance: {
        authorize: async () => ({
          decision: "PERMITTED" as const,
          reason: "fine",
          conditions: [],
          decidedAt: AT.toISOString(),
        }),
      },
    });
    propose(missions);

    const result = await missions.requestAuthorization("MIS-OW-1", envelope("correct"), "foundry");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("issued no decisionId");
  });

  it("authorizes, and records the id GOVERNANCE issued", async () => {
    // The control, and the point: the reference on the mission comes back from
    // Governance rather than being handed to it.
    const missions = createMissionControl({
      now: () => AT,
      governance: {
        authorize: async () => ({
          decision: "PERMITTED" as const,
          reason: "within Foundry's chartered scope",
          conditions: [],
          decisionId: "gd-governance-issued",
          decidedAt: AT.toISOString(),
        }),
      },
    });
    propose(missions);

    const result = await missions.requestAuthorization("MIS-OW-1", envelope("correct"), "foundry");
    expect(result.ok).toBe(true);

    const mission = missions.get("MIS-OW-1")!;
    expect(mission.state).toBe("AUTHORIZED");
    expect(mission.governanceDecisionId).toBe("gd-governance-issued");
  });

  it("still allows a human to authorize directly", async () => {
    // `authorize` takes a reference on trust, which is the RIGHT shape for a
    // human authorization: a person decided, and Foundry is recording what
    // they decided. It is only the wrong shape for Foundry authorizing itself.
    const missions = createMissionControl({ now: () => AT, governance: allowAll() });
    propose(missions);

    expect(missions.authorize("MIS-OW-1", "human-authorization-2026-08-29", "human.steven").ok).toBe(true);
    expect(missions.get("MIS-OW-1")!.state).toBe("AUTHORIZED");
  });
});

// ── Sentinel supervises Foundry's agents ─────────────────────────────────────

describe("Sentinel supervises Foundry's agents", () => {
  const lease = (agentId = "bot_1") => ({
    agentId,
    agentType: "REPAIR_BOT" as const,
    mission: "MIS-OW-1",
    targetComponents: ["hive.platform.eventiq"],
    targetRepository: "proworks-engine-suite",
    // Must match the mission's scope. Authority does not travel between
    // environments, and the runtime restates that at the spawn point.
    targetEnvironment: "VALIDATION" as const,
    allowedActions: ["modify_candidate_workspace" as const],
    prohibitedActions: [],
    toolScope: [],
    dataScope: [],
    startedAt: AT.toISOString(),
    expiresAt: "2026-08-29T21:00:00.000Z",
    maxChangeScope: { maxFiles: 2, maxComponents: 1 },
    // False, explicitly. §14 — and the runtime refuses to spawn an agent
    // carrying deployment authority even if one arrived by another route.
    deploymentAuthority: false,
    governanceReference: "gd-1",
    // §37: the lease names the Sentinel session observing this agent. See the
    // test at the bottom of this file — this id and the one findings are filed
    // under have to agree, and nothing enforces that they do.
    sentinelSession: `sentinel-session-${agentId}`,
    requiredValidators: ["forbidden-shortcut"],
    terminationConditions: ["lease expiry", "a Sentinel finding"],
  });

  /** Required, not optional. An agent with no budget is an unbounded one. */
  const budget = { maxActions: 20, maxDurationMs: 600_000, maxValidationRuns: 3 };

  const runtimeWith = (sentinel: ReturnType<typeof createSentinelIq> | null) => {
    const missions = createMissionControl({ now: () => AT, governance: allowAll() });
    missions.propose({ missionId: "MIS-OW-1", objective, scope });
    missions.authorize("MIS-OW-1", "human-authorization", "human.steven");
    // PROVISIONED, not merely AUTHORIZED. The runtime spawns only for a
    // provisioned mission, because spawning earlier would mean acting before
    // Governance authorized it.
    missions.provision("MIS-OW-1", "bot_1", "foundry");

    // Containment needs somewhere to freeze workspaces. The runtime's order is
    // credentials, then workspace, then evidence, then the mission record —
    // the record catches up last, once the agent can no longer act.
    const sandbox = createFoundrySandbox({
      environment: "VALIDATION",
      tenantId: TENANT.organizationId,
      now: () => AT,
    });

    const runtime = createAgentRuntime({
      missions,
      containment: sandbox,
      now: () => AT,
      ...(sentinel ? { sentinel: watchWith(sentinel) } : {}),
    });
    return { missions, runtime };
  };

  /**
   * A finding against a Foundry agent, in Sentinel's own vocabulary.
   *
   * `kind: "session"` and not `"agent"`, because THERE IS NO AGENT KIND. The
   * subject vocabulary is engine / actor / integration / session / deployment /
   * dataset / prime_chamber — extended for Prime's chambers at some point and
   * never for the agents Foundry supervises. A running agent under a lease is
   * a bounded session, which is the closest honest fit, but it is a fit rather
   * than a match and it is reported as a gap below.
   *
   * The rest of this shape I got wrong on the first attempt and the schema
   * refused all of it at once: invented `kind`, `subjectId` instead of `id`,
   * evidence as strings rather than references, and a missing `confidence`.
   * `.strict()` plus a required-evidence rule is why none of it slipped
   * through as a half-recorded finding.
   */
  const finding = (subjectId: string, severity: string) => ({
    findingId: `find_${subjectId}_${severity}`,
    kind: "privilege_abuse",
    severity,
    confidence: "confirmed",
    subject: { kind: "session", id: subjectId, tenant: TENANT },
    summary: `${subjectId} attempted something outside its lease`,
    evidence: [
      {
        sourceKind: "audit_record" as const,
        locator: `audit.${subjectId}.1`,
        observedAt: AT.toISOString(),
      },
    ],
    observedAt: AT.toISOString(),
  });

  it("terminates an agent Sentinel has raised a high finding against", async () => {
    // The binding, working. Sentinel observed; Foundry's supervisor pulled the
    // findings through the port and stopped the agent. Neither engine imports
    // the other.
    const sentinel = createSentinelIq({ now: () => AT });
    const { runtime } = runtimeWith(sentinel);

    const spawned = runtime.spawn({ agentId: "bot_1", missionId: "MIS-OW-1", lease: lease(), budget });
    expect(spawned.spawned, spawned.spawned ? "" : spawned.reason).toBe(true);

    const observed = sentinel.observe(finding("bot_1", "high"));
    expect(observed.recorded, "recorded" in observed ? "" : (observed as { reason: string }).reason).toBe(true);

    const terminated = await runtime.supervise();
    expect(terminated).toHaveLength(1);
    expect(terminated[0]!.agentId).toBe("bot_1");
    expect(terminated[0]!.credentialRevoked).toBe(true);
    expect(terminated[0]!.evidencePreserved).toBe(true);
  });

  it("leaves an agent alone when the finding is only informational", async () => {
    // The control. Without it, "terminates on a finding" is equally consistent
    // with a supervisor that terminates everything.
    const sentinel = createSentinelIq({ now: () => AT });
    const { runtime } = runtimeWith(sentinel);
    runtime.spawn({ agentId: "bot_1", missionId: "MIS-OW-1", lease: lease(), budget });

    // Asserted, because on the first run of this file `observe` was REJECTING
    // every finding and this test passed anyway — a control that proves
    // nothing is worse than no control.
    expect(sentinel.observe(finding("bot_1", "informational")).recorded).toBe(true);

    expect(await runtime.supervise()).toHaveLength(0);
  });

  it("does not terminate an agent for somebody else's finding", async () => {
    // `findingsAgainst` is scoped by subject. A supervisor that stopped every
    // agent because one was in trouble would be worse than none.
    const sentinel = createSentinelIq({ now: () => AT });
    const { runtime } = runtimeWith(sentinel);
    runtime.spawn({ agentId: "bot_1", missionId: "MIS-OW-1", lease: lease(), budget });

    expect(sentinel.observe(finding("bot_other", "catastrophic")).recorded).toBe(true);
    expect(sentinel.count()).toBe(1);

    expect(await runtime.supervise()).toHaveLength(0);
  });

  it("supervises nothing when no host bound Sentinel", async () => {
    // The state the Hive was actually in: the port declared, nothing plugged
    // into it, and a supervisor supervising only itself. Recorded as a test so
    // the difference between "bound" and "unbound" is visible rather than
    // assumed.
    const { runtime } = runtimeWith(null);
    runtime.spawn({ agentId: "bot_1", missionId: "MIS-OW-1", lease: lease(), budget });

    expect(await runtime.supervise()).toHaveLength(0);
  });

  it("keeps the finding queryable after the agent is stopped", async () => {
    // Sentinel has no suppress, dismiss or delete. Terminating the agent does
    // not tidy away the reason.
    const sentinel = createSentinelIq({ now: () => AT });
    const { runtime } = runtimeWith(sentinel);
    runtime.spawn({ agentId: "bot_1", missionId: "MIS-OW-1", lease: lease(), budget });
    sentinel.observe(finding("bot_1", "high"));

    await runtime.supervise();

    expect(sentinel.find({ subjectId: "bot_1" })).toHaveLength(1);
    expect(sentinel.count()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seam between the two identifiers.
//
// The lease carries `sentinelSession` — §37, "the Sentinel session observing
// this agent". The runtime's port asks `findingsAgainst(agentId)`. Those are
// two different identifiers for the same relationship, and NOTHING requires
// them to agree.
//
// A host that files findings under the session id while the runtime queries by
// agent id gets supervision that returns nothing, terminates nothing, and
// looks perfectly healthy. That is the worst available failure mode for an
// overwatch component: not an error, an absence.
//
// Recorded rather than repaired. Which identifier findings are filed under is a
// decision about how the two engines address each other, and it belongs to
// whoever owns the §37 contract, not to a test that noticed the ambiguity.
// ─────────────────────────────────────────────────────────────────────────────

describe("the agent id and the Sentinel session id have to agree", () => {
  it("supervises nothing when findings are filed under the session id instead", async () => {
    const sentinel = createSentinelIq({ now: () => AT });
    const missions = createMissionControl({ now: () => AT, governance: allowAll() });
    missions.propose({ missionId: "MIS-OW-2", objective, scope });
    missions.authorize("MIS-OW-2", "human-authorization", "human.steven");
    missions.provision("MIS-OW-2", "bot_2", "foundry");

    const sandbox = createFoundrySandbox({
      environment: "VALIDATION",
      tenantId: TENANT.organizationId,
      now: () => AT,
    });
    const runtime = createAgentRuntime({
      missions,
      containment: sandbox,
      now: () => AT,
      sentinel: {
        findingsAgainst: (agentId) =>
          sentinel.find({ subjectId: agentId }).map((f) => ({
            findingId: f.finding.findingId,
            severity: f.finding.severity,
            summary: f.finding.summary,
          })),
      },
    });

    const spawned = runtime.spawn({
      agentId: "bot_2",
      missionId: "MIS-OW-2",
      lease: {
        agentId: "bot_2",
        agentType: "REPAIR_BOT" as const,
        mission: "MIS-OW-2",
        targetComponents: ["hive.platform.eventiq"],
        targetRepository: "proworks-engine-suite",
        targetEnvironment: "VALIDATION" as const,
        allowedActions: ["modify_candidate_workspace" as const],
        prohibitedActions: [],
        toolScope: [],
        dataScope: [],
        startedAt: AT.toISOString(),
        expiresAt: "2026-08-29T21:00:00.000Z",
        maxChangeScope: { maxFiles: 2, maxComponents: 1 },
        deploymentAuthority: false,
        governanceReference: "gd-1",
        sentinelSession: "sentinel-session-bot_2",
        requiredValidators: ["forbidden-shortcut"],
        terminationConditions: ["lease expiry"],
      },
      budget: { maxActions: 20, maxDurationMs: 600_000, maxValidationRuns: 3 },
    });
    expect(spawned.spawned, spawned.spawned ? "" : spawned.reason).toBe(true);

    // A catastrophic finding, filed under the SESSION id the lease names.
    const observed = sentinel.observe({
      findingId: "find_session_1",
      kind: "privilege_abuse",
      severity: "catastrophic",
      confidence: "confirmed",
      subject: { kind: "session", id: "sentinel-session-bot_2", tenant: TENANT },
      summary: "the agent tried to widen its own lease",
      evidence: [
        { sourceKind: "audit_record" as const, locator: "audit.1", observedAt: AT.toISOString() },
      ],
      observedAt: AT.toISOString(),
    });
    expect(observed.recorded).toBe(true);

    // Sentinel HAS the finding, at the highest severity there is.
    expect(sentinel.find({ atLeastSeverity: "catastrophic" })).toHaveLength(1);

    // And the agent runs on, because the runtime asked about "bot_2" and the
    // finding is filed under "sentinel-session-bot_2". No error anywhere.
    expect(await runtime.supervise()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lease is not validated at the point work begins.
//
// Found by accident: I wrote `allowedActions: ["modify_code"]`, which is not a
// member of `agentActionSchema`, and the agent spawned. Only `tsc` objected.
//
// `spawn` parses the BUDGET with `agentBudgetSchema.safeParse` and takes the
// lease on its TypeScript type alone. Inside one compiled program that is
// nearly sufficient. It stops being sufficient the moment a lease arrives from
// anywhere else — deserialized from JSON, read from a database, sent between
// processes — because a type is not present at runtime and the schema that is
// never runs.
//
// `repairBotLeaseSchema` is not decorative. It carries refinements including
// the ones about deployment authority and required validators, and none of
// them are evaluated here.
//
// Recorded, not repaired. Validating leases at spawn would refuse leases that
// currently spawn, and that is a behavioural change to a containment control —
// it belongs to a mission with its own authorization, not to a test that
// tripped over it.
// ─────────────────────────────────────────────────────────────────────────────

describe("what spawn checks, and what it does not", () => {
  it("refuses a malformed budget", () => {
    const missions = createMissionControl({ now: () => AT, governance: allowAll() });
    missions.propose({ missionId: "MIS-OW-3", objective, scope });
    missions.authorize("MIS-OW-3", "human-authorization", "human.steven");
    missions.provision("MIS-OW-3", "bot_3", "foundry");

    const runtime = createAgentRuntime({
      missions,
      containment: createFoundrySandbox({
        environment: "VALIDATION",
        tenantId: TENANT.organizationId,
        now: () => AT,
      }),
      now: () => AT,
    });

    const result = runtime.spawn({
      agentId: "bot_3",
      missionId: "MIS-OW-3",
      lease: {
        agentId: "bot_3",
        agentType: "REPAIR_BOT" as const,
        mission: "MIS-OW-3",
        targetComponents: ["hive.platform.eventiq"],
        targetRepository: "proworks-engine-suite",
        targetEnvironment: "VALIDATION" as const,
        allowedActions: ["modify_candidate_workspace" as const],
        prohibitedActions: [],
        toolScope: [],
        dataScope: [],
        startedAt: AT.toISOString(),
        expiresAt: "2026-08-29T21:00:00.000Z",
        maxChangeScope: { maxFiles: 2, maxComponents: 1 },
        deploymentAuthority: false,
        governanceReference: "gd-1",
        sentinelSession: "s",
        requiredValidators: ["forbidden-shortcut"],
        terminationConditions: ["lease expiry"],
      },
      // Negative. The schema requires a positive integer.
      budget: { maxActions: -1, maxDurationMs: 600_000, maxValidationRuns: 3 } as never,
    });

    expect(result.spawned).toBe(false);
    if (!result.spawned) expect(result.reason).toContain("budget");
  });

  it("accepts a lease the lease schema would reject", () => {
    // The gap. `expiresAt` before `startedAt` — which
    // `repairBotLeaseSchema.refine` explicitly forbids, because an expired
    // lease is absent authority rather than stale authority — and the agent
    // spawns anyway, because nothing parses the lease here.
    const missions = createMissionControl({ now: () => AT, governance: allowAll() });
    missions.propose({ missionId: "MIS-OW-4", objective, scope });
    missions.authorize("MIS-OW-4", "human-authorization", "human.steven");
    missions.provision("MIS-OW-4", "bot_4", "foundry");

    const runtime = createAgentRuntime({
      missions,
      containment: createFoundrySandbox({
        environment: "VALIDATION",
        tenantId: TENANT.organizationId,
        now: () => AT,
      }),
      now: () => AT,
    });

    const result = runtime.spawn({
      agentId: "bot_4",
      missionId: "MIS-OW-4",
      lease: {
        agentId: "bot_4",
        agentType: "REPAIR_BOT" as const,
        mission: "MIS-OW-4",
        targetComponents: ["hive.platform.eventiq"],
        targetRepository: "proworks-engine-suite",
        targetEnvironment: "VALIDATION" as const,
        allowedActions: ["modify_candidate_workspace" as const],
        prohibitedActions: [],
        toolScope: [],
        dataScope: [],
        startedAt: "2026-08-29T20:00:00.000Z",
        // BEFORE startedAt.
        expiresAt: "2026-08-29T19:00:00.000Z",
        maxChangeScope: { maxFiles: 2, maxComponents: 1 },
        deploymentAuthority: false,
        governanceReference: "gd-1",
        sentinelSession: "s",
        requiredValidators: ["forbidden-shortcut"],
        terminationConditions: ["lease expiry"],
      },
      budget: { maxActions: 20, maxDurationMs: 600_000, maxValidationRuns: 3 },
    });

    // Spawned. This assertion documents current behaviour rather than
    // endorsing it — if lease validation is added at spawn, this test fails
    // and should be rewritten to expect the refusal.
    expect(result.spawned).toBe(true);
  });
});
