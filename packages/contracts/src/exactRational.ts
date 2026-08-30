// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Exact rational arithmetic — a finance-program platform primitive
// (promoted from ConsolidationIQ when AllocationIQ needed the same solve;
// two engines may not import each other, so shared math lives here).
// A percentage or allocation that depends on an iteration count or a
// floating-point rounding is not reproducible; 1/3 has an exact rational
// answer and no exact double one.
// ─────────────────────────────────────────────────────────────────────────────

export interface Rational {
  readonly num: bigint;
  readonly den: bigint; // always > 0
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x === 0n ? 1n : x;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("A rational with a zero denominator is not a number.");
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return { num: (num * sign) / g, den: (den * sign) / g };
}

export const R_ZERO = rational(0n, 1n);
export const R_ONE = rational(1n, 1n);

/** Parses "0.6", "60", "1/3" into an exact rational. Percent strings use ratioFromPercent. */
export function ratioFromDecimal(text: string): Rational {
  if (text.includes("/")) {
    const [n = "0", d = "1"] = text.split("/");
    return rational(BigInt(n), BigInt(d));
  }
  const negative = text.startsWith("-");
  const clean = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = clean.split(".");
  const num = BigInt(whole + fraction) * (negative ? -1n : 1n);
  return rational(num, 10n ** BigInt(fraction.length));
}

/** "60" (percent) → 3/5. */
export function ratioFromPercent(text: string): Rational {
  const r = ratioFromDecimal(text);
  return rational(r.num, r.den * 100n);
}

export const rAdd = (a: Rational, b: Rational): Rational =>
  rational(a.num * b.den + b.num * a.den, a.den * b.den);
export const rSub = (a: Rational, b: Rational): Rational =>
  rational(a.num * b.den - b.num * a.den, a.den * b.den);
export const rMul = (a: Rational, b: Rational): Rational =>
  rational(a.num * b.num, a.den * b.den);
export const rDiv = (a: Rational, b: Rational): Rational => {
  if (b.num === 0n) throw new RangeError("Division by a zero rational.");
  return rational(a.num * b.den, a.den * b.num);
};
export const rEquals = (a: Rational, b: Rational): boolean =>
  a.num * b.den === b.num * a.den;
export const rIsZero = (a: Rational): boolean => a.num === 0n;

/** Renders to a decimal string with `places` digits, half-even — for DISPLAY, never for arithmetic. */
export function rToDecimalString(r: Rational, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = r.num * scale;
  let quotient = scaled / r.den;
  const remainder = scaled % r.den;
  const doubled = (remainder < 0n ? -remainder : remainder) * 2n;
  const roundAway =
    doubled > r.den || (doubled === r.den && (quotient % 2n === 1n || quotient % 2n === -1n));
  if (roundAway) quotient += quotient < 0n || (quotient === 0n && r.num < 0n) ? -1n : 1n;
  const negative = quotient < 0n;
  const abs = (negative ? -quotient : quotient).toString().padStart(places + 1, "0");
  const whole = abs.slice(0, abs.length - places) || "0";
  const fraction = places === 0 ? "" : "." + abs.slice(abs.length - places);
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/**
 * Solves x · (I − A) = b over exact rationals by Gaussian elimination.
 * Returns undefined when the system is singular (a fully reciprocal
 * structure with no external holder has no meaningful solution).
 */
export function solveLinearSystem(
  aMatrix: readonly (readonly Rational[])[],
  bVector: readonly Rational[],
): readonly Rational[] | undefined {
  const n = bVector.length;
  // Build M = (I − A)^T so we solve M · x^T = b^T with row operations.
  const m: Rational[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => {
      if (j === n) return bVector[i] as Rational;
      const aji = (aMatrix[j] as readonly Rational[])[i] as Rational;
      const identity = i === j ? R_ONE : R_ZERO;
      return rSub(identity, aji);
    }),
  );
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let row = col; row < n; row++) {
      if (!rIsZero((m[row] as Rational[])[col] as Rational)) {
        pivot = row;
        break;
      }
    }
    if (pivot === -1) return undefined; // singular
    if (pivot !== col) {
      const tmp = m[col] as Rational[];
      m[col] = m[pivot] as Rational[];
      m[pivot] = tmp;
    }
    const pivotRow = m[col] as Rational[];
    const pivotValue = pivotRow[col] as Rational;
    for (let j = col; j <= n; j++) pivotRow[j] = rDiv(pivotRow[j] as Rational, pivotValue);
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = (m[row] as Rational[])[col] as Rational;
      if (rIsZero(factor)) continue;
      for (let j = col; j <= n; j++) {
        (m[row] as Rational[])[j] = rSub(
          (m[row] as Rational[])[j] as Rational,
          rMul(factor, pivotRow[j] as Rational),
        );
      }
    }
  }
  return Array.from({ length: n }, (_, i) => (m[i] as Rational[])[n] as Rational);
}
