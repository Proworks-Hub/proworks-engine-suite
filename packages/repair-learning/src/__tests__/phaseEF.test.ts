// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  buildFailureSignature,
  checkEligibility,
  checkMinimization,
  createExperienceStore,
  createPatternLibrary,
  findReusableKnowledge,
  generalize,
  repairCaseSchema,
  versionsCompatibleForReuse,
  type FailureSignature,
  type GeneralizationAuthority,
  type RepairCase,
  type SimulationRun,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phases E and F — Learn and Reuse.
//
// §27: "A Repair Experience is not automatically Hive Knowledge."
// ─────────────────────────────────────────────────────────────────────────────

const run = (over: Partial<SimulationRun> = {}): SimulationRun =>
  ({
    runId: "run_1",
    scenarioId: "SIM-0101",
    scenarioVersion: "2.0",
    executionId: "exec_1",
    correlationId: "cor_1",
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

const signature = (over: Record<string, unknown> = {}): FailureSignature =>
  buildFailureSignature({
    failureSignatureId: "sig_1",
    run: run(),
    primarySymptom: "duplicate work order created",
    errorCodes: ["EDUP"],
    affectedComponents: ["hive.specialized.workorderiq"],
    suspectedDependencies: ["hive.platform.eventiq"],
    tenantScope: "ksix",
    riskClass: "routine",
    invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
    ...over,
  });

const repairCase = (over: Record<string, unknown> = {}): RepairCase =>
  repairCaseSchema.parse({
    caseId: "case_1",
    failureSignatureHash: signature().signatureHash,
    failureSignature: signature(),
    environment: "SIMULATION",
    componentVersions: { "hive.platform.eventiq": "1.2.0" },
    diagnosisId: "dx_1",
    rootCause: "The work-order consumer is not idempotent on the delivery key.",
    diagnosisConfirmed: true,
    repairClass: "IDEMPOTENCY",
    repairAttempts: [
      {
        repairAttemptId: "ra_1",
        repairCandidateId: "rc_1",
        outcome: "APPLIED_SUCCEEDED",
        validatorOutcomes: { "forbidden-shortcut": "PASSED" },
        scores: { faultFixed: 1, constitutionalIntegrity: 1 },
        attemptedAt: "2026-08-29T10:05:00.000Z",
      },
    ],
    selectedRepairId: "rc_1",
    applicabilityScope: {
      components: ["hive.specialized.workorderiq"],
      engineVersions: { "hive.platform.eventiq": "1.2.0" },
      contractVersions: {},
      constitutionVersion: "1.0",
      environments: ["SIMULATION"],
      crossTenantLearningApproved: false,
    },
    confidence: "confirmed",
    provenance: {
      runId: "run_1",
      scenarioId: "SIM-0101",
      recordedBy: "foundry.repair-learning",
      recordedAt: "2026-08-29T10:10:00.000Z",
    },
    knowledgeStatus: "RECORDED",
    timings: { timeToDiagnoseMs: 4200, timeToRepairMs: 18000 },
    humanIntervention: false,
    ...over,
  });

const permits: GeneralizationAuthority = {
  mayGeneralize: () => ({ permitted: true, reason: "Approved for this test.", decisionId: "gd-gen-1" }),
};

const refuses: GeneralizationAuthority = {
  mayGeneralize: () => ({
    permitted: false,
    reason: "Cross-tenant learning has not been approved for this tenant.",
    decisionId: "gd-gen-2",
  }),
};

const goodLesson = {
  title: "Idempotent consumers under at-least-once delivery",
  description:
    "A consumer of at-least-once event delivery must make consequential state transitions idempotent, because a redelivered message is expected rather than exceptional.",
  failureClass: "DUPLICATE_DELIVERY",
  applicableComponents: ["event-consumer", "work-order-intake"],
  preconditions: ["the transport guarantees at-least-once delivery", "the consumer performs a consequential state transition"],
  recommendedResponse: "Key the consequential transition on a delivery identifier and treat a repeat as already-done.",
  forbiddenResponses: ["disable the duplicate check", "widen authority so the second write succeeds"],
};

describe("failed repairs are kept as learning data", () => {
  it("requires a failed attempt to say why", () => {
    // An unexplained failure teaches nothing, and §24 keeps failures precisely
    // so they can teach.
    const withoutReason = repairCaseSchema.safeParse({
      ...repairCase(),
      repairAttempts: [
        {
          repairAttemptId: "ra_2",
          repairCandidateId: "rc_2",
          outcome: "REJECTED_CONSTITUTIONAL",
          validatorOutcomes: {},
          scores: {},
          attemptedAt: "2026-08-29T10:05:00.000Z",
        },
      ],
      selectedRepairId: null,
    });
    expect(withoutReason.success).toBe(false);
  });

  it("stores a case whose only attempts failed", () => {
    // §24: "Do not store only successful repairs." A store that keeps only
    // successes produces a system that has never seen a bad idea.
    const store = createExperienceStore();
    const result = store.record(
      repairCase({
        caseId: "case_failed",
        selectedRepairId: null,
        repairAttempts: [
          {
            repairAttemptId: "ra_3",
            repairCandidateId: "rc_3",
            outcome: "REJECTED_CONSTITUTIONAL",
            failureReason: {
              whyFailed: "The candidate widened an authority grant to make the write succeed.",
              validatorThatFailed: "forbidden-shortcut",
              incorrectDiagnosis: false,
              unacceptableRisk: false,
              constitutionalViolation: "widen authority_grant",
            },
            validatorOutcomes: { "forbidden-shortcut": "FAILED" },
            scores: { constitutionalIntegrity: 0 },
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
      }),
    );
    expect(result.recorded).toBe(true);
    expect(store.find({ outcome: "REJECTED_CONSTITUTIONAL" })).toHaveLength(1);
  });

  it("refuses a case recording neither a success nor a failure", () => {
    expect(
      repairCaseSchema.safeParse({
        ...repairCase(),
        selectedRepairId: null,
        repairAttempts: [
          {
            repairAttemptId: "ra_4",
            repairCandidateId: "rc_4",
            outcome: "NOT_SELECTED",
            failureReason: { whyFailed: "another candidate was preferred", incorrectDiagnosis: false, unacceptableRisk: false },
            validatorOutcomes: {},
            scores: {},
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("never deletes a case, only moves its status", () => {
    const store = createExperienceStore();
    store.record(repairCase());
    store.setKnowledgeStatus("case_1", "SUPERSEDED", "A later case covers this.");
    expect(store.count()).toBe(1);
    expect(store.find({ knowledgeStatus: "SUPERSEDED" })).toHaveLength(1);
  });
});

describe("retrieval is deterministic before it is similar", () => {
  const populated = () => {
    const store = createExperienceStore();
    store.record(repairCase());
    store.record(
      repairCase({
        caseId: "case_2",
        failureSignatureHash: signature({ primarySymptom: "cost result negative" }).signatureHash,
        failureSignature: signature({
          primarySymptom: "cost result negative",
          errorCodes: ["EMARGIN"],
          affectedComponents: ["hive.specialized.costiq"],
          suspectedDependencies: [],
        }),
      }),
    );
    return store;
  };

  it("matches an identical signature exactly and says so", () => {
    // §26: deterministic first. An exact hash match is the strongest and
    // cheapest signal, and it short-circuits scoring entirely.
    const found = populated().similarTo(signature(), "ksix");
    expect(found[0]!.similarity).toBe(1);
    expect(found[0]!.matchedOn).toContain("exact signature hash");
  });

  it("names the deterministic reason a case surfaced", () => {
    // "Do not make vector similarity the sole retrieval method." Every result
    // says which concrete field matched.
    const found = populated().similarTo(signature(), "ksix");
    expect(found[0]!.matchedOn.join()).toContain("components:");
  });

  it("does not surface an unrelated failure", () => {
    // `readingTenant` is "ksix" and that is load-bearing. This call used to
    // omit it, which typechecked as an error and passed anyway: with the
    // argument undefined the tenant gate excluded every stored case, so the
    // empty result proved the gate worked rather than proving the signature
    // was unrelated. Same assertion, opposite meaning.
    const found = populated().similarTo(
      signature({
        primarySymptom: "completely different thing",
        errorCodes: ["EOTHER"],
        affectedComponents: ["hive.specialized.visioniq"],
        suspectedDependencies: [],
      }),
      "ksix",
    );
    expect(found).toHaveLength(0);
  });

  it("would have surfaced a related failure for the same tenant", () => {
    // The control for the test above. Without this, "no results" is equally
    // consistent with a store that never returns anything.
    const found = populated().similarTo(signature(), "ksix");
    expect(found.length).toBeGreaterThan(0);
  });
});

describe("a repair experience is not automatically Hive knowledge", () => {
  it("refuses to generalize an unconfirmed diagnosis", () => {
    const check = checkEligibility(repairCase({ diagnosisConfirmed: null }));
    expect(check.eligible).toBe(false);
    expect(check.reasons.join()).toContain("Unconfirmed is not confirmed");
  });

  it("refuses to generalize from a diagnosis later found wrong", () => {
    const check = checkEligibility(repairCase({ diagnosisConfirmed: false }));
    expect(check.eligible).toBe(false);
    expect(check.reasons.join()).toContain("teaches the wrong thing confidently");
  });

  it("refuses to generalize a merely suspected case", () => {
    // A suspicion does not become a rule by being written down.
    expect(checkEligibility(repairCase({ confidence: "suspected" })).eligible).toBe(false);
  });

  it("stops at the governance stage when Governance refuses", () => {
    // §36: Governance controls Knowledge Core generalization. A single boolean
    // would make "not eligible" and "Governance said no" indistinguishable.
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: refuses,
      proposed: goodLesson,
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(result.generalized).toBe(false);
    if (!result.generalized) expect(result.stage).toBe("governance");
  });

  it("asks Governance before doing the abstraction work", () => {
    // Otherwise the refusal arrives after the work.
    let asked = false;
    generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: {
        mayGeneralize: () => {
          asked = true;
          return { permitted: false, reason: "no", decisionId: "gd-x" };
        },
      },
      // Deliberately bad — minimization would reject it, but Governance runs
      // first so this never gets that far.
      proposed: { ...goodLesson, description: "Tenant ksix order 388 failed at 2:14 am." },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(asked).toBe(true);
  });
});

describe("minimization is the containment boundary", () => {
  it("rejects the directive's own bad example", () => {
    // "Tenant ABC's order 388 failed on server X at 2:14 AM." — tenant data
    // reclassified as knowledge.
    const check = checkMinimization({
      ...goodLesson,
      description: "Tenant ksix order 388 failed on server web-04 at 2:14 am.",
    });
    expect(check.clean).toBe(false);
    expect(check.found.length).toBeGreaterThan(1);
  });

  it("accepts the directive's own good example", () => {
    // "Consumers of at-least-once event delivery must make consequential state
    // transitions idempotent."
    expect(checkMinimization(goodLesson).clean).toBe(true);
  });

  it("catches identifying material hiding outside the description", () => {
    // A tenant id in applicableComponents is just as escaped as one in the
    // title.
    const check = checkMinimization({
      ...goodLesson,
      applicableComponents: ["wo_8f3a2b", "event-consumer"],
    });
    expect(check.clean).toBe(false);
  });

  it("blocks the pipeline at the minimization stage", () => {
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: permits,
      proposed: { ...goodLesson, description: "The failure happened at 2026-08-29T10:00 on server web-04." },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(result.generalized).toBe(false);
    if (!result.generalized) {
      expect(result.stage).toBe("minimization");
      expect(result.reason).toContain("readable by everything that reads knowledge");
    }
  });
});

describe("abstraction must actually abstract", () => {
  it("refuses a lesson that only restates the case", () => {
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: permits,
      // The exact components of the case. That is the case reworded.
      proposed: { ...goodLesson, applicableComponents: ["hive.specialized.workorderiq"] },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(result.generalized).toBe(false);
    if (!result.generalized) {
      expect(result.stage).toBe("abstraction");
      expect(result.reason).toContain("Name the KIND of component");
    }
  });

  it("produces a PROPOSED rule, never an APPROVED one", () => {
    // A pipeline that emitted APPROVED rules would be approving its own output.
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: permits,
      proposed: goodLesson,
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(result.generalized).toBe(true);
    if (result.generalized) {
      expect(result.rule.status).toBe("PROPOSED");
      expect(result.rule.provenance.governanceReference).toBe("gd-gen-1");
    }
  });

  it("calls a one-case rule suspected, not confirmed", () => {
    // One case is an anecdote, and a rule drawn from an anecdote will be
    // applied to situations it never saw.
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: permits,
      proposed: goodLesson,
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    if (result.generalized) expect(result.rule.confidence).toBe("suspected");
  });

  it("grows confidence with corroborating cases", () => {
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      corroboratingCases: [repairCase({ caseId: "case_b" }), repairCase({ caseId: "case_c" })],
      authority: permits,
      proposed: goodLesson,
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    if (result.generalized) {
      expect(result.rule.confidence).toBe("confirmed");
      expect(result.rule.evidenceCount).toBe(3);
    }
  });

  it("requires a rule to say what NOT to do", () => {
    const result = generalize({
      ruleId: "rule_1",
      repairCase: repairCase(),
      authority: permits,
      proposed: { ...goodLesson, forbiddenResponses: [] },
      proposedBy: "foundry.generalizer",
      proposedAt: "2026-08-29T11:00:00.000Z",
      constitutionVersion: "1.0",
    });
    expect(result.generalized).toBe(false);
    if (!result.generalized) expect(result.stage).toBe("validation");
  });
});

describe("version awareness refuses a blind reuse", () => {
  it("refuses across a major version", () => {
    // §31's own example: a repair valid for EventIQ 1.2 may be unsafe for 3.0.
    const check = versionsCompatibleForReuse({
      knownSafeFor: { "hive.platform.eventiq": "1.2.0" },
      currentVersions: { "hive.platform.eventiq": "3.0.0" },
    });
    expect(check.compatible).toBe(false);
    if (!check.compatible) expect(check.reason).toContain("may be unsafe for another");
  });

  it("allows a minor difference", () => {
    expect(
      versionsCompatibleForReuse({
        knownSafeFor: { "hive.platform.eventiq": "1.2.0" },
        currentVersions: { "hive.platform.eventiq": "1.7.3" },
      }).compatible,
    ).toBe(true);
  });

  it("refuses when the current version is unknown", () => {
    // An unrecorded version is not a matching one.
    const check = versionsCompatibleForReuse({
      knownSafeFor: { "hive.platform.eventiq": "1.2.0" },
      currentVersions: {},
    });
    expect(check.compatible).toBe(false);
    if (!check.compatible) expect(check.reason).toContain("precisely the case §31 exists for");
  });

  it("refuses a version recorded as unsafe", () => {
    expect(
      versionsCompatibleForReuse({
        knownSafeFor: {},
        knownUnsafeFor: { "hive.platform.eventiq": "2.0.0" },
        currentVersions: { "hive.platform.eventiq": "2.4.0" },
      }).compatible,
    ).toBe(false);
  });
});

describe("patterns are templates, not auto-fixes", () => {
  const pattern = (over: Record<string, unknown> = {}) => ({
    patternId: "pat_1",
    family: "IDEMPOTENT_CONSUMER_REPAIR",
    title: "Idempotent consumer",
    description: "Key the consequential transition on a delivery identifier.",
    repairClass: "IDEMPOTENCY",
    preconditions: ["at-least-once delivery"],
    doesNotApplyWhen: ["the transition is not consequential"],
    templateActions: [{ verb: "add", target: "code", guidance: "Check the delivery key before writing." }],
    knownSafeFor: { "hive.platform.eventiq": "1.0.0" },
    knownUnsafeFor: {},
    derivedFromRuleIds: ["rule_1"],
    status: "APPROVED",
    ...over,
  });

  it("requires every pattern to state where it does not apply", () => {
    // Every real pattern has a situation where it is the wrong answer. A
    // pattern claiming none has not been thought about.
    const library = createPatternLibrary();
    expect(library.add(pattern({ doesNotApplyWhen: [] })).added).toBe(false);
    expect(library.add(pattern()).added).toBe(true);
  });

  it("withholds a pattern whose disqualifier is present", () => {
    const library = createPatternLibrary();
    library.add(pattern());
    expect(
      library.applicable({
        satisfiedPreconditions: ["at-least-once delivery"],
        presentDisqualifiers: ["the transition is not consequential"],
        currentVersions: { "hive.platform.eventiq": "1.2.0" },
      }),
    ).toHaveLength(0);
  });

  it("withholds a pattern whose preconditions do not hold", () => {
    const library = createPatternLibrary();
    library.add(pattern());
    expect(
      library.applicable({
        satisfiedPreconditions: [],
        presentDisqualifiers: [],
        currentVersions: { "hive.platform.eventiq": "1.2.0" },
      }),
    ).toHaveLength(0);
  });

  it("withholds a pattern across a major version boundary", () => {
    const library = createPatternLibrary();
    library.add(pattern());
    expect(
      library.applicable({
        satisfiedPreconditions: ["at-least-once delivery"],
        presentDisqualifiers: [],
        currentVersions: { "hive.platform.eventiq": "3.0.0" },
      }),
    ).toHaveLength(0);
  });

  it("offers a pattern when everything holds", () => {
    const library = createPatternLibrary();
    library.add(pattern());
    expect(
      library.applicable({
        satisfiedPreconditions: ["at-least-once delivery"],
        presentDisqualifiers: [],
        currentVersions: { "hive.platform.eventiq": "1.2.0" },
      }),
    ).toHaveLength(1);
  });
});

describe("the reuse loop always demands revalidation", () => {
  const setup = () => {
    const store = createExperienceStore();
    store.record(repairCase());
    const library = createPatternLibrary();
    return { store, library };
  };

  it("finds a compatible prior case", () => {
    const { store, library } = setup();
    const finding = findReusableKnowledge({
      readingTenant: "ksix",
      signature: signature(),
      store,
      library,
      currentVersions: { "hive.platform.eventiq": "1.4.0" },
    });
    expect(finding.reusable).toBe(true);
    expect(finding.bestPriorCase?.caseId).toBe("case_1");
  });

  it("refuses to reuse across a major version", () => {
    const { store, library } = setup();
    const finding = findReusableKnowledge({
      readingTenant: "ksix",
      signature: signature(),
      store,
      library,
      currentVersions: { "hive.platform.eventiq": "3.0.0" },
    });
    expect(finding.reusable).toBe(false);
    expect(finding.reason).toContain("Generate a new candidate");
    // The similar case is still surfaced for a human to read.
    expect(finding.priorCases.length).toBeGreaterThan(0);
  });

  it("does not reuse a case whose repair failed", () => {
    // A failed case is valuable for what NOT to do — retrieval for a human to
    // read, not knowledge to apply.
    const store = createExperienceStore();
    store.record(
      repairCase({
        caseId: "case_failed",
        selectedRepairId: null,
        repairAttempts: [
          {
            repairAttemptId: "ra_5",
            repairCandidateId: "rc_5",
            outcome: "APPLIED_REGRESSED",
            failureReason: { whyFailed: "broke three neighbours", incorrectDiagnosis: false, unacceptableRisk: false },
            validatorOutcomes: {},
            scores: {},
            attemptedAt: "2026-08-29T10:05:00.000Z",
          },
        ],
      }),
    );

    const finding = findReusableKnowledge({
      readingTenant: "ksix",
      signature: signature(),
      store,
      library: createPatternLibrary(),
      currentVersions: { "hive.platform.eventiq": "1.2.0" },
    });
    expect(finding.reusable).toBe(false);
    expect(finding.priorCases).toHaveLength(1);
  });

  it("says revalidation is required even when it found something", () => {
    // §30's closing sentence, as a field rather than a footnote. There is no
    // path here that produces knowledge exempt from revalidation.
    const { store, library } = setup();
    const finding = findReusableKnowledge({
      readingTenant: "ksix",
      signature: signature(),
      store,
      library,
      currentVersions: { "hive.platform.eventiq": "1.2.0" },
    });
    expect(finding.stillRequiresValidation).toBe(true);
  });
});

describe("retrieval is scoped to the reading tenant", () => {
  // MIS-MC12. Before this gate, `findReusableKnowledge` returned another
  // tenant's whole RepairCase — root cause and provenance included — because
  // `signatureSimilarity` weights tenantScope at 0.05 and an otherwise
  // identical failure scored ~0.95 against a 0.6 threshold.
  //
  // `crossTenantLearningApproved` was stored as false on every case and nothing
  // read it. Third instance in this repository of a field declared, stored and
  // never consulted.

  const caseFor = (tenant: string, over: Record<string, unknown> = {}) =>
    repairCase({
      caseId: `case_${tenant}`,
      failureSignatureHash: signature({ tenantScope: tenant }).signatureHash,
      failureSignature: signature({ tenantScope: tenant }),
      rootCause: `${tenant}: no delivery-key check`,
      ...over,
    });

  it("does not return another tenant's case", () => {
    const store = createExperienceStore();
    store.record(caseFor("ksix"));

    const found = store.similarTo(signature({ tenantScope: "brighton-signs" }), "brighton-signs");
    expect(found).toEqual([]);
  });

  it("returns the reading tenant's own case", () => {
    const store = createExperienceStore();
    store.record(caseFor("ksix"));

    const found = store.similarTo(signature({ tenantScope: "ksix" }), "ksix");
    expect(found).toHaveLength(1);
    expect(found[0]!.case.caseId).toBe("case_ksix");
  });

  it("honours crossTenantLearningApproved when Governance has set it", () => {
    // The flag is Governance's to set (§36). Now that something reads it, an
    // approved case is shareable and an unapproved one is not.
    const store = createExperienceStore();
    store.record(
      caseFor("ksix", {
        applicabilityScope: {
          components: ["hive.specialized.workorderiq"],
          engineVersions: { "hive.platform.eventiq": "1.2.0" },
          contractVersions: {},
          constitutionVersion: "1.0",
          environments: ["SIMULATION"],
          crossTenantLearningApproved: true,
        },
      }),
    );

    const found = store.similarTo(signature({ tenantScope: "brighton-signs" }), "brighton-signs");
    expect(found).toHaveLength(1);
  });

  it("gates the whole reuse loop, not just the store", () => {
    const store = createExperienceStore();
    store.record(caseFor("ksix"));

    const finding = findReusableKnowledge({
      readingTenant: "brighton-signs",
      signature: signature({ tenantScope: "brighton-signs" }),
      store,
      library: createPatternLibrary(),
      currentVersions: { "hive.platform.eventiq": "1.2.0" },
    });

    expect(finding.reusable).toBe(false);
    expect(finding.bestPriorCase).toBeNull();
    // And nothing at all is surfaced — not even as a "similar case to read".
    expect(finding.priorCases).toEqual([]);
  });

  it("filters before scoring rather than after", () => {
    // Filtering a scored list would mean similarity had already read every
    // tenant's case, and a refactor returning the intermediate list would leak
    // silently. Asserted by the only observable consequence: a foreign case
    // never appears even at similarity 1.
    const store = createExperienceStore();
    store.record(caseFor("ksix"));

    const identical = signature({ tenantScope: "ksix" });
    expect(store.similarTo(identical, "ksix")[0]!.similarity).toBe(1);
    expect(store.similarTo(identical, "brighton-signs")).toEqual([]);
  });
});
