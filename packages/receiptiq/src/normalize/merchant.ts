// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MerchantIdentity, RegionCode } from "@proworks/contracts";
import { compactKey } from "./keys.js";

// ─────────────────────────────────────────────────────────────────────────────
// Merchant normalization.
//
// "HOME DEPOT #1234", "THE HOME DEPOT 4512 POS DEBIT" and "homedepot.com" are
// one merchant. Recognizing that is what lets two applications share price
// knowledge at all — without it, ProWorks and Family Table would each build a
// private pile of near-duplicate merchant names that never join up.
//
// Ported from Family Table's ftMerchNorm. Two layers, in order:
//
//   1. A known-brand table. Exact, curated, and the only way to collapse
//      "XFINITY" and "COMCAST" onto one identity.
//   2. A fallback that strips the noise banks and registers add — payment-rail
//      words, card and store numbers, TLDs — and keeps the first few words.
//
// The brand table below is deliberately generic across household and trade
// suppliers, because both hosts shop at overlapping merchants. It is data, and
// a host can extend it without touching this code.
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandRule {
  readonly pattern: RegExp;
  readonly name: string;
}

/**
 * Chains both hosts are likely to see. Ordered: the first match wins, so more
 * specific patterns belong above more general ones.
 */
export const DEFAULT_BRANDS: readonly BrandRule[] = [
  { pattern: /home\s*depot/i, name: "Home Depot" },
  { pattern: /lowe'?s/i, name: "Lowe's" },
  { pattern: /menards/i, name: "Menards" },
  { pattern: /harbor\s*freight/i, name: "Harbor Freight" },
  { pattern: /tractor\s*supply/i, name: "Tractor Supply" },
  { pattern: /ace\s*hardware/i, name: "Ace Hardware" },
  { pattern: /grainger/i, name: "Grainger" },
  { pattern: /fastenal/i, name: "Fastenal" },
  { pattern: /mcmaster[-\s]*carr/i, name: "McMaster-Carr" },
  { pattern: /metal\s*supermarkets/i, name: "Metal Supermarkets" },
  { pattern: /sam'?s\s*club/i, name: "Sam's Club" },
  { pattern: /costco/i, name: "Costco" },
  { pattern: /walmart|wal-mart/i, name: "Walmart" },
  { pattern: /target/i, name: "Target" },
  { pattern: /amazon|amzn/i, name: "Amazon" },
  { pattern: /king\s*soopers/i, name: "King Soopers" },
  { pattern: /safeway/i, name: "Safeway" },
  { pattern: /kroger/i, name: "Kroger" },
  { pattern: /aldi/i, name: "Aldi" },
  { pattern: /trader\s*joe/i, name: "Trader Joe's" },
  { pattern: /whole\s*foods/i, name: "Whole Foods" },
  { pattern: /uline/i, name: "Uline" },
  { pattern: /staples/i, name: "Staples" },
  { pattern: /office\s*depot/i, name: "Office Depot" },
];

/** Words a card processor adds that say nothing about who was paid. */
const PAYMENT_NOISE =
  /\b(pos|debit|credit|purchase|payment|card\s*\d+|recurring|web|ach|chk|ck|xxxx|sq|tst|paypal)\b/g;

export interface MerchantNormalizationOptions {
  /** Replaces the default brand table entirely when supplied. */
  brands?: readonly BrandRule[];
  /** Extends the default table. Checked before the defaults. */
  additionalBrands?: readonly BrandRule[];
  region?: RegionCode;
}

/**
 * Reduces printed merchant text to a stable identity.
 *
 * Always returns something. An unrecognized merchant still gets a usable key,
 * because refusing to normalize would mean refusing to record the observation,
 * and an observation at an unknown store is still a real price.
 */
export function normalizeMerchant(
  text: string | null | undefined,
  options: MerchantNormalizationOptions = {},
): MerchantIdentity {
  const raw = String(text ?? "").trim();
  const brands = options.brands ?? [...(options.additionalBrands ?? []), ...DEFAULT_BRANDS];

  for (const brand of brands) {
    if (brand.pattern.test(raw)) {
      return {
        ownership: "canonical",
        key: compactKey(brand.name),
        name: brand.name,
        ...(options.region ? { region: options.region } : {}),
      };
    }
  }

  const cleaned = raw
    .toLowerCase()
    .replace(PAYMENT_NOISE, " ")
    .replace(/\.(com|net|org|co\.uk)\b/g, " ")
    .replace(/[#*]\s*\d+/g, " ")
    .replace(/\d{3,}/g, " ")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w.length > 1).slice(0, 3);
  const name =
    words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || raw.slice(0, 18) || "Unknown";
  const key = words.join("") || compactKey(raw).slice(0, 18) || "unknown";

  return {
    ownership: "canonical",
    key,
    name,
    ...(options.region ? { region: options.region } : {}),
  };
}
