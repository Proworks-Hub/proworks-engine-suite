// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { environmentSchema } from "../execution/environment.js";
import { repairClassSchema } from "../repair/candidate.js";
import { signatureSimilarity, type FailureSignature } from "../evidence/signature.js";

// ─────────────────────────────────────────────────────────────────────────────
// The outcome record (§23), failed repairs as data (§24), and the Repair
// Experience Store (§25).
//
// §24 is the one that shapes the store: "Do not store only successful repairs.
// Failed candidates are important... This teaches Foundry what not to do."
//
// A store that keeps only successes produces a system that has never seen a bad
// idea and therefore cannot recognise one. So `outcome` is not a boolean, and
// every rejected candidate keeps its rejection reason as a first-class field
// rather than being dropped once a better candidate won.
//
// §25: "Do not make it ungoverned AI memory." Every case carries provenance, an
// applicability scope, a confidence, and a knowledge status — and none of it is
// free-form text a model wrote about itself. A case is a record, not a memory.
// ─────────────────────────────────────────────────────────────────────────────

export const repairOutcomeSchema = z.enum([
  /** Selected, applied, and the failure stopped. */
  "APPLIED_SUCCEEDED",
  /** Selected and applied, and something else broke. */
  "APPLIED_REGRESSED",
  /** Validated but not selected — another candidate was preferred. */
  "NOT_SELECTED",
  /** A validator objected. */
  "REJECTED_BY_VALIDATOR",
  /** A veto dimension failed. Constitutionally inadmissible. */
  "REJECTED_CONSTITUTIONAL",
  /** No candidate was admissible at all. */
  "NO_ADMISSIBLE_CANDIDATE",
  /** Applied and then undone. */
  "ROLLED_BACK",
]);
export type RepairOutcome = z.infer<typeof repairOutcomeSchema>;

/** Outcomes that teach what NOT to do. §24's whole point. */
export const NEGATIVE_OUTCOMES: readonly RepairOutcome[] = Object.freeze([
  "APPLIED_REGRESSED",
  "REJECTED_BY_VALIDATOR",
  "REJECTED_CONSTITUTIONAL",
  "NO_ADMISSIBLE_CANDIDATE",
  "ROLLED_BACK",
]);

/**
 * Why a candidate did not work out.
 *
 * §24's list, structured. Free text would make the negative cases
 * unsearchable, and an unsearchable failure teaches nobody anything.
 */
export const failureReasonSchema = z
  .object({
    whyFailed: z.string().min(1),
    validatorThatFailed: z.string().min(1).optional(),
    unexpectedRegression: z.string().min(1).optional(),
    incorrectDiagnosis: z.boolean().default(false),
    unacceptableRisk: z.boolean().default(false),
    constitutionalViolation: z.string().min(1).optional(),
  })
  .strict();
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const repairAttemptSchema = z
  .object({
    repairAttemptId: z.string().min(1),
    repairCandidateId: z.string().min(1),
    outcome: repairOutcomeSchema,
    /** Required for every negative outcome. */
    failureReason: failureReasonSchema.optional(),
    /** Which validators ran and what they said. References, not full results. */
    validatorOutcomes: z.record(z.string(), z.string()).default({}),
    /** Every scored dimension, kept inspectable (§20). */
    scores: z.record(z.string(), z.number().nullable()).default({}),
    attemptedAt: z.string().min(1),
  })
  .strict()
  .refine((a) => !NEGATIVE_OUTCOMES.includes(a.outcome) || Boolean(a.failureReason), {
    message:
      "A failed repair must record why it failed. An unexplained failure teaches nothing, and §24 keeps failures precisely so they can teach.",
    path: ["failureReason"],
  });
export type RepairAttempt = z.infer<typeof repairAttemptSchema>;

/**
 * Where a lesson from this case can legitimately be applied.
 *
 * §31: "A repair valid for EventIQ 1.2 may be unsafe for EventIQ 3.0... Do not
 * blindly reuse historical repairs." Required on every case, because a case
 * with no stated scope will be reused everywhere.
 */
export const applicabilityScopeSchema = z
  .object({
    components: z.array(z.string().min(1)).min(1),
    /** Exact versions this was observed under. Not ranges — observations. */
    engineVersions: z.record(z.string(), z.string()).default({}),
    contractVersions: z.record(z.string(), z.string()).default({}),
    constitutionVersion: z.string().min(1),
    environments: z.array(environmentSchema).min(1),
    /**
     * Whether this case may inform other tenants.
     *
     * False by default. §36 puts cross-tenant learning under Governance, and a
     * default of true would make every case cross-tenant before anybody
     * decided it should.
     */
    crossTenantLearningApproved: z.boolean().default(false),
  })
  .strict();
export type ApplicabilityScope = z.infer<typeof applicabilityScopeSchema>;

export const knowledgeStatusSchema = z.enum([
  /** Recorded. Nobody has judged it. */
  "RECORDED",
  /** Proposed for generalization. */
  "GENERALIZATION_PROPOSED",
  /** Governance permitted generalization. */
  "GENERALIZATION_APPROVED",
  /** Governance refused. Kept, with the refusal. */
  "GENERALIZATION_DENIED",
  /** A later case superseded it. */
  "SUPERSEDED",
]);
export type KnowledgeStatus = z.infer<typeof knowledgeStatusSchema>;

export const repairCaseSchema = z
  .object({
    caseId: z.string().min(1),
    /** The canonical signature hash. What makes prior cases findable. */
    failureSignatureHash: z.string().min(1),
    /** Kept whole for similarity comparison. */
    failureSignature: z.custom<FailureSignature>((v) => typeof v === "object" && v !== null),

    environment: environmentSchema,
    componentVersions: z.record(z.string(), z.string()).default({}),

    diagnosisId: z.string().min(1),
    rootCause: z.string().min(1),
    /** Whether the diagnosis turned out to be right. Null until known. */
    diagnosisConfirmed: z.boolean().nullable().default(null),

    repairClass: repairClassSchema,
    /** Every attempt, successful and not. §24. */
    repairAttempts: z.array(repairAttemptSchema).min(1),
    selectedRepairId: z.string().min(1).nullable(),

    applicabilityScope: applicabilityScopeSchema,
    confidence: z.enum(["suspected", "probable", "confirmed"]),

    /** Where this came from. §25 — a case is a record, not a memory. */
    provenance: z
      .object({
        runId: z.string().min(1),
        scenarioId: z.string().min(1).optional(),
        recordedBy: z.string().min(1),
        recordedAt: z.string().min(1),
      })
      .strict(),

    knowledgeStatus: knowledgeStatusSchema.default("RECORDED"),
    /** Timings, for the reuse proof in §46. */
    timings: z
      .object({
        timeToDetectMs: z.number().int().nonnegative().optional(),
        timeToDiagnoseMs: z.number().int().nonnegative().optional(),
        timeToRepairMs: z.number().int().nonnegative().optional(),
        timeToRecoverMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .default({}),
    humanIntervention: z.boolean().default(false),
  })
  .strict()
  .refine((c) => c.repairAttempts.some((a) => NEGATIVE_OUTCOMES.includes(a.outcome)) || c.selectedRepairId !== null, {
    message:
      "A case with no failed attempts must name the repair that was selected. A case recording neither a success nor a failure records nothing.",
    path: ["selectedRepairId"],
  });
export type RepairCase = z.infer<typeof repairCaseSchema>;

export interface CaseQuery {
  /** Exact signature match. The strongest and cheapest retrieval. */
  signatureHash?: string;
  component?: string;
  repairClass?: string;
  outcome?: RepairOutcome;
  knowledgeStatus?: KnowledgeStatus;
  environment?: string;
  limit?: number;
}

export interface SimilarCase {
  readonly case: RepairCase;
  readonly similarity: number;
  /** Why this case surfaced. Deterministic reasons first. */
  readonly matchedOn: readonly string[];
}

export interface ExperienceStore {
  record(input: unknown): { recorded: true; case: RepairCase } | { recorded: false; reason: string };
  /** Moves a case's knowledge status. Never deletes. */
  setKnowledgeStatus(
    caseId: string,
    status: KnowledgeStatus,
    reason: string,
  ): { updated: true } | { updated: false; reason: string };
  find(query?: CaseQuery): readonly RepairCase[];
  /**
   * Prior cases resembling a signature.
   *
   * §26: "Implement deterministic and similarity-based retrieval. V1 should
   * first use fault class, affected component, error code, violated invariant,
   * dependency, contract version, repair class... Do not make vector
   * similarity the sole retrieval method."
   *
   * Deterministic first: an exact signature hash match short-circuits. Then
   * component and error-code overlap. Similarity scoring is the tiebreaker,
   * not the mechanism.
   */
  similarTo(signature: FailureSignature, options?: { minSimilarity?: number; limit?: number }): readonly SimilarCase[];
  count(): number;
}

export function createExperienceStore(): ExperienceStore {
  // Append-oriented. Nothing removes a case; `setKnowledgeStatus` moves it,
  // including to SUPERSEDED, which keeps the superseded case readable.
  const cases: RepairCase[] = [];
  const statusHistory = new Map<string, { status: KnowledgeStatus; reason: string; at: string }[]>();

  return {
    record(input) {
      const parsed = repairCaseSchema.safeParse(input);
      if (!parsed.success) {
        return { recorded: false, reason: `Not a valid repair case: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (cases.some((c) => c.caseId === parsed.data.caseId)) {
        return { recorded: false, reason: `Case ${parsed.data.caseId} already exists.` };
      }
      cases.push(parsed.data);
      return { recorded: true, case: parsed.data };
    },

    setKnowledgeStatus(caseId, status, reason) {
      const index = cases.findIndex((c) => c.caseId === caseId);
      if (index === -1) return { updated: false, reason: `No case ${caseId}.` };

      const history = statusHistory.get(caseId) ?? [];
      history.push({ status, reason, at: new Date().toISOString() });
      statusHistory.set(caseId, history);

      cases[index] = { ...cases[index]!, knowledgeStatus: status };
      return { updated: true };
    },

    find(query = {}) {
      const matches = cases.filter((c) => {
        if (query.signatureHash && c.failureSignatureHash !== query.signatureHash) return false;
        if (query.component && !c.applicabilityScope.components.includes(query.component)) return false;
        if (query.repairClass && c.repairClass !== query.repairClass) return false;
        if (query.knowledgeStatus && c.knowledgeStatus !== query.knowledgeStatus) return false;
        if (query.environment && c.environment !== query.environment) return false;
        if (query.outcome && !c.repairAttempts.some((a) => a.outcome === query.outcome)) return false;
        return true;
      });
      return query.limit === undefined ? matches : matches.slice(0, query.limit);
    },

    similarTo(signature, options = {}) {
      const minSimilarity = options.minSimilarity ?? 0.5;

      const scored = cases.map((c) => {
        const matchedOn: string[] = [];

        // ── Deterministic signals, checked first and named ──────────────────
        if (c.failureSignatureHash === signature.signatureHash) {
          matchedOn.push("exact signature hash");
        }
        const sharedComponents = c.failureSignature.affectedComponents.filter((comp) =>
          signature.affectedComponents.includes(comp),
        );
        if (sharedComponents.length > 0) matchedOn.push(`components: ${sharedComponents.join(", ")}`);

        const sharedCodes = c.failureSignature.errorCodes.filter((code) =>
          signature.errorCodes.includes(code),
        );
        if (sharedCodes.length > 0) matchedOn.push(`error codes: ${sharedCodes.join(", ")}`);

        const sharedDeps = c.failureSignature.suspectedDependencies.filter((d) =>
          signature.suspectedDependencies.includes(d),
        );
        if (sharedDeps.length > 0) matchedOn.push(`dependencies: ${sharedDeps.join(", ")}`);

        // ── Then, and only then, a similarity score ─────────────────────────
        const similarity =
          c.failureSignatureHash === signature.signatureHash
            ? 1
            : signatureSimilarity(c.failureSignature, signature);

        return { case: c, similarity, matchedOn };
      });

      return scored
        .filter((s) => s.similarity >= minSimilarity && s.matchedOn.length > 0)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, options.limit ?? 10);
    },

    count: () => cases.length,
  };
}
