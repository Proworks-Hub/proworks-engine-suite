/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/services/costBasisService.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Choosing which price to believe, and never hiding it when the
 *           answer was "none of the good ones".
 */

import {
  type Decimal,
  ZERO,
  add,
  compare,
  divide,
  fromInteger,
  fromString,
  multiply,
  subtract,
  toNumber,
} from "../domain/decimal.js";
import type { CostBasis, CostPolicy, CostRate } from "../domain/costModel.js";
import {
  SOURCE_STRENGTH,
  ageInDays,
  type CostEvidenceQuality,
  type CostSourceKind,
} from "../domain/provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE FALLBACK IS THE WHOLE POINT
//
// Selecting a price is easy when a contract exists. The interesting case is
// when it does not: there is a stale observation, a forecast, and a default
// nobody has looked at since setup. Something has to be chosen, and the
// dangerous outcome is not choosing badly — it is choosing badly and
// presenting the result identically to a contract price.
//
// The directive puts it plainly: "No silent fallback to demo rates in
// production-trust output. Every fallback must be explicit, classified and
// visible." So every selection records what it considered, what it chose, why
// the others were rejected, and whether the choice was a fallback.
//
// WHAT COUNTS AS A FALLBACK
//
// Not simply "a weak source". A policy that lists APPROVED_RATE first has
// chosen approved rates deliberately, and using one is not a fallback. A
// fallback is when everything the policy PREFERRED was unavailable and the
// selection dropped below the caller's stated intent — which is why the flag
// is computed against the policy's ordering rather than against a global
// strength table.
//
// EFFECTIVE DATES ARE EVALUATED AT `asOf`, NOT NOW
//
// A rate that was in force in March must still be selectable when replaying a
// March estimate. Every date comparison here takes the instant as an argument,
// and nothing reads a clock.
// ─────────────────────────────────────────────────────────────────────────────

export type RejectionReason =
  | "NOT_YET_EFFECTIVE"
  | "EXPIRED"
  | "WRONG_UNIT"
  | "WRONG_CURRENCY"
  | "SOURCE_NOT_ACCEPTED"
  | "TOO_STALE"
  | "SAMPLE_TOO_SMALL"
  | "OUTLIER"
  | "LOWER_PRIORITY";

export interface RejectedCandidate {
  readonly rate: CostRate;
  readonly reason: RejectionReason;
  readonly explanation: string;
}

export type BasisSelection =
  | {
      readonly ok: true;
      readonly basis: CostBasis;
      /** True when everything the policy preferred was unavailable. */
      readonly wasFallback: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      /** Everything that was considered, so the refusal is diagnosable. */
      readonly rejected: readonly RejectedCandidate[];
    };

export interface SelectionRequest {
  readonly candidates: readonly CostRate[];
  readonly policy: CostPolicy;
  readonly asOf: Date;
  /** The unit the caller needs a rate in. */
  readonly requiredUnit: string;
  readonly basisId: string;
  readonly subject: CostBasis["subject"];
  readonly appliesTo: CostBasis["appliesTo"];
}

/**
 * Chooses a rate, or refuses and says what it looked at.
 *
 * The rejection list is not diagnostics — it becomes part of the basis, so an
 * explanation months later can say "we used the contract price, not the
 * observed average, because the contract is in force".
 */
export function selectBasis(request: SelectionRequest): BasisSelection {
  const { candidates, policy, asOf, requiredUnit } = request;
  const rejected: RejectedCandidate[] = [];
  const viable: CostRate[] = [];

  for (const rate of candidates) {
    // ── Hard disqualifications, checked before preference ────────────────
    //
    // A rate in the wrong unit or currency is not a worse choice, it is not a
    // choice: using it would produce an answer that is wrong by a conversion
    // factor and looks entirely normal.
    if (rate.perUnit !== requiredUnit) {
      rejected.push({
        rate,
        reason: "WRONG_UNIT",
        explanation: `Priced per ${rate.perUnit}, but this cost needs a rate per ${requiredUnit}. Converting is the caller's decision, not a silent one.`,
      });
      continue;
    }
    if (rate.currency !== policy.currency) {
      rejected.push({
        rate,
        reason: "WRONG_CURRENCY",
        explanation: `Priced in ${rate.currency}, but the estimate is in ${policy.currency}. Converting needs a rate, a date and a source.`,
      });
      continue;
    }

    const from = Date.parse(rate.effectiveFrom);
    if (Number.isNaN(from)) {
      rejected.push({
        rate,
        reason: "NOT_YET_EFFECTIVE",
        explanation: `effectiveFrom is not a usable date (${rate.effectiveFrom}).`,
      });
      continue;
    }
    if (from > asOf.getTime()) {
      rejected.push({
        rate,
        reason: "NOT_YET_EFFECTIVE",
        explanation: `Comes into force on ${rate.effectiveFrom}, after this calculation's instant.`,
      });
      continue;
    }
    if (rate.effectiveTo !== undefined && Date.parse(rate.effectiveTo) <= asOf.getTime()) {
      rejected.push({
        rate,
        reason: "EXPIRED",
        explanation: `Ceased to apply on ${rate.effectiveTo}.`,
      });
      continue;
    }

    if (!policy.acceptedSources.includes(rate.provenance.sourceKind)) {
      // An ordered ALLOWLIST: anything absent is refused, not merely ranked
      // lower. That is what makes "we do not price from forecasts" enforceable.
      rejected.push({
        rate,
        reason: "SOURCE_NOT_ACCEPTED",
        explanation: `Source ${rate.provenance.sourceKind} is not in this policy's accepted sources (${policy.acceptedSources.join(", ")}).`,
      });
      continue;
    }

    const age = ageInDays(rate.provenance, asOf);
    if (age > policy.freshnessWindowDays) {
      rejected.push({
        rate,
        reason: "TOO_STALE",
        explanation: `Observed ${age} days ago, beyond this policy's ${policy.freshnessWindowDays}-day window.`,
      });
      continue;
    }

    const sample = rate.provenance.sampleSize;
    // Only applied where sampling is a meaningful concept. A contract price is
    // not a sample of one; it is a contract.
    if (sample !== undefined && sample < policy.minimumSampleSize) {
      rejected.push({
        rate,
        reason: "SAMPLE_TOO_SMALL",
        explanation: `Rests on ${sample} observation(s); this policy requires at least ${policy.minimumSampleSize}.`,
      });
      continue;
    }

    viable.push(rate);
  }

  if (viable.length === 0) {
    return {
      ok: false,
      reason: `No rate satisfies this policy for ${request.subject.objectId}. ${rejected.length} candidate(s) were considered and each was rejected.`,
      rejected,
    };
  }

  // ── Preference, by the policy's own ordering ──────────────────────────
  const rank = (kind: CostSourceKind) => {
    const index = policy.acceptedSources.indexOf(kind);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const sorted = [...viable].sort((a, b) => {
    const byPolicy = rank(a.provenance.sourceKind) - rank(b.provenance.sourceKind);
    if (byPolicy !== 0) return byPolicy;
    // Then the more recent, then by id — so selection is deterministic and two
    // runs over the same candidates never disagree.
    const byDate = Date.parse(b.provenance.observedAt) - Date.parse(a.provenance.observedAt);
    if (byDate !== 0) return byDate;
    return a.rateId < b.rateId ? -1 : a.rateId > b.rateId ? 1 : 0;
  });

  const selected = sorted[0]!;
  for (const other of sorted.slice(1)) {
    rejected.push({
      rate: other,
      reason: "LOWER_PRIORITY",
      explanation: `${other.provenance.sourceKind} ranks below ${selected.provenance.sourceKind} in this policy's ordering.`,
    });
  }

  // A fallback is a drop below the policy's FIRST preference, not merely a
  // weak source. A policy that lists APPROVED_RATE first has chosen it.
  const wasFallback = rank(selected.provenance.sourceKind) > 0;

  if (wasFallback && !policy.allowFallback) {
    return {
      ok: false,
      reason: `The only usable rate is ${selected.provenance.sourceKind}, which is below this policy's first preference (${policy.acceptedSources[0]}), and the policy does not allow fallback.`,
      rejected: [
        ...rejected,
        {
          rate: selected,
          reason: "SOURCE_NOT_ACCEPTED",
          explanation: "Would have been selected, but fallback is disallowed by policy.",
        },
      ],
    };
  }

  return {
    ok: true,
    wasFallback,
    basis: {
      basisId: request.basisId,
      scope: selected.scope,
      subject: request.subject,
      appliesTo: request.appliesTo,
      selectedRate: selected,
      rejected: rejected.map((r) => ({ rate: r.rate, reason: `${r.reason}: ${r.explanation}` })),
      determinedAt: asOf.toISOString(),
      wasFallback,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EVIDENCE QUALITY (R8)
//
// Computed from facts, never supplied by a model. Each dimension can be
// pointed at: this much of the cost is priced, this old, from these sources,
// on this many observations, needing this much conversion, resting on this
// many assumptions.
// ─────────────────────────────────────────────────────────────────────────────

export interface QualityInput {
  /** Every component's amount and whether it had a basis. */
  readonly components: ReadonlyArray<{
    readonly amount: Decimal;
    readonly basis: CostBasis | null;
    readonly isUnpriced: boolean;
  }>;
  readonly policy: CostPolicy;
  readonly asOf: Date;
  readonly assumptionCount: number;
  /**
   * How well past estimates of this kind matched their actuals, 0-100.
   *
   * Null when nothing has been validated. Null and zero are different: one is
   * "we do not know", the other is "we know it is bad".
   */
  readonly historicalAccuracy: number | null;
}

/**
 * A weighted average where the weights are money. Returns 0-100.
 *
 * The weighting matters: a stale rate on a £2 washer is not the same problem
 * as a stale rate on £2,000 of steel, and an unweighted mean would say it was.
 */
function weightedScore(
  parts: ReadonlyArray<{ weight: Decimal; score: number }>,
  totalWeight: Decimal,
): number {
  if (compare(totalWeight, ZERO) <= 0) return 0;
  const weighted = parts.reduce<Decimal>(
    (acc, p) => add(acc, multiply(p.weight, fromInteger(p.score))),
    ZERO,
  );
  // `toNumber` is the documented lossy edge, used here at the very end on a
  // bounded 0-100 score rather than anywhere near an amount.
  return clamp(toNumber(divide(weighted, totalWeight, 6, "HALF_EVEN")));
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Assesses the evidence behind a set of components.
 *
 * Every dimension is money-weighted where that makes sense: a stale rate on a
 * £2 washer matters less than a stale rate on £2,000 of steel, and an
 * unweighted average would say otherwise.
 */
export function assessEvidence(input: QualityInput): CostEvidenceQuality {
  const total = input.components.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const pricedTotal = input.components
    .filter((c) => !c.isUnpriced)
    .reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);

  const priced = input.components.filter((c) => !c.isUnpriced && c.basis !== null);

  // Coverage: how much of the cost has a basis at all. Uses COUNT as well as
  // money, because an unpriced component with an unknown amount contributes
  // nothing to a money-weighted figure and would otherwise be invisible.
  const unpricedCount = input.components.filter((c) => c.isUnpriced).length;
  const coverageByCount =
    input.components.length === 0 ? 100 : clamp(((input.components.length - unpricedCount) / input.components.length) * 100);
  const coverageByMoney =
    compare(total, ZERO) <= 0 ? coverageByCount : clamp(toNumber(divide(multiply(pricedTotal, fromInteger(100)), total, 4, "HALF_EVEN")));
  const coverage = Math.min(coverageByCount, coverageByMoney);

  const freshness = weightedScore(
    priced.map((c) => {
      const age = ageInDays(c.basis!.selectedRate.provenance, input.asOf);
      const window = input.policy.freshnessWindowDays;
      // Linear decay across the window, floored at zero rather than negative.
      return { weight: c.amount, score: clamp(((window - age) / window) * 100) };
    }),
    pricedTotal,
  );

  const sourceStrength = weightedScore(
    priced.map((c) => ({
      weight: c.amount,
      score: SOURCE_STRENGTH[c.basis!.selectedRate.provenance.sourceKind],
    })),
    pricedTotal,
  );

  const sampleSufficiency = weightedScore(
    priced.map((c) => {
      const sample = c.basis!.selectedRate.provenance.sampleSize;
      // Absent means sampling does not apply — a contract is not a sample of
      // one — so it scores full rather than penalising a stronger source.
      if (sample === undefined) return { weight: c.amount, score: 100 };
      const required = input.policy.minimumSampleSize;
      return { weight: c.amount, score: clamp((sample / Math.max(required, 1)) * 100) };
    }),
    pricedTotal,
  );

  const normalization = weightedScore(
    priced.map((c) => {
      const p = c.basis!.selectedRate.provenance;
      // Each conversion is a place a mistake can enter. Not fatal, but not
      // free either.
      let score = 100;
      if (p.unitConverted) score -= 25;
      if (p.currencyConvertedFrom !== undefined) score -= 25;
      return { weight: c.amount, score: clamp(score) };
    }),
    pricedTotal,
  );

  // Assumptions are counted against the whole estimate rather than weighted,
  // because an assumption is about the calculation as a whole.
  const assumptionLoad = clamp(100 - input.assumptionCount * 15);

  const weakest = (
    [
      ["coverage", coverage],
      ["freshness", freshness],
      ["sourceStrength", sourceStrength],
      ["sampleSufficiency", sampleSufficiency],
      ["normalization", normalization],
      ["assumptionLoad", assumptionLoad],
      ...(input.historicalAccuracy === null ? [] : ([["validatedVariance", input.historicalAccuracy]] as const)),
    ] as ReadonlyArray<readonly [string, number]>
  )
    .filter(([, score]) => score < 70)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);

  if (input.historicalAccuracy === null) {
    // Absence is reported rather than scored. "Never validated" is actionable;
    // a silently omitted dimension is not.
    weakest.push("validatedVariance:never-validated");
  }

  return {
    coverage,
    freshness,
    sourceStrength,
    sampleSufficiency,
    normalization,
    assumptionLoad,
    validatedVariance: input.historicalAccuracy,
    weakest,
  };
}

/** How much of a total has no basis behind it. Reported, never hidden. */
export function unpricedShare(
  components: ReadonlyArray<{ amount: Decimal; isUnpriced: boolean }>,
): { readonly amount: Decimal; readonly ofTotal: Decimal } {
  const total = components.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const unpriced = components.filter((c) => c.isUnpriced).reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const ofTotal = compare(total, ZERO) <= 0 ? ZERO : divide(multiply(unpriced, fromInteger(100)), total, 4, "HALF_EVEN");
  return { amount: unpriced, ofTotal };
}

/** Kept for callers that need the raw difference between two rates. */
export function rateDelta(a: CostRate, b: CostRate): Decimal {
  return subtract(fromString(a.amount), fromString(b.amount));
}
