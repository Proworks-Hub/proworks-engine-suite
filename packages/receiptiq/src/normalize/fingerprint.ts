// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { compactKey, normalizeName } from "./keys.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprints: one identity per fact, whatever route it arrived by.
//
// The same receipt reaches a host as a photo, as a pasted email, and as
// something typed in by hand — sometimes all three, when someone is not sure
// the first attempt worked. And when two people in one household both
// contribute, the same purchase arrives twice from different devices.
//
// A fingerprint is what makes those land once. Ported from Family Table's
// ftReceiptFingerprint and the shared database's dedup key.
//
// These are composite keys, not hashes. Family Table's SQL used sha256 for the
// shared layer, but hashing here would buy nothing: the inputs are already
// de-identified by the time a fingerprint is computed, and a hash cannot be
// read when a duplicate turns out to be wrong. A composite key can be printed
// in a log and understood. It also keeps this package dependency-free and
// runnable in a browser, which Family Table needs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Identity of a receipt: this merchant, this day, this total.
 *
 * Total is part of the key on purpose. Two genuine trips to one shop on one
 * day are not duplicates, and they almost never come to the same cent.
 */
export function receiptFingerprint(
  merchant: string | null | undefined,
  date: string | null | undefined,
  totalCents: number | null | undefined,
): string {
  return [normalizeName(merchant), String(date ?? ""), String(Math.round(Number(totalCents) || 0))].join("|");
}

/**
 * Identity of a price observation: this item, at this merchant, in this
 * region, on this day, at this unit price.
 *
 * Unit price rather than line total, so the same item bought in different
 * quantities on the same day at the same shop is recognized as one observed
 * price instead of two.
 */
export function observationFingerprint(input: {
  itemKey: string;
  merchantKey: string;
  region?: string;
  observedOn: string;
  unitPriceCents: number;
}): string {
  return [
    input.itemKey,
    input.merchantKey,
    input.region ?? "",
    input.observedOn,
    String(Math.round(input.unitPriceCents)),
  ].join("|");
}

/**
 * Identity of a merchant's item code, for mapping a SKU to a canonical item.
 */
export function skuFingerprint(merchantKey: string, sku: string): string {
  return `${compactKey(merchantKey)}|${String(sku).toUpperCase().trim()}`;
}
