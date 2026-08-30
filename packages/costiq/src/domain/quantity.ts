/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/quantity.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  An exact amount of something, in a stated unit, that refuses to be
 *           silently confused with an amount of something else.
 */

import {
  type Decimal,
  type RoundingMode,
  add as decAdd,
  compare as decCompare,
  divide as decDivide,
  fromString,
  isNegative as decIsNegative,
  isZero as decIsZero,
  multiply as decMultiply,
  negate as decNegate,
  normalize,
  subtract as decSubtract,
  sum as decSum,
  toString as decToString,
  ZERO as DEC_ZERO,
} from "./decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// UNIT CONFUSION IS A COST ENGINE'S WORST SILENT FAILURE
//
// A material priced per kilogram, consumed in grams, multiplied without
// conversion, gives an answer a thousand times wrong — and it is a plausible
// number. It sums, it rounds, it prints on a quote. Nothing about it looks
// broken until somebody buys steel.
//
// So a quantity carries its unit, arithmetic between different units is
// REFUSED, and conversion is an explicit call with an explicit factor. There
// is no automatic coercion anywhere in this file.
//
// CONVERSION IS DATA, NOT CODE
//
// Factors live in a table that can be inspected and extended, not in a switch
// somebody has to read. Two units convert only when they measure the same
// DIMENSION — mass to mass, time to time. Converting kilograms to hours is not
// a missing factor, it is a modelling error, and it fails as one.
//
// DIMENSIONLESS IS A DIMENSION
//
// `each` is a real unit. Counting 5 of something is not the same as 5
// kilograms, and treating a bare number as compatible with everything is how
// unit checks get quietly bypassed.
// ─────────────────────────────────────────────────────────────────────────────

/** What a unit measures. Two units are only convertible within one dimension. */
export type Dimension =
  | "COUNT"
  | "MASS"
  | "LENGTH"
  | "AREA"
  | "VOLUME"
  | "TIME"
  | "ENERGY";

/** A unit code. Free-form so hosts can add their own, validated on use. */
export type UnitCode = string;

export interface UnitDefinition {
  readonly code: UnitCode;
  readonly dimension: Dimension;
  /**
   * How many BASE units one of these is, exactly.
   *
   * The base is arbitrary but fixed per dimension — gram for mass, millimetre
   * for length, second for time — and every conversion goes through it, so a
   * new unit needs one factor rather than one per pair.
   */
  readonly inBaseUnits: Decimal;
}

const def = (code: string, dimension: Dimension, inBase: string): UnitDefinition =>
  Object.freeze({ code, dimension, inBaseUnits: fromString(inBase) });

/**
 * The units CostIQ knows out of the box.
 *
 * Deliberately small. Every entry is a factor somebody could get wrong, so the
 * table holds what a manufacturing cost engine actually needs and hosts extend
 * it rather than this growing to cover everything measurable.
 *
 * Imperial factors are the exact international definitions — an inch is
 * exactly 25.4 mm, a pound exactly 453.59237 g — not approximations.
 */
const DEFAULT_UNITS: readonly UnitDefinition[] = Object.freeze([
  def("each", "COUNT", "1"),
  def("dozen", "COUNT", "12"),

  def("g", "MASS", "1"),
  def("kg", "MASS", "1000"),
  def("t", "MASS", "1000000"),
  def("mg", "MASS", "0.001"),
  def("lb", "MASS", "453.59237"),
  def("oz", "MASS", "28.349523125"),

  def("mm", "LENGTH", "1"),
  def("cm", "LENGTH", "10"),
  def("m", "LENGTH", "1000"),
  def("km", "LENGTH", "1000000"),
  def("in", "LENGTH", "25.4"),
  def("ft", "LENGTH", "304.8"),
  def("yd", "LENGTH", "914.4"),

  def("mm2", "AREA", "1"),
  def("cm2", "AREA", "100"),
  def("m2", "AREA", "1000000"),
  def("in2", "AREA", "645.16"),
  def("ft2", "AREA", "92903.04"),

  def("ml", "VOLUME", "1"),
  def("l", "VOLUME", "1000"),
  def("m3", "VOLUME", "1000000"),

  def("s", "TIME", "1"),
  def("min", "TIME", "60"),
  def("h", "TIME", "3600"),
  def("day", "TIME", "86400"),

  def("j", "ENERGY", "1"),
  def("kj", "ENERGY", "1000"),
  def("kwh", "ENERGY", "3600000"),
]);

/** Where unit definitions come from. Injectable so a host can add its own. */
export interface UnitRegistry {
  lookup(code: UnitCode): UnitDefinition | null;
}

export function createUnitRegistry(
  extra: readonly UnitDefinition[] = [],
): UnitRegistry {
  const byCode = new Map<string, UnitDefinition>();
  for (const u of [...DEFAULT_UNITS, ...extra]) byCode.set(u.code, u);
  return Object.freeze({ lookup: (code: UnitCode) => byCode.get(code) ?? null });
}

export const defaultUnitRegistry: UnitRegistry = createUnitRegistry();

/** An exact amount in a stated unit. */
export interface Quantity {
  readonly amount: Decimal;
  readonly unit: UnitCode;
}

export function quantity(amount: Decimal, unit: UnitCode): Quantity {
  return Object.freeze({ amount, unit });
}

export function quantityFromString(text: string, unit: UnitCode): Quantity {
  return quantity(fromString(text), unit);
}

export function zeroQuantity(unit: UnitCode): Quantity {
  return quantity(DEC_ZERO, unit);
}

/**
 * The definition for a unit, or a refusal naming it.
 *
 * Unknown units throw. A quantity in a unit nothing can interpret is not a
 * quantity — it is a number with a label — and letting it through means the
 * failure surfaces somewhere further away.
 */
export function unitDefinition(
  code: UnitCode,
  registry: UnitRegistry = defaultUnitRegistry,
): UnitDefinition {
  const found = registry.lookup(code);
  if (!found) {
    throw new RangeError(
      `Unknown unit ${JSON.stringify(code)}. Register it with a UnitRegistry before using it; an unrecognised unit cannot be converted or safely compared.`,
    );
  }
  return found;
}

function assertSameUnit(a: Quantity, b: Quantity, operation: string): void {
  if (a.unit !== b.unit) {
    throw new TypeError(
      `Cannot ${operation} ${a.unit} and ${b.unit} directly. Convert one to the other first — implicit unit coercion is how a cost comes out a thousand times wrong.`,
    );
  }
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  assertSameUnit(a, b, "add");
  return quantity(decAdd(a.amount, b.amount), a.unit);
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  assertSameUnit(a, b, "subtract");
  return quantity(decSubtract(a.amount, b.amount), a.unit);
}

/** Quantity scaled by a dimensionless factor — a yield, a waste allowance. */
export function scaleQuantity(a: Quantity, factor: Decimal): Quantity {
  return quantity(decMultiply(a.amount, factor), a.unit);
}

export function negateQuantity(a: Quantity): Quantity {
  return quantity(decNegate(a.amount), a.unit);
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  assertSameUnit(a, b, "compare");
  return decCompare(a.amount, b.amount);
}

export const quantityEquals = (a: Quantity, b: Quantity): boolean =>
  a.unit === b.unit && decCompare(a.amount, b.amount) === 0;
export const isZeroQuantity = (a: Quantity): boolean => decIsZero(a.amount);
export const isNegativeQuantity = (a: Quantity): boolean => decIsNegative(a.amount);

/** Sums quantities that must all share a unit. Unit stated, never inferred. */
export function sumQuantity(values: readonly Quantity[], unit: UnitCode): Quantity {
  for (const v of values) {
    if (v.unit !== unit) {
      throw new TypeError(
        `Cannot sum ${v.unit} into a ${unit} total. Convert first; a mixed-unit sum is a number with no meaning.`,
      );
    }
  }
  return quantity(decSum(values.map((v) => v.amount)), unit);
}

/**
 * The same physical amount expressed in `target`.
 *
 * Requires a scale and rounding mode, because conversions divide: 1 gram in
 * pounds has no exact decimal form. Widening conversions are still exact at
 * sufficient scale, and the caller chooses how much is sufficient.
 *
 * Refuses across dimensions. Kilograms to hours is not a missing factor.
 */
export function convertQuantity(
  value: Quantity,
  target: UnitCode,
  scale: number,
  mode: RoundingMode,
  registry: UnitRegistry = defaultUnitRegistry,
): Quantity {
  if (value.unit === target) return value;

  const from = unitDefinition(value.unit, registry);
  const to = unitDefinition(target, registry);

  if (from.dimension !== to.dimension) {
    throw new TypeError(
      `Cannot convert ${value.unit} (${from.dimension}) to ${target} (${to.dimension}). These measure different things, so no factor exists — this is a modelling error rather than a missing conversion.`,
    );
  }

  // Through the dimension's base unit, so a new unit needs one factor rather
  // than one per pair.
  const inBase = decMultiply(value.amount, from.inBaseUnits);
  return quantity(decDivide(inBase, to.inBaseUnits, scale, mode), target);
}

/** Whether two units can be converted at all. Cheaper than catching a throw. */
export function areCompatible(
  a: UnitCode,
  b: UnitCode,
  registry: UnitRegistry = defaultUnitRegistry,
): boolean {
  const da = registry.lookup(a);
  const db = registry.lookup(b);
  return da !== null && db !== null && da.dimension === db.dimension;
}

/** `<amount> <unit>`, exact. */
export function quantityToString(value: Quantity): string {
  return `${decToString(value.amount)} ${value.unit}`;
}

/** Canonical form for hashing. Normalised, so 1.50 kg and 1.5 kg hash alike. */
export function quantityCanonical(value: Quantity): string {
  return `${decToString(normalize(value.amount))} ${value.unit}`;
}

/**
 * A per-unit rate: an amount of something for each of something else.
 *
 * Modelled explicitly because it is the shape that makes unit errors
 * catchable. "£12 per kg" multiplied by "500 g" must either convert or refuse;
 * a bare `12` multiplied by a bare `500` can only produce 6000 and a bad day.
 */
export interface UnitRate<T> {
  readonly per: UnitCode;
  readonly value: T;
}

export function unitRate<T>(value: T, per: UnitCode): UnitRate<T> {
  return Object.freeze({ value, per });
}

/**
 * How many `rate.per` units are in `q`, converting if needed.
 *
 * The multiplier a rate should be applied with. Separated from the
 * multiplication itself so money and non-money rates share one unit-safe
 * conversion, and so the refusal happens before any arithmetic.
 */
export function rateMultiplier<T>(
  q: Quantity,
  rate: UnitRate<T>,
  scale: number,
  mode: RoundingMode,
  registry: UnitRegistry = defaultUnitRegistry,
): Decimal {
  return convertQuantity(q, rate.per, scale, mode, registry).amount;
}
