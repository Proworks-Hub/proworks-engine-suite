/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/ai/costAiSpecialist.ts
 * Module:   cost-iq-engine / ai
 * Purpose:  Where AI is allowed to help, and the wall that stops it deciding.
 */

import { z } from "zod";

import { decimalStringSchema } from "../domain/costModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// AI IS ADVISORY. THE WALL IS STRUCTURAL, NOT A RULE.
//
// A model can genuinely help here: spotting that a rate has not been touched
// in two years, noticing a family of estimates drifting, drafting a scenario
// worth running, reading a supplier's published price list. All of that is
// useful and none of it is authoritative.
//
// The temptation is to let a good suggestion become a value. "The model is
// confident this rate should be £2.40" is one refactor away from a rate of
// £2.40, and at that point every estimate downstream rests on something
// nobody approved and nothing can reproduce.
//
// So this module makes the wall STRUCTURAL:
//
//   - A candidate carries NO Decimal. Proposed numbers are strings on a
//     candidate object, never a `CostRate`, so nothing can pass one to the
//     calculator by mistake.
//   - `CostInsightCandidate` is a separate type from everything the kernel
//     consumes. There is no function in this package that turns one into a
//     `CostBasis` — promotion requires a governed path outside CostIQ.
//   - Every candidate records the model, provider and version that produced
//     it, so a bad suggestion can be traced to its source.
//
// PROMPT TEXT IS DATA
//
// Everything an AI returns is untrusted input, and it is validated by schema
// before it is looked at. A candidate whose "rationale" contains instructions
// is a candidate with a strange rationale — it is never a command, because
// nothing in this module executes text.
// ─────────────────────────────────────────────────────────────────────────────

/** What an AI is allowed to suggest. */
export const insightKindSchema = z.enum([
  /** This rate is old / this component is unpriced / this evidence is thin. */
  "MISSING_OR_STALE_EVIDENCE",
  /** A scenario that might be worth computing. */
  "SCENARIO_SUGGESTION",
  /** An interpretation of a variance that has already been computed. */
  "VARIANCE_NARRATIVE",
  /** A rate found in an approved public source, offered for review. */
  "RESEARCHED_REFERENCE",
  /** A draft improvement to a costing model, for a person to consider. */
  "IMPROVEMENT_DRAFT",
]);
export type InsightKind = z.infer<typeof insightKindSchema>;

/**
 * Something an AI noticed.
 *
 * DELIBERATELY NOT a rate, a basis or an estimate. Proposed numbers are
 * strings on this object and there is no function anywhere in this package
 * that converts one into something the calculator accepts.
 */
export const costInsightCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    kind: insightKindSchema,
    /** What was noticed, in plain words. */
    observation: z.string().min(1).max(2000),
    /** Why the model thinks so. */
    rationale: z.string().min(1).max(4000),

    /**
     * What the model is talking about.
     *
     * Ids only. A candidate that could carry a whole estimate would be a
     * candidate that could carry a DIFFERENT estimate.
     */
    subjectRefs: z.array(z.string().min(1)).max(50).default([]),
    /** Evidence the model is relying on, so a person can check rather than trust. */
    evidenceRefs: z.array(z.string().min(1)).max(50).default([]),

    /**
     * A proposed number, as a STRING, if the candidate suggests one.
     *
     * A string rather than a Decimal so it cannot be handed to the arithmetic
     * without somebody deliberately parsing it — which is the moment a human
     * decision belongs.
     */
    proposedValue: decimalStringSchema.optional(),
    proposedUnit: z.string().min(1).optional(),
    proposedCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),

    /**
     * Which model said it.
     *
     * Required. A suggestion nobody can trace to a provider and version is a
     * suggestion nobody can evaluate when it turns out to be wrong.
     */
    producedBy: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
    producedAt: z.string().min(1),
  })
  .strict()
  .refine((c) => c.proposedValue === undefined || c.proposedUnit !== undefined || c.proposedCurrency !== undefined, {
    message:
      "A proposed number needs a unit or a currency. A bare number cannot be evaluated, and cannot be compared with the rate it would replace.",
    path: ["proposedUnit"],
  });
export type CostInsightCandidate = z.infer<typeof costInsightCandidateSchema>;

/** The port a host binds an AI provider to. Optional, always. */
export interface CostAiSpecialist {
  /**
   * Suggests insights for a subject.
   *
   * Returns unvalidated data. The caller validates — a port that validated its
   * own output would let a provider decide what counts as valid.
   */
  suggest(input: {
    readonly subjectRefs: readonly string[];
    readonly context: string;
  }): Promise<readonly unknown[]>;
}

export type ValidationOutcome =
  | { readonly accepted: true; readonly candidate: CostInsightCandidate }
  | { readonly accepted: false; readonly reason: string; readonly issues: readonly string[] };

/**
 * Checks one thing an AI returned.
 *
 * STRUCTURAL VALIDATION ONLY. It does not judge whether the suggestion is
 * good — that is a person's job — it establishes that the shape is safe to
 * show one, and that it cannot be mistaken for a computed value.
 */
export function validateCandidate(raw: unknown): ValidationOutcome {
  const parsed = costInsightCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: "The AI returned something that is not a valid insight candidate.",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { accepted: true, candidate: parsed.data };
}

/**
 * Validates a batch, keeping the good and reporting the bad.
 *
 * One malformed candidate does not discard the rest: a model that returns four
 * useful observations and one broken one has still been useful, and throwing
 * the batch away teaches nobody anything.
 */
export function validateBatch(raw: readonly unknown[]): {
  readonly accepted: readonly CostInsightCandidate[];
  readonly rejected: readonly { readonly index: number; readonly reason: string; readonly issues: readonly string[] }[];
} {
  const accepted: CostInsightCandidate[] = [];
  const rejected: { index: number; reason: string; issues: readonly string[] }[] = [];

  raw.forEach((item, index) => {
    const outcome = validateCandidate(item);
    if (outcome.accepted) accepted.push(outcome.candidate);
    else rejected.push({ index, reason: outcome.reason, issues: outcome.issues });
  });

  return { accepted, rejected };
}

/**
 * Whether a candidate could ever become authoritative on its own.
 *
 * Always false, and it is a function rather than a comment so a test can
 * assert it. The equivalent of `linkGrantsDatabaseAccess()` elsewhere in the
 * suite: a claim about the architecture that CI checks.
 */
export function candidateIsAuthoritative(): false {
  return false;
}

/**
 * What a candidate would need before it could change anything.
 *
 * Returned as data so a host can render the checklist. CostIQ does not perform
 * any of it — promotion is a governed act, and an engine that could promote
 * its own suggestions would be an engine that approves its own inputs.
 */
export function promotionRequirements(candidate: CostInsightCandidate): readonly string[] {
  const requirements = [
    "A person with authority over rates must review it.",
    "The decision must be recorded through Governance, not through CostIQ.",
    `The resulting rate must carry its own provenance, not "an AI suggested it" — the evidence is what was verified, not the suggestion.`,
  ];
  if (candidate.proposedValue !== undefined) {
    requirements.push(
      "The proposed value must be verified against a source that meets the policy's accepted sources; a model's recollection is not a source.",
    );
  }
  if (candidate.kind === "RESEARCHED_REFERENCE") {
    requirements.push("The cited public source must be checked to exist and to say what the candidate claims.");
  }
  return requirements;
}
