// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { divideAndRound, type MethodRef, type RoundingMode } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// AssetFinanceIQ kernel — §16. Depreciation methods are CUMULATIVE FUNCTIONS
// C(n), and the ONE rounding boundary is on the cumulative function:
//   charge(n) = round(C(n)) − round(C(n−1))
// so Σ charges == round(C(N)) == the depreciable base EXACTLY, with no plug
// line and no final-period true-up — the deliberate correction of CostIQ's
// round-per-line-then-sum drift.
//
// A mid-life change opens a NEW MethodEpoch; history is never recomputed.
// Books diverge for real: US GAAP prohibits impairment reversal; tax books
// take a §481(a) catch-up where book frameworks apply estimates prospectively.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const ASSET_METHODS = {
  capThresholdPolicy: method("CAP-THRESHOLD-POLICY"),
  straightLine: method("DEPR-STRAIGHT-LINE"),
  decliningBalance: method("DEPR-DECLINING-BALANCE"),
  sumOfYearsDigits: method("DEPR-SUM-OF-YEARS-DIGITS"),
  unitsOfProduction: method("DEPR-UNITS-OF-PRODUCTION"),
  macrsGds: method("DEPR-MACRS-GDS"),
  scheduleRounding: method("DEPR-SCHEDULE-ROUNDING"),
  midqDetermination: method("MIDQ-DETERMINATION"),
  epochOpen: method("EPOCH-OPEN"),
  tax481aCatchup: method("TAX-481A-CATCHUP"),
  impairMeasure: method("IMPAIR-MEASURE"),
  impairReverseCeiling: method("IMPAIR-REVERSE-CEILING"),
  frameworkPermission: method("FRAMEWORK-PERMISSION"),
  disposalOutcome: method("DISPOSAL-OUTCOME"),
  proposalIdempotency: method("PROPOSAL-IDEMPOTENCY"),
} as const satisfies Record<string, MethodRef>;

export const ASSET_REFUSAL_KINDS = [
  "JUDGEMENT_REQUIRED",
  "USAGE_UNAVAILABLE",
  "MIDQ_INDETERMINATE",
  "TEST_BASIS_CONVENTION_REQUIRED",
  "RECOVERABLE_AMOUNT_UNAVAILABLE",
  "IMPAIRMENT_REVERSAL_PROHIBITED_BY_FRAMEWORK",
  "CATCHUP_NOT_PERMITTED",
  "AUTHORIZATION_REQUIRED",
  "EPOCH_HISTORY_IMMUTABLE",
] as const;
export type AssetRefusalKind = (typeof ASSET_REFUSAL_KINDS)[number];

export interface AssetRefusal {
  readonly kind: AssetRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: AssetRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: AssetRefusalKind,
  methodRef: MethodRef,
  detail: string,
): AssetRefusal extends never ? never : Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── CAP-THRESHOLD-POLICY: three-valued, never silently expensing ────────────

export function capitalizationVerdict(input: {
  readonly amountMinor: bigint;
  readonly thresholdMinor: bigint;
  /** Present when the betterment/restoration/adaptation test was answered. */
  readonly improvementTestOutcome?: "improvement" | "repair";
}): Result<"capitalize" | "expense" | "judgement-required"> {
  if (input.improvementTestOutcome === "improvement") return ok("capitalize");
  if (input.improvementTestOutcome === "repair") return ok("expense");
  if (input.amountMinor >= input.thresholdMinor) return ok("capitalize");
  // Below threshold with no improvement-test answer: the legal test is not
  // arithmetic, and defaulting to expense is a silent, permanent, understated
  // asset base. The unresolved test is NAMED.
  return ok("judgement-required");
}

// ── Cumulative depreciation functions (exact rational over bigint) ──────────

export interface CumulativeFn {
  /** Cumulative depreciation through period n, in minor units, full precision (num/den). */
  (n: number): { num: bigint; den: bigint };
}

export function straightLineC(baseMinor: bigint, totalPeriods: number): CumulativeFn {
  return (n) => {
    const capped = n >= totalPeriods ? totalPeriods : n;
    return { num: baseMinor * BigInt(capped), den: BigInt(totalPeriods) };
  };
}

export function sumOfYearsDigitsC(baseMinor: bigint, lifeYears: number): CumulativeFn {
  const denominator = BigInt((lifeYears * (lifeYears + 1)) / 2);
  return (n) => {
    const capped = n >= lifeYears ? lifeYears : n;
    let numerator = 0n;
    for (let i = 1; i <= capped; i++) numerator += BigInt(lifeYears - i + 1);
    return { num: baseMinor * numerator, den: denominator };
  };
}

/**
 * Declining balance with factor (×100, e.g. 200 for double-declining) and the
 * straight-line switch in the first period where the remaining-life SL charge
 * exceeds the DB charge. Iterative by construction; the switch period is part
 * of the returned schedule, recorded, never recomputed at read time.
 * Residual floors the carrying amount — the method never depreciates below it.
 */
export function decliningBalanceSchedule(input: {
  readonly costMinor: bigint;
  readonly residualMinor: bigint;
  readonly lifePeriods: number;
  readonly factorPercent: number; // 150 | 200
  readonly scale: number;
  readonly mode: RoundingMode;
}): { readonly charges: readonly bigint[]; readonly switchPeriod: number | undefined } {
  const charges: bigint[] = [];
  let carrying = input.costMinor;
  let switchPeriod: number | undefined;
  for (let n = 1; n <= input.lifePeriods; n++) {
    const remainingPeriods = input.lifePeriods - n + 1;
    const dbCharge = divideAndRound(
      carrying * BigInt(input.factorPercent),
      BigInt(input.lifePeriods) * 100n,
      input.mode,
    );
    const slCharge = divideAndRound(
      (carrying - input.residualMinor),
      BigInt(remainingPeriods),
      input.mode,
    );
    let charge: bigint;
    if (switchPeriod === undefined && slCharge > dbCharge) {
      switchPeriod = n;
    }
    charge = switchPeriod !== undefined ? slCharge : dbCharge;
    // Floor at residual: never below it.
    if (carrying - charge < input.residualMinor) charge = carrying - input.residualMinor;
    if (charge < 0n) charge = 0n;
    charges.push(charge);
    carrying -= charge;
  }
  return { charges, switchPeriod };
}

/**
 * DEPR-SCHEDULE-ROUNDING: the one boundary. charge(n) = round(C(n)) −
 * round(C(n−1)); the final period absorbs the residue BY CONSTRUCTION.
 */
export function scheduleFromCumulative(
  cumulative: CumulativeFn,
  totalPeriods: number,
  mode: RoundingMode,
): readonly bigint[] {
  const charges: bigint[] = [];
  let previous = 0n;
  for (let n = 1; n <= totalPeriods; n++) {
    const { num, den } = cumulative(n);
    const rounded = divideAndRound(num, den, mode);
    charges.push(rounded - previous);
    previous = rounded;
  }
  return charges;
}

// ── MACRS: table-driven, versioned data with a derivation ───────────────────

/**
 * 5-year property, 200% DB, per Pub. 946 — each table derivable as
 * 40%/yr × the convention's fraction of the first year, which is why the
 * golden case can assert them exactly. Rates in basis points of cost.
 */
export const MACRS_5YR_TABLES: Readonly<Record<string, readonly number[]>> = {
  "half-year": [2000, 3200, 1920, 1152, 1152, 576],
  "mid-quarter-q1": [3500, 2600, 1560, 1101, 1101, 138],
  "mid-quarter-q2": [2500, 3000, 1800, 1137, 1137, 426],
  "mid-quarter-q3": [1500, 3400, 2040, 1224, 1130, 712],
  "mid-quarter-q4": [500, 3800, 2280, 1368, 1094, 958],
};

export interface TestBasisConvention {
  readonly section179: "reduces" | "does-not-reduce";
  readonly bonus: "reduces" | "does-not-reduce";
  readonly sameYearDisposals: "excluded" | "included";
}

export interface InServiceRecord {
  readonly recordId: string;
  readonly quarter: 1 | 2 | 3 | 4;
  readonly preElectionBasisMinor: bigint;
  readonly section179Minor: bigint;
  readonly disposedSameYear: boolean;
  readonly basisFrozen: boolean;
}

export interface MidQuarterDetermination {
  readonly outcome: "mid-quarter-required" | "half-year" | "indeterminate";
  readonly q4RatioBasisPoints: number;
  /** The ratio the OTHER §179 reading would have produced, when it differs —
   * the difference between a system that made a choice and one that hid one. */
  readonly alternativeQ4RatioBasisPoints?: number;
  readonly convention: TestBasisConvention;
  readonly indeterminateReason?: "population-incomplete";
}

/**
 * MIDQ-DETERMINATION: population-scoped, immutable, three-valued.
 * `testBasisConvention` is a REQUIRED argument with no default (G-21: the
 * readings straddle the 40% statutory cliff — 35.29% vs 46.15% on one
 * population, a $21,500 / 27.56% first-year spread). An incomplete
 * population is `indeterminate`, and every MACRS schedule for the year then
 * refuses: unknown ≠ half-year.
 */
export function determineMidQuarter(
  population: readonly InServiceRecord[],
  convention: TestBasisConvention | undefined,
): Result<MidQuarterDetermination> {
  const M = ASSET_METHODS.midqDetermination;
  if (convention === undefined) {
    return refuse(
      "TEST_BASIS_CONVENTION_REQUIRED",
      M,
      "Which population, on which basis, enters the 40% test is a convention with opposite determinations on the same facts (G-21: 35.29% vs 46.15%). There is no default, no ??, no most-common fallback.",
    );
  }
  if (population.some((r) => !r.basisFrozen)) {
    return ok({
      outcome: "indeterminate",
      q4RatioBasisPoints: 0,
      convention,
      indeterminateReason: "population-incomplete",
    });
  }
  const ratioFor = (c: TestBasisConvention): number => {
    let total = 0n;
    let q4 = 0n;
    for (const record of population) {
      if (c.sameYearDisposals === "excluded" && record.disposedSameYear) continue;
      const basis =
        c.section179 === "reduces"
          ? record.preElectionBasisMinor - record.section179Minor
          : record.preElectionBasisMinor;
      total += basis;
      if (record.quarter === 4) q4 += basis;
    }
    if (total === 0n) return 0;
    return Number((q4 * 10000n) / total);
  };
  const ratio = ratioFor(convention);
  const alternative = ratioFor({
    ...convention,
    section179: convention.section179 === "reduces" ? "does-not-reduce" : "reduces",
  });
  return ok({
    outcome: ratio > 4000 ? "mid-quarter-required" : "half-year",
    q4RatioBasisPoints: ratio,
    ...(alternative !== ratio ? { alternativeQ4RatioBasisPoints: alternative } : {}),
    convention,
  });
}

/** Year-1 MACRS charge for a record under a determination. Refuses on indeterminate. */
export function macrsYear1Charge(
  postElectionBasisMinor: bigint,
  quarter: 1 | 2 | 3 | 4,
  determination: MidQuarterDetermination,
  mode: RoundingMode,
): Result<bigint> {
  const M = ASSET_METHODS.macrsGds;
  if (determination.outcome === "indeterminate") {
    return refuse(
      "MIDQ_INDETERMINATE",
      M,
      "The mid-quarter determination is indeterminate (population incomplete). It does NOT default to half-year: the error would be invisible because the numbers look plausible.",
    );
  }
  const table =
    determination.outcome === "half-year"
      ? MACRS_5YR_TABLES["half-year"]
      : MACRS_5YR_TABLES[`mid-quarter-q${quarter}`];
  const rate = table?.[0];
  if (rate === undefined) return refuse("MIDQ_INDETERMINATE", M, "No table row.");
  return ok(divideAndRound(postElectionBasisMinor * BigInt(rate), 10000n, mode));
}

// ── Epochs: prospective, immutable history; §481(a) only where permitted ────

export interface FrameworkPermissions {
  readonly permitsImpairmentReversal: boolean;
  readonly permitsMethodChangeCatchUp: boolean;
}

export const FRAMEWORKS: Readonly<Record<string, FrameworkPermissions>> = {
  ifrs: { permitsImpairmentReversal: true, permitsMethodChangeCatchUp: false },
  "us-gaap": { permitsImpairmentReversal: false, permitsMethodChangeCatchUp: false },
  "us-tax": { permitsImpairmentReversal: false, permitsMethodChangeCatchUp: true },
};

export interface MethodEpoch {
  readonly epochId: string;
  readonly effectiveFromPeriod: number;
  readonly charges: readonly bigint[];
  readonly reason:
    | "initial"
    | "life-revision"
    | "method-revision"
    | "impairment-rebasing"
    | "correction-of-error";
  readonly authorizationRef?: string;
}

/** The full schedule is the ordered concatenation of epochs. History never recomputes. */
export function openEpoch(
  priorEpochs: readonly MethodEpoch[],
  next: Omit<MethodEpoch, "epochId">,
): Result<readonly MethodEpoch[]> {
  const M = ASSET_METHODS.epochOpen;
  if (next.reason !== "initial" && next.authorizationRef === undefined) {
    return refuse("AUTHORIZATION_REQUIRED", M, `Opening a ${next.reason} epoch requires a Governance decision reference.`);
  }
  const lastEnd = priorEpochs.reduce(
    (acc, epoch) => Math.max(acc, epoch.effectiveFromPeriod + epoch.charges.length - 1),
    0,
  );
  if (next.effectiveFromPeriod <= lastEnd && priorEpochs.length > 0) {
    return refuse(
      "EPOCH_HISTORY_IMMUTABLE",
      M,
      `The new epoch starts at period ${next.effectiveFromPeriod}, inside history that ends at ${lastEnd}. A mid-life change NEVER recomputes history; it begins after it.`,
    );
  }
  return ok([...priorEpochs, { ...next, epochId: `epoch-${priorEpochs.length + 1}` }]);
}

/** Reading a historical figure reads the epoch that governed it, whatever happened since. */
export function chargeAt(epochs: readonly MethodEpoch[], period: number): bigint | undefined {
  for (const epoch of epochs) {
    const offset = period - epoch.effectiveFromPeriod;
    if (offset >= 0 && offset < epoch.charges.length) return epoch.charges[offset];
  }
  return undefined;
}

/**
 * TAX-481A-CATCHUP: only in frameworks that permit it, only for a METHOD
 * revision (a life revision is explicitly not a method change and permits no
 * catch-up — and the classification is an INPUT, not this engine's
 * judgement). The catch-up is a new fact about the current period; prior
 * epochs remain exactly what they were.
 */
export function tax481aCatchup(input: {
  readonly framework: string;
  readonly changeClassification: "method-revision" | "life-revision";
  readonly takenToDateMinor: bigint;
  readonly wouldHaveTakenMinor: bigint;
}): Result<{ catchUpMinor: bigint }> {
  const M = ASSET_METHODS.tax481aCatchup;
  const permissions = FRAMEWORKS[input.framework];
  if (!permissions?.permitsMethodChangeCatchUp) {
    return refuse(
      "CATCHUP_NOT_PERMITTED",
      M,
      `Framework ${input.framework} applies estimate changes prospectively; a §481(a) catch-up is a tax-book mechanism.`,
    );
  }
  if (input.changeClassification === "life-revision") {
    return refuse(
      "CATCHUP_NOT_PERMITTED",
      M,
      "A change in useful life alone is explicitly not an accounting-method change and permits no §481(a) adjustment.",
    );
  }
  return ok({ catchUpMinor: input.wouldHaveTakenMinor - input.takenToDateMinor });
}

// ── Impairment and disposal ─────────────────────────────────────────────────

export function measureImpairment(input: {
  readonly carryingMinor: bigint;
  readonly fairValueLessCostsMinor?: bigint;
  readonly valueInUseMinor?: bigint;
}): Result<{ lossMinor: bigint }> {
  const M = ASSET_METHODS.impairMeasure;
  if (input.fairValueLessCostsMinor === undefined && input.valueInUseMinor === undefined) {
    // A carrying amount is never impaired to a number the engine invented.
    return refuse(
      "RECOVERABLE_AMOUNT_UNAVAILABLE",
      M,
      "Recoverable amount is the higher of fair value less costs and value in use, BOTH supplied with evidence. The engine projects no cash flow and selects no discount rate.",
    );
  }
  const candidates = [input.fairValueLessCostsMinor, input.valueInUseMinor].filter(
    (v): v is bigint => v !== undefined,
  );
  const recoverable = candidates.reduce((a, b) => (a > b ? a : b));
  const loss = input.carryingMinor - recoverable;
  return ok({ lossMinor: loss > 0n ? loss : 0n });
}

/** Reversal: framework-bound (US GAAP refuses — a framework rule, not a flag), capped at the no-impairment counterfactual. */
export function reverseImpairment(input: {
  readonly framework: string;
  readonly currentCarryingMinor: bigint;
  readonly proposedCarryingMinor: bigint;
  readonly counterfactualCarryingMinor: bigint;
}): Result<{ newCarryingMinor: bigint }> {
  const M = ASSET_METHODS.impairReverseCeiling;
  const permissions = FRAMEWORKS[input.framework];
  if (!permissions?.permitsImpairmentReversal) {
    return refuse(
      "IMPAIRMENT_REVERSAL_PROHIBITED_BY_FRAMEWORK",
      M,
      `Framework ${input.framework} prohibits impairment reversal. Not a configuration flag a customer can turn on: a framework rule.`,
    );
  }
  const ceiling = input.counterfactualCarryingMinor;
  const proposed = input.proposedCarryingMinor > ceiling ? ceiling : input.proposedCarryingMinor;
  return ok({ newCarryingMinor: proposed > input.currentCarryingMinor ? proposed : input.currentCarryingMinor });
}

export function disposalOutcome(input: {
  readonly proceedsMinor: bigint;
  readonly carryingAtDisposalMinor: bigint;
}): { gainLossMinor: bigint } {
  return { gainLossMinor: input.proceedsMinor - input.carryingAtDisposalMinor };
}

export function proposalIdempotencyKey(components: {
  readonly tenantRef: string;
  readonly bookId: string;
  readonly recordId: string;
  readonly periodRef: string;
  readonly scheduleFingerprint: string;
  readonly proposalKind: string;
  readonly epochId: string;
}): string {
  return [
    components.tenantRef,
    components.bookId,
    components.recordId,
    components.periodRef,
    components.scheduleFingerprint,
    components.proposalKind,
    components.epochId,
  ].join("|");
}
