// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  certificationIsProductionAdmission,
  decisionCovers,
  degradedModeMayWidenPolicy,
  discoveryIsAuthorization,
  interoperabilityDecisionSchema,
  interoperabilityDecisionTypeSchema,
  technicallyValidMappingGrantsDataAccess,
  type CoverageRequest,
  type InteroperabilityDecision,
} from "../interoperability.js";

const T0 = "2026-08-30T10:00:00.000Z";

const decision = (over: Record<string, unknown> = {}): InteroperabilityDecision =>
  interoperabilityDecisionSchema.parse({
    decisionId: "dec-1",
    type: "ApproveExternalAdapterAdmission",
    targetId: "durable-log",
    targetVersion: "1.2.0",
    decidedBy: ["steven"],
    signatures: ["sig-steven"],
    scope: {
      instanceIds: ["ksix"],
      tenantIds: ["acme"],
      classifications: ["INTERNAL", "TENANT_PRIVATE"],
      subjects: ["COMMAND", "EVENT"],
    },
    allowedCapabilities: ["durable-queue", "acknowledgement"],
    conditions: [],
    effectiveFrom: T0,
    expiresAt: "2027-01-01T00:00:00.000Z",
    evidenceRefs: ["cert-run-1"],
    rationale: "Certified against its claims; needed for the fire-pit handoff.",
    rollbackPlan: "Revoke this decision and fall back to the subject bus for EVENT only.",
    revoked: false,
    revokedReason: null,
    auditRef: "audit/dec-1",
    ...over,
  });

const request = (over: Partial<CoverageRequest> = {}): CoverageRequest => ({
  type: "ApproveExternalAdapterAdmission",
  targetId: "durable-log",
  targetVersion: "1.2.0",
  instanceId: "ksix",
  tenantId: "acme",
  classification: "INTERNAL",
  subject: "COMMAND",
  capability: "durable-queue",
  now: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("the ten interoperability decision types exist so nothing has to infer permission", () => {
  it("names all ten", () => {
    expect(interoperabilityDecisionTypeSchema.options).toHaveLength(10);
    expect(interoperabilityDecisionTypeSchema.options).toContain("ApproveSemanticMappingContract");
    expect(interoperabilityDecisionTypeSchema.options).toContain("ApprovePromotionOfGeneralizedIntegrationLesson");
  });

  it("refuses a decision that grants every capability", () => {
    const result = interoperabilityDecisionSchema.safeParse({ ...decision(), allowedCapabilities: ["*"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("absence of one");
  });

  it("refuses a revocation with no reason", () => {
    expect(interoperabilityDecisionSchema.safeParse({ ...decision(), revoked: true, revokedReason: null }).success).toBe(false);
  });

  it("refuses a decision reaching RESTRICTED data with no evidence cited", () => {
    const result = interoperabilityDecisionSchema.safeParse({
      ...decision(),
      scope: { ...decision().scope, classifications: ["RESTRICTED"] },
      evidenceRefs: [],
    });
    expect(result.success).toBe(false);
  });

  it("refuses a decision that expires before it begins", () => {
    expect(
      interoperabilityDecisionSchema.safeParse({ ...decision(), effectiveFrom: "2027-01-01T00:00:00.000Z", expiresAt: T0 }).success,
    ).toBe(false);
  });
});

describe("coverage is literal — there is no close-enough branch", () => {
  it("covers a request that matches on every axis", () => {
    const verdict = decisionCovers(decision(), request());
    expect(verdict.covered).toBe(true);
  });

  it("refuses a different decision type, however adjacent", () => {
    const verdict = decisionCovers(decision(), request({ type: "ApproveAdapterCapabilityExpansion" }));
    expect(verdict.covered).toBe(false);
    expect(verdict.reason).toContain("however adjacent they feel");
  });

  it("refuses a different version — the update path is a permission question", () => {
    const verdict = decisionCovers(decision(), request({ targetVersion: "1.3.0" }));
    expect(verdict.covered).toBe(false);
    expect(verdict.reason).toContain("permission question");
  });

  it("refuses a more sensitive classification than the decision covers", () => {
    const verdict = decisionCovers(decision(), request({ classification: "PERSONAL" }));
    expect(verdict.covered).toBe(false);
    expect(verdict.reason).toContain("looks like consistency");
  });

  it("refuses another tenant, another instance and another subject", () => {
    expect(decisionCovers(decision(), request({ tenantId: "globex" })).covered).toBe(false);
    expect(decisionCovers(decision(), request({ instanceId: "partner" })).covered).toBe(false);
    expect(decisionCovers(decision(), request({ subject: "EVIDENCE" })).covered).toBe(false);
  });

  it("refuses a capability the decision does not list", () => {
    expect(decisionCovers(decision(), request({ capability: "artifact-store" })).covered).toBe(false);
  });

  it("refuses an expired decision, and says renewal is where the question gets re-asked", () => {
    const verdict = decisionCovers(decision(), request({ now: "2028-01-01T00:00:00.000Z" }));
    expect(verdict.covered).toBe(false);
    expect(verdict.reason).toContain("still a good idea");
  });

  it("refuses a revoked decision", () => {
    expect(decisionCovers(decision({ revoked: true, revokedReason: "compromised" }), request()).covered).toBe(false);
  });

  it("passes conditions through so a conditional permit stays conditional", () => {
    const verdict = decisionCovers(decision({ conditions: ["mutual TLS only", "no bulk export"] }), request());
    expect(verdict.covered).toBe(true);
    if (verdict.covered) expect(verdict.conditions).toHaveLength(2);
  });

  it("honours a wildcard scope where one was deliberately written", () => {
    const wide = decision({ scope: { ...decision().scope, tenantIds: ["*"] } });
    expect(decisionCovers(wide, request({ tenantId: "anyone" })).covered).toBe(true);
  });
});

describe("the four rules, as functions rather than prose", () => {
  it("holds all four", () => {
    expect(discoveryIsAuthorization()).toBe(false);
    expect(certificationIsProductionAdmission()).toBe(false);
    expect(technicallyValidMappingGrantsDataAccess()).toBe(false);
    expect(degradedModeMayWidenPolicy()).toBe(false);
  });
});
