/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/decimal.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  Exact decimal arithmetic on BigInt. The arithmetic foundation
 *           for every authoritative amount in CostIQ vNext.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS AT ALL
//
// v1 does its money math in JavaScript `Number`, which is IEEE-754 binary
// floating point. `0.1 + 0.2` is `0.30000000000000004` there, and a cost
// engine that adds a thousand line items accumulates that error into a number
// somebody invoices against. It is not a rounding preference; it is the wrong
// number.
//
// WHY BIGINT AND NOT A LIBRARY
//
// The directive allows "a well-maintained decimal library or a rigorously
// tested fixed-point representation" and forbids ad-hoc floating math. A
// library would be a new runtime dependency in a package whose entire value is
// being portable — CostIQ currently depends on exactly `zod` and the suite's
// own contracts, and the portability guard forbids node builtins.
//
// BigInt is standard ECMAScript. It is exact, unbounded, present in every
// runtime this engine could plausibly run in, and adds nothing to the
// dependency tree. The cost is that scale must be tracked by hand, which is
// what this file does.
//
// THE REPRESENTATION
//
//   value = units / 10^scale
//
// So `12.34` is `{ units: 1234n, scale: 2 }`. The same number can be written
// at any larger scale — `{ units: 123400n, scale: 4 }` — and the two are
// EQUAL. That matters: comparison and equality must normalise, and only
// `toString` cares which representation it was handed.
//
// WHAT IS EXACT AND WHAT IS NOT
//
// Addition, subtraction, multiplication and negation are exact and always
// succeed. Their scales are determined by the inputs, never by preference.
//
// DIVISION IS NOT EXACT and cannot be. One third has no finite decimal
// representation, so division REQUIRES an explicit target scale and rounding
// mode from the caller. There is no default, because a default would be this
// file quietly choosing how somebody's money gets rounded.
// ─────────────────────────────────────────────────────────────────────────────

/** A decimal number held exactly as `units / 10^scale`. */
export interface Decimal {
  readonly units: bigint;
  /** Digits after the point. Always >= 0. */
  readonly scale: number;
}

/**
 * How to resolve a value that falls between two representable numbers.
 *
 * Named rather than assumed. `HALF_EVEN` (banker's rounding) is the default
 * for financial totals in most jurisdictions because repeated `HALF_UP`
 * introduces an upward bias over many transactions — but "most" is not "all",
 * and the caller has to say.
 */
export type RoundingMode =
  /** Toward the nearer neighbour; exact halves go away from zero. */
  | "HALF_UP"
  /** Toward the nearer neighbour; exact halves go toward zero. */
  | "HALF_DOWN"
  /** Toward the nearer neighbour; exact halves go to the even digit. */
  | "HALF_EVEN"
  /** Toward zero. Truncation. */
  | "DOWN"
  /** Away from zero. */
  | "UP"
  /** Toward positive infinity. */
  | "CEILING"
  /** Toward negative infinity. */
  | "FLOOR";

const TEN = 10n;

/** 10^n as a bigint. Loops rather than `**` so no float ever appears. */
function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`Scale cannot be negative: ${n}`);
  let out = 1n;
  for (let i = 0; i < n; i += 1) out *= TEN;
  return out;
}

function assertValidScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new RangeError(`Scale must be a non-negative integer, received ${scale}.`);
  }
  // A guard rather than a limit anybody should reach. Scales beyond this are
  // a symptom — usually repeated multiplication with no intervening rounding —
  // and silently allowing them turns a modelling mistake into a memory problem.
  if (scale > 100) {
    throw new RangeError(
      `Scale ${scale} exceeds the supported maximum of 100. A scale this large usually means values were multiplied repeatedly without an explicit rounding step.`,
    );
  }
}

export const ZERO: Decimal = Object.freeze({ units: 0n, scale: 0 });
export const ONE: Decimal = Object.freeze({ units: 1n, scale: 0 });

/** A decimal from integer units at a scale. `fromUnits(1234n, 2)` is 12.34. */
export function fromUnits(units: bigint, scale: number): Decimal {
  assertValidScale(scale);
  return Object.freeze({ units, scale });
}

/** A decimal from a whole number. */
export function fromInteger(value: number | bigint): Decimal {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new TypeError(`fromInteger requires a whole number, received ${value}. Use fromString for fractional values.`);
  }
  return fromUnits(BigInt(value), 0);
}

/**
 * A decimal parsed from its decimal string.
 *
 * THE ONLY SAFE WAY IN FROM TEXT, and the reason `fromNumber` is what it is:
 * a string carries exactly the digits somebody wrote, while a float has
 * already lost them.
 */
export function fromString(text: string): Decimal {
  const trimmed = text.trim();
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new TypeError(`Not a decimal number: ${JSON.stringify(text)}`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] === "" ? "0" : match[2]!;
  const frac = match[3] ?? "";
  assertValidScale(frac.length);
  return fromUnits(sign * BigInt(whole + frac), frac.length);
}

/**
 * A decimal from a JavaScript number.
 *
 * DELIBERATELY AWKWARD. Every call is a place where binary floating point has
 * already happened, so this routes through the number's own decimal string —
 * which is the shortest decimal that round-trips, and therefore the closest
 * thing to what the caller meant. It refuses anything not finite rather than
 * producing a number nobody can explain.
 *
 * Use it at the EDGE, converting data that arrives as a float. Never in the
 * middle of a calculation.
 */
export function fromNumber(value: number): Decimal {
  if (!Number.isFinite(value)) {
    throw new TypeError(`Cannot represent ${value} exactly. Only finite numbers convert to Decimal.`);
  }
  // Exponent notation (1e-7, 1e21) is not decimal text, so it is expanded
  // first rather than rejected — the value is legitimate, the spelling is not.
  const text = Math.abs(value) < 1e21 && (Math.abs(value) >= 1e-6 || value === 0)
    ? String(value)
    : value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return fromString(text);
}

/** The two values re-expressed at a common scale. Always exact. */
function align(a: Decimal, b: Decimal): { a: bigint; b: bigint; scale: number } {
  if (a.scale === b.scale) return { a: a.units, b: b.units, scale: a.scale };
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * pow10(scale - a.scale),
    b: b.units * pow10(scale - b.scale),
    scale,
  };
}

/** Exact. The result's scale is the larger of the two. */
export function add(a: Decimal, b: Decimal): Decimal {
  const s = align(a, b);
  return fromUnits(s.a + s.b, s.scale);
}

/** Exact. */
export function subtract(a: Decimal, b: Decimal): Decimal {
  const s = align(a, b);
  return fromUnits(s.a - s.b, s.scale);
}

/**
 * Exact. The result's scale is the SUM of the input scales.
 *
 * That growth is the honest answer — 0.5 × 0.5 is 0.25, which needs two
 * places — and it is why a long chain of multiplications must be rounded
 * deliberately somewhere rather than left to grow.
 */
export function multiply(a: Decimal, b: Decimal): Decimal {
  return fromUnits(a.units * b.units, a.scale + b.scale);
}

export function negate(a: Decimal): Decimal {
  return fromUnits(-a.units, a.scale);
}

export function abs(a: Decimal): Decimal {
  return a.units < 0n ? negate(a) : a;
}

/** -1, 0 or 1. Normalises scale first, so 1.50 and 1.5 compare equal. */
export function compare(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const s = align(a, b);
  return s.a < s.b ? -1 : s.a > s.b ? 1 : 0;
}

export const equals = (a: Decimal, b: Decimal): boolean => compare(a, b) === 0;
export const lessThan = (a: Decimal, b: Decimal): boolean => compare(a, b) < 0;
export const greaterThan = (a: Decimal, b: Decimal): boolean => compare(a, b) > 0;
export const isZero = (a: Decimal): boolean => a.units === 0n;
export const isNegative = (a: Decimal): boolean => a.units < 0n;
export const isPositive = (a: Decimal): boolean => a.units > 0n;

/**
 * The quotient `numerator / divisor`, rounded to `scale`.
 *
 * SCALE AND MODE ARE REQUIRED. Division is the one operation here that cannot
 * be exact, so the caller states how much precision they want and what to do
 * with the remainder. A default would be this file deciding how somebody's
 * money is rounded.
 */
export function divide(
  numerator: Decimal,
  divisor: Decimal,
  scale: number,
  mode: RoundingMode,
): Decimal {
  assertValidScale(scale);
  if (divisor.units === 0n) {
    throw new RangeError("Division by zero. A cost model that divides by zero has a missing input, not a very large answer.");
  }
  // Shift the numerator up by the target scale plus the divisor's scale, so
  // integer division lands exactly at `scale` with a remainder to round on.
  const shifted = numerator.units * pow10(scale + divisor.scale);
  const denominator = divisor.units * pow10(numerator.scale);
  return fromUnits(roundQuotient(shifted, denominator, mode), scale);
}

/** Integer division of `n / d`, resolving the remainder by `mode`. */
function roundQuotient(n: bigint, d: bigint, mode: RoundingMode): bigint {
  // Normalise the sign onto the numerator so the remainder's sign is the
  // quotient's sign, which is what every mode below assumes.
  const negative = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;

  const q = an / ad;
  const r = an % ad;
  if (r === 0n) return negative ? -q : q;

  const twice = r * 2n;
  let roundAway: boolean;
  switch (mode) {
    case "DOWN":
      roundAway = false;
      break;
    case "UP":
      roundAway = true;
      break;
    case "CEILING":
      roundAway = !negative;
      break;
    case "FLOOR":
      roundAway = negative;
      break;
    case "HALF_UP":
      roundAway = twice >= ad;
      break;
    case "HALF_DOWN":
      roundAway = twice > ad;
      break;
    case "HALF_EVEN":
      // Exactly half goes to the even neighbour; otherwise nearest. This is
      // what stops a long series of roundings drifting upward.
      roundAway = twice > ad || (twice === ad && q % 2n === 1n);
      break;
    default: {
      // Exhaustiveness: a mode added to the union without a branch here fails
      // to compile rather than silently truncating somebody's money.
      const unreachable: never = mode;
      throw new TypeError(`Unsupported rounding mode: ${String(unreachable)}`);
    }
  }
  const magnitude = roundAway ? q + 1n : q;
  return negative ? -magnitude : magnitude;
}

/**
 * The same value re-expressed at `scale`.
 *
 * Widening is exact. Narrowing rounds, so it needs a mode — and the signature
 * requires one rather than defaulting, for the same reason `divide` does.
 */
export function rescale(value: Decimal, scale: number, mode: RoundingMode): Decimal {
  assertValidScale(scale);
  if (scale === value.scale) return value;
  if (scale > value.scale) return fromUnits(value.units * pow10(scale - value.scale), scale);
  return fromUnits(roundQuotient(value.units, pow10(value.scale - scale), mode), scale);
}

/**
 * The value with trailing zeros removed.
 *
 * For CANONICAL FORM, not for display: two decimals that are equal must
 * serialise identically, or a fingerprint over them would differ for the same
 * number. Never used to decide precision.
 */
export function normalize(value: Decimal): Decimal {
  if (value.units === 0n) return ZERO;
  let units = value.units;
  let scale = value.scale;
  while (scale > 0 && units % TEN === 0n) {
    units /= TEN;
    scale -= 1;
  }
  return fromUnits(units, scale);
}

/** The decimal string. Exact — this never loses a digit. */
export function toString(value: Decimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString();
  if (value.scale === 0) return (negative ? "-" : "") + digits;
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const frac = padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/**
 * A JavaScript number, for display and nothing else.
 *
 * LOSSY BY CONSTRUCTION, which is the entire reason this module exists. It is
 * named to be greppable: any authoritative calculation containing a call to it
 * has left exact arithmetic, and that should be visible in review.
 */
export function toNumber(value: Decimal): number {
  return Number(toString(value));
}

/** Sums exactly, left to right. An empty sum is zero, not an error. */
export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((acc, v) => add(acc, v), ZERO);
}

/**
 * Splits `total` into `weights.length` parts in proportion, losing nothing.
 *
 * ALLOCATION IS NOT MULTIPLICATION. Splitting 100.00 three ways gives
 * 33.33 + 33.33 + 33.33 = 99.99, and the missing penny has to go somewhere.
 * This distributes remainders one minor unit at a time to the largest
 * fractional parts, so the parts always re-sum to exactly `total` — which is
 * the invariant that matters when the total is an invoice and the parts are
 * cost components.
 */
export function allocate(
  total: Decimal,
  weights: readonly Decimal[],
  scale: number,
  mode: RoundingMode = "HALF_EVEN",
): readonly Decimal[] {
  assertValidScale(scale);
  if (weights.length === 0) return [];

  // Negative FIRST. `[1, -1]` sums to zero, so checking the total first would
  // report "weights sum to zero" for what is actually a negative share — a
  // true statement that sends the reader looking in the wrong place.
  if (weights.some(isNegative)) {
    throw new RangeError("Cannot allocate against a negative weight. A negative share of a cost is not a share.");
  }
  const weightTotal = sum(weights);
  if (isZero(weightTotal)) {
    throw new RangeError("Cannot allocate against weights that sum to zero — there is no proportion to divide by.");
  }

  const target = rescale(total, scale, mode);
  const unit = fromUnits(1n, scale);

  // Floor every share first, then hand the remainder out. Flooring guarantees
  // the shares never exceed the total, so the remainder is always positive and
  // distributing it can only bring the sum up to exactly the target.
  const floors = weights.map((w) => divide(multiply(target, w), weightTotal, scale, "FLOOR"));
  let distributed = sum(floors);
  const parts = [...floors];

  // Largest fractional part first, ties broken by index so the result is
  // deterministic — an allocation that depended on iteration order would
  // produce different invoices for the same input.
  const order = weights
    .map((w, index) => {
      const exact = divide(multiply(target, w), weightTotal, scale + 6, "FLOOR");
      return { index, remainder: subtract(exact, rescale(floors[index]!, scale + 6, "FLOOR")) };
    })
    .sort((x, y) => compare(y.remainder, x.remainder) || x.index - y.index);

  let cursor = 0;
  while (lessThan(distributed, target) && cursor < order.length) {
    const i = order[cursor]!.index;
    parts[i] = add(parts[i]!, unit);
    distributed = add(distributed, unit);
    cursor += 1;
  }

  return parts.map((p) => rescale(p, scale, mode));
}
