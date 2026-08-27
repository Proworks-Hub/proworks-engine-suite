// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { RegionCode } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Region normalization.
//
// Receipts print a city: "Brighton, CO". Family Table's local store kept that
// string verbatim, while its shared database required `US-CO` and rejected
// anything finer. The shared one is right — a city is close enough to identify
// a household, and a city is not what makes a price comparable anyway. Prices
// vary by state tax, chain region and distribution, not by suburb.
//
// So this is where the two representations meet: a host may keep the printed
// text privately, but only the coarse code crosses into shared knowledge.
// ─────────────────────────────────────────────────────────────────────────────

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","VI","GU",
]);

const CA_PROVINCES = new Set(["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"]);

const REGION_SHAPE = /^[A-Z]{2}(-[A-Z]{2,3})?$/;

/** True when the value is already a valid region code. */
export function isRegionCode(value: string | null | undefined): value is RegionCode {
  return typeof value === "string" && REGION_SHAPE.test(value);
}

/**
 * Reduces printed location text to a region code, or returns undefined when it
 * cannot be done confidently.
 *
 * Undefined rather than a guess: an observation with the wrong region is worse
 * than one with no region, because it pollutes a regional summary that someone
 * will later trust. The contribution boundary refuses observations without a
 * region for the same reason.
 *
 *   "Brighton, CO"      → "US-CO"
 *   "COLORADO SPRINGS CO 80903" → "US-CO"
 *   "US-CO"             → "US-CO"
 *   "Toronto, ON"       → "CA-ON"
 *   "somewhere"         → undefined
 */
export function parseRegion(text: string | null | undefined): RegionCode | undefined {
  const raw = String(text ?? "").trim();
  if (!raw) return undefined;

  const upper = raw.toUpperCase();
  if (REGION_SHAPE.test(upper)) return upper as RegionCode;

  // Trailing subdivision, with or without a comma and with or without a
  // postcode after it: "Brighton, CO" / "BRIGHTON CO 80601".
  const match = upper.match(/(?:^|[,\s])([A-Z]{2})(?:\s+[A-Z0-9-]{3,10})?\s*$/);
  const code = match?.[1];
  if (!code) return undefined;

  if (US_STATES.has(code)) return `US-${code}` as RegionCode;
  if (CA_PROVINCES.has(code)) return `CA-${code}` as RegionCode;
  return undefined;
}
