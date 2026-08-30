// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { divideAndRound, type MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// LeaseFinanceIQ kernel — §16. The load-bearing choices:
//
// - Classification determinacy (16.4): any criterion `met` → finance; ALL
//   `not-met` → operating; otherwise REFUSE naming each indeterminate
//   criterion. Defaulting an unevaluable criterion to not-met biases every
//   uncertain lease toward operating — the direction of error a preparer
//   benefits from — so it is structurally impossible, not discouraged.
// - The discount-rate ELECTION (LFIQ-K-1: 13.35% of the liability, invisible
//   in operating-model expense) and the COMPOUNDING convention (LFIQ-K-2:
//   0.961% of the entire liability) are required arguments with no default.
// - Rounding boundaries R0–R8: the rate is captured ONCE at RATE_SCALE, PV
//   rounds ONCE at R2, R6 absorbs the remainder in the final period, R7 uses
//   cumulative-target rounding, and R8 is an UNROUNDED plug — so the terminal
//   invariants hold exactly: liabilityClose == 0, rouClose == 0.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const LEASE_METHODS = {
  classificationAsc842Lessee: method("lease.classification.asc842.lessee"),
  discountRateSelect: method("lease.discountRate.select"),
  periodicRate: method("lease.rate.periodic"),
  presentValue: method("lease.pv.stream"),
  schedule: method("lease.schedule.amortization"),
  registry: method("lease.methods.registry"),
} as const satisfies Record<string, MethodRef>;

export const LEASE_REFUSAL_KINDS = [
  "ClassificationEvidenceInsufficient",
  "DiscountRateUnavailable",
  "RateTermMismatch",
  "CompoundingConventionRequired",
  "DiscountRateElectionRequired",
  "RiskFreeElectionUnavailable",
  "RateObservationConventionUnstated",
] as const;
export type LeaseRefusalKind = (typeof LEASE_REFUSAL_KINDS)[number];

export interface LeaseRefusal {
  readonly kind: LeaseRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LeaseRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: LeaseRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

/** R0's capture precision: part of the rounding contract, and what makes the G-23 goldens exact. */
export const RATE_SCALE = 12;
const RATE_D = 10n ** BigInt(RATE_SCALE);

// ── 16.4 · Classification: five criteria, three verdicts, one asymmetry ─────

export type CriterionVerdict = "met" | "not-met" | "indeterminate";

export interface ClassificationEvidence {
  /** C1: the contract's transfer clause — absent means INDETERMINATE, not no. */
  readonly ownershipTransfers?: boolean;
  /** C2: an option exists; a PurchaseOptionAssessment answers reasonable certainty. */
  readonly purchaseOptionExists?: boolean;
  readonly purchaseOptionReasonablyCertain?: boolean;
  /** C3: term vs remaining economic life, both in months. */
  readonly termMonths?: number;
  readonly remainingEconomicLifeMonths?: number;
  /** C4: PV of payments vs fair value, in minor units. */
  readonly pvOfPaymentsMinor?: bigint;
  readonly fairValueMinor?: bigint;
  /** C5: alternative-use evidence. */
  readonly noAlternativeUse?: boolean;
}

export interface ThresholdPolicy {
  /** "major part" — basis points of remaining life (the widely-applied 7500 is POLICY, not law). */
  readonly majorPartBps: number;
  /** "substantially all" — basis points of fair value. */
  readonly substantiallyAllBps: number;
}

export interface ClassificationOutcome {
  readonly classification: "finance" | "operating";
  readonly verdicts: Readonly<Record<string, CriterionVerdict>>;
}

export function classifyAsc842Lessee(
  evidence: ClassificationEvidence,
  policy: ThresholdPolicy,
): Result<ClassificationOutcome> {
  const M = LEASE_METHODS.classificationAsc842Lessee;
  const verdicts: Record<string, CriterionVerdict> = {};

  verdicts.C1 =
    evidence.ownershipTransfers === undefined
      ? "indeterminate"
      : evidence.ownershipTransfers
        ? "met"
        : "not-met";

  verdicts.C2 =
    evidence.purchaseOptionExists === undefined
      ? "indeterminate"
      : !evidence.purchaseOptionExists
        ? "not-met"
        : evidence.purchaseOptionReasonablyCertain === undefined
          ? "indeterminate" // an option exists and no assessment does
          : evidence.purchaseOptionReasonablyCertain
            ? "met"
            : "not-met";

  verdicts.C3 =
    evidence.termMonths === undefined || evidence.remainingEconomicLifeMonths === undefined
      ? "indeterminate"
      : evidence.termMonths * 10000 >= evidence.remainingEconomicLifeMonths * policy.majorPartBps
        ? "met"
        : "not-met";

  verdicts.C4 =
    evidence.pvOfPaymentsMinor === undefined || evidence.fairValueMinor === undefined
      ? "indeterminate"
      : evidence.pvOfPaymentsMinor * 10000n >=
          evidence.fairValueMinor * BigInt(policy.substantiallyAllBps)
        ? "met"
        : "not-met";

  verdicts.C5 =
    evidence.noAlternativeUse === undefined
      ? "indeterminate"
      : evidence.noAlternativeUse
        ? "met"
        : "not-met";

  const values = Object.values(verdicts);
  if (values.includes("met")) {
    // Sufficient: remaining verdicts may stay indeterminate.
    return ok({ classification: "finance", verdicts });
  }
  if (values.every((v) => v === "not-met")) {
    return ok({ classification: "operating", verdicts });
  }
  const indeterminates = Object.entries(verdicts)
    .filter(([, v]) => v === "indeterminate")
    .map(([k]) => k);
  return refuse(
    "ClassificationEvidenceInsufficient",
    M,
    `Criteria ${indeterminates.join(", ")} are indeterminate. Defaulting them to not-met would bias every uncertain lease toward operating — the direction the preparer benefits from — so the refusal names what is missing instead.`,
  );
}

// ── 16.5 · Discount-rate selection ──────────────────────────────────────────

export interface DiscountRateInputs {
  readonly standard: "asc842" | "ifrs16";
  readonly implicitRateReadilyDeterminable: boolean;
  readonly implicitRatePercent?: string;
  /** ASU 2021-09: by CLASS of underlying asset, a disclosure. Required as policy. */
  readonly riskFreeElectedClasses?: readonly string[];
  readonly assetClass: string;
  readonly riskFreeRatePercent?: string;
  readonly ibr?: {
    readonly ratePercent: string;
    readonly termMatchMonths: number;
  };
  readonly leaseTermMonths: number;
}

export function selectDiscountRate(
  input: DiscountRateInputs,
): Result<{ rateType: "implicit" | "risk-free" | "ibr"; ratePercent: string }> {
  const M = LEASE_METHODS.discountRateSelect;
  if (input.implicitRateReadilyDeterminable && input.implicitRatePercent !== undefined) {
    return ok({ rateType: "implicit", ratePercent: input.implicitRatePercent });
  }
  const elected = input.riskFreeElectedClasses?.includes(input.assetClass) === true;
  if (elected) {
    if (input.standard === "ifrs16") {
      // IFRS 16 has no such election — a typed refusal, not a silent ignore.
      return refuse(
        "RiskFreeElectionUnavailable",
        M,
        "The risk-free election is an ASC 842 (ASU 2021-09) mechanism, by class of underlying asset. IFRS 16 has no such election.",
      );
    }
    if (input.riskFreeRatePercent !== undefined) {
      return ok({ rateType: "risk-free", ratePercent: input.riskFreeRatePercent });
    }
  }
  if (input.ibr !== undefined) {
    if (input.ibr.termMatchMonths !== input.leaseTermMonths) {
      return refuse(
        "RateTermMismatch",
        M,
        `The IBR evidence matches a ${input.ibr.termMatchMonths}-month term; the lease term is ${input.leaseTermMonths} months. A rate with no term match is what auditors ask for and preparers most often lack.`,
      );
    }
    return ok({ rateType: "ibr", ratePercent: input.ibr.ratePercent });
  }
  return refuse(
    "DiscountRateUnavailable",
    M,
    "No implicit-rate evidence, no elected risk-free rate, no IBR evidence. Refused in preference to any rate this engine could have chosen for the entity.",
  );
}

// ── R0 · Periodic rate under a REQUIRED compounding convention ──────────────

export type CompoundingConvention = "nominal-div-12" | "effective-annual";

/** Percent string ("7", "4.25") → exact scaled fraction of 1 at RATE_SCALE. */
function percentToRateUnits(percent: string): { num: bigint; den: bigint } {
  const [whole = "0", fraction = ""] = percent.split(".");
  return { num: BigInt(whole + fraction), den: 100n * 10n ** BigInt(fraction.length) };
}

/** Integer 12th root: the largest u with (D+u)^12 ≤ target·D^12, then round to nearest. */
function twelfthRootMinusOne(annualNum: bigint, annualDen: bigint): bigint {
  // Solve (1+x)^12 = 1 + annual, x at RATE_SCALE.
  const target = (annualDen + annualNum) * RATE_D ** 12n; // scaled by den
  const pow12 = (u: bigint): bigint => {
    let v = 1n;
    const base = RATE_D + u;
    for (let i = 0; i < 12; i++) v *= base;
    return v * annualDen;
  };
  let low = 0n;
  let high = RATE_D; // x < 100%
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (pow12(mid) <= target) low = mid;
    else high = mid - 1n;
  }
  // Round to nearest by comparing the two neighbours' distance to the target.
  const below = pow12(low);
  const above = pow12(low + 1n);
  return target - below <= above - target ? low : low + 1n;
}

/**
 * The periodic rate, computed ONCE and captured by value (R0). LFIQ-K-2:
 * nominal÷12 vs effective-annual differ by 0.961% of the ENTIRE liability on
 * G-23 — the convention is required, with no default.
 */
export function periodicRateUnits(
  annualPercent: string,
  convention: CompoundingConvention | undefined,
): Result<bigint> {
  const M = LEASE_METHODS.periodicRate;
  if (convention === undefined) {
    return refuse(
      "CompoundingConventionRequired",
      M,
      "nominal-div-12 and effective-annual differ by 17.9bp on a 7% rate — 0.961% of the entire recognised liability, for the life of the lease. Declare one; nothing is hardcoded.",
    );
  }
  const { num, den } = percentToRateUnits(annualPercent);
  if (convention === "nominal-div-12") {
    return ok(divideAndRound(num * RATE_D, den * 12n, "half-even"));
  }
  return ok(twelfthRootMinusOne(num, den));
}

// ── R1/R2 · Present value of the payment stream, rounded ONCE ───────────────

export function presentValueMinor(
  paymentMinor: bigint,
  periods: number,
  rateUnits: bigint,
  timing: "arrears" | "advance",
): bigint {
  // v = D/(D+r) as an exact rational; the sum is computed exactly and rounded
  // once at R2 — factors are never individually rounded (R1).
  const num = RATE_D;
  const den = RATE_D + rateUnits;
  let vnNum = 1n;
  let vnDen = 1n;
  for (let i = 0; i < periods; i++) {
    vnNum *= num;
    vnDen *= den;
  }
  // arrears: Σ v^1..v^n = num(vnDen − vnNum) / (vnDen(den − num))
  const sNum = num * (vnDen - vnNum);
  const sDen = vnDen * (den - num);
  const pvNum =
    timing === "arrears" ? paymentMinor * sNum : paymentMinor * sNum * den; // advance = arrears × (1+r)
  const pvDen = timing === "arrears" ? sDen : sDen * num;
  return divideAndRound(pvNum, pvDen, "half-even");
}

// ── R4..R8 · The schedule, with exact terminal invariants ───────────────────

export interface SchedulePeriod {
  readonly period: number;
  readonly liabilityOpenMinor: bigint;
  readonly interestMinor: bigint;
  readonly paymentMinor: bigint;
  readonly liabilityCloseMinor: bigint;
  readonly singleLeaseCostMinor?: bigint;
  readonly rouAmortizationMinor: bigint;
  readonly rouCloseMinor: bigint;
}

export interface LeaseSchedule {
  readonly periods: readonly SchedulePeriod[];
  readonly totalInterestMinor: bigint;
}

export function buildSchedule(input: {
  readonly model: "finance" | "operating";
  readonly openingLiabilityMinor: bigint;
  readonly openingRouMinor: bigint;
  readonly paymentMinor: bigint;
  readonly periods: number;
  readonly rateUnits: bigint;
  readonly timing: "arrears" | "advance";
  /** R7's total cost includes unamortized IDC and deducts incentives — the
   * awkward totals that make cumulative-target rounding load-bearing. */
  readonly initialDirectCostsMinor?: bigint;
  readonly incentivesMinor?: bigint;
}): LeaseSchedule {
  const rows: SchedulePeriod[] = [];
  const n = BigInt(input.periods);
  let liability = input.openingLiabilityMinor;
  let rou = input.openingRouMinor;
  let totalInterest = 0n;

  // R6: final-period-absorbs straight-line base for the finance model.
  const rouBase = input.openingRouMinor / n;
  const rouRemainder = input.openingRouMinor - rouBase * n;

  // R7: cumulative-target rounding for the operating model's single cost —
  // total remaining cost = payments + IDC − incentives, which need not divide
  // evenly by n. Independent per-period rounding would miss the true total by
  // up to n minor units and the ROU asset would not reach zero.
  const totalCost =
    input.paymentMinor * n + (input.initialDirectCostsMinor ?? 0n) - (input.incentivesMinor ?? 0n);
  let previousCumulativeTarget = 0n;

  for (let p = 1; p <= input.periods; p++) {
    const open = liability;
    let interest: bigint;
    let payment = input.paymentMinor;
    if (input.timing === "advance") {
      // Payment applies before interest accrues (annuity-due).
      interest = divideAndRound((open - payment) * input.rateUnits, RATE_D, "half-even");
    } else {
      interest = divideAndRound(open * input.rateUnits, RATE_D, "half-even");
    }
    // Final period: the payment retires the liability exactly; the interest
    // is the closing difference — the effective-interest method's own
    // self-correction, one minor unit at most, absorbed in interest not in a
    // plug line.
    if (p === input.periods) {
      interest = payment - open;
      if (input.timing === "advance") interest = payment - open; // identical form
    }
    const close = open + interest - payment;
    totalInterest += interest;

    let singleLeaseCost: bigint | undefined;
    let rouAmortization: bigint;
    if (input.model === "operating") {
      const cumulativeTarget = divideAndRound(BigInt(p) * totalCost, n, "half-even");
      singleLeaseCost = cumulativeTarget - previousCumulativeTarget;
      previousCumulativeTarget = cumulativeTarget;
      // R8: the plug — the difference of two already-rounded integers. NO rounding.
      rouAmortization = singleLeaseCost - interest;
    } else {
      rouAmortization = p === input.periods ? rouBase + rouRemainder : rouBase;
    }
    rou -= rouAmortization;

    rows.push({
      period: p,
      liabilityOpenMinor: open,
      interestMinor: interest,
      paymentMinor: payment,
      liabilityCloseMinor: close,
      ...(singleLeaseCost !== undefined ? { singleLeaseCostMinor: singleLeaseCost } : {}),
      rouAmortizationMinor: rouAmortization,
      rouCloseMinor: rou,
    });
    liability = close;
  }
  return { periods: rows, totalInterestMinor: totalInterest };
}
