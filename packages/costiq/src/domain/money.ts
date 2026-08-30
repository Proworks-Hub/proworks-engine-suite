/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/money.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  An amount that knows its currency, and the rounding policy that
 *           says when and how it becomes payable.
 */

import {
  allocate as allocateDecimal,
  type Decimal,
  type RoundingMode,
  add as decAdd,
  compare as decCompare,
  divide as decDivide,
  fromInteger,
  fromString,
  isNegative as decIsNegative,
  isZero as decIsZero,
  multiply as decMultiply,
  negate as decNegate,
  normalize,
  rescale,
  subtract as decSubtract,
  sum as decSum,
  toString as decToString,
  ZERO as DEC_ZERO,
} from "./decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHY MONEY IS NOT JUST A NUMBER
//
// £10 + $10 is not 20 of anything. A cost engine that adds amounts without
// checking currency produces a total that looks right, sums correctly, and is
// meaningless — and it will do it silently, forever, until somebody notices a
// quote is wrong by an exchange rate.
//
// So currency travels WITH the amount and every binary operation checks it.
// There is no implicit conversion: converting currency needs a rate, a rate
// needs a date and a source, and none of that belongs in an arithmetic
// primitive.
//
// THE TWO-DECIMAL ASSUMPTION IS WRONG
//
// Most currencies have two minor digits. Japanese yen has none — ¥100.50 is
// not a thing. Kuwaiti dinar, Bahraini dinar and Omani rial have three.
// Hard-coding 2 produces amounts that cannot be paid, and rounds a yen amount
// to a precision it does not have.
//
// So minor units come from a provider. A default table covers the currencies
// with non-standard precision plus the common ones, and an unknown currency is
// REFUSED rather than assumed to be two — because assuming is exactly the bug.
//
// PRECISION DURING CALCULATION IS NOT PRECISION AT PAYMENT
//
// A unit cost of £0.001234 per gram is a real number that must not be rounded
// to £0.00 halfway through a calculation. Money therefore carries whatever
// scale the arithmetic produced, and `quantize` is the separate, explicit step
// that brings it to payable precision. Rounding early is how a thousand line
// items each lose a fraction of a penny.
// ─────────────────────────────────────────────────────────────────────────────

/** An ISO 4217 alphabetic code. Validated on construction, never inferred. */
export type CurrencyCode = string;

/** An exact amount in a stated currency. */
export interface Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
}

/**
 * How many digits a currency actually has when it is paid.
 *
 * Only the currencies that differ from two are listed, plus the majors, so the
 * table stays short enough to audit. Anything absent is refused rather than
 * guessed — see `minorUnitsFor`.
 */
const MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  // Zero-decimal currencies. ¥100.50 is not an amount that exists.
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // Three-decimal currencies.
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // Four-decimal.
  CLF: 4, UYW: 4,
  // Common two-decimal currencies, listed explicitly so the table is the
  // source of truth rather than a fallback.
  AUD: 2, BRL: 2, CAD: 2, CHF: 2, CNY: 2, DKK: 2, EUR: 2, GBP: 2,
  HKD: 2, ILS: 2, INR: 2, MXN: 2, NOK: 2, NZD: 2, PLN: 2, SEK: 2,
  SGD: 2, THB: 2, TRY: 2, USD: 2, ZAR: 2,
});

/** Where minor-unit counts come from. Injectable so a host can extend the set. */
export interface CurrencyPrecisionProvider {
  minorUnits(currency: CurrencyCode): number | null;
}

export const defaultCurrencyPrecision: CurrencyPrecisionProvider = Object.freeze({
  minorUnits: (currency: CurrencyCode) => MINOR_UNITS[currency] ?? null,
});

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Rejects anything that is not a three-letter uppercase code. */
export function assertCurrencyCode(currency: string): CurrencyCode {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new TypeError(
      `Not an ISO 4217 currency code: ${JSON.stringify(currency)}. Expected three uppercase letters, such as "GBP".`,
    );
  }
  return currency;
}

/**
 * How many minor digits `currency` has.
 *
 * THROWS for an unknown currency rather than returning two. Defaulting is the
 * bug this exists to prevent: a mistyped code would silently become a
 * two-decimal currency and round wrongly forever.
 */
export function minorUnitsFor(
  currency: CurrencyCode,
  provider: CurrencyPrecisionProvider = defaultCurrencyPrecision,
): number {
  const units = provider.minorUnits(assertCurrencyCode(currency));
  if (units === null) {
    throw new RangeError(
      `Unknown currency ${currency}: its minor-unit precision is not configured. Register it with a CurrencyPrecisionProvider rather than allowing a default, because assuming two decimals silently mis-rounds currencies that do not have two.`,
    );
  }
  return units;
}

/** Builds money from an exact decimal. */
export function money(amount: Decimal, currency: CurrencyCode): Money {
  return Object.freeze({ amount, currency: assertCurrencyCode(currency) });
}

/** Builds money from its decimal string. The safe path in from text. */
export function moneyFromString(text: string, currency: CurrencyCode): Money {
  return money(fromString(text), currency);
}

/** Zero in a stated currency. Zero still has a currency — see `assertSame`. */
export function zeroMoney(currency: CurrencyCode): Money {
  return money(DEC_ZERO, currency);
}

/**
 * Refuses to operate across currencies.
 *
 * Even for zero. It is tempting to let `0 GBP + 10 USD` work, and that
 * exception is precisely how a currency error enters a total: the zero is
 * usually an accumulator's starting value, so allowing it means the FIRST
 * addition sets the currency and every later mismatch is hidden.
 */
function assertSame(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Cannot ${operation} ${a.currency} and ${b.currency}. Converting between currencies needs a rate, a date and a source; it is not arithmetic.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSame(a, b, "add");
  return money(decAdd(a.amount, b.amount), a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSame(a, b, "subtract");
  return money(decSubtract(a.amount, b.amount), a.currency);
}

/**
 * Money times a dimensionless factor — a quantity, a percentage, a yield.
 *
 * Money times money is deliberately absent: £2 × £3 is not £6 or anything
 * else. If a formula seems to need it, one of the two is a rate and should be
 * modelled as one.
 */
export function multiplyMoney(a: Money, factor: Decimal): Money {
  return money(decMultiply(a.amount, factor), a.currency);
}

/** Money divided by a dimensionless divisor. Scale and mode required, as ever. */
export function divideMoney(
  a: Money,
  divisor: Decimal,
  scale: number,
  mode: RoundingMode,
): Money {
  return money(decDivide(a.amount, divisor, scale, mode), a.currency);
}

export function negateMoney(a: Money): Money {
  return money(decNegate(a.amount), a.currency);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSame(a, b, "compare");
  return decCompare(a.amount, b.amount);
}

export const moneyEquals = (a: Money, b: Money): boolean =>
  a.currency === b.currency && decCompare(a.amount, b.amount) === 0;
export const isZeroMoney = (a: Money): boolean => decIsZero(a.amount);
export const isNegativeMoney = (a: Money): boolean => decIsNegative(a.amount);

/**
 * Sums amounts that must all share a currency.
 *
 * Requires the currency explicitly rather than taking it from the first
 * element, so summing an empty list still produces a correctly-denominated
 * zero instead of failing or inventing one.
 */
export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  for (const v of values) {
    if (v.currency !== currency) {
      throw new TypeError(
        `Cannot sum ${v.currency} into a ${currency} total. Every amount in a sum must already be in the target currency.`,
      );
    }
  }
  return money(decSum(values.map((v) => v.amount)), currency);
}

/**
 * WHERE a rounding is being applied.
 *
 * Recorded because "the total was rounded" and "every line was rounded and
 * then summed" produce different numbers, and an auditor asking why a total is
 * a penny out needs to know which happened.
 */
export type RoundingStage =
  /** Kept at full precision. The default for anything mid-calculation. */
  | "NONE"
  /** Each component as it is computed. Produces penny drift across many lines. */
  | "COMPONENT"
  /** Once, on the assembled total. */
  | "TOTAL"
  /** At the point a number is shown or paid. */
  | "PRESENTATION";

/** Mode plus stage plus the precision to use. A policy, not a preference. */
export interface RoundingPolicy {
  readonly mode: RoundingMode;
  readonly stage: RoundingStage;
  /**
   * Digits to round to, or null for the currency's own minor units.
   *
   * Null is the common case. A number is for the rarer one where a business
   * genuinely costs to more precision than it pays — fuel at four decimals,
   * say — and it is stated rather than inferred.
   */
  readonly scale: number | null;
}

/**
 * The default policy: round once, on the total, to the currency's precision,
 * using banker's rounding.
 *
 * Every part of that is a decision. Rounding once rather than per component
 * avoids drift; the currency's own precision avoids the two-decimal
 * assumption; HALF_EVEN avoids the upward bias that HALF_UP accumulates over
 * many totals.
 */
export const DEFAULT_ROUNDING_POLICY: RoundingPolicy = Object.freeze({
  mode: "HALF_EVEN",
  stage: "TOTAL",
  scale: null,
});

/**
 * Brings an amount to payable precision.
 *
 * The explicit step. Money carries full calculation precision until something
 * calls this, which is what stops fractions of a penny disappearing one line
 * at a time.
 */
export function quantize(
  value: Money,
  policy: RoundingPolicy = DEFAULT_ROUNDING_POLICY,
  provider: CurrencyPrecisionProvider = defaultCurrencyPrecision,
): Money {
  const scale = policy.scale ?? minorUnitsFor(value.currency, provider);
  return money(rescale(value.amount, scale, policy.mode), value.currency);
}

/**
 * Whether the amount is already payable — no sub-minor-unit remainder.
 *
 * Useful as an assertion at the boundary where a number becomes an invoice.
 */
export function isPayable(
  value: Money,
  provider: CurrencyPrecisionProvider = defaultCurrencyPrecision,
): boolean {
  const scale = minorUnitsFor(value.currency, provider);
  return decCompare(rescale(value.amount, scale, "DOWN"), value.amount) === 0;
}

/** `<amount> <CURRENCY>`, exact. For logs, fingerprints and evidence. */
export function moneyToString(value: Money): string {
  return `${decToString(value.amount)} ${value.currency}`;
}

/**
 * The canonical form for hashing.
 *
 * Normalised, so `12.30 GBP` and `12.3 GBP` — the same amount written to
 * different precision — produce the SAME fingerprint. Without this a
 * calculation fingerprint would change when nothing about the money did.
 */
export function moneyCanonical(value: Money): string {
  return `${decToString(normalize(value.amount))} ${value.currency}`;
}

/**
 * Splits an amount across weights with nothing lost.
 *
 * Wraps the decimal allocator at the currency's own precision, which is the
 * only precision at which "nothing lost" is a meaningful claim — allocating to
 * four decimals and then rounding to two loses exactly what allocation exists
 * to prevent.
 */
export function allocateMoney(
  total: Money,
  weights: readonly Decimal[],
  provider: CurrencyPrecisionProvider = defaultCurrencyPrecision,
  mode: RoundingMode = "HALF_EVEN",
): readonly Money[] {
  const scale = minorUnitsFor(total.currency, provider);
  const parts = allocateDecimal(total.amount, weights, scale, mode);
  return parts.map((p) => money(p, total.currency));
}

/** A percentage as a decimal fraction: `percent("7.5")` is 0.075. */
export function percent(value: string): Decimal {
  return decDivide(fromString(value), fromInteger(100), fromString(value).scale + 2, "HALF_EVEN");
}
