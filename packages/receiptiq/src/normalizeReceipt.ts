// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  CanonicalItem,
  ExtractedReceipt,
  NormalizedReceipt,
  OwnershipClass,
  ReceiptLine,
} from "@proworks/contracts";
import { CONFIDENCE, money, moneyFromDecimal, normalizedReceiptSchema } from "@proworks/contracts";
import { normalizeName } from "./normalize/keys.js";
import { normalizeMerchant, type MerchantNormalizationOptions } from "./normalize/merchant.js";
import { parseRegion } from "./normalize/region.js";
import { normalizeUnit } from "./normalize/units.js";
import { receiptFingerprint } from "./normalize/fingerprint.js";
import { classifyItem, type ClassifierOptions } from "./knowledge/classifier.js";

// ─────────────────────────────────────────────────────────────────────────────
// Extraction → NormalizedReceipt.
//
// Everything upstream of here is uncertain: a model read a photo, or a parser
// read text somebody typed. This is where uncertainty becomes structure — and,
// importantly, where it stays labelled rather than being rounded away.
//
// The result is always PRIVATE. Nothing in this file decides what may be
// shared; that is the contribution boundary's job, and keeping the two apart
// is what stops a normalization change from quietly widening what leaks.
// ─────────────────────────────────────────────────────────────────────────────

export interface NormalizeOptions<TCategory extends string = string> {
  /** Who owns the resulting record. Opaque to ReceiptIQ. */
  ownerRef: string;
  ownership: Extract<OwnershipClass, "host-private" | "tenant-private">;
  /** How the receipt was captured. */
  source?: NormalizedReceipt["source"];
  /** Used when the receipt itself prints no location. */
  defaultRegionText?: string;
  /** Used when the receipt prints no date. Defaults to today. */
  today?: string;
  currency?: string;
  merchant?: MerchantNormalizationOptions;
  /** The host's taxonomy. Without it, lines are left unclassified. */
  classifier?: ClassifierOptions<TCategory>;
  /**
   * Resolves an already-known canonical item, so a receipt that prints a SKU
   * or an alias is matched to what previous receipts established rather than
   * creating a near-duplicate.
   */
  resolveItem?: (line: {
    name: string;
    key: string;
    sku?: string;
    merchantKey: string;
  }) => CanonicalItem | null | undefined;
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * Turns an extraction into a normalized, private receipt.
 *
 * Never throws on bad input. Real receipts arrive with missing dates, unreadable
 * totals and lines that are not products, and a normalizer that rejects them
 * hands the host nothing to show a human — which is exactly when a human is
 * most needed. Problems become `warnings` and low confidence instead.
 */
export function normalizeReceipt<TCategory extends string = string>(
  extracted: ExtractedReceipt,
  options: NormalizeOptions<TCategory>,
): NormalizedReceipt {
  const currency = options.currency ?? "USD";
  const warnings = [...(extracted.warnings ?? [])];

  const merchant = normalizeMerchant(extracted.merchant, options.merchant ?? {});
  if (!extracted.merchant) warnings.push("merchant was not read; observations cannot be contributed");

  const regionText = extracted.regionText ?? options.defaultRegionText;
  const region = parseRegion(regionText);
  if (regionText && !region) {
    warnings.push(
      `"${regionText}" could not be reduced to a region code; this receipt stays private until one is set`,
    );
  }

  const purchaseDate = extracted.date ?? options.today ?? todayISO();
  if (!extracted.date) warnings.push("no purchase date was read; today's date was used");

  const lines: ReceiptLine[] = (extracted.items ?? []).map((item) => {
    const quantity = item.qty && item.qty > 0 ? item.qty : 1;
    const lineTotal = moneyFromDecimal(item.price ?? 0, currency);
    const unitPrice = money(
      quantity > 0 ? Math.round(lineTotal.cents / quantity) : lineTotal.cents,
      currency,
    );
    const key = normalizeName(item.name);

    const known = options.resolveItem?.({
      name: item.name,
      key,
      ...(item.sku ? { sku: item.sku } : {}),
      merchantKey: merchant.key,
    });

    // A known item's category outranks a fresh classification: it is what
    // previous receipts — and any human correction — already established.
    let category: string | undefined = known?.category;
    let confidence: number = known ? CONFIDENCE.corrected : CONFIDENCE.unknown;

    if (!category && options.classifier) {
      const result = classifyItem(item.name, options.classifier);
      if (result.category) category = result.category;
      confidence = result.confidence;
    }

    if (item.isTax) confidence = 1;

    return {
      rawText: item.rawText ?? item.name,
      name: known?.name ?? item.name,
      ...(key ? { itemKey: known?.key ?? key } : {}),
      quantity,
      unit: normalizeUnit(item.unit) || "each",
      lineTotal,
      unitPrice,
      onSale: item.onSale ?? false,
      saleType: item.saleType ?? null,
      ...(item.originalPrice
        ? { originalPrice: moneyFromDecimal(item.originalPrice, currency) }
        : {}),
      ...(item.sku ? { sku: item.sku } : {}),
      ...(category ? { category } : {}),
      isTax: item.isTax ?? false,
      confidence,
      corrected: false,
    };
  });

  // A printed total is a fact and wins. Summing the lines is a fallback, and a
  // mismatch between the two is reported rather than reconciled — it usually
  // means a line was misread, which is a thing a human should see.
  const summed = lines.reduce((acc, line) => acc + line.lineTotal.cents, 0);
  const total =
    extracted.total !== undefined ? moneyFromDecimal(extracted.total, currency) : money(summed, currency);

  if (extracted.total !== undefined && Math.abs(total.cents - summed) > 1) {
    warnings.push(
      `lines sum to ${(summed / 100).toFixed(2)} but the receipt says ${(total.cents / 100).toFixed(2)} — something was misread`,
    );
  }

  const tax =
    extracted.tax !== undefined
      ? moneyFromDecimal(extracted.tax, currency)
      : money(
          lines.filter((line) => line.isTax).reduce((acc, line) => acc + line.lineTotal.cents, 0),
          currency,
        );

  return normalizedReceiptSchema.parse({
    ownership: options.ownership,
    ownerRef: options.ownerRef,
    merchantName: merchant.name,
    merchantKey: merchant.key,
    ...(region ? { region } : {}),
    ...(regionText ? { regionText } : {}),
    purchaseDate,
    lines,
    ...(tax.cents > 0 ? { tax, subtotal: money(total.cents - tax.cents, currency) } : {}),
    total,
    source: options.source ?? "manual",
    fingerprint: receiptFingerprint(merchant.name, purchaseDate, total.cents),
    warnings,
  });
}
