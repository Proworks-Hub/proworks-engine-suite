// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_EVIDENCE_FIELDS,
  foundryExecutesResearchedCode,
  foundryMayDeployToProduction,
  foundryMayGrantAuthority,
  foundryMayModifyGovernanceOrSentinel,
  generalizedLessonSchema,
  improvementPacketSchema,
  ingestFailure,
  mayInformCandidate,
  mayPromoteLesson,
  researchSourceSchema,
  scenarioDefinitionSchema,
  simulationRunSchema,
  type GeneralizedLesson,
  type IngestedFailureEvidence,
  type ResearchSource,
} from "../evolution.js";

const T0 = "2026-08-30T10:00:00.000Z";

const evidence = (over: Partial<IngestedFailureEvidence> = {}): IngestedFailureEvidence => ({
  evidenceId: "ev-1",
  intentFingerprint: "fp-abcd1234",
  failureStage: "SCHEMA_COMPATIBILITY",
  failureCode: "REQUIRED_FIELD_MISSING",
  adapterId: "durable-log",
  adapterVersion: "1.2.0",
  providerFamily: "log",
  patternId: "ASYNC_COMMAND_QUEUE",
  classification: "TENANT_PRIVATE",
  generalizedTags: ["schema-incompatible"],
  attemptCount: 3,
  isTest: false,
  observedAt: T0,
  ...over,
});

const source = (over: Partial<ResearchSource> = {}): ResearchSource =>
  researchSourceSchema.parse({
    sourceId: "src-asyncapi",
    url: "https://www.asyncapi.com/docs/reference/specification/v3.0.0",
    title: "AsyncAPI 3.0.0 specification",
    licenseClass: "OPEN_STANDARD",
    retrievedAt: T0,
    contentDigest: "sha256:cccc",
    trust: "REVIEWED",
    reviewNote: "Read by Steven; public standard, no license concerns.",
    mayContainPersonalData: false,
    ...over,
  });

const lesson = (over: Partial<GeneralizedLesson> = {}): GeneralizedLesson =>
  generalizedLessonSchema.parse({
    lessonId: "les-1",
    patternKey: "fp-abcd1234:SCHEMA_COMPATIBILITY:REQUIRED_FIELD_MISSING",
    statement: "Producers that add a required field before consumers upgrade break every consumer at once.",
    suggestedRemedy: "Add new fields as optional first; require them only after consumers have moved.",
    supportingObservations: 5,
    evidenceRefs: ["ev-1", "ev-2", "ev-3"],
    researchSourceIds: ["src-asyncapi"],
    privacyReviewed: true,
    status: "DRAFT",
    promotingDecisionRef: null,
    createdAt: T0,
    ...over,
  });

describe("the corpus refuses anything that identifies anybody", () => {
  it("ingests a properly minimized record", () => {
    const verdict = ingestFailure(evidence(), null);
    expect(verdict.ingested).toBe(true);
    if (verdict.ingested) {
      expect(verdict.pattern.observationCount).toBe(1);
      expect(verdict.pattern.patternKey).toContain("fp-abcd1234");
    }
  });

  it("refuses a record carrying a tenant id, even though the Fabric should have stripped it", () => {
    const contaminated = { ...evidence(), tenantId: "acme" } as unknown as IngestedFailureEvidence;
    const verdict = ingestFailure(contaminated, null);
    expect(verdict.ingested).toBe(false);
    if (!verdict.ingested) expect(verdict.reason).toContain("permanent cross-tenant disclosure");
  });

  it("refuses every forbidden field, one at a time", () => {
    for (const field of FORBIDDEN_EVIDENCE_FIELDS) {
      const contaminated = { ...evidence(), [field]: "x" } as unknown as IngestedFailureEvidence;
      expect(ingestFailure(contaminated, null).ingested).toBe(false);
    }
  });

  it("merges repeat observations into one class and counts them", () => {
    const first = ingestFailure(evidence(), null);
    if (!first.ingested) throw new Error("expected ingest");
    const second = ingestFailure(evidence({ adapterId: "subject-bus", observedAt: "2026-09-01T00:00:00.000Z" }), first.pattern);
    expect(second.ingested).toBe(true);
    if (second.ingested) {
      expect(second.pattern.observationCount).toBe(2);
      expect(second.pattern.adapterIds).toEqual(["durable-log", "subject-bus"]);
      expect(second.pattern.firstObservedAt).toBe(T0);
      expect(second.pattern.lastObservedAt).toBe("2026-09-01T00:00:00.000Z");
    }
  });
});

describe("research is untrusted until somebody reads it", () => {
  it("refuses to let an unreviewed source justify anything", () => {
    const verdict = mayInformCandidate(source({ trust: "UNREVIEWED", reviewNote: null }));
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("not provenance");
  });

  it("refuses a rejected source", () => {
    expect(mayInformCandidate(source({ trust: "REJECTED", reviewNote: "Stale and contradicted by the spec." })).permitted).toBe(false);
  });

  it("refuses an unknown license, treating unknown as the most restrictive case", () => {
    const verdict = mayInformCandidate(source({ licenseClass: "UNKNOWN" }));
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toContain("discovered by lawyers");
  });

  it("permits a reviewed open standard, and says code still may not be copied", () => {
    const verdict = mayInformCandidate(source());
    expect(verdict.permitted).toBe(true);
    expect(verdict.reason).toContain("code may not be copied");
  });

  it("requires a review note once a source is reviewed or rejected", () => {
    expect(researchSourceSchema.safeParse({ ...source(), trust: "REVIEWED", reviewNote: null }).success).toBe(false);
  });
});

describe("promotion is where a local observation becomes collective knowledge", () => {
  it("permits a well-supported, privacy-reviewed lesson with reviewed sources", () => {
    const verdict = mayPromoteLesson(lesson(), [source()]);
    expect(verdict.permitted).toBe(true);
    if (verdict.permitted) expect(verdict.reason).toContain("Governance still takes the decision");
  });

  it("blocks a lesson that was never privacy reviewed", () => {
    const verdict = mayPromoteLesson(lesson({ privacyReviewed: false }), [source()]);
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.blockers.join(" ")).toContain("cannot be recalled");
  });

  it("blocks a lesson supported by too few observations — a coincidence is not a lesson", () => {
    const verdict = mayPromoteLesson(lesson({ supportingObservations: 1 }), [source()]);
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.blockers.join(" ")).toContain("promoted coincidence");
  });

  it("blocks a lesson justified by an unreviewed source", () => {
    const verdict = mayPromoteLesson(lesson(), [source({ trust: "UNREVIEWED", reviewNote: null })]);
    expect(verdict.permitted).toBe(false);
  });

  it("blocks a lesson citing a source that is not on record", () => {
    const verdict = mayPromoteLesson(lesson({ researchSourceIds: ["src-ghost"] }), []);
    expect(verdict.permitted).toBe(false);
    if (!verdict.permitted) expect(verdict.blockers.join(" ")).toContain("worse than none");
  });

  it("requires a promoted lesson to name its promoting decision", () => {
    expect(generalizedLessonSchema.safeParse({ ...lesson(), status: "PROMOTED", promotingDecisionRef: null }).success).toBe(false);
  });
});

describe("scenarios and runs are permanent, reproducible and honest", () => {
  it("requires a scenario to be synthetic-only and to carry a seed", () => {
    const ok = scenarioDefinitionSchema.safeParse({
      scenarioId: "s-1",
      kind: "INTEROPERABILITY",
      title: "Polyglot local workflow",
      question: "Do four runtimes agree on one contract?",
      invariant: "No message is lost and no authority is widened.",
      contributedBy: "neural-fabric",
      seed: 42,
      syntheticDataOnly: true,
      createdAt: T0,
    });
    expect(ok.success).toBe(true);
    expect(
      scenarioDefinitionSchema.safeParse({
        scenarioId: "s-1",
        kind: "INTEROPERABILITY",
        title: "t",
        question: "q",
        invariant: "i",
        contributedBy: "c",
        seed: 1,
        syntheticDataOnly: false,
        createdAt: T0,
      }).success,
    ).toBe(false);
  });

  it("refuses an inconclusive run that does not say why", () => {
    const result = simulationRunSchema.safeParse({
      runId: "r-1",
      scenarioId: "s-1",
      scenarioVersion: 1,
      seed: 42,
      outcome: "INCONCLUSIVE",
      inconclusiveReason: null,
      componentVersions: { "neural-fabric": "0.23.0" },
      startedAt: T0,
      finishedAt: T0,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("reads as a pass to everyone who skims");
  });

  it("accepts a pass with no reason, since a pass is self-explanatory", () => {
    expect(
      simulationRunSchema.safeParse({
        runId: "r-1",
        scenarioId: "s-1",
        scenarioVersion: 1,
        seed: 42,
        outcome: "PASS",
        inconclusiveReason: null,
        componentVersions: {},
        startedAt: T0,
        finishedAt: T0,
      }).success,
    ).toBe(true);
  });
});

describe("improvement packets gather approval; they do not grant it", () => {
  it("refuses an approved packet with no approvals recorded", () => {
    const result = improvementPacketSchema.safeParse({
      packetId: "p-1",
      kind: "ADAPTER_CANDIDATE",
      title: "MQTT edge adapter",
      rationale: "Recurring edge failures across three instances.",
      diff: "…",
      testRefs: ["t-1"],
      simulationRunIds: [],
      benchmarkRefs: [],
      riskAssessment: "Medium.",
      securityReviewRef: null,
      rollbackPlan: "Unbind and fall back.",
      researchSourceIds: [],
      approvals: [],
      status: "APPROVED",
      createdAt: T0,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("status field is not an approval");
  });

  it("requires at least one test reference — a packet without tests is a suggestion", () => {
    expect(
      improvementPacketSchema.safeParse({
        packetId: "p-1",
        kind: "MAPPING_CANDIDATE",
        title: "t",
        rationale: "r",
        diff: "d",
        testRefs: [],
        simulationRunIds: [],
        benchmarkRefs: [],
        riskAssessment: "low",
        securityReviewRef: null,
        rollbackPlan: "revert",
        researchSourceIds: [],
        approvals: [],
        status: "SANDBOX",
        createdAt: T0,
      }).success,
    ).toBe(false);
  });
});

describe("the four refusals that make the rest safe", () => {
  it("holds all four", () => {
    expect(foundryMayDeployToProduction()).toBe(false);
    expect(foundryMayGrantAuthority()).toBe(false);
    expect(foundryMayModifyGovernanceOrSentinel()).toBe(false);
    expect(foundryExecutesResearchedCode()).toBe(false);
  });
});
