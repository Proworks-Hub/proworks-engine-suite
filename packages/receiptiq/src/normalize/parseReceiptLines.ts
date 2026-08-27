// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// The receipt line parser.
//
// This is the piece of ReceiptIQ that earns its keep. Receipts are printed for
// humans holding them at a till, not for machines, and every chain does it
// differently — but the ways they express a discount, a multi-buy or a weighed
// item turn out to be a small, learnable set.
//
// Ported from Family Table's ftReceiptParse, which has read real grocery,
// hardware and clothing receipts in production. Its rules are preserved
// exactly, including the ones that look like details and are not:
//
//   * A discount line modifies the line ABOVE it. Receipts print the coupon
//     after the item it applies to, so a parser that treats each line
//     independently records the full price and silently loses the saving.
//   * The price PAID is the fact; the original is kept beside it, never
//     instead of it.
//   * "2 @ 2.50" is a per-unit price and "2/5.00" is a deal total. Confusing
//     them doubles or halves the line.
//   * Units are captured only when PRINTED. A parser that guesses "each" for a
//     weighed item invents a unit price that is wrong by a factor of the
//     weight, and unit prices are what the whole engine is built to compare.
//
// Everything here works in integer cents. Receipt arithmetic that rounds after
// each step drifts, and these numbers get summed across thousands of rows.
// ─────────────────────────────────────────────────────────────────────────────

export type SaleType = "percentage" | "fixed" | "bogo" | "other";

export interface ParsedLine {
  /** The line exactly as it arrived, so a human can always check the reading. */
  rawText: string;
  name: string;
  quantity: number;
  /** Canonical unit, or "each" when the receipt printed none. */
  unit: string;
  lineTotalCents: number;
  unitPriceCents: number;
  onSale: boolean;
  saleType: SaleType | null;
  /** Only when a was/regular price was actually printed. */
  originalPriceCents?: number;
  /** The merchant's own item code, when the receipt prints one. */
  sku?: string;
  /** Tax is a receipt fact, never a product. */
  isTax: boolean;
}

/** Parses a printed decimal into cents without floating-point drift. */
function toCents(text: string | undefined): number {
  if (!text) return 0;
  const normalized = text.replace(",", ".").trim();
  const match = normalized.match(/^(-?)(\d*)(?:\.(\d{0,2}))?$/);
  if (!match) return Math.round((parseFloat(normalized) || 0) * 100);
  const sign = match[1] === "-" ? -1 : 1;
  const whole = parseInt(match[2] || "0", 10);
  const frac = (match[3] ?? "").padEnd(2, "0");
  return sign * (whole * 100 + parseInt(frac || "0", 10));
}

/** Whole-cent division that keeps the total honest. */
const perUnit = (totalCents: number, quantity: number): number =>
  quantity > 0 ? Math.round(totalCents / quantity) : totalCents;

const SUMMARY_LINE = /^(sub\s*)?total\b/i;
const TAX_LINE = /^(?:sales\s+)?tax\b[^\d]*(\d+[.,]?\d{0,2})\s*$/i;
const DISCOUNT_LINE =
  /^(?:-|\()?\s*(?:coupon|discount|savings?|less|member price adj)\b[^\d]*(\d+[.,]?\d{0,2})\s*\)?\s*$/i;
const BARE_NEGATIVE = /^-\s*\$?(\d+[.,]?\d{0,2})\s*$/;

const WAS_PRICE = /\b(?:was|reg\.?|orig\.?|regular)\s*\$?(\d+[.,]?\d{0,2})/i;
const PERCENT_OFF = /(\d{1,3})\s*%\s*off/i;
const BOGO = /\b(bogo|b1g1)\b/i;
const SALE_WORD = /\b(sale|clearance|markdown)\b/i;

/** "2 @ 2.50" (per unit) or "2/5.00" (deal total). */
const QUANTITY_DEAL = /(\d+)\s*([@/])\s*\$?(\d+[.,]?\d{0,2})\s*$/;
/** Trailing price: everything before it is the name. */
const TRAILING_PRICE = /^(.*?)[\s$]+(-?\d+[.,]?\d{0,2})\s*$/;
/** A printed weight or count at the end of the item name. */
const PRINTED_UNIT = /\s(\d+(?:\.\d+)?)\s*(lb|lbs|oz|kg|g|ct|pk)\.?$/i;

/**
 * A merchant item code. Labelled forms only — `SKU 123456`, `ITEM# 123456`.
 *
 * Bare digit runs are deliberately not treated as SKUs. Receipts are full of
 * unlabelled numbers (store number, lane, loyalty tail, UPC fragments), and a
 * wrong SKU is worse than none: it maps a canonical item to the wrong code and
 * every later receipt inherits the mistake.
 */
const SKU_LABELLED = /\b(?:sku|item\s*#?|mfr\s*#?|model|part\s*#?)[:\s#]*([A-Z0-9][A-Z0-9-]{3,19})\b/i;

export interface ParseOptions {
  /** Additional merchant-specific SKU patterns. First capture group wins. */
  skuPatterns?: readonly RegExp[];
}

/**
 * Reads printed receipt text into structured lines.
 *
 * Never throws and never drops a line. Text it cannot price becomes a
 * zero-priced line rather than disappearing, because a human reviewing the
 * result needs to see what was on the receipt — including the parts the parser
 * failed on. Silent omission is the one failure mode that cannot be corrected
 * downstream.
 */
export function parseReceiptLines(text: string | null | undefined, options: ParseOptions = {}): ParsedLine[] {
  const out: ParsedLine[] = [];

  for (const rawLine of String(text ?? "").split("\n")) {
    const rawText = rawLine.trim();
    if (!rawText) continue;

    // Summary lines are not products.
    if (SUMMARY_LINE.test(rawText)) continue;

    const taxMatch = rawText.match(TAX_LINE);
    if (taxMatch) {
      const cents = toCents(taxMatch[1]);
      out.push({
        rawText,
        name: "Tax",
        quantity: 1,
        unit: "each",
        lineTotalCents: cents,
        unitPriceCents: cents,
        onSale: false,
        saleType: null,
        isTax: true,
      });
      continue;
    }

    // A discount reduces the line above it. The paid price becomes the fact and
    // the pre-discount price is preserved as the original.
    const discountMatch = rawText.match(DISCOUNT_LINE) ?? rawText.match(BARE_NEGATIVE);
    if (discountMatch && out.length > 0) {
      const discount = toCents(discountMatch[1]);
      const previous = out[out.length - 1]!;
      if (discount > 0 && discount < previous.lineTotalCents) {
        previous.originalPriceCents = previous.originalPriceCents ?? previous.lineTotalCents;
        previous.lineTotalCents -= discount;
        previous.unitPriceCents = perUnit(previous.lineTotalCents, previous.quantity);
        previous.onSale = true;
        previous.saleType = previous.saleType ?? "fixed";
      }
      continue;
    }

    // Sale markers are stripped from the name as they are recognized, so the
    // item name that survives is the product rather than the promotion.
    let working = rawText;
    let originalPriceCents = 0;
    let onSale = false;
    let saleType: SaleType | null = null;

    const wasMatch = working.match(WAS_PRICE);
    if (wasMatch && wasMatch.index !== undefined) {
      originalPriceCents = toCents(wasMatch[1]);
      onSale = true;
      saleType = "other";
      working = (working.slice(0, wasMatch.index) + working.slice(wasMatch.index + wasMatch[0].length))
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    const percentMatch = working.match(PERCENT_OFF);
    if (percentMatch && percentMatch.index !== undefined) {
      onSale = true;
      saleType = "percentage";
      working = (
        working.slice(0, percentMatch.index) + working.slice(percentMatch.index + percentMatch[0].length)
      )
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    if (BOGO.test(working)) {
      onSale = true;
      saleType = "bogo";
      working = working.replace(new RegExp(BOGO.source, "gi"), "").replace(/\s{2,}/g, " ").trim();
    }

    if (SALE_WORD.test(working)) {
      onSale = true;
      saleType = saleType ?? "other";
      working = working.replace(new RegExp(SALE_WORD.source, "gi"), "").replace(/\s{2,}/g, " ").trim();
    }

    // A SKU is pulled out of the name so it does not pollute the item key.
    let sku: string | undefined;
    for (const pattern of [SKU_LABELLED, ...(options.skuPatterns ?? [])]) {
      const match = working.match(pattern);
      if (match?.[1] && match.index !== undefined) {
        sku = match[1].toUpperCase();
        working = (working.slice(0, match.index) + working.slice(match.index + match[0].length))
          .replace(/\s{2,}/g, " ")
          .trim();
        break;
      }
    }

    const finish = (line: ParsedLine): void => {
      if (line.originalPriceCents !== undefined && line.originalPriceCents > line.lineTotalCents) {
        line.onSale = true;
        line.saleType = line.saleType ?? "other";
      } else {
        delete line.originalPriceCents;
      }
      out.push(line);
    };

    const dealMatch = working.match(QUANTITY_DEAL);
    if (dealMatch && dealMatch.index !== undefined) {
      const quantity = Math.max(1, parseInt(dealMatch[1]!, 10) || 1);
      const amount = toCents(dealMatch[3]);
      // "@" prices each unit; "/" prices the whole deal.
      const lineTotalCents = dealMatch[2] === "@" ? amount * quantity : amount;
      const name = working.slice(0, dealMatch.index).replace(/[\s.$]+$/, "");
      finish({
        rawText,
        name: name || working,
        quantity,
        unit: "each",
        lineTotalCents,
        unitPriceCents: perUnit(lineTotalCents, quantity),
        onSale,
        saleType,
        ...(originalPriceCents > 0 ? { originalPriceCents } : {}),
        ...(sku ? { sku } : {}),
        isTax: false,
      });
      continue;
    }

    const priceMatch = working.match(TRAILING_PRICE);
    if (priceMatch) {
      const lineTotalCents = Math.abs(toCents(priceMatch[2]));
      let name = (priceMatch[1] ?? "").replace(/[\s.]+$/, "");
      let quantity = 1;
      let unit = "each";

      // Printed weights only — never guessed.
      const unitMatch = name.match(PRINTED_UNIT);
      if (unitMatch && unitMatch.index !== undefined) {
        quantity = parseFloat(unitMatch[1]!) || 1;
        unit = unitMatch[2]!.toLowerCase().replace(/^lbs$/, "lb");
        name = name.slice(0, unitMatch.index).trim();
      }

      finish({
        rawText,
        name,
        quantity,
        unit,
        lineTotalCents,
        unitPriceCents: perUnit(lineTotalCents, quantity),
        onSale,
        saleType,
        ...(originalPriceCents > 0 ? { originalPriceCents } : {}),
        ...(sku ? { sku } : {}),
        isTax: false,
      });
      continue;
    }

    // Unreadable as a priced line. Kept at zero so a human sees it.
    finish({
      rawText,
      name: working,
      quantity: 1,
      unit: "each",
      lineTotalCents: 0,
      unitPriceCents: 0,
      onSale,
      saleType,
      ...(sku ? { sku } : {}),
      isTax: false,
    });
  }

  return out;
}
