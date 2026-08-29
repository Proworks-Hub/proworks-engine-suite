// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  buildFailureSignature,
  repairCaseSchema,
  type FailureSignature,
  type RepairCase,
  type SimulationRun,
} from "@proworks-hub/repair-learning";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures for MC-11 and MC-12.
//
// Both scenarios start from the same place -- a ksix duplicate-delivery failure
// that was diagnosed and successfully repaired -- and then ask different
// questions of it. MC-11 asks what may be written down. MC-12 asks who may read
// it back.
//
// One fixture rather than two copies, so the two scenarios cannot silently
// drift into testing different situations while appearing to test one.
// ─────────────────────────────────────────────────────────────────────────────

/** Stable opaque per-tenant case ids, the shape a host that does not leak names would mint. */
const OPAQUE_ID: Readonly<Record<string, string>> = Object.freeze({
  ksix: "7f3a91",
  "brighton-signs": "c20b4e",
});

const RUN = {
  runId: "run_1",
  scenarioId: "mc-fixture",
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
  engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "n" },
  outcome: "FAILED",
  outcomeReason: "duplicate work order created",
  forbiddenRepairActions: [],
  versions: {},
} as unknown as SimulationRun;

/**
 * The same failure, scoped to a tenant.
 *
 * `tenantScope` is inside the canonical hash, so two shops hitting an
 * identical bug produce DIFFERENT signature hashes. That is deliberate: the
 * signature identifies one tenant's occurrence, not a class of occurrence.
 */
export function signatureFor(tenant: string): FailureSignature {
  return buildFailureSignature({
    failureSignatureId: `sig_${tenant}`,
    run: RUN,
    primarySymptom: "duplicate work order created",
    errorCodes: ["EDUP"],
    affectedComponents: ["hive.specialized.workorderiq"],
    tenantScope: tenant,
    riskClass: "routine",
    invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
  });
}

/**
 * A confirmed, successfully repaired case belonging to one tenant.
 *
 * `rootCause` deliberately names the tenant and an order number. Real cases do
 * -- that is what a root cause looks like when someone writes it honestly --
 * and it is precisely why the raw case may not travel.
 */
export function repairCaseFor(tenant: string, options: { caseId?: string } = {}): RepairCase {
  const signature = signatureFor(tenant);
  return repairCaseSchema.parse({
    // Opaque by default, and deliberately NOT `case_${tenant}`.
    //
    // A case id named after its tenant would make MC-11's content scan fail for
    // a reason that has nothing to do with minimization -- the fixture's own
    // naming -- and would hide whether minimization actually works. MC-11 tests
    // the tenant-named form separately and on purpose.
    caseId: options.caseId ?? `case_${OPAQUE_ID[tenant] ?? "0000"}`,
    failureSignatureHash: signature.signatureHash,
    failureSignature: signature,
    environment: "SIMULATION",
    componentVersions: {},
    diagnosisId: `dx_${tenant}`,
    rootCause: `${tenant}: order 388 was delivered twice and the consumer performs no delivery-key check.`,
    diagnosisConfirmed: true,
    repairClass: "IDEMPOTENCY",
    repairAttempts: [
      {
        repairAttemptId: `ra_${tenant}`,
        repairCandidateId: `rc_${tenant}`,
        outcome: "APPLIED_SUCCEEDED",
        validatorOutcomes: {},
        scores: {},
        attemptedAt: "2026-08-29T10:05:00.000Z",
      },
    ],
    selectedRepairId: `rc_${tenant}`,
    applicabilityScope: {
      components: ["hive.specialized.workorderiq"],
      engineVersions: {},
      contractVersions: {},
      constitutionVersion: "1.0",
      environments: ["SIMULATION"],
      // FALSE. Cross-tenant learning is Governance's to approve, not a
      // property a case may assert about itself.
      crossTenantLearningApproved: false,
    },
    confidence: "confirmed",
    provenance: {
      runId: "run_1",
      recordedBy: "foundry",
      recordedAt: "2026-08-29T10:10:00.000Z",
    },
    knowledgeStatus: "RECORDED",
    timings: {},
    humanIntervention: false,
  });
}

/** Governance that permits generalization, so minimization is what is tested. */
export const PERMISSIVE_AUTHORITY = {
  mayGeneralize: () => ({ permitted: true, reason: "ok", decisionId: "gd-1" }),
};
