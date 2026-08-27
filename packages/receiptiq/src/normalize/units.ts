// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Units and package sizes.
//
// A price is only comparable once you know what it bought. $3.49 for pasta
// sauce means nothing until you know whether that was 24 oz or 8 oz — and the
// same is true of steel: $18.97 per what?
//
// Ported from Family Table's FT_CI_UNITS. Everything converts through a base
// unit per dimension, so conversions compose without a lookup matrix.
//
// Deliberately absent: length. Family Table never needed it, and adding it for
// a hypothetical trade use case would mean guessing at conventions (linear
// feet, board feet, per-piece) that a real ProWorks receipt should decide.
// ─────────────────────────────────────────────────────────────────────────────

export type UnitKind = "count" | "mass" | "volume";

export interface UnitDefinition {
  readonly kind: UnitKind;
  /** How many base units one of these is. Base: 1 item, 1 gram, 1 millilitre. */
  readonly base: number;
  readonly label: string;
}

export const UNITS: Readonly<Record<string, UnitDefinition>> = {
  each: { kind: "count", base: 1, label: "each" },
  item: { kind: "count", base: 1, label: "each" },
  ct: { kind: "count", base: 1, label: "each" },
  pk: { kind: "count", base: 1, label: "each" },

  g: { kind: "mass", base: 1, label: "g" },
  kg: { kind: "mass", base: 1000, label: "kg" },
  oz: { kind: "mass", base: 28.349523125, label: "oz" },
  lb: { kind: "mass", base: 453.59237, label: "lb" },

  ml: { kind: "volume", base: 1, label: "ml" },
  l: { kind: "volume", base: 1000, label: "l" },
  "fl oz": { kind: "volume", base: 29.5735295625, label: "fl oz" },
  tsp: { kind: "volume", base: 4.92892159375, label: "tsp" },
  tbsp: { kind: "volume", base: 14.78676478125, label: "tbsp" },
  cup: { kind: "volume", base: 236.5882365, label: "cup" },
  pint: { kind: "volume", base: 473.176473, label: "pint" },
  quart: { kind: "volume", base: 946.352946, label: "quart" },
  gallon: { kind: "volume", base: 3785.411784, label: "gallon" },
};

const ALIASES: Readonly<Record<string, string>> = {
  ea: "each",
  items: "each",
  count: "ct",
  pack: "pk",
  ounce: "oz",
  ounces: "oz",
  pound: "lb",
  pounds: "lb",
  lbs: "lb",
  gram: "g",
  grams: "g",
  kilogram: "kg",
  kilograms: "kg",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  floz: "fl oz",
  "fluid ounce": "fl oz",
  "fluid ounces": "fl oz",
  fluidounces: "fl oz",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cups: "cup",
  pt: "pint",
  pints: "pint",
  qt: "quart",
  quarts: "quart",
  gal: "gallon",
  gallons: "gallon",
};

/** Reduces a printed unit to a canonical one. Unknown units pass through unchanged. */
export function normalizeUnit(unit: string | null | undefined): string {
  const key = String(unit ?? "")
    .toLowerCase()
    .trim()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
  return ALIASES[key] ?? key;
}

/**
 * Converts a quantity between units of the same dimension.
 *
 * Returns null when the units are unknown or belong to different dimensions.
 * Null rather than a throw, because "I cannot compare these" is an ordinary
 * outcome when reading real receipts — an item priced by weight and a recipe
 * measured by volume simply do not convert without a density nobody has.
 */
export function convertUnit(
  quantity: number,
  from: string | null | undefined,
  to: string | null | undefined,
): number | null {
  const a = UNITS[normalizeUnit(from)];
  const b = UNITS[normalizeUnit(to)];
  if (!a || !b || a.kind !== b.kind) return null;
  return (Number(quantity) || 0) * (a.base / b.base);
}

/** True when both units describe the same dimension. */
export function unitsComparable(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = UNITS[normalizeUnit(a)];
  const y = UNITS[normalizeUnit(b)];
  return Boolean(x && y && x.kind === y.kind);
}
