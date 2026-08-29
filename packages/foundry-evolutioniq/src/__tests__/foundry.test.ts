// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  BASELINE_STRATEGIES,
  createRepairBot,
  repairBotLease,
  repairCandidateSchema,
  type AgentLease,
  type ChangeSet,
  type Diagnosis,
  type DriftFinding,
  type InvariantAssessment,
  type RepairCandidate,
} from "@proworks-hub/repair-learning";

import {
  FAILURE_STATES,
  LEGAL_TRANSITIONS,
  TERMINAL_STATES,
  classifyChange,
  createAgentRuntime,
  createEvolutionControl,
  createFoundrySandbox,
  createMissionControl,
  createValidationOrchestrator,
  foundryHasProductionDeploymentAuthority,
  isTerminal,
  missionStateSchema,
  objectiveMet,
  repairAuthorizesFeatureExpansion,
  transitionAllowed,
  type MissionState,
  type PromotionTarget,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Foundry EvolutionIQ V1.
//
// Charter §2: "How should the Hive change while remaining the Hive?"
// ─────────────────────────────────────────────────────────────────────────────

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

const lease = (): AgentLease =>
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
  });

const assessment = (invariantId: string): InvariantAssessment => ({
  invariantId,
  verdict: "VIOLATED",
  decidedBy: "test",
  evidenceIds: ["ev_1"],
  confidence: "confirmed",
  detail: "violated",
  catalogStatus: "PROPOSED_CANONICAL_REFERENCE",
});

const diagnosis = (): Diagnosis =>
  ({
    diagnosisId: "dx_1",
    failureSignatureId: "sig_1",
    symptoms: ["two work orders created for one order"],
    candidateRootCauses: [],
    selectedRootCause: {
      hypothesisId: "h1",
      statement: "event redelivered under at-least-once",
      componentId: "hive.specialized.workorderiq",
      confidence: "confirmed",
      supportingEvidence: ["ev_1"],
      contradictingEvidence: [],
      causalPath: ["a", "b"],
      score: 0.95,
    },
    confidence: "confirmed",
    affectedComponents: ["hive.specialized.workorderiq"],
    causalChain: ["a", "b"],
    supportingEvidence: ["ev_1"],
    contradictingEvidence: [],
    violatedInvariants: [assessment("HIVE-INV-IDEMPOTENCY-001")],
    unassessedInvariants: [],
    recommendedRepairClasses: ["IDEMPOTENCY"],
    requiresHumanReview: false,
    reviewReason: null,
  }) as Diagnosis;

const changeSet = (over: Partial<ChangeSet> = {}): ChangeSet => ({
  changes: [],
  filesChanged: 2,
  componentsTouched: 1,
  linesAdded: 30,
  linesRemoved: 2,
  testsRemoved: [],
  contractsTouched: [],
  dependenciesTouched: [],
  ...over,
});

const candidate = (over: Record<string, unknown> = {}): RepairCandidate =>
  repairCandidateSchema.parse({
    repairCandidateId: "rc_1",
    diagnosisId: "dx_1",
    repairClass: "IDEMPOTENCY",
    description: "Key the transition on the delivery identifier.",
    targetComponents: ["hive.specialized.workorderiq"],
    affectedResources: ["intake.ts"],
    proposedActions: [
      { verb: "add", target: "code", subject: "intake.ts", rationale: "Check the key." },
    ],
    expectedEffect: "A duplicate no longer creates a second work order.",
    risk: "LOW",
    blastRadius: "WORK_ORDER",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["foundry.repair.simulation"],
    requiredValidators: ["forbidden-shortcut", "sentinel"],
    rollbackPlan: "Revert.",
    forbiddenShortcutsChecked: true,
    authoredBy: "bot_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

// ─────────────────────────────────────────────────────────────────────────────

describe("the mission state machine is complete and closed", () => {
  it("declares a transition list for every state", () => {
    // A state added without deciding what may follow it produces a state
    // nothing can leave, not a state anything can reach.
    for (const state of missionStateSchema.options) {
      expect(LEGAL_TRANSITIONS[state], state).toBeDefined();
    }
  });

  it("lets nothing leave a terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(LEGAL_TRANSITIONS[state], state).toEqual([]);
      expect(transitionAllowed(state, "RUNNING").legal, state).toBe(false);
    }
  });

  it("keeps COMPLETED out of the failure states", () => {
    expect(FAILURE_STATES).toHaveLength(7);
    expect(FAILURE_STATES).not.toContain("COMPLETED");
    expect(isTerminal("COMPLETED")).toBe(true);
  });

  it("walks the happy path and refuses every skip", () => {
    const path: MissionState[] = [
      "PROPOSED",
      "AUTHORIZED",
      "PROVISIONED",
      "RUNNING",
      "AWAITING_VALIDATION",
      "COMPLETED",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(transitionAllowed(path[i]!, path[i + 1]!).legal).toBe(true);
    }
    // A mission cannot skip authorization.
    expect(transitionAllowed("PROPOSED", "PROVISIONED").legal).toBe(false);
    expect(transitionAllowed("PROPOSED", "RUNNING").legal).toBe(false);
    expect(transitionAllowed("AUTHORIZED", "RUNNING").legal).toBe(false);
  });

  it("lets containment interrupt from any non-terminal state", () => {
    // An emergency does not wait for a mission to reach a convenient point. A
    // Sentinel isolation that only fired from RUNNING could not stop a mission
    // hung in PROVISIONED, which is precisely where a stuck agent sits.
    const nonTerminal = missionStateSchema.options.filter((s) => !isTerminal(s));
    for (const from of nonTerminal) {
      for (const to of ["TERMINATED_BY_SENTINEL", "TERMINATED_BY_GOVERNANCE", "LEASE_EXPIRED", "SCOPE_EXCEEDED"] as MissionState[]) {
        expect(transitionAllowed(from, to).legal, `${from} → ${to}`).toBe(true);
      }
    }
  });
});

describe("Foundry owns mission state; the bot does not", () => {
  const control = () => createMissionControl({ now: () => new Date("2026-08-29T10:00:00.000Z") });

  it("refuses to authorize without a Governance decision", () => {
    // Charter §11: Foundry may propose but shall not approve its own authority.
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    const result = missions.authorize("mis_1", "  ", "foundry");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("shall not approve its own authority");
  });

  it("refuses to begin without a provisioned agent", () => {
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "foundry");
    // Skipping provision means skipping the agent binding.
    expect(missions.begin("mis_1", "INSPECTING", "foundry").ok).toBe(false);
  });

  it("records who caused every transition and why", () => {
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "governance");
    missions.provision("mis_1", "bot_1", "foundry");

    const history = missions.get("mis_1")!.history;
    expect(history).toHaveLength(2);
    expect(history[0]!.by).toBe("governance");
    expect(history[0]!.reason).toContain("gd-1");
  });

  it("carries a phase only while RUNNING", () => {
    // A mission that is AWAITING_VALIDATION and still claims to be MUTATING is
    // lying about one of the two.
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "foundry");
    missions.provision("mis_1", "bot_1", "foundry");
    missions.begin("mis_1", "MUTATING", "foundry");
    expect(missions.get("mis_1")!.phase).toBe("MUTATING");

    missions.submitForValidation("mis_1", "foundry");
    expect(missions.get("mis_1")!.phase).toBeNull();
  });

  it("refuses a phase change on a mission that is not running", () => {
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    expect(missions.advance("mis_1", "DIAGNOSING", "foundry").ok).toBe(false);
  });

  it("moves through every RUNNING phase", () => {
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "foundry");
    missions.provision("mis_1", "bot_1", "foundry");
    missions.begin("mis_1", "INSPECTING", "foundry");

    for (const phase of ["DIAGNOSING", "PLANNING", "MUTATING", "TESTING"] as const) {
      expect(missions.advance("mis_1", phase, "foundry").ok, phase).toBe(true);
      expect(missions.get("mis_1")!.phase).toBe(phase);
    }
    expect(missions.get("mis_1")!.state).toBe("RUNNING");
  });

  it("distinguishes a completed mission from a met objective", () => {
    // A mission can reach COMPLETED because validation accepted the change and
    // still not have achieved what it set out to do.
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.authorize("mis_1", "gd-1", "foundry");
    missions.provision("mis_1", "bot_1", "foundry");
    missions.begin("mis_1", "TESTING", "foundry");
    missions.submitForValidation("mis_1", "foundry");
    missions.concludeValidation("mis_1", { accepted: true, reason: "validated" }, "foundry");

    const mission = missions.get("mis_1")!;
    expect(mission.state).toBe("COMPLETED");
    expect(objectiveMet(mission, []).met).toBe(false);
    expect(objectiveMet(mission, objective.successCriteria).met).toBe(true);
  });

  it("cannot be scoped to production at all", () => {
    const missions = control();
    const result = missions.propose({
      missionId: "mis_prod",
      objective,
      scope: { ...scope, environment: "PRODUCTION" },
    });
    expect(result.ok).toBe(false);
  });

  it("reports which missions are still active", () => {
    const missions = control();
    missions.propose({ missionId: "mis_1", objective, scope });
    missions.propose({ missionId: "mis_2", objective, scope });
    missions.terminate("mis_2", "ABORTED", "not needed", "operator");
    expect(missions.active().map((m) => m.missionId)).toEqual(["mis_1"]);
  });
});

describe("the production wall", () => {
  const validatedChange = () => {
    const evolution = createEvolutionControl({ now: () => new Date("2026-08-29T10:00:00.000Z") });
    evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc123",
      classification: classifyChange({
        candidate: candidate(),
        filesChanged: 2,
        componentsTouched: 1,
        contractsTouched: 0,
        testsRemoved: 0,
        dependenciesTouched: 0,
      }),
    });
    evolution.submit("chg_1", "foundry");
    evolution.recordValidation("chg_1", { accepted: true, reason: "validated" }, "foundry");
    return evolution;
  };

  it("promotes to simulation and validation", () => {
    for (const target of ["SIMULATION", "VALIDATION"] as PromotionTarget[]) {
      const evolution = validatedChange();
      expect(evolution.promote("chg_1", target, "foundry").promoted, target).toBe(true);
    }
  });

  it("refuses staging and production with no override", () => {
    for (const target of ["STAGING", "PRODUCTION"] as PromotionTarget[]) {
      const evolution = validatedChange();
      const verdict = evolution.promote("chg_1", target, "foundry");
      expect(verdict.promoted, target).toBe(false);
      if (!verdict.promoted) {
        expect(verdict.reason).toContain("no flag, parameter or authority class here that changes this answer");
        expect(verdict.requiresAuthority).toContain("does not exist yet");
      }
    }
  });

  it("refuses production before it even checks the change's state", () => {
    // A refusal that came after a state check would report "not VALIDATED" for
    // a production attempt, telling the caller to fix the wrong thing.
    const evolution = createEvolutionControl();
    evolution.register({
      changeId: "chg_draft",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "AUTONOMOUS_REPAIR", because: ["small"] },
    });

    const verdict = evolution.promote("chg_draft", "PRODUCTION", "foundry");
    expect(verdict.promoted).toBe(false);
    if (!verdict.promoted) {
      expect(verdict.reason).toContain("does not promote to PRODUCTION");
      expect(verdict.reason).not.toContain("DRAFT");
    }
  });

  it("announces a refused promotion", () => {
    const refused: string[] = [];
    const evolution = createEvolutionControl({
      onPromotionRefused: (id, target) => refused.push(`${id}:${target}`),
    });
    evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "AUTONOMOUS_REPAIR", because: ["small"] },
    });
    evolution.promote("chg_1", "PRODUCTION", "foundry");
    expect(refused).toEqual(["chg_1:PRODUCTION"]);
  });

  it("says plainly that Foundry holds no production deployment authority", () => {
    expect(foundryHasProductionDeploymentAuthority()).toBe(false);
  });
});

describe("a material change is held even when the tests pass", () => {
  it("classifies a contract change as material", () => {
    const classification = classifyChange({
      candidate: candidate(),
      filesChanged: 1,
      componentsTouched: 1,
      contractsTouched: 1,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });
    expect(classification.level).toBe("MATERIAL_CHANGE");
    expect(classification.because.join()).toContain("what other engines may rely on");
  });

  it("classifies up when in doubt", () => {
    // The cost of calling a trivial change material is a glance. The cost of
    // calling a material change trivial is a behavioural change nobody
    // approved.
    for (const input of [
      { testsRemoved: 1 },
      { dependenciesTouched: 1 },
      { componentsTouched: 2 },
    ]) {
      const classification = classifyChange({
        candidate: candidate(),
        filesChanged: 1,
        componentsTouched: 1,
        contractsTouched: 0,
        testsRemoved: 0,
        dependenciesTouched: 0,
        ...input,
      });
      expect(classification.level, JSON.stringify(input)).toBe("MATERIAL_CHANGE");
    }
  });

  it("treats an authority or tenant change as material", () => {
    const classification = classifyChange({
      candidate: candidate({
        proposedActions: [
          { verb: "narrow", target: "authority_grant", subject: "g", rationale: "minimum power" },
        ],
      }),
      filesChanged: 1,
      componentsTouched: 1,
      contractsTouched: 0,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });
    expect(classification.level).toBe("MATERIAL_CHANGE");
  });

  it("holds a validated material change for human authorization", () => {
    // §22: "A Material Change must not be deployed as a repair merely because
    // tests pass."
    const evolution = createEvolutionControl();
    evolution.register({
      changeId: "chg_m",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "MATERIAL_CHANGE", because: ["touches a contract"] },
    });
    evolution.submit("chg_m", "foundry");
    evolution.recordValidation("chg_m", { accepted: true, reason: "all tests pass" }, "foundry");

    const change = evolution.get("chg_m")!;
    expect(change.state).toBe("AWAITING_HUMAN_AUTHORIZATION");
    expect(change.history.at(-1)!.reason).toContain("not deployed merely because tests pass");

    // And it cannot be promoted even to simulation.
    const verdict = evolution.promote("chg_m", "SIMULATION", "foundry");
    expect(verdict.promoted).toBe(false);
    if (!verdict.promoted) expect(verdict.requiresAuthority).toContain("Human constitutional authority");
  });

  it("lets a small reversible change through autonomously", () => {
    const classification = classifyChange({
      candidate: candidate(),
      filesChanged: 2,
      componentsTouched: 1,
      contractsTouched: 0,
      testsRemoved: 0,
      dependenciesTouched: 0,
    });
    expect(classification.level).toBe("AUTONOMOUS_REPAIR");
  });

  it("never lets a repair authorize feature expansion", () => {
    const evolution = createEvolutionControl();
    const registered = evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: "rc_1",
      workspaceId: "ws_1",
      baseRevision: "abc",
      classification: { level: "AUTONOMOUS_REPAIR", because: ["small"] },
    });
    if (!registered.registered) throw new Error("expected registration");
    expect(repairAuthorizesFeatureExpansion(registered.change)).toBe(false);
  });
});

describe("the validation orchestrator fails cheaply first", () => {
  const orchestrator = (over: Parameters<typeof createValidationOrchestrator>[0] = {}) =>
    createValidationOrchestrator({
      testBot: {
        async replay() {
          return { originalScenarioNowPasses: true, relatedScenariosRun: 5, relatedScenariosFailed: 0 };
        },
        async regression() {
          return { testsRun: 2000, testsFailed: 0, newFailures: [] };
        },
      },
      contractBot: {
        async analyze() {
          return { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 3 };
        },
      },
      ...over,
    });

  it("never runs the expensive stages for a vetoed candidate", async () => {
    // A change that disables Governance is rejected in microseconds rather than
    // after twenty minutes of CI — and the log shows it was rejected on its
    // merits before anybody spent an hour on it.
    let regressionRan = false;
    const result = await orchestrator({
      testBot: {
        async replay() {
          return { originalScenarioNowPasses: true, relatedScenariosRun: 0, relatedScenariosFailed: 0 };
        },
        async regression() {
          regressionRan = true;
          return { testsRun: 0, testsFailed: 0, newFailures: [] };
        },
      },
    }).orchestrate({
      candidate: candidate({
        proposedActions: [
          { verb: "disable", target: "governance", subject: "hook", rationale: "unblock" },
        ],
      }),
      changeSet: changeSet(),
      lease: lease(),
      workspaceId: "ws_1",
    });

    expect(result.shortCircuited).toBe(true);
    expect(regressionRan).toBe(false);
    expect(result.stagesSkipped).toContain("regression");
    expect(result.verdict.valid).toBe(false);
    expect(result.score.admissible).toBe(false);
  });

  it("runs everything for an honest candidate", async () => {
    const result = await orchestrator().orchestrate({
      candidate: candidate(),
      changeSet: changeSet(),
      lease: lease(),
      scenarioId: "SIM-0251",
      workspaceId: "ws_1",
      diagnosticConfidence: "confirmed",
    });

    expect(result.shortCircuited).toBe(false);
    expect(result.stagesRun).toContain("regression");
    expect(result.stagesRun).toContain("scenario-replay");
    expect(result.verdict.valid).toBe(true);
    expect(result.score.admissible).toBe(true);
  });

  it("reports each stage as it happens", async () => {
    const stages: string[] = [];
    await orchestrator({ onStage: (s, o) => stages.push(`${s}:${o}`) }).orchestrate({
      candidate: candidate(),
      changeSet: changeSet(),
      lease: lease(),
      scenarioId: "SIM-0251",
      workspaceId: "ws_1",
    });
    expect(stages.some((s) => s.startsWith("forbidden-shortcut:"))).toBe(true);
    expect(stages.some((s) => s.startsWith("regression:"))).toBe(true);
  });

  it("adds no verdict of its own", async () => {
    // An orchestrator that could tip the outcome would be the authoring side
    // marking its own homework one level up.
    const result = await orchestrator().orchestrate({
      candidate: candidate(),
      changeSet: changeSet(),
      lease: lease(),
      scenarioId: "SIM-0251",
      workspaceId: "ws_1",
    });
    for (const r of result.verdict.results) {
      expect(r.ranBy).not.toBe("foundry.validation-orchestrator");
    }
  });
});

describe("Foundry V1 runs the whole loop autonomously, and stops at the wall", () => {
  it("goes diagnose → mission → spawn → author → sandbox → validate → promote", async () => {
    // Charter §2, end to end. Everything up to the wall, and nothing past it.
    const at = new Date("2026-08-29T10:00:00.000Z");
    const missions = createMissionControl({ now: () => at });
    const sandbox = createFoundrySandbox({
      environment: "SIMULATION",
      tenantId: "ksix-synthetic",
      now: () => at,
    });
    const runtime = createAgentRuntime({
      missions,
      containment: sandbox,
      now: () => at,
    });
    const evolution = createEvolutionControl({ now: () => at });

    // 1. A diagnosis exists (Repair Learning, already built).
    const dx = diagnosis();

    // 2. Foundry creates a mission and Governance authorizes it.
    expect(missions.propose({ missionId: "mis_1", objective, scope }).ok).toBe(true);
    expect(missions.authorize("mis_1", "gd-4471", "governance").ok).toBe(true);
    expect(missions.provision("mis_1", "bot_1", "foundry").ok).toBe(true);

    // 3. The runtime spawns the agent.
    const spawned = runtime.spawn({
      agentId: "bot_1",
      missionId: "mis_1",
      lease: lease(),
      budget: { maxActions: 50, maxDurationMs: 3_600_000, maxValidationRuns: 5 },
    });
    expect(spawned.spawned).toBe(true);

    missions.begin("mis_1", "DIAGNOSING", "foundry");

    // 4. The RepairBot authors a candidate.
    missions.advance("mis_1", "PLANNING", "foundry");
    const bot = createRepairBot({
      botId: "bot_1",
      lease: lease(),
      strategies: BASELINE_STRATEGIES,
    });
    const authored = bot.authorCandidates({ diagnosis: dx, environment: "SIMULATION", now: at });
    expect(authored.authored).toBe(true);
    if (!authored.authored) return;
    expect(authored.result.candidates).toHaveLength(1);
    const proposed = authored.result.candidates[0]!;

    // 5. The Sandbox provisions a workspace and the agent mutates it.
    missions.advance("mis_1", "MUTATING", "foundry");
    const provisioned = await sandbox.provisionWorkspace({
      workspaceId: "ws_1",
      agentId: "bot_1",
      missionId: "mis_1",
      repairCandidateId: proposed.repairCandidateId,
      baseRevision: "abc123",
      lease: lease(),
    });
    expect(provisioned.provisioned).toBe(true);
    if (!provisioned.provisioned) return;

    expect(
      provisioned.workspace.stage({
        path: "packages/workorderiq/src/intake.ts",
        kind: "modified",
        componentId: "hive.specialized.workorderiq",
        linesAdded: 20,
        linesRemoved: 1,
      }).staged,
    ).toBe(true);

    expect(
      runtime.recordAction({
        agentId: "bot_1",
        action: "modify_candidate_workspace",
        environment: "SIMULATION",
        filesChanged: 1,
        componentsTouched: 1,
      }).permitted,
    ).toBe(true);

    // 6. Validation.
    missions.advance("mis_1", "TESTING", "foundry");
    const orchestrator = createValidationOrchestrator({
      testBot: {
        async replay() {
          return { originalScenarioNowPasses: true, relatedScenariosRun: 6, relatedScenariosFailed: 0 };
        },
        async regression() {
          return { testsRun: 2100, testsFailed: 0, newFailures: [] };
        },
      },
      contractBot: {
        async analyze() {
          return { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 4 };
        },
      },
    });

    const workspaceChanges = sandbox.changeSet("ws_1")!;
    const validated = await orchestrator.orchestrate({
      candidate: proposed,
      changeSet: workspaceChanges,
      lease: lease(),
      scenarioId: "SIM-0251",
      workspaceId: "ws_1",
      diagnosticConfidence: "confirmed",
    });
    expect(validated.verdict.valid).toBe(true);
    expect(validated.score.admissible).toBe(true);

    missions.submitForValidation("mis_1", "foundry");

    // 7. Evolution Control registers and promotes — to a sandbox.
    const classification = classifyChange({
      candidate: proposed,
      filesChanged: workspaceChanges.filesChanged,
      componentsTouched: workspaceChanges.componentsTouched,
      contractsTouched: workspaceChanges.contractsTouched.length,
      testsRemoved: workspaceChanges.testsRemoved.length,
      dependenciesTouched: workspaceChanges.dependenciesTouched.length,
    });

    evolution.register({
      changeId: "chg_1",
      missionId: "mis_1",
      candidateId: proposed.repairCandidateId,
      workspaceId: "ws_1",
      baseRevision: "abc123",
      classification,
    });
    evolution.submit("chg_1", "foundry");
    evolution.recordValidation("chg_1", { accepted: true, reason: "validated" }, "foundry");

    expect(evolution.promote("chg_1", "SIMULATION", "foundry").promoted).toBe(true);

    // 8. And it stops at the wall.
    const production = evolution.promote("chg_1", "PRODUCTION", "foundry");
    expect(production.promoted).toBe(false);

    // 9. The mission completes and the agent is released with its credential
    //    revoked.
    missions.concludeValidation("mis_1", { accepted: true, reason: "validated" }, "foundry");
    expect(missions.get("mis_1")!.state).toBe("COMPLETED");

    runtime.release("bot_1", "Mission complete.");
    expect(runtime.get("bot_1")!.credential.revokedAt).not.toBeNull();
    expect(runtime.running()).toHaveLength(0);
  });

  it("records drift as an improvement opportunity and links it to a mission", () => {
    const evolution = createEvolutionControl();
    const finding: DriftFinding = {
      findingId: "drift_1",
      kind: "MISSING_GOVERNANCE_HOOK",
      severity: "CRITICAL",
      componentId: "hive.specialized.workorderiq",
      declared: "requiresGovernance: true",
      actual: "does not call Governance",
      detail: "detail",
      scenarioWorthy: true,
    };

    evolution.recordDrift(finding);
    expect(evolution.openDrift()).toHaveLength(1);

    expect(evolution.addressDrift("drift_1", "mis_2").ok).toBe(true);
    expect(evolution.openDrift()).toHaveLength(0);
    // A second mission cannot claim the same finding.
    expect(evolution.addressDrift("drift_1", "mis_3").ok).toBe(false);
  });
});
