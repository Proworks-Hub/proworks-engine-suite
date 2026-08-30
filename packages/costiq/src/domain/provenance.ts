/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/provenance.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  Where a number came from, how good it is, and how sure anyone
 *           should be about it.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// A COST WITHOUT PROVENANCE IS A RUMOUR
//
// Every number in an estimate came from somewhere: a signed contract, a
// purchase six months ago, a supplier's verbal quote, a spreadsheet somebody
// pasted in, or a default nobody has looked at since setup. Those are not
// equally trustworthy, and an estimate that presents them identically is
// hiding the only thing that would let a person judge it.
//
// So every value that enters a calculation carries a `Provenance`, and the
// estimate carries the mix. "This quote is £4,200" is a claim. "This quote is
// £4,200, of which 78% rests on contract prices confirmed this quarter and 4%
// on a default rate from 2024 nobody has reviewed" is information.
//
// EVIDENCE QUALITY IS COMPUTED, NOT ASSERTED
//
// The directive is explicit that quality must be deterministic and must not be
// an AI-generated confidence score. So `CostEvidenceQuality` is derived from
// facts that can be checked — how much of the cost is priced at all, how old
// the evidence is, how strong its source, how many observations it rests on,
// whether units needed converting, how many assumptions were required, and
// whether past estimates using it turned out right.
//
// A model that says "85% confident" and cannot say why is not evidence. Each
// dimension here can be pointed at.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What kind of thing a number came from.
 *
 * Ordered deliberately in `SOURCE_STRENGTH` below: a signed contract price is
 * stronger evidence than a remembered one, and the ordering is what lets a
 * policy prefer without a human ranking every pair.
 */
export const costSourceKindSchema = z.enum([
  /** A price in a signed agreement. The strongest thing short of an invoice. */
  "CONTRACT",
  /** A price actually paid, evidenced by a transaction. */
  "OBSERVED_TRANSACTION",
  /** A supplier's written quote. Real, but not yet committed to. */
  "SUPPLIER_QUOTE",
  /** A rate an authorised person approved for use. */
  "APPROVED_RATE",
  /** A published index or reference series. */
  "EXTERNAL_REFERENCE",
  /** A frozen standard cost from an approved version. */
  "STANDARD",
  /** A generalized figure from Collective Knowledge — never raw tenant data. */
  "COLLECTIVE_REFERENCE",
  /** A projection. Evidence about the future is evidence about a guess. */
  "FORECAST",
  /** Somebody typed it. Legitimate, and the weakest thing that is not a default. */
  "MANUAL_OVERRIDE",
  /**
   * A value used because nothing better existed.
   *
   * The most important kind, because it is the one that must never be silent.
   * A fallback that looks like a real rate is how a quote goes out built on
   * demo data.
   */
  "FALLBACK_DEFAULT",
]);
export type CostSourceKind = z.infer<typeof costSourceKindSchema>;

/**
 * How strong each source is, from 0 to 100.
 *
 * Numbers rather than an order so a policy can express "at least 60" without
 * enumerating members. The gaps are meaningful: the drop from OBSERVED to
 * QUOTE is small, the drop from MANUAL_OVERRIDE to FALLBACK_DEFAULT is a
 * cliff, because one is a person's judgement and the other is nobody's.
 */
export const SOURCE_STRENGTH: Readonly<Record<CostSourceKind, number>> = Object.freeze({
  CONTRACT: 100,
  OBSERVED_TRANSACTION: 90,
  SUPPLIER_QUOTE: 75,
  APPROVED_RATE: 70,
  EXTERNAL_REFERENCE: 60,
  STANDARD: 55,
  COLLECTIVE_REFERENCE: 45,
  FORECAST: 30,
  MANUAL_OVERRIDE: 25,
  FALLBACK_DEFAULT: 5,
});

/** Where one value came from. Attached to every input that enters a cost. */
export const provenanceSchema = z
  .object({
    sourceKind: costSourceKindSchema,
    /**
     * The originating system's own identifier, kept verbatim.
     *
     * So somebody can go and look. A provenance that says "from ReceiptIQ" and
     * cannot say which receipt is not traceable, and traceability is the
     * entire point.
     */
    sourceRef: z.string().min(1),
    /** Which system said so. */
    sourceSystem: z.string().min(1),
    /** When the underlying fact was true — not when the record was written. */
    observedAt: z.string().min(1),
    /**
     * How many independent observations this rests on.
     *
     * One purchase is a data point. Forty purchases is a rate. Absent means
     * the concept does not apply — a contract price is not a sample.
     */
    sampleSize: z.number().int().positive().optional(),
    /**
     * Anything that qualifies the number.
     *
     * Free text, and deliberately so: "this was a clearance price", "this
     * excludes tooling", "this supplier has since closed". A caveat nobody can
     * express gets dropped, and a dropped caveat is how a bad number looks
     * clean.
     */
    caveats: z.array(z.string().min(1)).default([]),
    /** Whether a unit conversion was applied on the way in. */
    unitConverted: z.boolean().default(false),
    /** Whether a currency conversion was applied, and at what rate reference. */
    currencyConvertedFrom: z.string().min(1).optional(),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * How confident anyone should be, expressed as separate dimensions.
 *
 * SEPARATE ON PURPOSE. A single score hides which problem you have, and the
 * remedies are completely different: thin coverage needs more pricing work,
 * stale evidence needs a refresh, weak sources need better suppliers or
 * contracts. Collapsing them into "72%" tells nobody what to do next.
 *
 * Every dimension is 0-100 and every one is computed from facts. None is
 * supplied by a model.
 */
export const costEvidenceQualitySchema = z
  .object({
    /** Share of the cost that has any priced basis at all. */
    coverage: z.number().min(0).max(100),
    /** How recent the evidence is, relative to the policy's freshness window. */
    freshness: z.number().min(0).max(100),
    /** Weighted `SOURCE_STRENGTH` across the components. */
    sourceStrength: z.number().min(0).max(100),
    /** Whether the observations behind rates are numerous enough to be rates. */
    sampleSufficiency: z.number().min(0).max(100),
    /** How much unit/currency conversion the inputs needed. Each one is a risk. */
    normalization: z.number().min(0).max(100),
    /** How little the result rests on assumptions rather than evidence. */
    assumptionLoad: z.number().min(0).max(100),
    /** How well past estimates built this way matched their actuals. */
    validatedVariance: z.number().min(0).max(100).nullable(),
    /**
     * The dimensions that dragged the assessment down, worst first.
     *
     * The actionable part. A score says how bad; this says what to fix.
     */
    weakest: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CostEvidenceQuality = z.infer<typeof costEvidenceQualitySchema>;

/**
 * A coarse band for the whole assessment.
 *
 * For people and dashboards, never for arithmetic. A calculation that branched
 * on a band would be making a decision from a rounding of a rounding.
 */
export const evidenceGradeSchema = z.enum(["STRONG", "ADEQUATE", "WEAK", "INSUFFICIENT"]);
export type EvidenceGrade = z.infer<typeof evidenceGradeSchema>;

/**
 * The band for an assessment.
 *
 * `validatedVariance` is excluded from the average when it is null — an
 * engine that has never validated anything should not be penalised as though
 * it validated badly, and it should not be rewarded either. Absence is
 * absence, so it is left out of the mean and reported in `weakest` instead.
 *
 * COVERAGE IS A FLOOR, NOT AN AVERAGE. Half a cost being unpriced cannot be
 * offset by the other half having excellent sources: the answer is still
 * missing half the money. So poor coverage caps the grade regardless of
 * everything else.
 */
export function gradeEvidence(quality: CostEvidenceQuality): EvidenceGrade {
  if (quality.coverage < 50) return "INSUFFICIENT";

  const dimensions = [
    quality.coverage,
    quality.freshness,
    quality.sourceStrength,
    quality.sampleSufficiency,
    quality.normalization,
    quality.assumptionLoad,
    ...(quality.validatedVariance === null ? [] : [quality.validatedVariance]),
  ];
  const mean = dimensions.reduce((a, b) => a + b, 0) / dimensions.length;

  // Coverage caps the outcome. An 80% mean over 60% coverage is still an
  // estimate missing 40% of the money.
  if (quality.coverage < 80) return mean >= 70 ? "ADEQUATE" : "WEAK";
  if (mean >= 80) return "STRONG";
  if (mean >= 60) return "ADEQUATE";
  return "WEAK";
}

/**
 * An assumption the calculation had to make.
 *
 * Recorded rather than absorbed. "Assumed 5% scrap because the process has no
 * measured yield" is the difference between a number somebody can challenge
 * and a number that simply appeared.
 */
export const costAssumptionSchema = z
  .object({
    id: z.string().min(1),
    /** What was assumed, in plain words. */
    statement: z.string().min(1),
    /** Why it was necessary — usually a missing input. */
    because: z.string().min(1),
    /** How much of the total rests on it, if that can be determined. */
    affectsComponentIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CostAssumption = z.infer<typeof costAssumptionSchema>;

/**
 * Whether a provenance is a fallback.
 *
 * A named predicate rather than an inline comparison, because "is this real
 * evidence or a default nobody chose" is asked in several places and must
 * mean the same thing in all of them.
 */
export function isFallback(provenance: Provenance): boolean {
  return provenance.sourceKind === "FALLBACK_DEFAULT";
}

/** Whether a provenance came from a person typing rather than a system. */
export function isManual(provenance: Provenance): boolean {
  return provenance.sourceKind === "MANUAL_OVERRIDE";
}

/**
 * How stale a provenance is at a given moment, in whole days.
 *
 * Takes `now` as an argument rather than reading a clock. The predictability
 * contract requires canonical output to be independent of wall time, so
 * nothing in the domain may call `Date.now()` — the caller supplies the
 * instant, and a replay supplies the original one.
 */
export function ageInDays(provenance: Provenance, now: Date): number {
  const observed = Date.parse(provenance.observedAt);
  if (Number.isNaN(observed)) {
    throw new TypeError(
      `Provenance ${provenance.sourceRef} has an unparseable observedAt: ${JSON.stringify(provenance.observedAt)}. Evidence with no usable date cannot be aged, and treating it as fresh would be the wrong guess.`,
    );
  }
  const elapsed = now.getTime() - observed;
  // Floor rather than round: evidence 23 hours old is zero days old, and
  // rounding it up to one would make freshness jitter across a boundary
  // nothing actually crossed.
  return Math.floor(elapsed / 86_400_000);
}
