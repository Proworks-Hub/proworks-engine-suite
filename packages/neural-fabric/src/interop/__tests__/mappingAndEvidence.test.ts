/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  checkCompatibility,
  draftMappingCandidate,
  draftingApprovesMapping,
  mappingContractSchema,
  mappingIsApplicable,
  type MappingContract,
  type SchemaDescriptor,
} from "../mappingContract.js";
import {
  SAFE_TAG_VOCABULARY,
  connectionFailureEvidenceSchema,
  evidenceMayCarryPayload,
  exportFailure,
  fingerprint,
  minimizeFailure,
  type ConnectionEvidencePort,
  type RawFailureObservation,
} from "../connectionEvidence.js";

const T0 = "2026-08-30T10:00:00.000Z";

const contract = (over: Record<string, unknown> = {}): MappingContract =>
  mappingContractSchema.parse({
    mappingContractId: "map-order",
    version: "1.0.0",
    sourceSchemaId: "ksix.order",
    sourceSchemaVersion: "3",
    destinationSchemaId: "partner.workorder",
    destinationSchemaVersion: "1",
    compatibilityRange: "ksix.order@3 → partner.workorder@1",
    mappings: [
      {
        sourceFields: ["orderId"],
        destinationField: "workOrderRef",
        transform: "RENAME",
        lossy: false,
        nullSemantics: "REFUSE",
        semanticConfidence: "ESTABLISHED",
        rationale: "Both identify the same job; confirmed with the partner's integrator.",
      },
    ],
    prohibitedFields: ["customerEmail"],
    unmappedFields: [{ field: "internalNotes", reason: "Shop-floor commentary; not the partner's business." }],
    sourceClassification: "TENANT_PRIVATE",
    resultClassification: "TENANT_PRIVATE",
    authoredBy: "steven",
    reviewedBy: "partner-integrator",
    aiParticipation: "NONE",
    goldenTests: [{ name: "basic", inputJson: '{"orderId":"o-1"}', expectedJson: '{"workOrderRef":"o-1"}' }],
    reviewStatus: "APPROVED",
    approvingDecisionRef: "dec-map-1",
    ...over,
  });

describe("a mapping contract cannot be vague about anything that matters", () => {
  it("refuses a lossy mapping that does not say what it loses", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [{ ...contract().mappings[0]!, transform: "CAST", lossy: true, lossDescription: undefined }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a unit conversion with no stated conversion", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [{ ...contract().mappings[0]!, transform: "UNIT_CONVERT", unitConversion: undefined }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("spacecraft");
  });

  it("refuses an enum remap with no table", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [{ ...contract().mappings[0]!, transform: "ENUM_REMAP", enumTable: undefined }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses two mappings writing the same destination field", () => {
    const one = contract().mappings[0]!;
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [one, { ...one, sourceFields: ["altId"] }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("array order");
  });

  it("refuses a mapping that reads a field the same contract prohibits", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [{ ...contract().mappings[0]!, sourceFields: ["customerEmail"] }],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a mapping that loosens the classification — translation is not declassification", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      sourceClassification: "PERSONAL",
      resultClassification: "INTERNAL",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("quietest export path");
  });

  it("permits a mapping that tightens the classification", () => {
    expect(
      mappingContractSchema.safeParse({ ...contract(), sourceClassification: "INTERNAL", resultClassification: "RESTRICTED" }).success,
    ).toBe(true);
  });
});

describe("ambiguity blocks approval rather than defaulting to yes", () => {
  it("refuses to approve a contract containing an UNCERTAIN mapping", () => {
    const result = mappingContractSchema.safeParse({
      ...contract(),
      mappings: [{ ...contract().mappings[0]!, semanticConfidence: "UNCERTAIN" }],
      reviewStatus: "APPROVED",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("resolved by someone who knows the domain");
  });

  it("permits the same contract as a DRAFT — a draft is allowed to admit doubt", () => {
    expect(
      mappingContractSchema.safeParse({
        ...contract(),
        mappings: [{ ...contract().mappings[0]!, semanticConfidence: "UNCERTAIN" }],
        reviewStatus: "DRAFT",
        approvingDecisionRef: null,
        reviewedBy: null,
      }).success,
    ).toBe(true);
  });

  it("refuses an APPROVED contract with no approving decision or no reviewer", () => {
    expect(mappingContractSchema.safeParse({ ...contract(), approvingDecisionRef: null }).success).toBe(false);
    expect(mappingContractSchema.safeParse({ ...contract(), reviewedBy: null }).success).toBe(false);
  });

  it("will not apply a draft to live traffic", () => {
    const draft = mappingContractSchema.parse({
      ...contract(),
      reviewStatus: "DRAFT",
      approvingDecisionRef: null,
      reviewedBy: null,
    });
    const verdict = mappingIsApplicable(draft);
    expect(verdict.applicable).toBe(false);
    expect(verdict.reason).toContain("somebody's proposal");
  });

  it("applies an approved contract", () => {
    expect(mappingIsApplicable(contract()).applicable).toBe(true);
  });
});

describe("compatibility names undecided fields, not just missing ones", () => {
  const source: SchemaDescriptor = {
    schemaId: "ksix.order",
    version: "3",
    requiredFields: ["orderId", "customerEmail"],
    optionalFields: ["internalNotes", "rushFlag"],
  };
  const destination: SchemaDescriptor = {
    schemaId: "partner.workorder",
    version: "1",
    requiredFields: ["workOrderRef"],
    optionalFields: [],
  };

  it("flags a source field that is neither mapped, prohibited nor deliberately unmapped", () => {
    const verdict = checkCompatibility(contract(), source, destination);
    expect(verdict.unaccountedSource).toEqual(["rushFlag"]);
    expect(verdict.compatible).toBe(false);
    expect(verdict.explanation).toContain("passed through by default");
  });

  it("is compatible once every source field has an explicit decision", () => {
    const complete = mappingContractSchema.parse({
      ...contract(),
      unmappedFields: [
        { field: "internalNotes", reason: "Shop-floor commentary." },
        { field: "rushFlag", reason: "The partner has no concept of rush; deliberately dropped." },
      ],
    });
    const verdict = checkCompatibility(complete, source, destination);
    expect(verdict.compatible).toBe(true);
    expect(verdict.unaccountedSource).toEqual([]);
  });

  it("flags a destination requirement nothing produces", () => {
    const verdict = checkCompatibility(contract(), source, {
      ...destination,
      requiredFields: ["workOrderRef", "dueDate"],
    });
    expect(verdict.unsatisfiedRequired).toEqual(["dueDate"]);
    expect(verdict.explanation).toContain("reject every message");
  });
});

describe("drafting proposes and never approves", () => {
  it("says so, assertably", () => {
    expect(draftingApprovesMapping()).toBe(false);
  });

  it("marks exact name matches PROBABLE, never ESTABLISHED", () => {
    const { draft } = draftMappingCandidate({
      mappingContractId: "map-draft",
      source: { schemaId: "a", version: "1", requiredFields: ["status"], optionalFields: [] },
      destination: { schemaId: "b", version: "1", requiredFields: ["status"], optionalFields: [] },
      sourceClassification: "INTERNAL",
      authoredBy: "aria",
      aiParticipation: "DRAFTED_BY_MODEL",
    });
    expect(draft.mappings[0]!.semanticConfidence).toBe("PROBABLE");
    expect(draft.mappings[0]!.rationale).toContain("not about meaning");
    expect(draft.reviewStatus).toBe("DRAFT");
    expect(draft.approvingDecisionRef).toBeNull();
  });

  it("refuses to guess an unmatched required destination field, and says who must decide", () => {
    const { requiresHumanDecision } = draftMappingCandidate({
      mappingContractId: "map-draft",
      source: { schemaId: "a", version: "1", requiredFields: ["orderId"], optionalFields: [] },
      destination: { schemaId: "b", version: "1", requiredFields: ["orderId", "dueDate"], optionalFields: [] },
      sourceClassification: "INTERNAL",
      authoredBy: "aria",
      aiParticipation: "DRAFTED_BY_MODEL",
    });
    expect(requiresHumanDecision).toHaveLength(1);
    expect(requiresHumanDecision[0]).toContain("knows both domains");
  });

  it("produces a draft that cannot be approved when nothing matched", () => {
    const { draft } = draftMappingCandidate({
      mappingContractId: "map-draft",
      source: { schemaId: "a", version: "1", requiredFields: ["alpha"], optionalFields: [] },
      destination: { schemaId: "b", version: "1", requiredFields: ["beta"], optionalFields: [] },
      sourceClassification: "INTERNAL",
      authoredBy: "aria",
      aiParticipation: "DRAFTED_BY_MODEL",
    });
    expect(draft.mappings[0]!.semanticConfidence).toBe("UNCERTAIN");
    // Approving it is refused by the schema, which is the point of the
    // placeholder being UNCERTAIN rather than merely absent.
    const attempt = mappingContractSchema.safeParse({
      ...draft,
      reviewStatus: "APPROVED",
      approvingDecisionRef: "dec-x",
      reviewedBy: "someone",
    });
    expect(attempt.success).toBe(false);
  });

  it("carries AI participation through so a reviewer knows what drafted it", () => {
    const { draft } = draftMappingCandidate({
      mappingContractId: "map-draft",
      source: { schemaId: "a", version: "1", requiredFields: ["x"], optionalFields: [] },
      destination: { schemaId: "b", version: "1", requiredFields: ["x"], optionalFields: [] },
      sourceClassification: "INTERNAL",
      authoredBy: "aria",
      aiParticipation: "DRAFTED_BY_MODEL",
    });
    expect(draft.aiParticipation).toBe("DRAFTED_BY_MODEL");
  });
});

describe("failure evidence carries the shape and never the content", () => {
  const raw = (over: Partial<RawFailureObservation> = {}): RawFailureObservation => ({
    sourceCapability: "ordering",
    destinationCapability: "partner.workorder",
    lane: "COMMAND",
    patternId: "ASYNC_COMMAND_QUEUE",
    failureStage: "SCHEMA_COMPATIBILITY",
    failureCode: "REQUIRED_FIELD_MISSING",
    classification: "TENANT_PRIVATE",
    topologyVersionId: "v-9",
    contractProfileVersion: "json-schema/2020-12",
    adapterId: "durable-log",
    adapterVersion: "1.2.0",
    providerFamily: "log",
    attemptCount: 3,
    circuitState: "OPEN",
    isTest: false,
    observedAt: T0,
    // Everything below must not survive minimization.
    tenantId: "acme-manufacturing",
    participantId: "worker-7",
    instanceId: "ksix",
    payloadSample: '{"customerEmail":"jane@example.com","total":448.19}',
    errorMessage: "field customerEmail missing for jane@example.com",
    fieldNames: ["customerEmail", "shippingAddress"],
    ...over,
  });

  it("carries no payload, and has no field that could", () => {
    expect(evidenceMayCarryPayload()).toBe(false);
    const evidence = minimizeFailure(raw(), "ev-1");
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("acme-manufacturing");
    expect(serialized).not.toContain("worker-7");
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("customerEmail");
    expect(serialized).not.toContain("448.19");
  });

  it("refuses an evidence record carrying an extra field", () => {
    const evidence = minimizeFailure(raw(), "ev-1");
    expect(connectionFailureEvidenceSchema.safeParse({ ...evidence, payloadSample: "x" }).success).toBe(false);
  });

  it("keeps the class of the data without keeping the data", () => {
    const evidence = minimizeFailure(raw(), "ev-1");
    expect(evidence.classification).toBe("TENANT_PRIVATE");
    expect(evidence.adapterId).toBe("durable-log");
    expect(evidence.attemptCount).toBe(3);
  });

  it("fingerprints by shape, so two instances hitting the same wall agree", () => {
    const a = minimizeFailure(raw({ tenantId: "acme" }), "ev-a");
    const b = minimizeFailure(raw({ tenantId: "globex", participantId: "other-worker" }), "ev-b");
    expect(a.intentFingerprint).toBe(b.intentFingerprint);
  });

  it("fingerprints differently when the shape genuinely differs", () => {
    const a = minimizeFailure(raw(), "ev-a");
    const b = minimizeFailure(raw({ destinationCapability: "somewhere.else" }), "ev-b");
    expect(a.intentFingerprint).not.toBe(b.intentFingerprint);
  });

  it("produces a stable fingerprint across runs", () => {
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["a", "b"]));
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["b", "a"]));
  });

  it("emits only vocabulary tags for EVERY failure stage, not just the sampled one", () => {
    // Covers what the vocabulary filter protects: a stage added later whose
    // tag was never added to the vocabulary. Iterating every stage is the
    // assertion that matters, since the filter itself is unobservable.
    const stages = [
      "INTENT_VALIDATION", "PATTERN_PLANNING", "CONTRACT_RESOLUTION", "SCHEMA_COMPATIBILITY",
      "MAPPING", "ADAPTER_SELECTION", "ADAPTER_DISPATCH", "PROVIDER_OUTAGE",
      "SECURITY_VERIFICATION", "GATEWAY_INGRESS", "GATEWAY_EGRESS", "DELIVERY_TIMEOUT", "EDGE_RECONNECT",
    ] as const;
    for (const stage of stages) {
      const evidence = minimizeFailure(raw({ failureStage: stage }), `ev-${stage}`);
      for (const t of evidence.generalizedTags) {
        expect(SAFE_TAG_VOCABULARY).toContain(t);
      }
      expect(connectionFailureEvidenceSchema.safeParse(evidence).success).toBe(true);
    }
  });

  it("emits only tags from the closed safe vocabulary", () => {
    const evidence = minimizeFailure(raw(), "ev-1");
    for (const t of evidence.generalizedTags) expect(SAFE_TAG_VOCABULARY).toContain(t);
    expect(evidence.generalizedTags).toContain("schema-incompatible");
    expect(evidence.generalizedTags).toContain("circuit-open");
  });

  it("does not let a Foundry outage break the delivery path", () => {
    const brokenPort: ConnectionEvidencePort = {
      record() {
        throw new Error("Foundry is unreachable");
      },
    };
    const result = exportFailure(brokenPort, raw(), "ev-1");
    expect(result.exported).toBe(false);
    expect(result.evidence.evidenceId).toBe("ev-1");
  });

  it("records through a working port", () => {
    const seen: string[] = [];
    const port: ConnectionEvidencePort = { record: (e) => void seen.push(e.evidenceId) };
    expect(exportFailure(port, raw(), "ev-2").exported).toBe(true);
    expect(seen).toEqual(["ev-2"]);
  });
});
