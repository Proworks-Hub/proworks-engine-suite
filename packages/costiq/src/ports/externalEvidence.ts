/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/ports/externalEvidence.ts
 * Module:   cost-iq-engine / ports
 * Purpose:  Taking cost evidence from outside, without taking its word for it.
 */

import { z } from "zod";

import { decimalStringSchema } from "../domain/costModel.js";
import { costSourceKindSchema, SOURCE_STRENGTH } from "../domain/provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE ARRIVING FROM ELSEWHERE IS STILL EVIDENCE, AND STILL UNTRUSTED
//
// Real rates come from outside CostIQ: an invoice ReceiptIQ parsed, a published
// index, a supplier's quote, a currency conversion. The engine needs them and
// cannot fetch any of them — that is I/O, and this package has none.
//
// So this is the port. What matters is what happens to what comes back.
//
// THE SUPPLIER OF EVIDENCE DOES NOT GRADE IT
//
// A provider says "this is a contract price". If CostIQ accepted that, then
// source strength — the thing every downstream decision leans on — would be
// set by whoever was easiest to integrate. So the KIND is validated against a
// closed list, the strength is looked up here rather than read from the
// payload, and a provider claiming a strength it was not given is refused.
//
// That is not suspicion of any particular integration. It is that "how much
// should we believe this" has to be answered in one place, by rules somebody
// reviewed, or it is answered fifty times by fifty adapters.
//
// EVERY FETCH CAN COME BACK EMPTY, AND THAT IS AN ANSWER
//
// "No evidence found" is a legitimate, common, and useful result. It is
// modelled explicitly rather than as an empty array, because an empty array
// reads the same as a failed call, and the two need completely different
// responses: one means price it another way, the other means try again.
// ─────────────────────────────────────────────────────────────────────────────

export const externalEvidenceQuerySchema = z
  .object({
    /** What is being priced, in the caller's own terms. */
    subjectRef: z.string().min(1),
    /** The unit an answer must be in, so a mismatched one is caught here. */
    requiredUnit: z.string().min(1),
    requiredCurrency: z.string().regex(/^[A-Z]{3}$/),
    /**
     * The moment being asked about.
     *
     * Required. "What does steel cost" has no answer; "what did steel cost on
     * the 14th" does, and a query without a date silently means "now", which
     * makes a replayed estimate disagree with the original.
     */
    asOf: z.string().min(1),
    tenantId: z.string().min(1),
    isTest: z.boolean(),
  })
  .strict();
export type ExternalEvidenceQuery = z.infer<typeof externalEvidenceQuerySchema>;

/**
 * One piece of evidence, as a provider offers it.
 *
 * Amounts are STRINGS. A JSON number would have gone through a float on the
 * way in, which is the one thing this engine's arithmetic exists to avoid, and
 * the loss would happen before any of it ran.
 */
export const externalEvidenceSchema = z
  .object({
    /** The provider's own identifier, so somebody can go and look. */
    sourceRef: z.string().min(1),
    sourceSystem: z.string().min(1),
    /** Validated against the closed list. The provider does not get to invent one. */
    sourceKind: costSourceKindSchema,
    amount: decimalStringSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    unit: z.string().min(1),
    /** When the fact was true, not when the record was written. */
    observedAt: z.string().min(1),
    /** How many observations this rests on, where the concept applies. */
    sampleSize: z.number().int().positive().optional(),
    caveats: z.array(z.string().min(1)).max(50).default([]),
  })
  .strict();
export type ExternalEvidence = z.infer<typeof externalEvidenceSchema>;

export type EvidenceLookup =
  | { readonly outcome: "FOUND"; readonly evidence: readonly ExternalEvidence[] }
  /** Looked, found nothing. Price it another way. */
  | { readonly outcome: "NONE_AVAILABLE"; readonly note: string }
  /** Could not look. Try again; do not conclude the thing is unpriced. */
  | { readonly outcome: "UNAVAILABLE"; readonly note: string };

export interface ExternalEvidencePort {
  /** Returns unvalidated data. The caller validates — see the header. */
  lookup(query: ExternalEvidenceQuery): Promise<unknown>;
}

export type EvidenceAcceptance =
  | { readonly accepted: true; readonly evidence: ExternalEvidence; readonly strength: number }
  | { readonly accepted: false; readonly reason: string };

/**
 * Checks one piece of external evidence against the query that asked for it.
 *
 * The unit and currency checks are here rather than left to the caller because
 * a rate in the wrong unit is not a smaller problem than a missing one — it is
 * a bigger one, since it computes.
 */
export function acceptEvidence(raw: unknown, query: ExternalEvidenceQuery): EvidenceAcceptance {
  const parsed = externalEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: `Not valid evidence: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    };
  }
  const evidence = parsed.data;

  if (evidence.unit !== query.requiredUnit) {
    return {
      accepted: false,
      reason: `The evidence is priced per "${evidence.unit}" and the question asked for "${query.requiredUnit}". Converting here would hide a unit assumption inside a lookup; convert deliberately through the quantity rules, where a cross-dimension conversion is refused rather than guessed.`,
    };
  }

  if (evidence.currency !== query.requiredCurrency) {
    return {
      accepted: false,
      reason: `The evidence is in ${evidence.currency} and the question asked for ${query.requiredCurrency}. A conversion needs a rate and a date, both of which are evidence in their own right — so it is refused here rather than performed silently.`,
    };
  }

  if (evidence.observedAt > query.asOf) {
    // The failure that makes a replay disagree with the original, and the one
    // nobody looks for, because the number is perfectly plausible.
    return {
      accepted: false,
      reason: `The evidence was observed at ${evidence.observedAt}, after the ${query.asOf} the question asked about. Using it would answer a question about the past with information from the future, and the resulting estimate could never be reproduced as it stood.`,
    };
  }

  // Strength comes from the KIND, looked up here. A mutation that read it from
  // the payload instead survives mutation testing, and honestly so: the schema
  // is `.strict()`, so evidence carrying a `sourceStrength` field never reaches
  // this line — it is refused at parsing. The two defences are deliberate and
  // the outer one makes the inner one unobservable, which is what
  // defence-in-depth looks like from a mutation runner's point of view.
  return { accepted: true, evidence, strength: SOURCE_STRENGTH[evidence.sourceKind] };
}

/**
 * Validates a whole lookup result.
 *
 * Distinguishes the three outcomes, and keeps the good pieces from a batch
 * where some are bad — a provider that returns four usable rates and one in the
 * wrong currency has still been useful.
 */
export function acceptLookup(
  raw: unknown,
  query: ExternalEvidenceQuery,
): {
  readonly result: EvidenceLookup;
  readonly rejected: readonly { readonly index: number; readonly reason: string }[];
} {
  if (raw === null || raw === undefined) {
    return {
      result: {
        outcome: "UNAVAILABLE",
        note: "The evidence provider returned nothing at all. That is different from finding nothing: do not conclude the subject is unpriced, and do not fall back to a default on the strength of it.",
      },
      rejected: [],
    };
  }

  if (!Array.isArray(raw)) {
    return {
      result: {
        outcome: "UNAVAILABLE",
        note: "The evidence provider returned something that is not a list of evidence. Treated as a failed lookup rather than as an empty one.",
      },
      rejected: [],
    };
  }

  const accepted: ExternalEvidence[] = [];
  const rejected: { index: number; reason: string }[] = [];

  raw.forEach((item, index) => {
    const outcome = acceptEvidence(item, query);
    if (outcome.accepted) accepted.push(outcome.evidence);
    else rejected.push({ index, reason: outcome.reason });
  });

  if (accepted.length === 0) {
    return {
      result: {
        outcome: "NONE_AVAILABLE",
        note:
          rejected.length === 0
            ? `No evidence exists for "${query.subjectRef}" as at ${query.asOf}. Price it another way, and record that this is why.`
            : `${rejected.length} piece${rejected.length === 1 ? "" : "s"} of evidence came back and none was usable. That is not the same as none existing — the provider has something, and it does not fit the question as asked.`,
      },
      rejected,
    };
  }

  return { result: { outcome: "FOUND", evidence: accepted }, rejected };
}

/**
 * Whether a provider may state its own source strength.
 *
 * Always false. Strength is looked up from the kind, by rules somebody
 * reviewed, so that "how much should we believe this" is answered in one place
 * rather than by whichever integration was written last.
 */
export function providerMaySetStrength(): false {
  return false;
}
