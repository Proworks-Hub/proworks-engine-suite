// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Money, PriceObservation, RegionCode } from "@proworks/contracts";
import { money } from "@proworks/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Price estimation.
//
// Ported from Family Table's ftCIEstimate, which is a better estimator than
// its size suggests, for two reasons worth keeping:
//
//   1. SALE PRICES ARE FACTS BUT POOR PREDICTORS. A shop selling steel at
//      $18.97 today and $12 during a clearance has not made $12 the price.
//      When there are enough regular observations, sales are excluded from the
//      estimate — while still being recorded, because what you actually paid
//      is never wrong.
//
//   2. CONFIDENCE COMES FROM COUNT *AND* AGE. Five observations from two years
//      ago describe a market that has moved. One from yesterday describes a
//      transaction. Neither is a price you should quote from, and the tiers
//      say so instead of returning a number that looks equally solid either
//      way.
//
// The median leads rather than the mean, because receipt data has outliers —
// a mis-parsed line, a bulk buy, a clearance — and one bad row should not move
// the answer much.
// ─────────────────────────────────────────────────────────────────────────────

export type EstimateConfidence = "high" | "medium" | "low";

export interface PriceEstimate {
  itemKey: string;
  /** Observations considered after narrowing by store and region. */
  count: number;
  /** How many of those the estimate is actually computed from. */
  basis: number;
  /** How many of the considered observations were sale prices. */
  saleCount: number;
  median: Money;
  average: Money;
  min: Money;
  max: Money;
  latest: Money;
  latestObservedOn: string;
  latestOnSale: boolean;
  confidence: EstimateConfidence;
  /** How the observations were narrowed, so a caller can explain the number. */
  source: "merchant" | "region" | "all";
  merchantKey?: string;
  region?: RegionCode;
}

export interface EstimateOptions {
  merchantKey?: string;
  region?: RegionCode;
  /** Return nothing rather than widening when the merchant has no history. */
  strictMerchant?: boolean;
  /** Overridable so estimates are testable without freezing the clock. */
  now?: Date;
  /** Most recent observations to consider. Family Table's default was 50. */
  window?: number;
}

const DEFAULT_WINDOW = 50;
const DAY_MS = 86_400_000;

const medianOf = (sorted: number[]): number =>
  sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]!
    : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);

/**
 * Estimates what an item costs, from observations alone.
 *
 * Returns null when there is nothing to go on. Null rather than a zero or a
 * guess: a caller that gets a number has no way to tell an estimate of zero
 * from an absence of data, and one of those is safe to quote from.
 */
export function estimatePrice(
  itemKey: string,
  observations: readonly PriceObservation[],
  options: EstimateOptions = {},
): PriceEstimate | null {
  const currency = observations[0]?.unitPrice.currency ?? "USD";
  const all = observations.filter((o) => o.itemKey === itemKey && o.unitPrice.cents > 0);
  if (all.length === 0) return null;

  let rows = all;
  let source: PriceEstimate["source"] = "all";

  if (options.merchantKey) {
    const atMerchant = rows.filter(
      (o) =>
        o.merchantKey === options.merchantKey &&
        (!options.region || o.region === options.region),
    );
    if (atMerchant.length > 0) {
      rows = atMerchant;
      source = "merchant";
    } else if (options.strictMerchant) {
      return null;
    }
  }

  if (source === "all" && options.region) {
    const inRegion = rows.filter((o) => o.region === options.region);
    if (inRegion.length > 0) {
      rows = inRegion;
      source = "region";
    }
  }

  rows = rows
    .slice()
    .sort((a, b) => b.observedOn.localeCompare(a.observedOn))
    .slice(0, options.window ?? DEFAULT_WINDOW);

  if (rows.length === 0) return null;

  // Regular prices are the estimate when there are enough of them.
  const regular = rows.filter((o) => !o.onSale);
  const basis = regular.length >= 2 ? regular : rows;

  const values = basis.map((o) => o.unitPrice.cents).sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);

  const now = (options.now ?? new Date()).getTime();
  const youngestDays = Math.min(
    ...rows.map((o) => Math.max(0, (now - new Date(`${o.observedOn}T12:00:00Z`).getTime()) / DAY_MS)),
  );

  const confidence: EstimateConfidence =
    rows.length >= 5 && youngestDays <= 60 ? "high" : rows.length >= 2 && youngestDays <= 180 ? "medium" : "low";

  const newest = rows[0]!;

  return {
    itemKey,
    count: rows.length,
    basis: basis.length,
    saleCount: rows.length - regular.length,
    median: money(medianOf(values), currency),
    average: money(Math.round(sum / values.length), currency),
    min: money(values[0]!, currency),
    max: money(values[values.length - 1]!, currency),
    latest: newest.unitPrice,
    latestObservedOn: newest.observedOn,
    latestOnSale: newest.onSale,
    confidence,
    source,
    ...(options.merchantKey && source === "merchant" ? { merchantKey: options.merchantKey } : {}),
    ...(options.region ? { region: options.region } : {}),
  };
}

/**
 * Prefers a merchant the caller actually buys from, then falls back.
 *
 * Family Table called this the source hierarchy, and it is a thin wrapper on
 * purpose: there is only ever one estimator, so a preferred-merchant number
 * and a general number are never computed two different ways.
 */
export function bestEstimate(
  itemKey: string,
  observations: readonly PriceObservation[],
  options: EstimateOptions & { preferredMerchantKey?: string } = {},
): PriceEstimate | null {
  const preferred = options.preferredMerchantKey ?? options.merchantKey;
  if (preferred) {
    const exact = estimatePrice(itemKey, observations, {
      ...options,
      merchantKey: preferred,
      strictMerchant: true,
    });
    if (exact) return exact;
  }
  return estimatePrice(itemKey, observations, { ...options, merchantKey: undefined });
}

export interface MerchantPriceSummary {
  merchantKey: string;
  merchantName: string;
  region?: RegionCode;
  label: string;
  count: number;
  median: Money;
  latest: Money;
  latestObservedOn: string;
  latestOnSale: boolean;
}

/**
 * The same item, merchant by merchant — which is the question anyone actually
 * has when they are about to buy something.
 */
export function summarizeByMerchant(
  itemKey: string,
  observations: readonly PriceObservation[],
): MerchantPriceSummary[] {
  const groups = new Map<string, PriceObservation[]>();

  for (const observation of observations) {
    if (observation.itemKey !== itemKey || observation.unitPrice.cents <= 0) continue;
    const key = `${observation.merchantKey}|${observation.region ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(observation);
    else groups.set(key, [observation]);
  }

  return [...groups.values()]
    .map((rows) => {
      const sorted = rows.map((o) => o.unitPrice.cents).sort((a, b) => a - b);
      const newest = rows.reduce((a, b) => (a.observedOn.localeCompare(b.observedOn) >= 0 ? a : b));
      const currency = newest.unitPrice.currency;
      return {
        merchantKey: newest.merchantKey,
        merchantName: newest.merchantName,
        ...(newest.region ? { region: newest.region } : {}),
        label: newest.region ? `${newest.merchantName} – ${newest.region}` : newest.merchantName,
        count: rows.length,
        median: money(medianOf(sorted), currency),
        latest: newest.unitPrice,
        latestObservedOn: newest.observedOn,
        latestOnSale: newest.onSale,
      };
    })
    .sort((a, b) => b.count - a.count);
}
