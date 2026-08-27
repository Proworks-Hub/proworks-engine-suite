// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ExtractedReceipt, RawReceiptInput, ReceiptExtractor } from "@proworks-hub/contracts";
import { parseReceiptLines } from "../normalize/parseReceiptLines.js";

// ─────────────────────────────────────────────────────────────────────────────
// The deterministic text extractor.
//
// ReceiptIQ ships this so the pipeline can be exercised, tested and used with
// no AI provider, no API key and no network. Family Table's receipt features
// are all gated behind "turn AI on and add your Claude API key", which means
// its receipt pipeline cannot be tested without one — and a pipeline that
// cannot run offline cannot be trusted to behave the same way twice.
//
// This handles typed and pasted receipts, which is the manual path Family
// Table's own adapter registry describes as "always works, no AI needed".
// Images go to a host-supplied extractor through the ReceiptExtractor port.
// ─────────────────────────────────────────────────────────────────────────────

const DATE_PATTERNS: ReadonlyArray<{ pattern: RegExp; order: "ymd" | "mdy" }> = [
  { pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/, order: "ymd" },
  { pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/, order: "mdy" },
  { pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/, order: "mdy" },
];

const pad = (value: string): string => value.padStart(2, "0");

/** Finds a purchase date, or returns undefined rather than assuming today. */
export function findDate(text: string): string | undefined {
  for (const { pattern, order } of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (order === "ymd") return `${match[1]}-${match[2]}-${match[3]}`;
    const year = match[3]!.length === 2 ? `20${match[3]}` : match[3]!;
    return `${year}-${pad(match[1]!)}-${pad(match[2]!)}`;
  }
  return undefined;
}

const amountFrom = (line: string): number | undefined => {
  const match = line.match(/(-?\d+[.,]?\d{0,2})\s*$/);
  if (!match) return undefined;
  const value = parseFloat(match[1]!.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Reads a receipt printed as text.
 *
 * The merchant is taken from the first line that is not a price, a date or a
 * street address — which is where nearly every receipt prints it. When that
 * heuristic fails the merchant comes back undefined rather than wrong, and the
 * host can ask; a receipt filed under the wrong shop corrupts every price
 * comparison that shop is part of.
 */
export function extractFromText(text: string): ExtractedReceipt {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const warnings: string[] = [];

  let merchant: string | undefined;
  let regionText: string | undefined;

  for (const [index, line] of lines.slice(0, 6).entries()) {
    if (/\d+[.,]\d{2}\s*$/.test(line)) continue;
    if (findDate(line)) continue;
    if (/^\d+\s+\w/.test(line)) continue; // street address
    if (!merchant) {
      merchant = line;
      // A city/state line usually sits directly beneath the shop name.
      const next = lines[index + 1];
      if (next && /[A-Za-z]+,?\s+[A-Z]{2}\b/.test(next) && !/\d+[.,]\d{2}/.test(next)) {
        regionText = next;
      }
      break;
    }
  }

  if (!merchant) warnings.push("merchant could not be read from the text");

  const date = findDate(text);
  if (!date) warnings.push("no purchase date found in the text");

  let total: number | undefined;
  let tax: number | undefined;
  const body: string[] = [];

  for (const line of lines) {
    if (/^(grand\s+)?total\b/i.test(line)) {
      total = total ?? amountFrom(line);
      continue;
    }
    if (/^sub\s*total\b/i.test(line)) continue;
    if (/^(?:sales\s+)?tax\b/i.test(line)) {
      tax = tax ?? amountFrom(line);
      // Kept in the body too: the line parser records tax as a receipt fact.
      body.push(line);
      continue;
    }
    if (line === merchant || line === regionText) continue;
    if (findDate(line) && !/\d+[.,]\d{2}\s*$/.test(line)) continue;
    body.push(line);
  }

  // The line parser owns line structure, here and on every other capture path,
  // so there is exactly one implementation of what a receipt line means.
  const items = parseReceiptLines(body.join("\n")).map((line) => ({
    name: line.name,
    price: line.lineTotalCents / 100,
    qty: line.quantity,
    unit: line.unit,
    onSale: line.onSale,
    saleType: line.saleType,
    isTax: line.isTax,
    rawText: line.rawText,
    ...(line.sku ? { sku: line.sku } : {}),
    ...(line.originalPriceCents !== undefined
      ? { originalPrice: line.originalPriceCents / 100 }
      : {}),
  }));

  if (items.length === 0) warnings.push("no priced lines were found in the text");

  return {
    ...(merchant ? { merchant } : {}),
    ...(regionText ? { regionText } : {}),
    ...(date ? { date } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(tax !== undefined ? { tax } : {}),
    items,
    warnings,
  };
}

/**
 * The built-in extractor. Handles text and pasted e-receipts; refuses images,
 * because pretending to read one would be worse than saying it cannot.
 */
export const textExtractor: ReceiptExtractor = {
  name: "receiptiq-text",
  extract(input: RawReceiptInput): ExtractedReceipt {
    if (input.kind !== "text") {
      throw new Error(
        `The built-in extractor reads text only, and was given "${input.kind}". ` +
          `Supply a host ReceiptExtractor that can read images.`,
      );
    }
    return extractFromText(input.text);
  },
};
