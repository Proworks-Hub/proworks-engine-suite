// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  R_ZERO,
  rAdd,
  rDiv,
  rMul,
  rSub,
  rational,
  type MethodRef,
  type Rational,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// DebtIQ kernel — §16. The EIR is solved by BISECTION on exact decimal, not
// Newton–Raphson: bisection is deterministic, has no derivative to misbehave
// on an irregular vector, and its step count is a pure function of the
// stopping width — the same inputs produce the same answer on every platform.
// The amortized-cost recurrence carries UNROUNDED: rounding the interest and
// carrying the rounded value forward leaves 0.01 at maturity on five annual
// periods and much more on 360 monthly ones; the residual goes to a declared
// plug or the run refuses. The 10% modification test includes fees exchanged
// with the LENDER ONLY — 200k of third-party legal costs wrongly included
// flips modification to extinguishment on the golden case (G-11).
// Covenants have NO built-in ratios: a covenant definition is contract text,
// and a template cannot be tested against.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const DEBT_METHODS = {
  dayCount: method("debtiq.daycount"),
  eirSolve: method("debtiq.eir.solve"),
  amortCost: method("debtiq.amortcost.effective-interest"),
  accrualFixed: method("debtiq.accrual.fixed"),
  levelPayment: method("debtiq.amortization.level-payment"),
  tenPercentIfrs: method("debtiq.mod.tenpercent-test.ifrs"),
  covenantEval: method("debtiq.covenant.evaluate"),
  prepayment: method("debtiq.prepayment.apply"),
  ladder: method("debtiq.maturity.ladder"),
} as const satisfies Record<string, MethodRef>;

export const DEBT_REFUSAL_KINDS = [
  "mixed-date-adjustment",
  "act-act-icma-requires-coupon-schedule",
  "eir-no-sign-change",
  "eir-not-converged",
  "amortization-residual-unallocated",
  "plug-policy-not-declared",
  "fee-payee-not-declared",
  "covenant-template-not-testable",
  "covenant-term-unbound",
  "prepayment-application-order-not-declared",
  "ladder-buckets-not-declared",
  "convention-incomplete",
] as const;
export type DebtRefusalKind = (typeof DEBT_REFUSAL_KINDS)[number];

export interface DebtRefusal {
  readonly kind: DebtRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: DebtRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: DebtRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.1 · day-count conventions ───────────────────────────────────────────

export type DayCountConvention =
  | "act-360"
  | "act-365f"
  | "act-act-isda"
  | "30-360-us"
  | "30e-360"
  | "30e-360-isda";

export interface CalDate {
  readonly y: number;
  readonly m: number; // 1..12
  readonly d: number;
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]!);
const isLastDayOfMonth = (dt: CalDate): boolean => dt.d === daysInMonth(dt.y, dt.m);

/** Days between two dates (civil calendar), d2 > d1. */
export function actualDays(d1: CalDate, d2: CalDate): number {
  const toSerial = (dt: CalDate): number => {
    // Days since 0000-03-01 (civil), the standard branchless algorithm.
    const y = dt.m <= 2 ? dt.y - 1 : dt.y;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (dt.m + (dt.m > 2 ? -3 : 9)) + 2) / 5) + dt.d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe;
  };
  return toSerial(d2) - toSerial(d1);
}

/**
 * Year fraction as an exact rational. §16.1 preconditions: d1 < d2; the
 * caller asserts both dates share one adjustment state (mixed adjustment is
 * refused). ACT/ACT-ICMA needs the coupon schedule and refuses without it —
 * it is not a substitute for ACT/ACT-ISDA.
 */
export function dayCountFraction(
  convention: DayCountConvention,
  d1: CalDate,
  d2: CalDate,
  options?: {
    readonly bothAdjusted?: boolean;
    readonly bothUnadjusted?: boolean;
    readonly eomInstrument?: boolean;
    readonly maturityDate?: CalDate;
  },
): Result<Rational> {
  const M = DEBT_METHODS.dayCount;
  if (options?.bothAdjusted === false && options?.bothUnadjusted === false) {
    return refuse("mixed-date-adjustment", M, "Both dates adjusted or both unadjusted — never mixed.");
  }
  switch (convention) {
    case "act-360":
      return ok(rational(BigInt(actualDays(d1, d2)), 360n));
    case "act-365f":
      return ok(rational(BigInt(actualDays(d1, d2)), 365n));
    case "act-act-isda": {
      // Split at calendar-year boundaries; each slice over its own year length.
      let fraction: Rational = R_ZERO;
      let cursor = d1;
      while (cursor.y < d2.y) {
        const yearEnd: CalDate = { y: cursor.y + 1, m: 1, d: 1 };
        fraction = rAdd(fraction, rational(BigInt(actualDays(cursor, yearEnd)), isLeap(cursor.y) ? 366n : 365n));
        cursor = yearEnd;
      }
      fraction = rAdd(fraction, rational(BigInt(actualDays(cursor, d2)), isLeap(d2.y) ? 366n : 365n));
      return ok(fraction);
    }
    case "30-360-us": {
      let D1 = d1.d;
      let D2 = d2.d;
      if (D1 === 31) D1 = 30;
      if (D2 === 31 && D1 === 30) D2 = 30;
      return ok(rational(BigInt(360 * (d2.y - d1.y) + 30 * (d2.m - d1.m) + (D2 - D1)), 360n));
    }
    case "30e-360": {
      let D1 = d1.d;
      let D2 = d2.d;
      if (isLastDayOfMonth(d1)) D1 = 30;
      const isMaturity =
        options?.maturityDate !== undefined &&
        d2.y === options.maturityDate.y &&
        d2.m === options.maturityDate.m &&
        d2.d === options.maturityDate.d;
      if (isLastDayOfMonth(d2) && !(isMaturity && d2.m === 2)) D2 = 30;
      return ok(rational(BigInt(360 * (d2.y - d1.y) + 30 * (d2.m - d1.m) + (D2 - D1)), 360n));
    }
    case "30e-360-isda": {
      // The four ORDERED rules; T-11 proves order matters by permuting them.
      let D1 = d1.d;
      let D2 = d2.d;
      const eom = options?.eomInstrument === true;
      const lastFeb = (dt: CalDate): boolean => dt.m === 2 && isLastDayOfMonth(dt);
      if (eom && lastFeb(d1) && lastFeb(d2)) D2 = 30; // rule 1
      if (eom && lastFeb(d1)) D1 = 30; // rule 2
      if (D2 === 31 && (D1 === 30 || D1 === 31)) D2 = 30; // rule 3
      if (D1 === 31) D1 = 30; // rule 4
      return ok(rational(BigInt(360 * (d2.y - d1.y) + 30 * (d2.m - d1.m) + (D2 - D1)), 360n));
    }
  }
}

/** ACT/ACT-ICMA lives apart because its inputs differ: it needs the coupon
 * schedule (frequency and the next regular coupon date). */
export function dayCountFractionIcma(
  d1: CalDate,
  d2: CalDate,
  couponSchedule: { readonly frequency: number; readonly nextCouponDate: CalDate } | undefined,
): Result<Rational> {
  const M = DEBT_METHODS.dayCount;
  if (couponSchedule === undefined) {
    return refuse("act-act-icma-requires-coupon-schedule", M, "ACT/ACT-ICMA needs the coupon schedule; it is not a substitute for ACT/ACT-ISDA.");
  }
  return ok(
    rational(
      BigInt(actualDays(d1, d2)),
      BigInt(couponSchedule.frequency) * BigInt(actualDays(d1, couponSchedule.nextCouponDate)),
    ),
  );
}

// ── §16.2 · EIR by deterministic bisection ──────────────────────────────────

export interface DatedCashFlow {
  /** Year offset from t0 (integer periods for a regular schedule). */
  readonly t: number;
  readonly amountMinor: bigint;
}

const rPowInt = (base: Rational, exponent: number): Rational => {
  let result = rational(1n, 1n);
  for (let i = 0; i < exponent; i++) result = rMul(result, base);
  return result;
};

function npvAtRateE10(cashFlows: readonly DatedCashFlow[], rateE10: bigint): Rational {
  const onePlusR = rational(10_000_000_000n + rateE10, 10_000_000_000n);
  let pv: Rational = R_ZERO;
  for (const cf of cashFlows) {
    pv = rAdd(pv, rDiv(rational(cf.amountMinor, 1n), rPowInt(onePlusR, cf.t)));
  }
  return pv;
}

export interface EirSolution {
  /** The solved rate scaled by 1e10 (e.g. 660326388 = 6.60326388%). */
  readonly rateE10: bigint;
  readonly methodRef: MethodRef;
  readonly stepCount: number;
}

/**
 * Solves Σ CFᵢ/(1+r)^tᵢ = 0 by bisection on the integer rateE10 axis. The
 * bracket is [0, 200%]; the search stops when the bracket width reaches one
 * unit of the axis — a stopping width, not an epsilon on the output, and the
 * step count is a pure function of it. Every failure is a refusal: there is
 * no best-effort EIR, because a wrong EIR mis-states every period of the
 * instrument's life.
 */
export function solveEir(cashFlows: readonly DatedCashFlow[]): Result<EirSolution> {
  const M = DEBT_METHODS.eirSolve;
  const signs = cashFlows.map((c) => (c.amountMinor < 0n ? -1 : c.amountMinor > 0n ? 1 : 0)).filter((s) => s !== 0);
  let changes = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) changes += 1;
  if (changes === 0) {
    return refuse("eir-no-sign-change", M, "The cash-flow vector never changes sign; no internal rate exists.");
  }
  let lo = 0n;
  let hi = 20_000_000_000n; // 200%
  const npvLo = npvAtRateE10(cashFlows, lo);
  const npvHi = npvAtRateE10(cashFlows, hi);
  if (npvLo.num <= 0n === npvHi.num <= 0n) {
    return refuse("eir-not-converged", M, "No sign change of NPV over the [0%, 200%] bracket.");
  }
  const loPositive = npvLo.num > 0n;
  let steps = 0;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const pv = npvAtRateE10(cashFlows, mid);
    if (pv.num > 0n === loPositive) lo = mid;
    else hi = mid;
    steps += 1;
  }
  return ok({ rateE10: lo, methodRef: M, stepCount: steps });
}

// ── §16.3 · amortized cost: unrounded carry, exact terminal ─────────────────

export interface AmortCostPeriod {
  readonly period: number;
  readonly openingCarrying: Rational;
  readonly interest: Rational;
  readonly cashMinor: bigint;
  readonly closingCarrying: Rational;
}

/** interest = openingCarrying × EIR; closing = opening + interest − cash.
 * Carried UNROUNDED — display rounding never re-enters the recurrence. */
export function amortizedCostSchedule(
  openingMinor: bigint,
  rateE10: bigint,
  periodCashMinor: readonly bigint[],
): readonly AmortCostPeriod[] {
  const rate = rational(rateE10, 10_000_000_000n);
  let carrying = rational(openingMinor, 1n);
  return periodCashMinor.map((cashMinor, i) => {
    const opening = carrying;
    const interest = rMul(opening, rate);
    carrying = rSub(rAdd(opening, interest), rational(cashMinor, 1n));
    return { period: i + 1, openingCarrying: opening, interest, cashMinor, closingCarrying: carrying };
  });
}

// ── §16.4 · fixed accrual with period additivity (P-2) ──────────────────────

export function fixedAccrual(
  principalMinor: bigint,
  rateE10: bigint,
  fraction: Rational,
): Rational {
  return rMul(rMul(rational(principalMinor, 1n), rational(rateE10, 10_000_000_000n)), fraction);
}

// ── §16.9 · level-payment schedule with the plug policy required ────────────

export type PlugPolicy = "final-payment-absorbs" | "final-principal-absorbs" | "refuse";

export interface LevelPaymentSchedule {
  readonly paymentMinor: bigint;
  readonly finalPaymentMinor: bigint;
  readonly residualAbsorbedMinor: bigint;
  readonly rows: readonly { period: number; interestMinor: bigint; principalMinor: bigint; closingMinor: bigint }[];
  readonly methodRef: MethodRef;
}

const halfUp = (numerator: bigint, denominator: bigint): bigint => {
  // denominator > 0; round half away from zero toward +∞ for positive values.
  const q = numerator / denominator;
  const rem = numerator % denominator;
  if (rem === 0n) return q;
  if (numerator > 0n) return 2n * rem >= denominator ? q + 1n : q;
  return 2n * -rem >= denominator ? q - 1n : q;
};

/**
 * payment = P·i/(1 − (1+i)^−n) exact, rounded once (RB-5, half-up); each
 * period's interest rounded at RB-4 (half-up); the terminal residual goes to
 * the DECLARED plug or the run refuses. There is no default: the credit
 * agreement's payment table is contractual and the plug decides whether the
 * schedule matches it.
 */
export function levelPaymentSchedule(
  principalMinor: bigint,
  rateNum: bigint,
  rateDen: bigint,
  periods: number,
  plugPolicy: PlugPolicy | undefined,
): Result<LevelPaymentSchedule> {
  const M = DEBT_METHODS.levelPayment;
  if (plugPolicy === undefined) {
    return refuse("plug-policy-not-declared", M, "final-payment-absorbs, final-principal-absorbs, or refuse — the agreement names one.");
  }
  const i = rational(rateNum, rateDen);
  const onePlusI = rAdd(rational(1n, 1n), i);
  const discount = rDiv(rational(1n, 1n), rPowInt(onePlusI, periods));
  const paymentExact = rDiv(rMul(rational(principalMinor, 1n), i), rSub(rational(1n, 1n), discount));
  const paymentMinor = halfUp(paymentExact.num, paymentExact.den);
  let balance = principalMinor;
  const rows: { period: number; interestMinor: bigint; principalMinor: bigint; closingMinor: bigint }[] = [];
  for (let p = 1; p <= periods; p++) {
    const interestMinor = halfUp(balance * rateNum, rateDen);
    const principalPart = paymentMinor - interestMinor;
    balance -= principalPart;
    rows.push({ period: p, interestMinor, principalMinor: principalPart, closingMinor: balance });
  }
  const residual = balance; // negative = borrower overpaid
  if (residual === 0n) {
    return ok({ paymentMinor, finalPaymentMinor: paymentMinor, residualAbsorbedMinor: 0n, rows, methodRef: M });
  }
  if (plugPolicy === "refuse") {
    return refuse("amortization-residual-unallocated", M, `Residual of ${residual} minor units with no plug policy the agreement specifies.`);
  }
  // Both absorb policies adjust the FINAL row so the terminal balance is zero;
  // they differ in which component carries the plug, reported identically here
  // via residualAbsorbedMinor and the corrected final row.
  const last = rows[rows.length - 1]!;
  const finalPaymentMinor = plugPolicy === "final-payment-absorbs" ? paymentMinor + residual : paymentMinor;
  const corrected =
    plugPolicy === "final-payment-absorbs"
      ? { ...last, principalMinor: last.principalMinor + residual, closingMinor: 0n }
      : { ...last, principalMinor: last.principalMinor + residual, interestMinor: last.interestMinor - residual, closingMinor: 0n };
  rows[rows.length - 1] = corrected;
  return ok({ paymentMinor, finalPaymentMinor, residualAbsorbedMinor: residual, rows, methodRef: M });
}

// ── §16.10 · the IFRS 9 10% test: lender fees only, enforced in the type ────

export interface ModificationFee {
  readonly amountMinor: bigint;
  /** REQUIRED. Only lender-exchanged fees enter the test (IFRS 9.B3.3.6);
   * including third-party legal costs flips the golden case from
   * modification to extinguishment (G-11). */
  readonly payee: "lender" | "third-party";
}

export interface TenPercentTestResult {
  readonly pvOld: Rational;
  readonly pvNew: Rational;
  readonly differenceBps: bigint; // |PV_new − PV_old| / PV_old in basis points, truncated
  readonly conclusion: "modification" | "extinguishment";
  readonly lenderFeesIncludedMinor: bigint;
  readonly thirdPartyFeesExcludedMinor: bigint;
  readonly methodRef: MethodRef;
}

export function tenPercentTestIfrs(
  carryingMinor: bigint,
  newCashFlows: readonly DatedCashFlow[],
  originalEirE10: bigint,
  fees: readonly ModificationFee[],
): Result<TenPercentTestResult> {
  const M = DEBT_METHODS.tenPercentIfrs;
  const pvOld = rational(carryingMinor, 1n);
  const lenderFees = fees.filter((f) => f.payee === "lender").reduce((a, f) => a + f.amountMinor, 0n);
  const excluded = fees.filter((f) => f.payee === "third-party").reduce((a, f) => a + f.amountMinor, 0n);
  const pvNew = rAdd(npvAtRateE10(newCashFlows, originalEirE10), rational(lenderFees, 1n));
  const diff = rSub(pvNew, pvOld);
  const absDiff = diff.num < 0n ? rational(-diff.num, diff.den) : diff;
  const ratio = rDiv(absDiff, pvOld);
  const bps = (ratio.num * 10_000n) / ratio.den;
  return ok({
    pvOld,
    pvNew,
    differenceBps: bps,
    conclusion: bps >= 1_000n ? "extinguishment" : "modification",
    lenderFeesIncludedMinor: lenderFees,
    thirdPartyFeesExcludedMinor: excluded,
    methodRef: M,
  });
}

// ── §16.6 · covenants: an attested definition language, no built-in ratios ──

export type CovenantExpr =
  | { readonly node: "term"; readonly name: string }
  | { readonly node: "const"; readonly value: Rational }
  | { readonly node: "add" | "sub" | "mul"; readonly left: CovenantExpr; readonly right: CovenantExpr }
  | { readonly node: "div"; readonly numerator: CovenantExpr; readonly denominator: CovenantExpr }
  | { readonly node: "min" | "max"; readonly left: CovenantExpr; readonly right: CovenantExpr }
  | {
      readonly node: "addback";
      readonly term: string;
      readonly cap: Rational | null;
      readonly permitted: boolean;
    };

/** Div returns a DefinedRatio, never a number: a zero denominator propagates
 * to `untestable`, never 0 and never Infinity — the direct antidote to the
 * `marginPct: … : 0` pattern found in shipped code. */
export type DefinedValue =
  | { readonly defined: true; readonly value: Rational }
  | { readonly defined: false; readonly reason: string };

export interface CovenantDefinition {
  readonly agreementRef: string;
  readonly kind: "attested" | "template";
  readonly expression: CovenantExpr;
  readonly comparator: "<=" | ">=" | "<" | ">";
  readonly threshold: Rational;
  readonly declaredTerms: readonly string[];
}

export type CovenantOutcome =
  | { readonly outcome: "pass" | "breach"; readonly measured: Rational }
  | { readonly outcome: "untestable"; readonly reason: string };

function evaluateExpr(expr: CovenantExpr, bindings: ReadonlyMap<string, Rational>): DefinedValue {
  switch (expr.node) {
    case "term": {
      const v = bindings.get(expr.name);
      return v === undefined ? { defined: false, reason: `term ${expr.name} unbound` } : { defined: true, value: v };
    }
    case "const":
      return { defined: true, value: expr.value };
    case "addback": {
      if (!expr.permitted) return { defined: true, value: R_ZERO };
      const v = bindings.get(expr.term);
      if (v === undefined) return { defined: false, reason: `add-back term ${expr.term} unbound` };
      if (expr.cap !== null && v.num * expr.cap.den > expr.cap.num * v.den) {
        return { defined: true, value: expr.cap };
      }
      return { defined: true, value: v };
    }
    case "div": {
      const n = evaluateExpr(expr.numerator, bindings);
      const d = evaluateExpr(expr.denominator, bindings);
      if (!n.defined) return n;
      if (!d.defined) return d;
      if (d.value.num === 0n) return { defined: false, reason: "zero-denominator" };
      return { defined: true, value: rDiv(n.value, d.value) };
    }
    default: {
      const l = evaluateExpr(expr.left, bindings);
      const r = evaluateExpr(expr.right, bindings);
      if (!l.defined) return l;
      if (!r.defined) return r;
      switch (expr.node) {
        case "add":
          return { defined: true, value: rAdd(l.value, r.value) };
        case "sub":
          return { defined: true, value: rSub(l.value, r.value) };
        case "mul":
          return { defined: true, value: rMul(l.value, r.value) };
        case "min":
          return { defined: true, value: l.value.num * r.value.den <= r.value.num * l.value.den ? l.value : r.value };
        case "max":
          return { defined: true, value: l.value.num * r.value.den >= r.value.num * l.value.den ? l.value : r.value };
      }
    }
  }
}

function referencedTerms(expr: CovenantExpr, into: Set<string>): void {
  switch (expr.node) {
    case "term":
      into.add(expr.name);
      return;
    case "const":
      return;
    case "addback":
      into.add(expr.term);
      return;
    case "div":
      referencedTerms(expr.numerator, into);
      referencedTerms(expr.denominator, into);
      return;
    default:
      referencedTerms(expr.left, into);
      referencedTerms(expr.right, into);
  }
}

/** G-10: a template cannot be tested against — it must be instantiated into
 * an attested per-agreement definition first. Every referenced term must be
 * declared, before any test runs. */
export function evaluateCovenant(
  definition: CovenantDefinition,
  bindings: ReadonlyMap<string, Rational>,
): Result<CovenantOutcome> {
  const M = DEBT_METHODS.covenantEval;
  if (definition.kind === "template") {
    return refuse(
      "covenant-template-not-testable",
      M,
      `Definition for ${definition.agreementRef} is a template. "Leverage ratio" means whatever the credit agreement says; instantiate and attest first.`,
    );
  }
  const referenced = new Set<string>();
  referencedTerms(definition.expression, referenced);
  const undeclared = [...referenced].filter((t) => !definition.declaredTerms.includes(t));
  if (undeclared.length > 0) {
    return refuse("covenant-term-unbound", M, `Expression references undeclared terms: ${undeclared.join(", ")}.`);
  }
  const measured = evaluateExpr(definition.expression, bindings);
  if (!measured.defined) {
    return ok({ outcome: "untestable", reason: measured.reason });
  }
  const cmp = measured.value.num * definition.threshold.den - definition.threshold.num * measured.value.den;
  const holds =
    definition.comparator === "<="
      ? cmp <= 0n
      : definition.comparator === ">="
        ? cmp >= 0n
        : definition.comparator === "<"
          ? cmp < 0n
          : cmp > 0n;
  return ok({ outcome: holds ? "pass" : "breach", measured: measured.value });
}

// ── §16.11 / §16.12 · prepayment order and maturity ladder ──────────────────

export function applyPrepayment(
  scheduledPrincipalMinor: readonly { period: number; amountMinor: bigint }[],
  prepaymentMinor: bigint,
  applicationOrder: "to-earliest-scheduled" | "to-latest-scheduled" | "pro-rata" | undefined,
): Result<readonly { period: number; amountMinor: bigint }[]> {
  const M = DEBT_METHODS.prepayment;
  if (applicationOrder === undefined) {
    return refuse("prepayment-application-order-not-declared", M, "The application order is the agreement's, not the engine's.");
  }
  let remaining = prepaymentMinor;
  const source =
    applicationOrder === "to-latest-scheduled" ? [...scheduledPrincipalMinor].reverse() : [...scheduledPrincipalMinor];
  if (applicationOrder === "pro-rata") {
    const total = scheduledPrincipalMinor.reduce((a, r) => a + r.amountMinor, 0n);
    if (total === 0n) return ok(scheduledPrincipalMinor);
    let applied = 0n;
    const out = scheduledPrincipalMinor.map((row, index) => {
      const share =
        index === scheduledPrincipalMinor.length - 1
          ? prepaymentMinor - applied // exactness: last row absorbs the division residue, reported by construction
          : (prepaymentMinor * row.amountMinor) / total;
      applied += share;
      return { period: row.period, amountMinor: row.amountMinor - share };
    });
    return ok(out);
  }
  const reduced = source.map((row) => {
    const take = remaining < row.amountMinor ? remaining : row.amountMinor;
    remaining -= take;
    return { period: row.period, amountMinor: row.amountMinor - take };
  });
  return ok(applicationOrder === "to-latest-scheduled" ? reduced.reverse() : reduced);
}

export function maturityLadder(
  instruments: readonly { instrumentRef: string; maturityDate: string; principalMinor: bigint }[],
  bucketEdges: readonly string[] | undefined,
): Result<readonly { bucketEndExclusive: string; principalMinor: bigint }[]> {
  const M = DEBT_METHODS.ladder;
  if (bucketEdges === undefined || bucketEdges.length === 0) {
    return refuse("ladder-buckets-not-declared", M, '"0-1y / 1-3y / 3-5y / 5y+" is a convention, not a standard; the caller declares dated boundaries.');
  }
  const edges = [...bucketEdges].sort();
  const totals = new Map<string, bigint>(edges.map((e) => [e, 0n]));
  const beyondKey = "beyond-final-edge";
  totals.set(beyondKey, 0n);
  for (const inst of instruments) {
    const edge = edges.find((e) => inst.maturityDate < e) ?? beyondKey;
    totals.set(edge, (totals.get(edge) ?? 0n) + inst.principalMinor);
  }
  return ok([...totals.entries()].map(([bucketEndExclusive, principalMinor]) => ({ bucketEndExclusive, principalMinor })));
}
