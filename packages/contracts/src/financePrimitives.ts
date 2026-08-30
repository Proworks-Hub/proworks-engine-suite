// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Finance primitives — the neutral module every Finance engine shares.
//
// Authorized by DEC-025 (2026-08-30), closing escalation A-1 of the Finance
// Core Engine Program: the primitive a general ledger needs did not exist.
// `receipt.ts`'s `moneySchema` ({ cents, currency = "USD" }) remains untouched
// for its existing consumers — its migration is a separate, deferred decision
// (A-2). Nothing here changes an existing shape; this module is additive.
//
// THE RULES THESE TYPES ENCODE
//
// - Exact decimal. Never IEEE-754. An amount is a decimal STRING on the wire,
//   because a JSON number is a double in most parsers and the wire is exactly
//   where exact decimal is lost.
// - Explicit ISO-4217 currency. NO DEFAULT. A currency that defaults is an
//   unknown presented as a value, which the Constitution forbids.
// - Explicit, currency-dependent `scale`. USD is 2, JPY is 0, KWD is 3.
//   Nothing here hardcodes a scale.
// - Rounding is a DECISION, taken at named boundaries only, with an explicit
//   `RoundingMode` argument. It is deliberately NOT a field of `ExactMoney`:
//   a value does not know how it will next be rounded, and intermediate
//   arithmetic carries full precision. (LedgerIQ blueprint §20.1 sketched
//   roundingMode as a wire field; SHARED_CONTRACTS.md — which governs shared
//   types — says "named per boundary", and that is what this module does.)
// - Cross-currency arithmetic fails. TypeScript cannot make it a compile
//   error without per-currency branding, so it is a thrown TypeError-class
//   error at the earliest possible moment instead — never a silent NaN, never
//   a wrong sum.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-4217 alphabetic currency code. Deliberately NO default. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, {
  message: "Currency must be a three-letter ISO-4217 code. There is no default currency.",
});
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * How a value is rounded at a named boundary.
 *
 * `half-even` (banker's rounding) exists because half-up applied to millions
 * of lines is a measurable bias; `half-up` exists because several statutory
 * regimes require it. The point is that the caller SAYS which.
 */
export const roundingModeSchema = z.enum([
  "half-up",
  "half-down",
  "half-even",
  "up",
  "down",
  "ceiling",
  "floor",
]);
export type RoundingMode = z.infer<typeof roundingModeSchema>;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/**
 * The exact-decimal money primitive (the "target Money" of the Finance
 * program's shared contracts).
 *
 * `amount` is a canonical decimal string carrying exactly `scale` fraction
 * digits (none when scale is 0). The canonical form matters: it makes
 * equality a string comparison and prevents the same value having two
 * encodings.
 */
export const exactMoneySchema = z
  .object({
    /** Canonical decimal string, e.g. "1085000.00" at scale 2, "-1" at scale 0. */
    amount: z.string().regex(DECIMAL_STRING, {
      message: "Amount must be a decimal string. A JSON number is a double and is refused, not coerced.",
    }),
    currency: currencyCodeSchema,
    /** Minor-unit precision for this currency. 2 for USD/EUR, 0 for JPY, 3 for KWD. */
    scale: z.number().int().min(0).max(6),
  })
  .strict()
  .refine(
    (m) => {
      const dot = m.amount.indexOf(".");
      const fractionDigits = dot === -1 ? 0 : m.amount.length - dot - 1;
      return fractionDigits === m.scale;
    },
    {
      message:
        "Amount must carry exactly `scale` fraction digits — the canonical form that makes equality a string comparison.",
      path: ["amount"],
    },
  );
export type ExactMoney = z.infer<typeof exactMoneySchema>;

/** Thrown when arithmetic would cross currencies or scales. Programmer error, not a refusal. */
export class CurrencyMismatchError extends Error {
  constructor(a: ExactMoney, b: ExactMoney) {
    super(
      `Cross-currency arithmetic is not a thing this module does: ${a.currency}@${a.scale} vs ${b.currency}@${b.scale}. ` +
        "Convert explicitly, with a rate, its source and its effective date.",
    );
    this.name = "CurrencyMismatchError";
  }
}

/** The integer minor units behind an ExactMoney. Exact; no floating point is involved. */
export function exactMinorUnits(m: ExactMoney): bigint {
  const negative = m.amount.startsWith("-");
  const digits = (negative ? m.amount.slice(1) : m.amount).replace(".", "");
  const units = BigInt(digits);
  return negative ? -units : units;
}

/** Builds the canonical ExactMoney for integer minor units. */
export function exactMoneyFromMinorUnits(
  units: bigint,
  currency: CurrencyCode,
  scale: number,
): ExactMoney {
  const negative = units < 0n;
  const abs = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? abs : abs.slice(0, abs.length - scale);
  const fraction = scale === 0 ? "" : "." + abs.slice(abs.length - scale);
  return exactMoneySchema.parse({
    amount: `${negative ? "-" : ""}${whole}${fraction}`,
    currency,
    scale,
  });
}

/**
 * Integer division with an explicit rounding mode. The single place rounding
 * arithmetic lives, so every boundary rounds identically.
 */
export function divideAndRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new RangeError("Denominator must be positive.");
  const negative = numerator < 0n;
  const absNum = negative ? -numerator : numerator;
  const quotient = absNum / denominator;
  const remainder = absNum % denominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  const doubled = remainder * 2n;
  let roundUp: boolean;
  switch (mode) {
    case "up":
      roundUp = true;
      break;
    case "down":
      roundUp = false;
      break;
    case "ceiling":
      roundUp = !negative;
      break;
    case "floor":
      roundUp = negative;
      break;
    case "half-up":
      roundUp = doubled >= denominator;
      break;
    case "half-down":
      roundUp = doubled > denominator;
      break;
    case "half-even":
      roundUp = doubled > denominator || (doubled === denominator && quotient % 2n === 1n);
      break;
  }
  const rounded = roundUp ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Parses a decimal string into ExactMoney at the stated scale.
 *
 * Input carrying MORE precision than the scale requires a `roundingMode` —
 * rounding without being told how is the silent `Math.round` this module
 * replaces. Input at or below the scale needs none.
 */
export function exactMoneyFromDecimalString(
  amount: string,
  currency: CurrencyCode,
  scale: number,
  roundingMode?: RoundingMode,
): ExactMoney {
  if (!DECIMAL_STRING.test(amount)) {
    throw new SyntaxError(`Not a decimal string: "${amount}"`);
  }
  const dot = amount.indexOf(".");
  const fractionDigits = dot === -1 ? 0 : amount.length - dot - 1;
  if (fractionDigits <= scale) {
    const padded =
      scale === 0
        ? dot === -1
          ? amount
          : amount.slice(0, dot)
        : (dot === -1 ? amount + "." : amount) + "0".repeat(scale - fractionDigits);
    return exactMoneySchema.parse({ amount: padded, currency, scale });
  }
  if (!roundingMode) {
    throw new RangeError(
      `"${amount}" carries ${fractionDigits} fraction digits but the scale is ${scale}. ` +
        "Rounding is a decision: pass a RoundingMode.",
    );
  }
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).replace(".", "");
  const raw = (negative ? -1n : 1n) * BigInt(digits);
  const units = divideAndRound(raw, 10n ** BigInt(fractionDigits - scale), roundingMode);
  return exactMoneyFromMinorUnits(units, currency, scale);
}

function assertSameDenomination(a: ExactMoney, b: ExactMoney): void {
  if (a.currency !== b.currency || a.scale !== b.scale) throw new CurrencyMismatchError(a, b);
}

export function addExactMoney(a: ExactMoney, b: ExactMoney): ExactMoney {
  assertSameDenomination(a, b);
  return exactMoneyFromMinorUnits(exactMinorUnits(a) + exactMinorUnits(b), a.currency, a.scale);
}

export function subtractExactMoney(a: ExactMoney, b: ExactMoney): ExactMoney {
  assertSameDenomination(a, b);
  return exactMoneyFromMinorUnits(exactMinorUnits(a) - exactMinorUnits(b), a.currency, a.scale);
}

export function negateExactMoney(m: ExactMoney): ExactMoney {
  return exactMoneyFromMinorUnits(-exactMinorUnits(m), m.currency, m.scale);
}

export function isZeroExactMoney(m: ExactMoney): boolean {
  return exactMinorUnits(m) === 0n;
}

/** -1, 0 or 1. Throws on cross-currency comparison, like the arithmetic. */
export function compareExactMoney(a: ExactMoney, b: ExactMoney): -1 | 0 | 1 {
  assertSameDenomination(a, b);
  const ua = exactMinorUnits(a);
  const ub = exactMinorUnits(b);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/**
 * Sums a list. The zero of an empty list has no inferable currency, so
 * currency and scale are explicit arguments rather than guessed.
 */
export function sumExactMoney(
  values: readonly ExactMoney[],
  currency: CurrencyCode,
  scale: number,
): ExactMoney {
  let total = 0n;
  for (const v of values) {
    if (v.currency !== currency || v.scale !== scale) {
      throw new CurrencyMismatchError(v, exactMoneyFromMinorUnits(0n, currency, scale));
    }
    total += exactMinorUnits(v);
  }
  return exactMoneyFromMinorUnits(total, currency, scale);
}

/**
 * Multiplies an amount by an exact decimal rate into a target denomination,
 * rounding once, at this boundary, in the stated mode. This is the FX
 * conversion primitive: the ONLY rounding in a conversion happens here.
 */
export function multiplyExactMoneyByRate(
  m: ExactMoney,
  rate: string,
  targetCurrency: CurrencyCode,
  targetScale: number,
  roundingMode: RoundingMode,
): ExactMoney {
  if (!DECIMAL_STRING.test(rate)) throw new SyntaxError(`Not a decimal string rate: "${rate}"`);
  const dot = rate.indexOf(".");
  const rateFraction = dot === -1 ? 0 : rate.length - dot - 1;
  const rateNegative = rate.startsWith("-");
  if (rateNegative) throw new RangeError("A negative exchange rate is not a rate.");
  const rateUnits = BigInt(rate.replace(".", ""));

  // amount × rate, tracked exactly: minorUnits(m) × rateUnits carries
  // (m.scale + rateFraction) implied decimals; rescale to targetScale.
  const raw = exactMinorUnits(m) * rateUnits;
  const impliedScale = m.scale + rateFraction;
  const units =
    impliedScale >= targetScale
      ? divideAndRound(raw, 10n ** BigInt(impliedScale - targetScale), roundingMode)
      : raw * 10n ** BigInt(targetScale - impliedScale);
  return exactMoneyFromMinorUnits(units, targetCurrency, targetScale);
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived primitives — Quantity, Rate, Percentage, ExchangeRateRef.
// PC-2b of the Finance program: none of these existed at baseline `7d6f183`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A non-monetary amount: headcount, square metres, machine hours. Read by
 * LedgerIQ's statistical entries, and by every engine whose evidence carries
 * a measured quantity. Never `Money`; never a bare float.
 */
export const quantitySchema = z
  .object({
    /** Exact decimal string. */
    amount: z.string().regex(DECIMAL_STRING),
    /** The unit, explicit — "hours", "m2", "each". Never implied by context. */
    unit: z.string().min(1),
    /** Optional unit system ("si", "imperial", a domain registry name). */
    unitSystem: z.string().min(1).optional(),
  })
  .strict();
export type Quantity = z.infer<typeof quantitySchema>;

/** An exact decimal rate (a multiplier). Never a bare float. */
export const rateValueSchema = z.string().regex(DECIMAL_STRING);

/**
 * A percentage, in percent units ("2.5" is 2.5%). Exists so a bare float can
 * never masquerade as a percentage, and so 0.025-vs-2.5 confusion is a parse
 * failure rather than a 100× defect.
 */
export const percentageSchema = z
  .object({
    percent: z.string().regex(DECIMAL_STRING),
  })
  .strict();
export type Percentage = z.infer<typeof percentageSchema>;

/**
 * The three defensible FX rate-type conventions (IAS 21 / ASC 830). LedgerIQ
 * implements all three and chooses none: the convention is a required,
 * explicitly declared argument (C-8, K-16 — measured spread 2.212% on one
 * entry). No default.
 */
export const fxRateTypeSchema = z.enum([
  "spot-at-transaction-date",
  "period-average",
  "period-fixed",
]);
export type FxRateType = z.infer<typeof fxRateTypeSchema>;

/**
 * An exchange rate captured BY VALUE with its provenance. A conversion that
 * cannot name its rate's source and effective date is a conversion that
 * cannot be replayed.
 */
export const exchangeRateRefSchema = z
  .object({
    base: currencyCodeSchema,
    quote: currencyCodeSchema,
    /** Exact decimal string: 1 base = rate × quote. */
    rate: rateValueSchema,
    /** Where the rate came from — a feed name, a table reference. Never blank. */
    source: z.string().min(1),
    /** ISO date the rate applies to. */
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rateType: fxRateTypeSchema,
  })
  .strict()
  .refine((r) => r.base !== r.quote, {
    message: "A rate from a currency to itself is not a rate.",
    path: ["quote"],
  });
export type ExchangeRateRef = z.infer<typeof exchangeRateRefSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// MethodRef, FreshnessState, EvidenceQuality — the program-wide vocabulary
// (PC-4). Referenced by every Finance engine; redefined by none.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The versioned identity of a consequential rule. Every persisted result
 * records the MethodRef that produced it, so a historical figure stays
 * reproducible after the method changes. A result-changing modification
 * REQUIRES a new semantic version.
 */
export const methodRefSchema = z
  .object({
    methodId: z.string().min(1),
    semanticVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** ISO date this version takes effect, where the registry states one. */
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
export type MethodRef = z.infer<typeof methodRefSchema>;

/**
 * The recalculation vocabulary (Blueprint V2 §36). Every engine whose outputs
 * can go stale maps upstream change to these states, and states which state
 * blocks which downstream use.
 */
export const freshnessStateSchema = z.enum([
  "current",
  "affected",
  "stale",
  "review-required",
  "recalculation-required",
]);
export type FreshnessState = z.infer<typeof freshnessStateSchema>;

/**
 * How strong an evidence source is. ORDERED, strongest first. An enum, not a
 * number: a number invites averaging, and averaging is how a weak basis looks
 * strong.
 */
export const sourceStrengthSchema = z.enum([
  "authoritative-local",
  "observed-local",
  "derived",
  "approved-external",
  "collective-generalized",
  "simulated",
  "ai-candidate",
]);
export type SourceStrength = z.infer<typeof sourceStrengthSchema>;

/** Strongest-first order, for comparisons. Lower index = stronger. */
export const SOURCE_STRENGTH_ORDER: readonly SourceStrength[] = [
  "authoritative-local",
  "observed-local",
  "derived",
  "approved-external",
  "collective-generalized",
  "simulated",
  "ai-candidate",
];

/** Negative when a is stronger than b, zero when equal. */
export function compareSourceStrength(a: SourceStrength, b: SourceStrength): number {
  return SOURCE_STRENGTH_ORDER.indexOf(a) - SOURCE_STRENGTH_ORDER.indexOf(b);
}

/** The qualitative level of one evidence dimension. "unknown" must be said, never assumed. */
export const evidenceDimensionLevelSchema = z.enum(["unknown", "weak", "adequate", "strong"]);
export type EvidenceDimensionLevel = z.infer<typeof evidenceDimensionLevelSchema>;

/** How much a piece of evidence leans on assumption. Ordered lightest-last deliberately not — states, not scores. */
export const assumptionLoadSchema = z.enum(["unknown", "heavy", "moderate", "light", "none"]);
export type AssumptionLoad = z.infer<typeof assumptionLoadSchema>;

/**
 * Blueprint V2 §35: seven dimensions, exposed INDIVIDUALLY. There is
 * deliberately no rolled-up score and no function in this repository computes
 * one — a single number is exactly the thing that lets a weak basis look
 * strong. Every field is required: an unstated dimension would be an unknown
 * presented as adequate.
 */
export const evidenceQualitySchema = z
  .object({
    coverage: evidenceDimensionLevelSchema,
    freshness: evidenceDimensionLevelSchema,
    sourceStrength: sourceStrengthSchema,
    sampleSufficiency: evidenceDimensionLevelSchema,
    normalizationQuality: evidenceDimensionLevelSchema,
    assumptionLoad: assumptionLoadSchema,
    historicalReliability: evidenceDimensionLevelSchema,
  })
  .strict();
export type EvidenceQuality = z.infer<typeof evidenceQualitySchema>;

/** A reference to one supporting fact, with the quality of that support. */
export const evidenceRefSchema = z
  .object({
    /** Where the fact lives — an id, a canonical reference, a document key. */
    ref: z.string().min(1),
    quality: evidenceQualitySchema,
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/**
 * LOCK-2's structural check: is this evidence set ENTIRELY ai-candidate?
 * Read by LedgerIQ's `AI_CANDIDATE_SOLE_BASIS` refusal — an AI candidate may
 * inform an authoritative result; it may never be the sole basis of one.
 * An EMPTY evidence set returns false: absence of evidence is a different
 * condition from AI-only evidence, and conflating them would hide the first.
 */
export function isSoleBasisAiCandidate(evidence: readonly EvidenceRef[]): boolean {
  return (
    evidence.length > 0 && evidence.every((e) => e.quality.sourceStrength === "ai-candidate")
  );
}
