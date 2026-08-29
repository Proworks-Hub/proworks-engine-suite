// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { createAuditIq } from "@proworks-hub/auditiq";

import {
  BASELINE_VALIDATORS,
  REPAIR_AUDIT_ACTIONS,
  agentLeaseSchema,
  auditSeams,
  createDiagnosticBot,
  createRepairAuditor,
  createRepairBot,
  repairBotLease,
  repairCandidateSchema,
  scoreRepair,
  V1_DEFAULT_ACTIONS,
  validate,
  type AuditContext,
  type ChangeSet,
  type Diagnosis,
  type GeneralizedRule,
  type InvariantAssessment,
  type RepairCandidate,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// AuditIQ wiring (§38).
//
// Foundry Charter §16: material actions must identify what was proposed, which
// agents participated, the authority permitting it, and the validation that
// followed.
// ─────────────────────────────────────────────────────────────────────────────

let counter = 0;
const audit = () =>
  createAuditIq({
    now: () => new Date("2026-08-29T10:00:00.000Z"),
    generateId: () => `aud_${(counter += 1)}`,
  });

const context: AuditContext = {
  tenant: { organizationId: "ksix", roles: [] },
  correlationId: "cor_1",
  executionId: "exec_1",
  governanceDecisionId: "gd-4471",
};

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
    symptoms: ["two work orders"],
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
    ...over,
  }) as Diagnosis;

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
    authoredBy: "bot_repair_1",
    authoredAt: "2026-08-29T10:00:00.000Z",
    ...over,
  });

const changeSet: ChangeSet = {
  changes: [],
  filesChanged: 1,
  componentsTouched: 1,
  linesAdded: 12,
  linesRemoved: 2,
  testsRemoved: [],
  contractsTouched: [],
  dependenciesTouched: [],
};

const validationContext = (c: RepairCandidate) => ({
  candidate: c,
  changeSet,
  lease: undefined as never,
  scenarioForbiddenActions: [],
  replay: { originalScenarioNowPasses: true, relatedScenariosRun: 4, relatedScenariosFailed: 0 },
  regression: { testsRun: 100, testsFailed: 0, newFailures: [] },
  contracts: { breakingChanges: [], deprecatedFieldsUsed: [], consumersChecked: 2 },
});

const lease = () =>
  repairBotLease({
    agentId: "bot_repair_1",
    mission: "Restore idempotent intake.",
    targetComponents: ["hive.specialized.workorderiq"],
    targetRepository: "proworks-engine-suite",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    expiresAt: "2026-08-29T14:00:00.000Z",
    governanceReference: "gd-4471",
    sentinelSession: "sen-991",
  });

describe("every action AuditIQ accepts", () => {
  it("covers the eleven §38 actions", () => {
    expect(REPAIR_AUDIT_ACTIONS).toHaveLength(11);
    for (const required of [
      "repair.diagnosis_created",
      "repair.candidate_created",
      "repair.rejected",
      "repair.validated",
      "repair.selected",
      "repair.applied",
      "repair.rolled_back",
      "repair.generalized",
      "repair.pattern_promoted",
      "repair.agent_lease_issued",
      "repair.agent_lease_expired",
    ]) {
      expect(REPAIR_AUDIT_ACTIONS as readonly string[], required).toContain(required);
    }
  });

  it("writes every action without a single refusal", () => {
    // A refused audit write means this subsystem is emitting malformed
    // evidence. Exercising all eleven against the real store is the only way to
    // know the shapes are right.
    const log = audit();
    const auditor = createRepairAuditor({ audit: log });

    const c = candidate();
    const verdict = validate(validationContext(c), BASELINE_VALIDATORS);
    const score = scoreRepair({ candidate: c, changeSet, verdict });
    const rule: GeneralizedRule = {
      ruleId: "rule_1",
      title: "Idempotent consumers under at-least-once delivery",
      description: "Consumers must make consequential transitions idempotent.",
      failureClass: "DUPLICATE_DELIVERY",
      repairClass: "IDEMPOTENCY",
      applicableComponents: ["event-consumer"],
      applicableContracts: [],
      preconditions: ["at-least-once delivery"],
      recommendedResponse: "Key on a delivery identifier.",
      forbiddenResponses: ["disable the duplicate check"],
      confidence: "suspected",
      evidenceCount: 1,
      provenance: {
        derivedFromCaseIds: ["case_1"],
        proposedBy: "foundry.generalizer",
        proposedAt: "2026-08-29T11:00:00.000Z",
        governanceReference: "gd-gen-1",
      },
      constitutionVersion: "1.0",
      charterVersions: {},
      status: "PROPOSED",
    };

    auditor.diagnosisCreated(diagnosis(), "bot_dx_1", context);
    auditor.candidateCreated(c, context);
    auditor.candidateValidated("rc_1", verdict, context);
    auditor.repairSelected(score, context);
    auditor.repairApplied("rc_1", "SIMULATION", context);
    auditor.repairRolledBack("rc_1", "A regression appeared in a neighbouring scenario.", context);
    auditor.lessonGeneralized(rule, context);
    auditor.patternPromoted("pat_1", ["rule_1"], context);
    auditor.leaseIssued(lease(), context);
    auditor.leaseExpired(lease(), context);

    const rejected = validate(
      validationContext(
        candidate({
          repairCandidateId: "rc_bad",
          proposedActions: [
            { verb: "disable", target: "governance", subject: "hook", rationale: "unblock" },
          ],
        }),
      ),
      BASELINE_VALIDATORS,
    );
    if (rejected.valid) throw new Error("fixture should have been rejected");
    auditor.candidateRejected("rc_bad", rejected, context);

    expect(auditor.rejected()).toEqual([]);
    expect(log.count()).toBe(11);
    expect(log.verify().intact).toBe(true);
  });
});

describe("rejections are recorded as loudly as approvals", () => {
  it("records a validator veto as failed, not denied", () => {
    // I originally wrote `denied` here, reasoning that a veto is a decision
    // rather than a fault. AuditIQ refused the record: a denied action must
    // reference the Governance decision that denied it, and a validator veto
    // has none. The decision this subsystem holds PERMITTED the session, so
    // recording it as the denier would attribute a refusal to an authorization.
    const log = audit();
    const auditor = createRepairAuditor({ audit: log });

    const bad = candidate({
      repairCandidateId: "rc_bad",
      proposedActions: [
        { verb: "widen", target: "authority_grant", subject: "g", rationale: "unblock" },
      ],
    });
    const verdict = validate(validationContext(bad), BASELINE_VALIDATORS);
    if (verdict.valid) throw new Error("fixture should have been rejected");

    auditor.candidateRejected("rc_bad", verdict, context);

    const record = log.query({ action: "repair.rejected" })[0]!;
    expect(record.record.outcome).toBe("failed");
    expect(record.record.reason).toContain("regardless of any other score");
    expect(record.record.detail?.vetoedBy).toBe("forbidden-shortcut");
  });

  it("leaves a queryable trail of every refusal", () => {
    // An audit trail showing only successes is one where the constitutional
    // vetoes left no trace, and the veto is the part somebody wants to review.
    const log = audit();
    const auditor = createRepairAuditor({ audit: log });

    for (const id of ["rc_a", "rc_b"]) {
      const bad = candidate({
        repairCandidateId: id,
        proposedActions: [{ verb: "remove", target: "test", subject: "t", rationale: "r" }],
      });
      const verdict = validate(validationContext(bad), BASELINE_VALIDATORS);
      if (verdict.valid) throw new Error("fixture should have been rejected");
      auditor.candidateRejected(id, verdict, context);
    }

    expect(log.query({ action: "repair.rejected" })).toHaveLength(2);
    expect(log.query({ outcome: "failed" })).toHaveLength(2);
  });
});

describe("what goes into an audit record, and what does not", () => {
  it("records references and scalars, never the candidate itself", () => {
    // AuditIQ owns "audit event structures... NOT domain source records". A
    // record carrying the whole candidate would make it a second store of
    // everything repair learning has ever seen.
    const log = audit();
    createRepairAuditor({ audit: log }).candidateCreated(candidate(), context);

    const record = log.query()[0]!.record;
    expect(record.target).toEqual({ type: "repair_candidate", id: "rc_1" });
    for (const [, value] of Object.entries(record.detail ?? {})) {
      expect(typeof value).not.toBe("object");
    }
    expect(JSON.stringify(record)).not.toContain("proposedActions");
  });

  it("puts deployment authority where an auditor looks first", () => {
    const log = audit();
    createRepairAuditor({ audit: log }).leaseIssued(lease(), context);
    const record = log.query()[0]!.record;
    expect(record.detail?.deploymentAuthority).toBe(false);
    expect(record.governanceDecisionId).toBe("gd-4471");
  });

  it("names the authority permitting a generalization", () => {
    // Foundry Charter §16: material actions identify the authority permitting
    // them. For a generalization that is Governance's decision, not the
    // caller's context.
    const log = audit();
    createRepairAuditor({ audit: log }).lessonGeneralized(
      {
        ruleId: "rule_1",
        title: "t",
        description: "d",
        failureClass: "f",
        repairClass: "IDEMPOTENCY",
        applicableComponents: ["c"],
        applicableContracts: [],
        preconditions: ["p"],
        recommendedResponse: "r",
        forbiddenResponses: ["f"],
        confidence: "suspected",
        evidenceCount: 1,
        provenance: {
          derivedFromCaseIds: ["case_1"],
          proposedBy: "foundry.generalizer",
          proposedAt: "2026-08-29T11:00:00.000Z",
          governanceReference: "gd-gen-7",
        },
        constitutionVersion: "1.0",
        charterVersions: {},
        status: "PROPOSED",
      },
      context,
    );

    expect(log.query()[0]!.record.governanceDecisionId).toBe("gd-gen-7");
  });

  it("records a diagnosis that reached no conclusion", () => {
    const log = audit();
    createRepairAuditor({ audit: log }).diagnosisCreated(
      diagnosis({
        selectedRootCause: null,
        requiresHumanReview: true,
        reviewReason: "Two hypotheses are indistinguishable.",
        confidence: null,
      }),
      "bot_dx_1",
      context,
    );

    const record = log.query()[0]!.record;
    expect(record.reason).toContain("no selected root cause");
    expect(record.detail?.requiresHumanReview).toBe(true);
  });
});

describe("the pipeline stays unaware of AuditIQ", () => {
  it("binds through the callback seams rather than an import", () => {
    // A pipeline that imported AuditIQ would be one where an engine cannot run
    // without an audit store, and a host would eventually make it optional to
    // get a test passing.
    const log = audit();
    const auditor = createRepairAuditor({ audit: log });
    const seams = auditSeams(auditor, context);

    const bot = createRepairBot({
      botId: "bot_repair_1",
      lease: lease(),
      ...seams.repairBot,
    });

    bot.authorCandidates({
      diagnosis: diagnosis(),
      environment: "SIMULATION",
      now: new Date("2026-08-29T11:00:00.000Z"),
    });

    expect(log.query({ action: "repair.candidate_created" })).toHaveLength(1);
  });

  it("wires the diagnostic bot's proposals too", () => {
    const log = audit();
    const seams = auditSeams(createRepairAuditor({ audit: log }), context);

    // The diagnostic bot's seam takes (diagnosis, botId).
    seams.diagnosticBot.onProposal(diagnosis(), "bot_dx_1");

    const record = log.query({ action: "repair.diagnosis_created" })[0]!;
    expect(record.record.detail?.byBot).toBe("bot_dx_1");
  });

  it("keeps the chain intact across a whole loop", () => {
    // Tamper-evidence is the reason to use AuditIQ rather than a log file.
    const log = audit();
    const auditor = createRepairAuditor({ audit: log });
    const seams = auditSeams(auditor, context);

    createDiagnosticBot({
      botId: "bot_dx_1",
      scope: {
        runIds: ["run_1"],
        tenants: ["ksix"],
        mayReadContracts: true,
        mayReadArchitectureDocs: true,
        mayReadPriorCases: true,
      },
      ...seams.diagnosticBot,
    });

    createRepairBot({ botId: "bot_repair_1", lease: lease(), ...seams.repairBot }).authorCandidates({
      diagnosis: diagnosis(),
      environment: "SIMULATION",
      now: new Date("2026-08-29T11:00:00.000Z"),
    });

    auditor.leaseIssued(lease(), context);
    expect(log.verify().intact).toBe(true);
    expect(log.count()).toBeGreaterThanOrEqual(2);
  });
});

describe("an audit failure does not abort the repair it was recording", () => {
  it("collects a refusal rather than throwing", () => {
    const log = audit();
    const auditor = createRepairAuditor({ audit: log, component: "" });
    expect(() => auditor.candidateCreated(candidate(), context)).not.toThrow();
    // An empty component is invalid evidence, so AuditIQ refuses and the
    // auditor reports it as a finding rather than losing it.
    expect(auditor.rejected().length).toBeGreaterThan(0);
    expect(log.count()).toBe(0);
  });
});
