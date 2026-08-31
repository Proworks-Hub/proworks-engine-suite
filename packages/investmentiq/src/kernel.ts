// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  rAdd,
  rDiv,
  rMul,
  rSub,
  rational,
  type MethodRef,
  type Rational,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// InvestmentIQ kernel — §16. The convention family is the point: bank
// discount yield divides by FACE and every other convention divides by
// price, so discount is always the lowest; 360 vs 365 vs compounding drives
// the rest of the spread, and none is a default. The six policy limit tests
// are TERNARY, and the aggregation rule is normative: indeterminate NEVER
// rounds down to compliant — a limit reported compliant because an attribute
// was missing is the same defect as a covenant passing on a defaulted input.
// M-CE-1 never asserts cash-equivalence: the accounting conclusion is the
// entity's; the engine reports the facts a policy needs.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const INVESTMENT_METHODS = {
  accrual: method("M-ACCR-1"),
  amort: method("M-AMORT-1"),
  yieldFamily: method("M-YIELD-FAMILY"),
  ytm: method("M-YTM-1"),
  policy: method("M-POL"),
  realized: method("M-REAL-1"),
  unrealized: method("M-UNREAL-1"),
  cashEquivalent: method("M-CE-1"),
} as const satisfies Record<string, MethodRef>;

export const INVESTMENT_REFUSAL_KINDS = [
  "day_count_not_declared",
  "disposal_method_not_declared",
  "specified_lots_insufficient",
  "unrealized_requires_fair_value_evidence",
  "acquisition_yield_missing",
] as const;
export type InvestmentRefusalKind = (typeof INVESTMENT_REFUSAL_KINDS)[number];

export interface InvestmentRefusal {
  readonly kind: InvestmentRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: InvestmentRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: InvestmentRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.2 · accrued interest: the convention IS the method ──────────────────

/** ACT/360 vs ACT/365F differ by ~1.39% of the accrual — 12,500.00 vs
 * 12,328.77 on 1,000,000 at 5% for 90 days. There is no defensible default. */
export function accruedInterest(
  principalMinor: bigint,
  couponRateE8: bigint,
  actualDaysHeld: number,
  dayCount: "act-360" | "act-365f" | undefined,
): Result<{ accrued: Rational; dayCount: string }> {
  const M = INVESTMENT_METHODS.accrual;
  if (dayCount === undefined) {
    return refuse("day_count_not_declared", M, "ACT/360 and ACT/365F differ by 1.39% of the accrual; the convention is required.");
  }
  const denominator = dayCount === "act-360" ? 360n : 365n;
  const accrued = rMul(
    rMul(rational(principalMinor, 1n), rational(couponRateE8, 100_000_000n)),
    rational(BigInt(actualDaysHeld), denominator),
  );
  return ok({ accrued, dayCount });
}

// ── §16.3 · effective-interest amortization to par ──────────────────────────

export interface AmortRow {
  readonly period: number;
  readonly opening: Rational;
  readonly interestIncome: Rational;
  readonly couponMinor: bigint;
  readonly closing: Rational;
}

export interface AmortSchedule {
  readonly rows: readonly AmortRow[];
  /** The final carrying amount is forced to par and the residual is assigned
   * to the FINAL period's amortization, declared — never distributed
   * silently. Rounding happens at exactly one place. */
  readonly finalResidualAssigned: Rational;
  readonly methodRef: MethodRef;
}

export function effectiveInterestAmortization(
  acquisitionCostMinor: bigint,
  parMinor: bigint,
  acquisitionYieldE10: bigint | undefined,
  couponPerPeriodMinor: bigint,
  periods: number,
): Result<AmortSchedule> {
  const M = INVESTMENT_METHODS.amort;
  if (acquisitionYieldE10 === undefined) {
    return refuse("acquisition_yield_missing", M, "The effective rate is the acquisition yield, frozen at acquisition with its convention. It is not recomputed when rates move — that is what amortized cost means.");
  }
  const rate = rational(acquisitionYieldE10, 10_000_000_000n);
  let carrying = rational(acquisitionCostMinor, 1n);
  const rows: AmortRow[] = [];
  for (let p = 1; p <= periods; p++) {
    const opening = carrying;
    const interestIncome = rMul(opening, rate);
    carrying = rSub(rAdd(opening, interestIncome), rational(couponPerPeriodMinor, 1n));
    rows.push({ period: p, opening, interestIncome, couponMinor: couponPerPeriodMinor, closing: carrying });
  }
  const residual = rSub(rational(parMinor, 1n), carrying);
  const last = rows[rows.length - 1];
  if (last !== undefined) {
    rows[rows.length - 1] = { ...last, closing: rational(parMinor, 1n) };
  }
  return ok({ rows, finalResidualAssigned: residual, methodRef: M });
}

// ── §16.6 · the yield convention family ─────────────────────────────────────

export interface YieldFamilyResult {
  /** (D/F) × (360/d) — face basis: ALWAYS the lowest of the family. */
  readonly bankDiscountE8: bigint;
  /** (D/P) × (360/d) — price basis. */
  readonly moneyMarketE8: bigint;
  /** (D/P) × (365/d) — price basis, 365. */
  readonly bondEquivalentE8: bigint;
  readonly methodRef: MethodRef;
}

const toE8 = (r: Rational): bigint => (r.num * 100_000_000n) / r.den;

export function yieldConventionFamily(
  faceMinor: bigint,
  priceMinor: bigint,
  daysToMaturity: number,
): YieldFamilyResult {
  const D = rational(faceMinor - priceMinor, 1n);
  const d = BigInt(daysToMaturity);
  const discount = rMul(rDiv(D, rational(faceMinor, 1n)), rational(360n, d));
  const mmy = rMul(rDiv(D, rational(priceMinor, 1n)), rational(360n, d));
  const bey = rMul(rDiv(D, rational(priceMinor, 1n)), rational(365n, d));
  return {
    bankDiscountE8: toE8(discount),
    moneyMarketE8: toE8(mmy),
    bondEquivalentE8: toE8(bey),
    methodRef: INVESTMENT_METHODS.yieldFamily,
  };
}

// ── §16.4 · YTM: indeterminate on non-convergence, assumptions recorded ─────

export type YtmResult =
  | {
      readonly state: "solved";
      readonly ytmE10: bigint;
      /** All three recorded because the reinvestment assumption in particular
       * is routinely false and a treasurer comparing YTM to a realised
       * return needs to know it was assumed. */
      readonly assumptions: readonly ["coupons-paid-on-schedule", "coupons-reinvested-at-ytm", "principal-repaid-at-maturity"];
    }
  | { readonly state: "indeterminate"; readonly reason: string };

export function yieldToMaturity(
  priceMinor: bigint,
  cashFlows: readonly { t: number; amountMinor: bigint }[],
): YtmResult {
  const flows = [{ t: 0, amountMinor: -priceMinor }, ...cashFlows];
  const npv = (rateE10: bigint): Rational => {
    const onePlusR = rational(10_000_000_000n + rateE10, 10_000_000_000n);
    let pv = rational(0n, 1n);
    for (const cf of flows) {
      let denom = rational(1n, 1n);
      for (let i = 0; i < cf.t; i++) denom = rMul(denom, onePlusR);
      pv = rAdd(pv, rDiv(rational(cf.amountMinor, 1n), denom));
    }
    return pv;
  };
  let lo = 0n;
  let hi = 20_000_000_000n;
  const npvLo = npv(lo);
  const npvHi = npv(hi);
  if (npvLo.num > 0n === npvHi.num > 0n) {
    // Non-convergence returns indeterminate, NEVER a last iterate.
    return { state: "indeterminate", reason: "No NPV sign change over the [0%, 200%] bracket." };
  }
  const loPositive = npvLo.num > 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (npv(mid).num > 0n === loPositive) lo = mid;
    else hi = mid;
  }
  return {
    state: "solved",
    ytmE10: lo,
    assumptions: ["coupons-paid-on-schedule", "coupons-reinvested-at-ytm", "principal-repaid-at-maturity"],
  };
}

// ── §16.7 · the six limit tests: ternary, and the aggregation rule ──────────

export type LimitVerdict = "compliant" | "breached" | "indeterminate";

export interface LimitTest {
  readonly limitId: string;
  readonly verdict: LimitVerdict;
  /** Required whenever indeterminate: the resolution path, not just a shrug. */
  readonly indeterminateReason: string | null;
}

export interface PolicyEvaluation {
  readonly limits: readonly LimitTest[];
  readonly overall: LimitVerdict;
  readonly methodRef: MethodRef;
}

/** breached if ANY breached; else indeterminate if ANY indeterminate; else
 * compliant. `indeterminate` never rounds down to `compliant` — §37.4
 * requires a mutation flipping each branch to fail a test. */
export function aggregatePolicy(limits: readonly LimitTest[]): PolicyEvaluation {
  const overall: LimitVerdict = limits.some((l) => l.verdict === "breached")
    ? "breached"
    : limits.some((l) => l.verdict === "indeterminate")
      ? "indeterminate"
      : "compliant";
  return { limits, overall, methodRef: INVESTMENT_METHODS.policy };
}

export interface RatingObservation {
  readonly agencyScaleRef: string;
  readonly notch: number; // lower is better, 1 = top
  readonly observedAt: string;
}

/** M-POL-2, the rating floor, with its normative indeterminate conditions:
 * no observation for the required scale; only stale observations; or
 * conflicting agencies with no tie-break in the policy. */
export function ratingFloorTest(
  limitId: string,
  requiredScaleRef: string,
  floorNotch: number,
  observations: readonly RatingObservation[],
  staleBefore: string,
  conflictTieBreak: "worst-of" | "best-of" | undefined,
): LimitTest {
  const relevant = observations.filter((o) => o.agencyScaleRef === requiredScaleRef);
  if (relevant.length === 0) {
    return { limitId, verdict: "indeterminate", indeterminateReason: `No RatingObservation for ${requiredScaleRef}.` };
  }
  const fresh = relevant.filter((o) => o.observedAt >= staleBefore);
  if (fresh.length === 0) {
    return { limitId, verdict: "indeterminate", indeterminateReason: `Only stale observations (before ${staleBefore}).` };
  }
  const notches = new Set(fresh.map((o) => o.notch));
  if (notches.size > 1 && conflictTieBreak === undefined) {
    return { limitId, verdict: "indeterminate", indeterminateReason: "Agencies conflict and the policy states no tie-break rule." };
  }
  const effective =
    notches.size === 1
      ? fresh[0]!.notch
      : conflictTieBreak === "worst-of"
        ? Math.max(...fresh.map((o) => o.notch))
        : Math.min(...fresh.map((o) => o.notch));
  return {
    limitId,
    verdict: effective <= floorNotch ? "compliant" : "breached",
    indeterminateReason: null,
  };
}

/** M-POL-4 concentration on a percent-of-market-value basis: with any
 * position not fair-value-evidenced the test is indeterminate — TODAY:
 * ALWAYS, and the honest resolution path is a policy decision to express the
 * limit on an amortized-cost basis. */
export function concentrationTest(
  limitId: string,
  holdings: readonly { issuerRef: string | null; valueMinor: bigint; valueBasis: "fair-value-evidenced" | "amortized-cost" }[],
  limitBps: bigint,
  limitBasis: "percent-of-market-value" | "percent-of-amortized-cost",
): LimitTest {
  if (holdings.some((h) => h.issuerRef === null)) {
    return { limitId, verdict: "indeterminate", indeterminateReason: "A holding's issuerRef is unresolved; two holdings may be one exposure." };
  }
  if (limitBasis === "percent-of-market-value" && holdings.some((h) => h.valueBasis !== "fair-value-evidenced")) {
    return {
      limitId,
      verdict: "indeterminate",
      indeterminateReason:
        "percent-of-market-value limit over positions not fair-value-evidenced. Resolution path: the policy owner may express the limit on an amortized-cost basis — a policy decision, not the engine's substitution.",
    };
  }
  const total = holdings.reduce((a, h) => a + h.valueMinor, 0n);
  if (total === 0n) {
    return { limitId, verdict: "indeterminate", indeterminateReason: "Zero total basis; concentration undefined." };
  }
  const byIssuer = new Map<string, bigint>();
  for (const h of holdings) byIssuer.set(h.issuerRef!, (byIssuer.get(h.issuerRef!) ?? 0n) + h.valueMinor);
  const worst = [...byIssuer.values()].reduce((a, v) => (v > a ? v : a), 0n);
  return { limitId, verdict: (worst * 10_000n) / total > limitBps ? "breached" : "compliant", indeterminateReason: null };
}

// ── §16.8 · realized gain: the disposal method is required ──────────────────

export interface Lot {
  readonly lotId: string;
  readonly settlementDate: string;
  readonly units: bigint;
  readonly costMinor: bigint;
}

export type DisposalMethod =
  | { readonly kind: "fifo" }
  | { readonly kind: "average-cost" }
  | { readonly kind: "specific-identification"; readonly lotIds: readonly string[] };

export function realizedGain(
  lots: readonly Lot[],
  unitsSold: bigint,
  proceedsMinor: bigint,
  transactionCostsMinor: bigint,
  disposalMethod: DisposalMethod | undefined,
): Result<{ realizedMinor: bigint; costBasisMinor: bigint; lotsConsumed: readonly string[] }> {
  const M = INVESTMENT_METHODS.realized;
  if (disposalMethod === undefined) {
    return refuse("disposal_method_not_declared", M, "FIFO, average cost, or specific identification — the caller declares; there is no default.");
  }
  // The declared total order: (settlementDate, lotId) — "insertion order" is
  // not a domain fact.
  const ordered = [...lots].sort((a, b) =>
    a.settlementDate !== b.settlementDate ? (a.settlementDate < b.settlementDate ? -1 : 1) : a.lotId < b.lotId ? -1 : 1,
  );
  let costBasis = 0n;
  const consumed: string[] = [];
  if (disposalMethod.kind === "average-cost") {
    const totalUnits = ordered.reduce((a, l) => a + l.units, 0n);
    const totalCost = ordered.reduce((a, l) => a + l.costMinor, 0n);
    if (totalUnits < unitsSold) {
      return refuse("specified_lots_insufficient", M, `Selling ${unitsSold} units against ${totalUnits} held.`);
    }
    costBasis = (totalCost * unitsSold) / totalUnits;
  } else {
    const pool =
      disposalMethod.kind === "fifo"
        ? ordered
        : ordered.filter((l) => disposalMethod.lotIds.includes(l.lotId));
    let remaining = unitsSold;
    for (const lot of pool) {
      if (remaining === 0n) break;
      const take = remaining < lot.units ? remaining : lot.units;
      costBasis += (lot.costMinor * take) / lot.units;
      consumed.push(lot.lotId);
      remaining -= take;
    }
    if (remaining > 0n) {
      return refuse(
        "specified_lots_insufficient",
        M,
        disposalMethod.kind === "specific-identification"
          ? `Named lots cover ${unitsSold - remaining} of ${unitsSold} units sold.`
          : `Held lots cover ${unitsSold - remaining} of ${unitsSold} units sold.`,
      );
    }
  }
  return ok({ realizedMinor: proceedsMinor - transactionCostsMinor - costBasis, costBasisMinor: costBasis, lotsConsumed: consumed });
}

/** M-UNREAL-1: refuses unless the basis is fair-value-evidenced. Amortized
 * cost against a guess is not an unrealized gain. */
export function unrealizedGain(
  carryingMinor: bigint,
  fairValue: { readonly minor: bigint; readonly basis: "fair-value-evidenced" | "indicative" } | undefined,
): Result<{ unrealizedMinor: bigint }> {
  const M = INVESTMENT_METHODS.unrealized;
  if (fairValue === undefined || fairValue.basis !== "fair-value-evidenced") {
    return refuse("unrealized_requires_fair_value_evidence", M, "No evidenced fair value; an unrealized figure over an indicative mark is not a measurement.");
  }
  return ok({ unrealizedMinor: fairValue.minor - carryingMinor });
}

// ── §16.12 · cash-equivalent candidacy: facts, never an assertion ───────────

export interface CashEquivalentFacts {
  readonly kind: "cash-equivalent-candidacy-facts"; // NOT a verdict
  readonly originalMaturityDays: number | null;
  readonly readilyConvertible: boolean | null;
  readonly insignificantValueChangeRisk: boolean | null;
  /** The accounting conclusion is the ENTITY's, under its framework. */
  readonly assertion: "none";
  readonly methodRef: MethodRef;
}

export function cashEquivalentCandidacy(facts: {
  readonly originalMaturityDays: number | null;
  readonly readilyConvertible: boolean | null;
  readonly insignificantValueChangeRisk: boolean | null;
}): CashEquivalentFacts {
  return {
    kind: "cash-equivalent-candidacy-facts",
    originalMaturityDays: facts.originalMaturityDays,
    readilyConvertible: facts.readilyConvertible,
    insignificantValueChangeRisk: facts.insignificantValueChangeRisk,
    assertion: "none",
    methodRef: INVESTMENT_METHODS.cashEquivalent,
  };
}
