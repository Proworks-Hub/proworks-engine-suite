// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { NormalizedReceipt, PriceObservation, ReceiptLine } from "@proworks/contracts";
import { assertNoIdentityFields, priceObservationSchema } from "@proworks/contracts";
import { observationFingerprint } from "../normalize/fingerprint.js";

// ─────────────────────────────────────────────────────────────────────────────
// The contribution boundary.
//
// This is the only place in ReceiptIQ where a private record becomes shared
// knowledge, and it is the reason the engine can serve two applications that
// must never see each other's data.
//
// It is the portable form of Family Table's share_price_observation(), a
// PL/pgSQL function its own schema described as "the entire coupling between
// the app layer and the price database". That function was written so the
// price database could later become its own service. This is that service's
// boundary, in TypeScript, where both hosts can use one implementation.
//
// Four rules, all of them refusals:
//
//   1. Contribution is OPT-IN. Not opted in, nothing crosses. There is no
//      default that shares.
//   2. A REGION IS REQUIRED. A price with no region cannot be compared to
//      anything, so it is noise in the shared layer even though it is
//      perfectly good private history.
//   3. TAX AND UNPRICED LINES DO NOT CROSS. Tax is a fact about a jurisdiction
//      and a total, not about a product.
//   4. NOTHING IDENTIFYING CROSSES. Enforced twice — by `.strict()` parsing,
//      which rejects unknown keys, and by assertNoIdentityFields, which
//      catches anything named like an identifier even if a schema were later
//      loosened. Belt and braces, because this is the failure nobody notices.
//
// What is deliberately absent from the output: the receipt, its id, its owner,
// the host, the tenant, and any time more precise than a date.
// ─────────────────────────────────────────────────────────────────────────────

export interface ContributionOptions {
  /**
   * Whether the owner has agreed to contribute. Required, with no default:
   * a caller that forgets to pass it gets a refusal, not a silent share.
   */
  optedIn: boolean;
  /** Overrides the receipt's region when a host resolves it separately. */
  region?: string;
  /** Restricts contribution to specific lines, by index. */
  lineFilter?: (line: ReceiptLine, index: number) => boolean;
}

export interface ContributionResult {
  /** De-identified observations, ready for a PriceObservationRepository. */
  observations: PriceObservation[];
  /** Lines that did not cross, and why — so a host can be honest about it. */
  withheld: Array<{ index: number; name: string; reason: string }>;
}

/**
 * Extracts shareable price observations from a private receipt.
 *
 * Returns what may cross; it does not persist anything. Persisting is a host's
 * decision and a repository's job, and keeping this function pure means the
 * privacy rules can be tested without a database.
 */
export function contributeObservations(
  receipt: NormalizedReceipt,
  options: ContributionOptions,
): ContributionResult {
  const withheld: ContributionResult["withheld"] = [];

  if (!options.optedIn) {
    return {
      observations: [],
      withheld: receipt.lines.map((line, index) => ({
        index,
        name: line.name,
        reason: "not opted in to contribute shared price knowledge",
      })),
    };
  }

  const region = options.region ?? receipt.region;
  if (!region) {
    return {
      observations: [],
      withheld: receipt.lines.map((line, index) => ({
        index,
        name: line.name,
        reason: "no region — a price with no region cannot be compared to anything",
      })),
    };
  }

  if (!receipt.merchantKey) {
    return {
      observations: [],
      withheld: receipt.lines.map((line, index) => ({
        index,
        name: line.name,
        reason: "merchant could not be identified",
      })),
    };
  }

  const observations: PriceObservation[] = [];
  const seen = new Set<string>();

  receipt.lines.forEach((line, index) => {
    if (options.lineFilter && !options.lineFilter(line, index)) {
      withheld.push({ index, name: line.name, reason: "excluded by the host" });
      return;
    }
    if (line.isTax) {
      withheld.push({ index, name: line.name, reason: "tax is not a product" });
      return;
    }
    if (line.unitPrice.cents <= 0) {
      withheld.push({ index, name: line.name, reason: "no usable price" });
      return;
    }
    if (!line.itemKey) {
      withheld.push({ index, name: line.name, reason: "item could not be identified" });
      return;
    }

    const fingerprint = observationFingerprint({
      itemKey: line.itemKey,
      merchantKey: receipt.merchantKey!,
      region,
      observedOn: receipt.purchaseDate,
      unitPriceCents: line.unitPrice.cents,
    });

    // The same fact twice on one receipt lands once.
    if (seen.has(fingerprint)) {
      withheld.push({ index, name: line.name, reason: "duplicate of an earlier line" });
      return;
    }
    seen.add(fingerprint);

    // Built field by field rather than spread from the line, so a field added
    // to ReceiptLine later cannot cross this boundary by accident. Adding one
    // here has to be a decision somebody makes on purpose.
    const candidate = {
      ownership: "canonical" as const,
      itemKey: line.itemKey,
      itemName: line.name,
      merchantKey: receipt.merchantKey!,
      merchantName: receipt.merchantName,
      region,
      price: line.lineTotal,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      onSale: line.onSale,
      saleType: line.saleType,
      ...(line.originalPrice ? { originalPrice: line.originalPrice } : {}),
      observedOn: receipt.purchaseDate,
      source: "receipt" as const,
      confidence: line.confidence,
      fingerprint,
    };

    // Two independent checks. The schema is strict, so an unexpected key fails
    // here; the assertion then catches anything named like an identifier that
    // a future schema change might have let through.
    const observation = priceObservationSchema.parse(candidate);
    assertNoIdentityFields(observation, "priceObservation");

    observations.push(observation);
  });

  return { observations, withheld };
}
