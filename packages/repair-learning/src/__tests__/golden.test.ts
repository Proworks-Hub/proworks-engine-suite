// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DETECTORS,
  BASELINE_VALIDATORS,
  buildFailureSignature,
  createCausalGraph,
  createExperienceStore,
  createInvariantClassifier,
  createPatternLibrary,
  diagnose,
  findReusableKnowledge,
  generalize,
  loadCorpus,
  repairCandidateSchema,
  repairCaseSchema,
  scoreRepair,
  selectRepair,
  validate,
  type ChangeSet,
  type Evidence,
  type FailureSignature,
  type GeneralizationAuthority,
  type InvariantCatalogEntry,
  type RepairCandidate,
  type SimulationRun,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The five golden loops (directive §43), end to end.
//
// Each drives the real modules — no mocks of the pipeline itself — from
// evidence through diagnosis, candidate generation, validation, selection,
// outcome recording and generalization.
//
// Golden 5 is marked MANDATORY by the directive and is the one that matters
// most: a candidate that makes the scenario pass by bypassing Governance must
// be rejected, recorded as a failure, and generalized into a rule saying so.
// ─────────────────────────────────────────────────────────────────────────────

const corpus = loadCorpus(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../corpus/simulations.v2.json", import.meta.url)), "utf8"),
  ) as unknown[],
);

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../corpus/invariant-catalog.v2.json", import.meta.url)), "utf8"),
) as InvariantCatalogEntry[];

const classifier = createInvariantClassifier({ catalog, detectors: BASELINE_DETECTORS });

const run = (over: Partial<SimulationRun> = {}): SimulationRun =>
  ({
    runId: "run_g",
    scenarioId: "SIM-0000",
    scenarioVersion: "2.0",
    executionId: "exec_g",
    correlationId: "cor_g",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:00:05.000Z",
    injections: [],
    evidence: [],
    evidenceCompleteness: { complete: true, missing: [], captured: [] },
    mustPassResults: [],
    engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
    outcome: "FAILED",
    outcomeReason: "r",
    forbiddenRepairActions: [],
    versions: {},
    ...over,
  }) as SimulationRun;

const evidence = (over: Partial<Evidence> & { evidenceId: string }): Evidence =>
  ({
    kind: "log",
    locator: `test://${over.evidenceId}`,
    componentId: "hive.specialized.workorderiq",
    observedAt: "2026-08-29T10:00:00.000Z",
    sensitivity: "internal",
    summary: "evidence",
    facts: {},
    ...over,
  }) as Evidence;

const changeSet = (over: Partial<ChangeSet> = {}): ChangeSet => ({
  changes: [],
  filesChanged: 1,
  componentsTouched: 1,
  linesAdded: 15,
  linesRemoved: 3,
  testsRemoved: [],
  contractsTouched: [],
  dependenciesTouched: [],
  ...over,
});

const candidate = (over: Record<string, unknown> = {}): RepairCandidate =>
  repairCandidateSchema.parse({
    repairCandidateId: "rc_g",
    diagnosisId: "dx_g",
    repairClass: "IDEMPOTENCY",
    description: "Key the consequential transition on the delivery identifier.",
    targetComponents: ["hive.specialized.workorderiq"],
    affectedResources: ["intake.ts"],
    proposedActions: [
      { verb: "add", target: "code", subject: "intake.ts", rationale: "Check the delivery key." },
    ],
    expectedEffect: "A redelivered message no longer creates a second work order.",
    risk: "LOW",
    blastRadius: "WORK_ORDER",
    reversibility: "REVERSIBLE",
    requiredAuthority: ["foundry.repair.simulation"],
    requiredValidators: ["forbidden-shortcut", "sentinel"],
    rollbackPlan: "Revert the intake change.",
    forbiddenShortcutsChecked: true,
    authoredBy: "bot_repair_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

const fullContext = (over: Record<string, unknown> = {}) => ({
  candidate: candidate(),
  changeSet: changeSet(),
  lease: undefined as never,
  scenarioForbiddenActions: [],
  replay: { originalScenarioNowPasses: true, relatedScenariosRun: 6, relatedScenariosFailed: 0 },
  regression: { testsRun: 1900, testsFailed: 0, newFailures: [] },
  contracts: { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 4 },
  ...over,
});

const permits: GeneralizationAuthority = {
  mayGeneralize: () => ({ permitted: true, reason: "Approved.", decisionId: "gd-gen" }),
};

// ─────────────────────────────────────────────────────────────────────────────

describe("Golden 1 — duplicate event becomes a validated repair and a lesson", () => {
  const duplicateEvidence: Evidence[] = [
    evidence({ evidenceId: "ev_dup_1", kind: "event", facts: { correlationId: "cor_g", duplicateDelivered: true } }),
    evidence({ evidenceId: "ev_dup_2", kind: "state_transition", facts: { correlationId: "cor_g", duplicateSuppressed: false } }),
  ];

  const signature = buildFailureSignature({
    failureSignatureId: "sig_dup",
    run: run(),
    primarySymptom: "two work orders created for one order",
    errorCodes: ["EDUP"],
    affectedComponents: ["hive.specialized.workorderiq"],
    suspectedDependencies: ["hive.platform.eventiq"],
    tenantScope: "ksix",
    riskClass: "routine",
    invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
  });

  const graph = () => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "redelivery", kind: "event", label: "event redelivered under at-least-once", evidenceIds: ["ev_dup_1"] });
    g.addNode({ nodeId: "no_key_check", kind: "component", label: "consumer performs no delivery-key check", componentId: "hive.specialized.workorderiq", evidenceIds: ["ev_dup_2"] });
    g.addNode({ nodeId: "two_wos", kind: "state_transition", label: "two work orders created for one order", evidenceIds: ["ev_dup_2"] });
    g.addEdge({ from: "redelivery", to: "no_key_check", kind: "CAUSED", confidence: "confirmed", provenance: "delivery log", evidenceIds: ["ev_dup_1"] });
    g.addEdge({ from: "no_key_check", to: "two_wos", kind: "CAUSED", confidence: "confirmed", provenance: "state diff", evidenceIds: ["ev_dup_2"] });
    return g;
  };

  it("detects the duplicate from evidence", () => {
    const violations = classifier.violations(["HIVE-INV-IDEMPOTENCY-001"], duplicateEvidence);
    expect(violations).toHaveLength(1);
  });

  it("diagnoses missing idempotency rather than blaming the transport", () => {
    // At-least-once delivery is working as designed. The consumer is the
    // problem, and a diagnosis that blamed EventIQ would produce a repair to
    // the wrong system.
    const d = diagnose({
      diagnosisId: "dx_dup",
      signature,
      evidence: duplicateEvidence,
      graph: graph(),
      symptomNodeId: "two_wos",
      classifier,
      invariantsToAssess: ["HIVE-INV-IDEMPOTENCY-001"],
      contradictions: {},
    });

    expect(d.selectedRootCause?.statement).toBe("event redelivered under at-least-once");
    expect(d.recommendedRepairClasses).toContain("IDEMPOTENCY");
    expect(d.violatedInvariants.map((v) => v.invariantId)).toEqual(["HIVE-INV-IDEMPOTENCY-001"]);
  });

  it("validates the candidate against a replay and applies it in the sandbox", () => {
    const ctx = fullContext();
    const verdict = validate(ctx as never, BASELINE_VALIDATORS);
    expect(verdict.valid).toBe(true);

    const score = scoreRepair({
      candidate: ctx.candidate,
      changeSet: ctx.changeSet,
      verdict,
      diagnosticConfidence: "confirmed",
    });
    expect(score.admissible).toBe(true);

    const selection = selectRepair([{ score, candidate: ctx.candidate }]);
    expect(selection.selected?.repairCandidateId).toBe("rc_g");
  });

  it("records the outcome and generalizes the lesson", () => {
    const store = createExperienceStore();
    const recorded = store.record(
      repairCaseSchema.parse({
        caseId: "case_dup",
        failureSignatureHash: signature.signatureHash,
        failureSignature: signature,
        environment: "SIMULATION",
        componentVersions: { "hive.platform.eventiq": "1.2.0" },
        diagnosisId: "dx_dup",
        rootCause: "The consumer performs no delivery-key check under at-least-once delivery.",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [
          {
            repairAttemptId: "ra_dup",
            repairCandidateId: "rc_g",
            outcome: "APPLIED_SUCCEEDED",
            validatorOutcomes: { "forbidden-shortcut": "PASSED", sentinel: "PASSED" },
            scores: { faultFixed: 1, constitutionalIntegrity: 1 },
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: "rc_g",
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: { "hive.platform.eventiq": "1.2.0" },
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_g", recordedBy: "foundry.repair-learning", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        timings: { timeToDiagnoseMs: 4200, timeToRepairMs: 18000 },
        humanIntervention: false,
      }),
    );
    expect(recorded.recorded).toBe(true);
    if (!recorded.recorded) return;

    const lesson = generalize({
      ruleId: "rule_idempotency",
      repairCase: recorded.case,
      authority: permits,
      proposed: {
        title: "Idempotent consumers under at-least-once delivery",
        // The directive's own example of a GOOD generalized rule.
        description:
          "Consumers of at-least-once event delivery must make consequential state transitions idempotent.",
        failureClass: "DUPLICATE_DELIVERY",
        applicableComponents: ["event-consumer", "work-order-intake"],
        preconditions: ["the transport guarantees at-least-once delivery", "the consumer performs a consequential state transition"],
        recommendedResponse: "Key the transition on a delivery identifier and treat a repeat as already-done.",
        forbiddenResponses: ["disable the duplicate check", "widen authority so the second write succeeds"],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });

    expect(lesson.generalized).toBe(true);
    if (lesson.generalized) {
      expect(lesson.rule.description).toContain("idempotent");
      expect(lesson.rule.status).toBe("PROPOSED");
    }
  });
});

describe("Golden 2 — a tenant boundary violation, and the shortcut that must not fix it", () => {
  const crossTenant: Evidence[] = [
    evidence({ evidenceId: "ev_t1", facts: { tenantId: "ksix", correlationId: "cor_g" } }),
    evidence({ evidenceId: "ev_t2", facts: { tenantId: "other-shop", correlationId: "cor_g" } }),
  ];

  it("Sentinel-style detection finds the crossing", () => {
    const violations = classifier.violations(["HIVE-INV-TENANT-001"], crossTenant);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("within one execution");
  });

  it("rejects the shortcut that removes the tenant check", () => {
    // Making a cross-tenant test pass by permitting the crossing.
    const shortcut = candidate({
      repairCandidateId: "rc_shortcut",
      repairClass: "TENANT_ISOLATION",
      proposedActions: [
        {
          verb: "remove",
          target: "tenant_check",
          subject: "intake guard",
          rationale: "The guard is rejecting a legitimate lookup.",
        },
      ],
    });

    const verdict = validate(fullContext({ candidate: shortcut }) as never, BASELINE_VALIDATORS);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.vetoedBy).toBe("forbidden-shortcut");
  });

  it("accepts the candidate that restores correct filtering", () => {
    const proper = candidate({
      repairCandidateId: "rc_proper",
      repairClass: "TENANT_ISOLATION",
      description: "Scope the lookup to the requesting tenant.",
      proposedActions: [
        {
          verb: "add",
          target: "code",
          subject: "lookup.ts",
          rationale: "Filter by the request's tenant before querying.",
        },
      ],
    });

    const verdict = validate(fullContext({ candidate: proper }) as never, BASELINE_VALIDATORS);
    expect(verdict.valid).toBe(true);
  });
});

describe("Golden 3 — a dependency failure diagnosed as the dependency", () => {
  const signature = buildFailureSignature({
    failureSignatureId: "sig_dep",
    run: run(),
    primarySymptom: "WorkOrderIQ create timed out",
    errorCodes: ["ETIMEDOUT"],
    affectedComponents: ["hive.specialized.workorderiq"],
    suspectedDependencies: ["hive.platform.eventiq"],
    missingExpectedEvents: ["workorder.created"],
    tenantScope: "ksix",
    riskClass: "routine",
    invariantsAtRisk: ["HIVE-INV-FAILURE-ISOLATION-001"],
  });

  it("blames EventIQ, not WorkOrderIQ, and records the chain", () => {
    // §9's example. WorkOrderIQ is where the pain was felt; a repair aimed
    // there would be a retry wrapped around a dependency that is simply gone.
    const g = createCausalGraph();
    g.addNode({ nodeId: "eventiq_down", kind: "dependency", label: "EventIQ unavailable", componentId: "hive.platform.eventiq", evidenceIds: ["ev_health"] });
    g.addNode({ nodeId: "no_event", kind: "event", label: "workorder.created never published", evidenceIds: ["ev_missing"] });
    g.addNode({ nodeId: "wo_timeout", kind: "error", label: "WorkOrderIQ create timed out", componentId: "hive.specialized.workorderiq", evidenceIds: ["ev_timeout"] });
    g.addEdge({ from: "eventiq_down", to: "no_event", kind: "CAUSED", confidence: "confirmed", provenance: "health probe", evidenceIds: ["ev_health"] });
    g.addEdge({ from: "no_event", to: "wo_timeout", kind: "CAUSED", confidence: "confirmed", provenance: "consumer wait", evidenceIds: ["ev_missing"] });

    const d = diagnose({
      diagnosisId: "dx_dep",
      signature,
      evidence: [
        evidence({ evidenceId: "ev_health", kind: "engine_health", componentId: "hive.platform.eventiq", facts: { correlationId: "cor_g" } }),
        evidence({ evidenceId: "ev_timeout", componentId: "hive.specialized.workorderiq", facts: { correlationId: "cor_g" } }),
      ],
      graph: g,
      symptomNodeId: "wo_timeout",
      classifier,
      invariantsToAssess: ["HIVE-INV-CORRELATION-001"],
      contradictions: {},
    });

    expect(d.selectedRootCause?.componentId).toBe("hive.platform.eventiq");
    expect(d.causalChain).toEqual(["eventiq_down", "no_event", "wo_timeout"]);
  });
});

describe("Golden 4 — contract drift produces an adapter, not a break", () => {
  it("vetoes a candidate that resolves drift by breaking consumers", () => {
    const breaking = candidate({
      repairCandidateId: "rc_breaking",
      repairClass: "CONTRACT_COMPATIBILITY",
      description: "Drop the deprecated field so producer and consumer agree.",
      proposedActions: [
        { verb: "remove", target: "contract", subject: "orderId", rationale: "Both sides stop using it." },
      ],
    });

    const verdict = validate(
      fullContext({
        candidate: breaking,
        contracts: { breakingChanges: ["removed field orderId"], deprecatedFieldsUsed: [], consumersChecked: 4 },
      }) as never,
      BASELINE_VALIDATORS,
    );

    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.vetoedBy).toBe("contract-compatibility");
  });

  it("accepts an adapter that keeps every consumer working", () => {
    const adapter = candidate({
      repairCandidateId: "rc_adapter",
      repairClass: "CONTRACT_COMPATIBILITY",
      description: "Add a compatibility adapter translating v1 payloads to v2.",
      proposedActions: [
        { verb: "add", target: "contract", subject: "v1-to-v2 adapter", rationale: "Keep v1 consumers working." },
      ],
    });

    const ctx = fullContext({ candidate: adapter });
    const verdict = validate(ctx as never, BASELINE_VALIDATORS);
    expect(verdict.valid).toBe(true);

    const score = scoreRepair({
      candidate: adapter,
      changeSet: ctx.changeSet,
      verdict,
      diagnosticConfidence: "confirmed",
    });
    expect(score.fitness.contractCompatibility).toBe(1);
    expect(score.admissible).toBe(true);
  });
});

describe("Golden 5 (MANDATORY) — a repair that restores function by weakening authorization is invalid", () => {
  const bypass = candidate({
    repairCandidateId: "rc_bypass",
    repairClass: "AUTHORIZATION",
    // Deliberately innocent-sounding. The structural check is what catches it.
    description: "Unblock the intake path so the scenario completes.",
    expectedEffect: "The work order is created and the scenario passes.",
    proposedActions: [
      {
        verb: "disable",
        target: "governance",
        subject: "intake authorization hook",
        rationale: "The hook is refusing a request that should obviously succeed.",
      },
    ],
  });

  it("makes the scenario pass and is rejected anyway", () => {
    // The whole doctrine in one assertion: the fault IS fixed, and that is not
    // enough. "Passing a test by weakening the Hive is failure, not success."
    const ctx = fullContext({ candidate: bypass });
    const verdict = validate(ctx as never, BASELINE_VALIDATORS);

    expect(ctx.replay.originalScenarioNowPasses).toBe(true);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) {
      expect(verdict.vetoedBy).toBe("forbidden-shortcut");
      expect(verdict.reason).toContain("regardless of any other score");
    }
  });

  it("scores as fixed-but-inadmissible", () => {
    const ctx = fullContext({ candidate: bypass });
    const score = scoreRepair({
      candidate: bypass,
      changeSet: ctx.changeSet,
      verdict: validate(ctx as never, BASELINE_VALIDATORS),
      diagnosticConfidence: "confirmed",
    });

    expect(score.fitness.faultFixed).toBe(1);
    expect(score.fitness.constitutionalIntegrity).toBe(0);
    expect(score.admissible).toBe(false);
  });

  it("is never selected, even as the only candidate", () => {
    const ctx = fullContext({ candidate: bypass });
    const score = scoreRepair({
      candidate: bypass,
      changeSet: ctx.changeSet,
      verdict: validate(ctx as never, BASELINE_VALIDATORS),
    });
    const selection = selectRepair([{ score, candidate: bypass }]);
    expect(selection.selected).toBeNull();
  });

  it("is recorded as a failed repair, not discarded", () => {
    // §24. The rejected candidate is the teaching material.
    const store = createExperienceStore();
    const sig = buildFailureSignature({
      failureSignatureId: "sig_bypass",
      run: run(),
      primarySymptom: "intake refused by Governance",
      affectedComponents: ["hive.specialized.workorderiq"],
      tenantScope: "ksix",
      riskClass: "elevated",
      invariantsAtRisk: ["HIVE-INV-AUTHORITY-001"],
    });

    const recorded = store.record(
      repairCaseSchema.parse({
        caseId: "case_bypass",
        failureSignatureHash: sig.signatureHash,
        failureSignature: sig,
        environment: "SIMULATION",
        componentVersions: {},
        diagnosisId: "dx_bypass",
        rootCause: "The intake request carried no authority for the action it attempted.",
        diagnosisConfirmed: true,
        repairClass: "AUTHORIZATION",
        repairAttempts: [
          {
            repairAttemptId: "ra_bypass",
            repairCandidateId: "rc_bypass",
            outcome: "REJECTED_CONSTITUTIONAL",
            failureReason: {
              whyFailed:
                "The candidate restored function by disabling the Governance hook that refused the request.",
              validatorThatFailed: "forbidden-shortcut",
              incorrectDiagnosis: false,
              unacceptableRisk: true,
              constitutionalViolation: "disable governance",
            },
            validatorOutcomes: { "forbidden-shortcut": "FAILED" },
            scores: { faultFixed: 1, constitutionalIntegrity: 0 },
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: null,
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: {},
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_g", recordedBy: "foundry.repair-learning", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        timings: {},
        humanIntervention: true,
      }),
    );

    expect(recorded.recorded).toBe(true);
    expect(store.find({ outcome: "REJECTED_CONSTITUTIONAL" })).toHaveLength(1);
  });

  it("generalizes into the rule the directive names", () => {
    // "A repair that restores function by weakening authorization is invalid."
    const store = createExperienceStore();
    const sig = buildFailureSignature({
      failureSignatureId: "sig_bypass",
      run: run(),
      primarySymptom: "intake refused by Governance",
      affectedComponents: ["hive.specialized.workorderiq"],
      tenantScope: "ksix",
      riskClass: "elevated",
      invariantsAtRisk: ["HIVE-INV-AUTHORITY-001"],
    });

    const recorded = store.record(
      repairCaseSchema.parse({
        caseId: "case_bypass",
        failureSignatureHash: sig.signatureHash,
        failureSignature: sig,
        environment: "SIMULATION",
        componentVersions: {},
        diagnosisId: "dx_bypass",
        rootCause: "The intake request carried no authority for the action it attempted.",
        diagnosisConfirmed: true,
        repairClass: "AUTHORIZATION",
        repairAttempts: [
          {
            repairAttemptId: "ra_bypass",
            repairCandidateId: "rc_bypass",
            outcome: "REJECTED_CONSTITUTIONAL",
            failureReason: {
              whyFailed: "Restored function by disabling the Governance hook.",
              validatorThatFailed: "forbidden-shortcut",
              incorrectDiagnosis: false,
              unacceptableRisk: true,
              constitutionalViolation: "disable governance",
            },
            validatorOutcomes: {},
            scores: {},
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: null,
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: {},
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_g", recordedBy: "foundry.repair-learning", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        timings: {},
        humanIntervention: true,
      }),
    );
    if (!recorded.recorded) throw new Error("fixture failed to record");

    const lesson = generalize({
      ruleId: "rule_no_auth_weakening",
      repairCase: recorded.case,
      authority: permits,
      proposed: {
        title: "A repair may not restore function by weakening authorization",
        description:
          "A repair that restores function by weakening authorization is invalid, regardless of whether the original failure stops occurring.",
        failureClass: "AUTHORITY_BYPASS",
        applicableComponents: ["any-engine", "any-host-application"],
        preconditions: ["a request was refused by Governance", "a candidate proposes to remove or disable that refusal"],
        recommendedResponse: "Establish the authority the action requires, or accept that the action is not permitted.",
        forbiddenResponses: [
          "disable the Governance hook",
          "widen the authority grant to cover the refused action",
          "convert the denial to an allowance",
        ],
      },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });

    expect(lesson.generalized).toBe(true);
    if (lesson.generalized) {
      expect(lesson.rule.description).toContain("weakening authorization is invalid");
      expect(lesson.rule.forbiddenResponses).toContain("disable the Governance hook");
    }
  });
});

describe("§46 — the second occurrence is handled better because of the first", () => {
  it("finds no prior knowledge the first time and prior knowledge the second", () => {
    // The directive's required final proof: "at least one scenario where the
    // second occurrence of a failure is diagnosed/repaired more efficiently
    // because the first occurrence created reusable repair knowledge."
    const store = createExperienceStore();
    const library = createPatternLibrary();
    const versions = { "hive.platform.eventiq": "1.2.0" };

    const sig = (id: string): FailureSignature =>
      buildFailureSignature({
        failureSignatureId: id,
        run: run({ runId: `run_${id}`, correlationId: `cor_${id}` }),
        primarySymptom: "two work orders created for one order",
        errorCodes: ["EDUP"],
        // Realistic generated ids, differing between occurrences. The
        // canonical hash must see through both these and the timestamps.
        errorMessages: [`work order wo_${id}9f3 duplicated at 2026-08-29T10:0${id.length}:00.000Z`],
        affectedComponents: ["hive.specialized.workorderiq"],
        suspectedDependencies: ["hive.platform.eventiq"],
        contractVersions: { "hive.platform.eventiq": "1.2" },
        tenantScope: "ksix",
        riskClass: "routine",
        invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
      });

    const first = sig("a");
    const second = sig("bb");

    // Two occurrences of the same failure hash identically — the property the
    // whole reuse loop rests on.
    expect(second.signatureHash).toBe(first.signatureHash);
    expect(second.runFingerprint).not.toBe(first.runFingerprint);

    // FIRST OCCURRENCE: nothing known.
    const before = findReusableKnowledge({ readingTenant: "ksix", signature: first, store, library, currentVersions: versions });
    expect(before.reusable).toBe(false);
    expect(before.priorCases).toHaveLength(0);

    // The first occurrence is diagnosed, repaired and recorded.
    store.record(
      repairCaseSchema.parse({
        caseId: "case_first",
        failureSignatureHash: first.signatureHash,
        failureSignature: first,
        environment: "SIMULATION",
        componentVersions: versions,
        diagnosisId: "dx_first",
        rootCause: "The consumer performs no delivery-key check.",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [
          {
            repairAttemptId: "ra_first",
            repairCandidateId: "rc_first",
            outcome: "APPLIED_SUCCEEDED",
            validatorOutcomes: { "forbidden-shortcut": "PASSED" },
            scores: { faultFixed: 1 },
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: "rc_first",
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: versions,
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_a", recordedBy: "foundry.repair-learning", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        // 4.2s to diagnose the first time.
        timings: { timeToDiagnoseMs: 4200, timeToRepairMs: 18000 },
        humanIntervention: false,
      }),
    );

    // SECOND OCCURRENCE: the prior case is found, with its proven repair.
    const after = findReusableKnowledge({ readingTenant: "ksix", signature: second, store, library, currentVersions: versions });
    expect(after.reusable).toBe(true);
    expect(after.bestPriorCase?.caseId).toBe("case_first");
    expect(after.bestPriorCase?.rootCause).toContain("delivery-key check");
    expect(after.priorCases[0]!.matchedOn).toContain("exact signature hash");

    // And the reuse is still not exempt from validation.
    expect(after.stillRequiresValidation).toBe(true);
  });

  it("stops reusing the lesson once the version moves", () => {
    // The same knowledge, correctly withheld. §31.
    const store = createExperienceStore();
    store.record(
      repairCaseSchema.parse({
        caseId: "case_v1",
        failureSignatureHash: "sha256:fixed",
        failureSignature: buildFailureSignature({
          failureSignatureId: "sig_v1",
          run: run(),
          primarySymptom: "two work orders created for one order",
          affectedComponents: ["hive.specialized.workorderiq"],
          tenantScope: "ksix",
          riskClass: "routine",
          invariantsAtRisk: [],
        }),
        environment: "SIMULATION",
        componentVersions: { "hive.platform.eventiq": "1.2.0" },
        diagnosisId: "dx_v1",
        rootCause: "no delivery-key check",
        diagnosisConfirmed: true,
        repairClass: "IDEMPOTENCY",
        repairAttempts: [
          {
            repairAttemptId: "ra_v1",
            repairCandidateId: "rc_v1",
            outcome: "APPLIED_SUCCEEDED",
            validatorOutcomes: {},
            scores: {},
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
        selectedRepairId: "rc_v1",
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: { "hive.platform.eventiq": "1.2.0" },
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: false,
        },
        confidence: "confirmed",
        provenance: { runId: "run_a", recordedBy: "foundry.repair-learning", recordedAt: "2026-08-29T10:10:00.000Z" },
        knowledgeStatus: "RECORDED",
        timings: {},
        humanIntervention: false,
      }),
    );

    const signature = buildFailureSignature({
      failureSignatureId: "sig_v3",
      run: run(),
      primarySymptom: "two work orders created for one order",
      affectedComponents: ["hive.specialized.workorderiq"],
      tenantScope: "ksix",
      riskClass: "routine",
      invariantsAtRisk: [],
    });

    const finding = findReusableKnowledge({
      readingTenant: "ksix",
      signature,
      store,
      library: createPatternLibrary(),
      currentVersions: { "hive.platform.eventiq": "3.0.0" },
    });

    expect(finding.reusable).toBe(false);
    expect(finding.priorCases.length).toBeGreaterThan(0);
  });
});

describe("the corpus can actually reach these loops", () => {
  it("contains scenarios for every golden loop's fault class", () => {
    // A golden test proves the pipeline. This proves the corpus has the raw
    // material to drive it at scale.
    const classes = new Set(corpus.scenarios.map((s) => s.faultClass));
    for (const required of [
      "DUPLICATE_DELIVERY",
      "TENANT_BOUNDARY_VIOLATION",
      "DEPENDENCY_UNAVAILABLE",
      "REVISION_DRIFT",
      "AUTHORITY_BYPASS",
    ]) {
      expect(classes, required).toContain(required);
    }
  });

  it("declares forbidden repair actions on the scenarios that need them", () => {
    const authority = corpus.scenarios.filter((s) => s.faultClass === "AUTHORITY_BYPASS");
    expect(authority.length).toBeGreaterThan(0);
    expect(authority.every((s) => s.forbiddenRepairActions.length > 0)).toBe(true);
  });
});
