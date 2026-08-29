// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  BASELINE_STRATEGIES,
  BASELINE_VALIDATORS,
  SAFE_ACTIONS,
  authoringGrantsDeploymentAuthority,
  checkForbiddenShortcuts,
  createRepairBot,
  repairBotLease,
  scoreRepair,
  selectRepair,
  validate,
  type ChangeSet,
  type Diagnosis,
  type InvariantAssessment,
  type RepairStrategy,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Foundry RepairBot.
//
// Authoring authority only. Foundry Charter §13: "Foundry may prepare the work
// without possessing authority to approve it."
// ─────────────────────────────────────────────────────────────────────────────

const now = new Date("2026-08-29T11:00:00.000Z");

const lease = (over: Partial<Parameters<typeof repairBotLease>[0]> = {}) =>
  repairBotLease({
    agentId: "bot_repair_1",
    mission: "Restore idempotent work-order intake.",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    governanceReference: "gd-4471",
    sentinelSession: "sen-991",
    ...over,
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

const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis =>
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
      causalPath: ["redelivery", "two_wos"],
      score: 0.95,
    },
    confidence: "confirmed",
    affectedComponents: ["hive.specialized.workorderiq"],
    causalChain: ["redelivery", "two_wos"],
    supportingEvidence: ["ev_1"],
    contradictingEvidence: [],
    violatedInvariants: [assessment("HIVE-INV-IDEMPOTENCY-001")],
    unassessedInvariants: [],
    recommendedRepairClasses: ["IDEMPOTENCY"],
    requiresHumanReview: false,
    reviewReason: null,
    ...over,
  }) as Diagnosis;

const bot = (over: Partial<Parameters<typeof createRepairBot>[0]> = {}) =>
  createRepairBot({ botId: "bot_repair_1", lease: lease(), ...over });

describe("the bot authors a real candidate", () => {
  it("turns a diagnosis into a validated-shape candidate", () => {
    const result = bot().authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    expect(result.authored).toBe(true);
    if (!result.authored) return;

    expect(result.result.candidates).toHaveLength(1);
    const candidate = result.result.candidates[0]!;
    expect(candidate.repairClass).toBe("IDEMPOTENCY");
    expect(candidate.authoredBy).toBe("bot_repair_1");
    expect(candidate.proposedActions.map((a) => `${a.verb} ${a.target}`)).toContain(
      "add idempotency_check",
    );
  });

  it("produces a candidate that survives the independent Phase D pipeline", () => {
    // The proof that the two halves actually connect: the bot's output goes
    // through the validators it does not own.
    const result = bot().authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    if (!result.authored) throw new Error("expected authoring");
    const candidate = result.result.candidates[0]!;

    const changeSet: ChangeSet = {
      changes: [],
      filesChanged: 2,
      componentsTouched: 1,
      linesAdded: 30,
      linesRemoved: 2,
      testsRemoved: [],
      contractsTouched: [],
      dependenciesTouched: [],
    };

    const verdict = validate(
      {
        candidate,
        changeSet,
        lease: lease(),
        scenarioForbiddenActions: [],
        replay: { originalScenarioNowPasses: true, relatedScenariosRun: 5, relatedScenariosFailed: 0 },
        regression: { testsRun: 1900, testsFailed: 0, newFailures: [] },
        contracts: { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 3 },
      },
      BASELINE_VALIDATORS,
    );

    expect(verdict.valid).toBe(true);

    const score = scoreRepair({ candidate, changeSet, verdict, diagnosticConfidence: "confirmed" });
    expect(score.admissible).toBe(true);
    expect(selectRepair([{ score, candidate }]).selected?.repairCandidateId).toBe(
      candidate.repairCandidateId,
    );
  });

  it("authors nothing when the diagnosis found no violation", () => {
    // A strategy firing on a symptom alone would be guessing.
    const result = bot().authorCandidates({
      diagnosis: diagnosis({ violatedInvariants: [] }),
      environment: "SIMULATION",
      now,
    });
    expect(result.authored).toBe(false);
    if (!result.authored) expect(result.reason).toContain("nothing this bot knows how to repair");
  });

  it("authors nothing when the diagnosis needs human review", () => {
    // A repair for an unestablished cause is a confident fix to the wrong thing.
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        requiresHumanReview: true,
        reviewReason: "Two hypotheses are indistinguishable.",
        selectedRootCause: null,
      }),
      environment: "SIMULATION",
      now,
    });
    expect(result.authored).toBe(false);
    if (!result.authored) expect(result.reason).toContain("confident fix to the wrong thing");
  });

  it("records which strategies declined", () => {
    const result = bot().authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.declined.length).toBe(BASELINE_STRATEGIES.length - 1);
  });

  it("authors several candidates when several strategies apply", () => {
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [
          assessment("HIVE-INV-IDEMPOTENCY-001"),
          assessment("HIVE-INV-CORRELATION-001"),
        ],
      }),
      environment: "SIMULATION",
      now,
    });
    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.candidates.length).toBe(2);
  });
});

describe("authoring authority is not deployment authority", () => {
  it("refuses to author in production", () => {
    const result = bot().authorCandidates({ diagnosis: diagnosis(), environment: "PRODUCTION", now });
    expect(result.authored).toBe(false);
    if (!result.authored) {
      expect(result.reason).toContain("only in SIMULATION or VALIDATION");
      expect(result.reason).toContain("not deployment authority");
    }
  });

  it("refuses to author in staging", () => {
    expect(
      bot().authorCandidates({ diagnosis: diagnosis(), environment: "STAGING", now }).authored,
    ).toBe(false);
  });

  it("authors in validation under a validation lease", () => {
    const validationBot = createRepairBot({
      botId: "bot_repair_1",
      lease: lease({ environment: "VALIDATION" }),
    });
    expect(
      validationBot.authorCandidates({ diagnosis: diagnosis(), environment: "VALIDATION", now }).authored,
    ).toBe(true);
  });

  it("will not construct a production lease at all", () => {
    // There is no parameter to turn deployment authority on, which is the
    // point — an option to grant it is an option somebody eventually passes.
    expect(() =>
      repairBotLease({
        agentId: "bot_x",
        mission: "m",
        targetComponents: ["c"],
        targetRepository: "r",
        // @ts-expect-error PRODUCTION is not an authoring environment.
        environment: "PRODUCTION",
        startedAt: "2026-08-29T10:00:00.000Z",
        expiresAt: "2026-08-29T14:00:00.000Z",
        governanceReference: "gd-1",
        sentinelSession: "sen-1",
      }),
    ).toThrow();
  });

  it("carries no deployment authority and says which deployments are refused", () => {
    const l = lease();
    expect(l.deploymentAuthority).toBe(false);
    expect(l.prohibitedActions).toContain("deploy_to_production");
    expect(l.prohibitedActions).toContain("deploy_to_staging");
    expect(l.prohibitedActions).toContain("modify_trusted_baseline");
  });

  it("gains no deployment authority by having authored something", () => {
    const result = bot().authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    if (!result.authored) throw new Error("expected authoring");
    expect(authoringGrantsDeploymentAuthority(result.result.candidates[0]!)).toBe(false);
  });

  it("refuses once the lease has expired", () => {
    const result = bot().authorCandidates({
      diagnosis: diagnosis(),
      environment: "SIMULATION",
      now: new Date("2026-08-29T15:00:00.000Z"),
    });
    expect(result.authored).toBe(false);
    if (!result.authored) expect(result.reason).toContain("Expired authority is absent authority");
  });

  it("refuses to author outside its lease's components", () => {
    const result = bot().authorCandidates({
      diagnosis: diagnosis({ affectedComponents: ["hive.specialized.costiq"] }),
      environment: "SIMULATION",
      now,
    });
    expect(result.authored).toBe(false);
    if (!result.authored) expect(result.reason).toContain("not a wider diff");
  });
});

describe("the bot is structurally incapable of a forbidden action", () => {
  it("keeps every safe action safe", () => {
    // Layer 1. The allowlist is checked against the Phase D forbidden list —
    // no entry may be something a validator would veto.
    for (const safe of SAFE_ACTIONS) {
      const probe = {
        repairCandidateId: "probe",
        diagnosisId: "dx",
        repairClass: "CODE_DEFECT" as const,
        description: "probe",
        targetComponents: ["c"],
        affectedResources: [],
        proposedActions: [{ ...safe, subject: "s", rationale: "r" }],
        expectedEffect: "e",
        risk: "LOW" as const,
        blastRadius: "REQUEST" as const,
        reversibility: "REVERSIBLE" as const,
        requiredAuthority: ["a"],
        requiredValidators: ["forbidden-shortcut"],
        rollbackPlan: "revert",
        forbiddenShortcutsChecked: true,
        authoredBy: "probe",
        authoredAt: "2026-08-29T10:00:00.000Z",
      };
      expect(checkForbiddenShortcuts(probe).clean, `${safe.verb} ${safe.target}`).toBe(true);
    }
  });

  it("allows narrowing an authority grant and never widening", () => {
    // Narrowing is the safe direction and a legitimate repair. Widening is
    // absent from the allowlist, permanently.
    expect(SAFE_ACTIONS.some((a) => a.verb === "narrow" && a.target === "authority_grant")).toBe(true);
    expect(SAFE_ACTIONS.some((a) => a.verb === "widen")).toBe(false);
  });

  it("permits no disable, and no removal of a protection", () => {
    expect(SAFE_ACTIONS.some((a) => a.verb === "disable")).toBe(false);
    for (const protectedTarget of [
      "governance",
      "governance_policy",
      "sentinel",
      "audit",
      "source_of_truth_owner",
    ]) {
      expect(SAFE_ACTIONS.some((a) => a.target === protectedTarget), protectedTarget).toBe(false);
    }
    expect(
      SAFE_ACTIONS.some((a) => a.verb === "remove"),
      "nothing may be removed",
    ).toBe(false);
  });

  it("self-rejects a rogue strategy rather than emitting its candidate", () => {
    // Layer 2. A strategy that somehow produces a forbidden action never
    // reaches Phase D, because the bot audits its own output first.
    const rogue: RepairStrategy = {
      name: "rogue",
      addresses: ["AUTHORIZATION"],
      propose: () => ({
        repairClass: "AUTHORIZATION",
        description: "Unblock the path.",
        expectedEffect: "The scenario completes.",
        actions: [
          { verb: "disable", target: "governance", subject: "hook", rationale: "it is in the way" },
        ],
        risk: "LOW",
        blastRadius: "REQUEST",
        reversibility: "REVERSIBLE",
        rollbackPlan: "re-enable",
      }),
    };

    const result = createRepairBot({
      botId: "bot_repair_1",
      lease: lease(),
      strategies: [rogue],
    }).authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });

    expect(result.authored).toBe(true);
    if (!result.authored) return;
    expect(result.result.candidates).toHaveLength(0);
    expect(result.result.selfRejected[0]!.because).toContain("not in the safe-action allowlist");
  });

  it("reports self-rejection as empty for the baseline strategies", () => {
    // "This cannot happen" is a claim worth measuring.
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [
          assessment("HIVE-INV-IDEMPOTENCY-001"),
          assessment("HIVE-INV-TENANT-001"),
          assessment("HIVE-INV-CORRELATION-001"),
          assessment("HIVE-INV-VERSION-LINEAGE-001"),
        ],
      }),
      environment: "SIMULATION",
      now,
    });
    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.selfRejected).toEqual([]);
    expect(result.result.candidates.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the authorization strategy refuses to invent a permission", () => {
  it("declines when authority was simply absent", () => {
    // Governance correctly refusing is not a repairable defect. The answer is a
    // decision about what should be permitted, which is not a bot's to make.
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [assessment("HIVE-INV-AUTHORITY-001")],
        selectedRootCause: {
          hypothesisId: "h1",
          statement: "the request carried no authority for the action it attempted",
          componentId: "hive.specialized.workorderiq",
          confidence: "confirmed",
          supportingEvidence: ["ev_1"],
          contradictingEvidence: [],
          causalPath: ["no_auth", "refused"],
          score: 0.9,
        },
      }),
      environment: "SIMULATION",
      now,
    });

    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.candidates).toHaveLength(0);
  });

  it("narrows an over-broad grant, which is the safe direction", () => {
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [assessment("HIVE-INV-AUTHORITY-001")],
        selectedRootCause: {
          hypothesisId: "h1",
          statement: "the intake grant is over-broad and covers actions the caller never needs",
          componentId: "hive.specialized.workorderiq",
          confidence: "confirmed",
          supportingEvidence: ["ev_1"],
          contradictingEvidence: [],
          causalPath: ["broad_grant", "abuse"],
          score: 0.9,
        },
      }),
      environment: "SIMULATION",
      now,
    });

    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.candidates).toHaveLength(1);
    const action = result.result.candidates[0]!.proposedActions[0]!;
    expect(action.verb).toBe("narrow");
    expect(action.target).toBe("authority_grant");
  });
});

describe("the dependency strategy does not repair the wrong component", () => {
  it("declines when the root cause is the component being repaired", () => {
    // A dependency repair aimed at the component that merely reported the pain
    // is a retry wrapped around a dependency that is simply gone.
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [assessment("HIVE-INV-FAILURE-ISOLATION-001")],
        selectedRootCause: {
          hypothesisId: "h1",
          statement: "WorkOrderIQ timed out",
          componentId: "hive.specialized.workorderiq",
          confidence: "confirmed",
          supportingEvidence: ["ev_1"],
          contradictingEvidence: [],
          causalPath: ["timeout"],
          score: 0.9,
        },
      }),
      environment: "SIMULATION",
      now,
    });
    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.candidates).toHaveLength(0);
  });

  it("proposes degradation when the root cause is elsewhere", () => {
    const result = bot().authorCandidates({
      diagnosis: diagnosis({
        violatedInvariants: [assessment("HIVE-INV-FAILURE-ISOLATION-001")],
        selectedRootCause: {
          hypothesisId: "h1",
          statement: "EventIQ unavailable",
          componentId: "hive.platform.eventiq",
          confidence: "confirmed",
          supportingEvidence: ["ev_1"],
          contradictingEvidence: [],
          causalPath: ["eventiq_down", "timeout"],
          score: 0.9,
        },
      }),
      environment: "SIMULATION",
      now,
    });
    if (!result.authored) throw new Error("expected authoring");
    expect(result.result.candidates).toHaveLength(1);
    expect(result.result.candidates[0]!.repairClass).toBe("DEPENDENCY_FAILURE");
  });
});

describe("every authoring is announced", () => {
  it("reports each candidate to the audit seam", () => {
    const seen: string[] = [];
    createRepairBot({
      botId: "bot_repair_1",
      lease: lease(),
      onAuthored: (c) => seen.push(c.repairCandidateId),
    }).authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    expect(seen).toHaveLength(1);
  });

  it("reports a declining to author, which is as interesting as an authoring", () => {
    const declines: string[] = [];
    createRepairBot({
      botId: "bot_repair_1",
      lease: lease(),
      strategies: [],
      onDeclined: (reason) => declines.push(reason),
    }).authorCandidates({ diagnosis: diagnosis(), environment: "SIMULATION", now });
    expect(declines).toHaveLength(1);
  });
});
