// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Normalized keys.
//
// Every piece of receipt knowledge is looked up by a key derived from text a
// machine printed, which means the same thing arrives spelled a dozen ways.
// These functions are the reason "MILK 2% GAL", "Milk 2% Gallon" and
// "milk  2%  gal" can be recognized as one item.
//
// Ported from Family Table's ftCINormName, which has been the lookup key for
// its entire price history. Changing how it collapses text would orphan that
// history, so the behaviour is preserved exactly.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapses a display name to a stable lookup key: lowercase, articles
 * dropped, everything non-alphanumeric flattened to single spaces.
 *
 * "The Classico Tomato & Basil" → "classico tomato basil"
 */
export function normalizeName(name: string | null | undefined): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A key with no spaces at all, for identifiers that must survive a URL or a filename. */
export function compactKey(name: string | null | undefined): string {
  return normalizeName(name).replace(/\s+/g, "");
}

/**
 * Store identity: a chain in a region.
 *
 * Walmart in Brighton and Walmart in Colorado Springs price differently, so
 * they are different keys. Which Walmart in Brighton is not recorded, because
 * that is a fact about the shopper rather than the price.
 */
export function storeKey(merchant: string | null | undefined, region?: string | null): string {
  const m = compactKey(merchant);
  const r = compactKey(region);
  if (!m && !r) return "";
  return r ? `${m}|${r}` : m;
}
