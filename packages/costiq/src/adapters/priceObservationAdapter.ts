// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PriceObservation } from "@proworks/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Observed prices as a cost basis.
//
// Until now every material rate CostIQ used was configured — a number someone
// typed once and nobody revisited. This is where that changes: what the shop
// actually paid, at a named supplier, on a known date, becomes the basis for
// what a job costs.
//
// The adapter lives in CostIQ, not ReceiptIQ, for the same reason
// manufacturingPlanAdapter does: the consumer owns the translation. CostIQ
// imports only `@proworks/contracts`, so it has no dependency on ReceiptIQ at
// all — any system that can produce valid PriceObservations can feed it.
//
// The honesty rules are the point of the file:
//
//   * SALE PRICES DO NOT SET A COST BASIS. What a clearance cost once is not
//     what the next sheet will cost. Sales are excluded when regular prices
//     exist, and the exclusion is reported.
//   * STALE PRICES ARE FLAGGED, NOT SILENTLY USED. A quote built on a
//     two-year-old steel price is wrong in a way that only shows up after the
//     job is sold.
//   * A THIN BASIS SAYS SO. One observation is a transaction, not a market
//     rate, and the caller is told which it has.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostBasis {
  itemKey: string;
  itemName: string;
  /** Cost per unit, in minor units of `currency`. */
  unitPriceCents: number;
  currency: string;
  unit: string;
  /** Observations the basis was computed from. */
  observationCount: number;
  /** Most recent observation used. */
  observedOn: string;
  /** Days between `observedOn` and the reference date. */
  ageDays: number;
  /** Supplier, when the basis was narrowed to one. */
  merchantKey?: string;
  merchantName?: string;
  /** What this basis does and does not account for. Never empty when it matters. */
  caveats: string[];
}

export interface CostBasisOptions {
  /** Restricts the basis to one supplier. */
  merchantKey?: string;
  /** Ignores observations older than this. Defaults to 365 days. */
  maxAgeDays?: number;
  /** Warns above this age even when the observation is still used. */
  staleAfterDays?: number;
  /** Reference date. Overridable so results are testable. */
  now?: Date;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_AGE = 365;
const DEFAULT_STALE_AFTER = 90;

const medianOf = (sorted: number[]): number =>
  sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]!
    : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);

/**
 * Derives a material cost basis from observed prices.
 *
 * Returns null when there is nothing recent enough to stand on. Null rather
 * than a stale number: a caller that gets a basis will price work with it, and
 * "I don't know what this costs" has to be expressible or it never gets said.
 */
export function priceObservationsToCostBasis(
  itemKey: string,
  observations: readonly PriceObservation[],
  options: CostBasisOptions = {},
): CostBasis | null {
  const now = (options.now ?? new Date()).getTime();
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE;
  const staleAfterDays = options.staleAfterDays ?? DEFAULT_STALE_AFTER;
  const caveats: string[] = [];

  const ageOf = (observation: PriceObservation): number =>
    Math.max(0, (now - new Date(`${observation.observedOn}T12:00:00Z`).getTime()) / DAY_MS);

  let rows = observations.filter((o) => o.itemKey === itemKey && o.unitPrice.cents > 0);
  if (rows.length === 0) return null;

  if (options.merchantKey) {
    const atMerchant = rows.filter((o) => o.merchantKey === options.merchantKey);
    if (atMerchant.length === 0) return null;
    rows = atMerchant;
  }

  const withinWindow = rows.filter((o) => ageOf(o) <= maxAgeDays);
  if (withinWindow.length === 0) {
    const newest = rows.reduce((a, b) => (a.observedOn.localeCompare(b.observedOn) >= 0 ? a : b));
    caveats.push(
      `The most recent observed price is ${Math.round(ageOf(newest))} days old, beyond the ${maxAgeDays}-day window. No cost basis was produced.`,
    );
    return null;
  }
  rows = withinWindow;

  // Regular prices set the basis when there are enough of them.
  const regular = rows.filter((o) => !o.onSale);
  const basis = regular.length >= 2 ? regular : rows;

  if (regular.length >= 2 && rows.length > regular.length) {
    caveats.push(
      `${rows.length - regular.length} sale price(s) excluded — a promotional price is not a cost basis.`,
    );
  } else if (regular.length < 2 && rows.some((o) => o.onSale)) {
    caveats.push(
      "Sale prices are included because there are too few regular observations to exclude them. This basis may be lower than what a restock actually costs.",
    );
  }

  const newest = basis.reduce((a, b) => (a.observedOn.localeCompare(b.observedOn) >= 0 ? a : b));
  const ageDays = Math.round(ageOf(newest));

  if (ageDays > staleAfterDays) {
    caveats.push(
      `The most recent observed price is ${ageDays} days old; confirm it before quoting from it.`,
    );
  }
  if (basis.length === 1) {
    caveats.push("Based on a single purchase, which is a transaction rather than a market rate.");
  }

  const units = new Set(basis.map((o) => o.unit));
  if (units.size > 1) {
    caveats.push(
      `Observations use mixed units (${[...units].join(", ")}); the basis is stated in "${newest.unit}" and may not be comparable.`,
    );
  }

  const values = basis.map((o) => o.unitPrice.cents).sort((a, b) => a - b);

  return {
    itemKey,
    itemName: newest.itemName,
    unitPriceCents: medianOf(values),
    currency: newest.unitPrice.currency,
    unit: newest.unit,
    observationCount: basis.length,
    observedOn: newest.observedOn,
    ageDays,
    ...(options.merchantKey
      ? { merchantKey: newest.merchantKey, merchantName: newest.merchantName }
      : {}),
    caveats,
  };
}

/**
 * Renders a cost basis as the material rate the calculator wants: cost per
 * unit in major units, alongside the caveats to carry into `assumptions`.
 */
export function costBasisToMaterialRate(basis: CostBasis): {
  unitCost: number;
  currency: string;
  unit: string;
  assumptions: string[];
} {
  return {
    unitCost: basis.unitPriceCents / 100,
    currency: basis.currency,
    unit: basis.unit,
    assumptions: [
      `Material cost from ${basis.observationCount} observed purchase(s), most recent ${basis.observedOn}.`,
      ...basis.caveats,
    ],
  };
}
