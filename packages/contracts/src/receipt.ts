// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The receipt seam.
//
// A receipt is two things at once, and keeping them apart is the entire point
// of this file.
//
// It is a PRIVATE RECORD: this household bought these things, or this shop
// purchased this stock. That belongs to whichever host captured it and must
// never be visible to another.
//
// It is also an OBSERVATION: this merchant sold this item at this price on
// this date. That is a fact about the world, useful to everyone, and tied to
// nobody once the private half is stripped away.
//
// ReceiptIQ owns the schema for both and the boundary between them. Hosts own
// the records. The rule is enforced here rather than described: canonical
// schemas are `.strict()`, so a host that tries to smuggle a household id into
// a shared observation fails to parse rather than succeeding quietly.
//
// This mirrors a guard Family Table already runs against its shared database,
// which refuses to install if a column appears whose name could tie a row to a
// person. That guard was right; `assertNoIdentityFields` is its portable twin.
// ─────────────────────────────────────────────────────────────────────────────

// ── Ownership ────────────────────────────────────────────────────────────────

/**
 * Every persisted record carries one of these. There is no default: a record
 * whose ownership was never decided is a record that will eventually leak.
 *
 * - `canonical`     — shared knowledge. Identifies a product, a merchant, or a
 *                     price. Identifies no person, household, business or
 *                     device. Readable by any authorized consumer.
 * - `host-private`  — belongs to one host application. Family Table's receipts
 *                     are invisible to ProWorks and vice versa.
 * - `tenant-private`— belongs to one tenant within a host: a single household,
 *                     a single shop. Invisible to other tenants of that host.
 */
export const ownershipClassSchema = z.enum(["canonical", "host-private", "tenant-private"]);
export type OwnershipClass = z.infer<typeof ownershipClassSchema>;

/**
 * Words that must never appear as a field name on a canonical record.
 *
 * Matched as whole words rather than substrings. Family Table's SQL guard used
 * a substring regex, which works against snake_case column names but would
 * reject `ownership` here for containing `owner`, and `personalize` for
 * containing `person`. A guard that cries wolf gets switched off, so this one
 * tokenizes the field name first and compares word by word.
 */
export const IDENTITY_FIELD_WORDS: ReadonlySet<string> = new Set([
  "household",
  "user",
  "member",
  "person",
  "family",
  "account",
  "device",
  "email",
  "phone",
  "address",
  "postcode",
  "zip",
  "latitude",
  "longitude",
  "ip",
  "owner",
  "tenant",
  "uid",
  "ssn",
]);

/** Exact field names that are identifying even though their words are innocuous. */
const IDENTITY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "createdby",
  "submittedby",
  "capturedby",
  "authuid",
  "sub",
]);

/** Splits `householdId`, `household_id` and `HOUSEHOLD-ID` into comparable words. */
function fieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * Refuses an object that carries anything capable of identifying who observed
 * something. Descends into nested objects and arrays, because the realistic
 * failure is a host attaching `{ meta: { householdId } }` and nobody noticing
 * until the shared database already has a year of it.
 *
 * Throws rather than returning false: this is a boundary violation, not a
 * validation failure, and a caller who could ignore the result would.
 */
export function assertNoIdentityFields(value: unknown, path = "record"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoIdentityFields(entry, `${path}[${i}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const words = fieldWords(key);
    const offending = words.find((word) => IDENTITY_FIELD_WORDS.has(word));
    if (offending || IDENTITY_FIELD_NAMES.has(words.join(""))) {
      throw new Error(
        `Canonical records must not identify anyone. Found "${key}" at ${path}. ` +
          `If this is a private record, classify it as host-private or tenant-private instead.`,
      );
    }
    assertNoIdentityFields(entry, `${path}.${key}`);
  }
}

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * Money as integer minor units. Family Table's local store used floating
 * dollars and its shared database used integer cents; the shared one was
 * right, because a price that is going to be summed, compared and averaged
 * across thousands of observations cannot afford binary-fraction drift.
 */
export const moneySchema = z.object({
  cents: z.number().int(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a three-letter ISO code")
    .default("USD"),
});
export type Money = z.infer<typeof moneySchema>;

export const money = (cents: number, currency = "USD"): Money => ({
  cents: Math.round(cents),
  currency,
});

/** Converts a decimal amount as printed on a receipt into minor units. */
export const moneyFromDecimal = (amount: number, currency = "USD"): Money =>
  money(Math.round(amount * 100), currency);

export const moneyToDecimal = (m: Money): number => m.cents / 100;

/**
 * A region, no finer than a state or country subdivision: `US-CO`, `GB-SCT`.
 *
 * Deliberately coarse. Which branch someone shops at is a fact about them, not
 * about the price, and a precise enough location is an identifier no matter
 * what the surrounding column is called.
 */
export const regionCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}(-[A-Z]{2,3})?$/, "region must look like US-CO or GB — state or country, no finer");
export type RegionCode = z.infer<typeof regionCodeSchema>;

/** A normalized lookup key: lowercase, punctuation collapsed. */
export const normalizedKeySchema = z.string().min(1);

/**
 * How much to trust a value, 0–1. ReceiptIQ never discards a low-confidence
 * reading; it labels it, so a host can route it to a human instead of acting
 * on it. Family Table's tiers — 0.95 corrected, 0.7 recognized, 0.3 unknown —
 * are carried forward as the default scale.
 */
export const confidenceSchema = z.number().min(0).max(1);

export const CONFIDENCE = {
  /** A human corrected this. Nothing outranks it. */
  corrected: 0.95,
  /** Matched a known pattern or lexicon entry. */
  recognized: 0.7,
  /** Read, but unclassified. Below the review threshold. */
  unknown: 0.3,
  /** At or above this, a host may act without asking. */
  reviewThreshold: 0.5,
} as const;

// ── Canonical knowledge ──────────────────────────────────────────────────────

/**
 * A merchant as shared knowledge: a chain in a region. Never a branch, never
 * an address, never a store number.
 */
export const merchantIdentitySchema = z
  .object({
    ownership: z.literal("canonical").default("canonical"),
    /** Stable lookup key, e.g. "homedepot". */
    key: normalizedKeySchema,
    /** Display name, e.g. "Home Depot". */
    name: z.string().min(1),
    region: regionCodeSchema.optional(),
  })
  .strict();
export type MerchantIdentity = z.infer<typeof merchantIdentitySchema>;

/**
 * An item as shared knowledge. The same physical thing appears on receipts
 * under many spellings, so aliases are first-class rather than a lossy
 * rename — matching future receipts is what they are for.
 */
export const canonicalItemSchema = z
  .object({
    ownership: z.literal("canonical").default("canonical"),
    key: normalizedKeySchema,
    name: z.string().min(1),
    aliases: z.array(z.string()).default([]),
    brand: z.string().optional(),
    /** Global identifier when one is printed. The strongest match available. */
    upc: z.string().optional(),
    /** Package size, e.g. 24 with unit "oz". Drives true unit pricing. */
    packageQty: z.number().positive().optional(),
    packageUnit: z.string().optional(),
    /**
     * Classification in the taxonomy of whichever host taught it. Free text on
     * purpose: a household files a purchase under budget categories and a shop
     * files it under expense accounts, and neither taxonomy belongs in the
     * engine.
     */
    category: z.string().optional(),
    categoryConfidence: confidenceSchema.optional(),
  })
  .strict();
export type CanonicalItem = z.infer<typeof canonicalItemSchema>;

/**
 * A merchant's own identifier for an item — the thing that makes recognition
 * work across hosts.
 *
 * When Family Table scans Home Depot SKU 123456 and ProWorks later buys SKU
 * 123456 at Home Depot, this mapping is what lets ReceiptIQ say "that is
 * 1/8-inch steel flat bar" without either application seeing the other's
 * receipt.
 */
export const merchantItemRefSchema = z
  .object({
    ownership: z.literal("canonical").default("canonical"),
    merchantKey: normalizedKeySchema,
    /** The merchant's SKU, model number, or item code as printed. */
    sku: z.string().min(1),
    itemKey: normalizedKeySchema,
    /** How the mapping was established. */
    source: z.enum(["receipt", "catalog", "manual"]).default("receipt"),
    confidence: confidenceSchema.default(CONFIDENCE.recognized),
  })
  .strict();
export type MerchantItemRef = z.infer<typeof merchantItemRefSchema>;

/**
 * A price someone actually paid, stripped of who paid it.
 *
 * `.strict()` plus `assertNoIdentityFields` is the boundary: this is the only
 * shape that crosses from a host's private records into shared knowledge, and
 * it cannot carry a passenger.
 *
 * Note what is absent — no receipt id, no line id, no host name, no tenant, no
 * timestamp. `observedOn` is a date, not a time: an exact moment says when
 * someone shops, which is a behavioural fingerprint. A date does not.
 */
export const priceObservationSchema = z
  .object({
    ownership: z.literal("canonical").default("canonical"),
    itemKey: normalizedKeySchema,
    itemName: z.string().min(1),
    merchantKey: normalizedKeySchema,
    merchantName: z.string().min(1),
    region: regionCodeSchema.optional(),
    /** Price for the whole line, as paid. */
    price: moneySchema,
    quantity: z.number().positive().default(1),
    unit: z.string().default("each"),
    /** Price per unit of quantity. Derived, stored, so summaries need no math. */
    unitPrice: moneySchema,
    /**
     * Sale prices are facts but poor predictors, so they are marked rather
     * than mixed in. Estimators prefer regular prices when they have enough.
     */
    onSale: z.boolean().default(false),
    saleType: z.enum(["percentage", "fixed", "bogo", "other"]).nullable().default(null),
    /** Only when a was/regular price was actually printed. Never inferred. */
    originalPrice: moneySchema.optional(),
    observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "observedOn must be YYYY-MM-DD"),
    source: z.enum(["receipt", "shelf", "published", "manual"]).default("receipt"),
    confidence: confidenceSchema.default(0.8),
    /** Dedupe key. The same fact contributed twice must land once. */
    fingerprint: z.string().min(1),
  })
  .strict();
export type PriceObservation = z.infer<typeof priceObservationSchema>;

// ── Private records ──────────────────────────────────────────────────────────

export const receiptLineSchema = z.object({
  /** The text as printed, kept so a human can always check the reading. */
  rawText: z.string(),
  /** What ReceiptIQ believes it says. */
  name: z.string(),
  itemKey: normalizedKeySchema.optional(),
  quantity: z.number().positive().default(1),
  unit: z.string().default("each"),
  lineTotal: moneySchema,
  unitPrice: moneySchema,
  onSale: z.boolean().default(false),
  saleType: z.enum(["percentage", "fixed", "bogo", "other"]).nullable().default(null),
  originalPrice: moneySchema.optional(),
  /** Merchant SKU when the receipt prints one. */
  sku: z.string().optional(),
  /** Host taxonomy, assigned by the host's own classifier. */
  category: z.string().optional(),
  /** Tax is a receipt fact, never a product. Excluded from observations. */
  isTax: z.boolean().default(false),
  confidence: confidenceSchema.default(CONFIDENCE.unknown),
  /** True once a human has corrected this line. */
  corrected: z.boolean().default(false),
});
export type ReceiptLine = z.infer<typeof receiptLineSchema>;

export const NORMALIZED_RECEIPT_VERSION = 1;

/**
 * A receipt after extraction and normalization.
 *
 * Always private. ReceiptIQ owns this schema so both hosts read receipts the
 * same way; it does not own the instances, and no repository in this package
 * can list one host's receipts to another.
 *
 * There is deliberately no image field, at any nesting level. Family Table
 * processes receipt photos in memory and discards them, and its database has
 * no column that could hold one. Adding one here would quietly undo that.
 */
export const normalizedReceiptSchema = z.object({
  receiptVersion: z.literal(NORMALIZED_RECEIPT_VERSION).default(NORMALIZED_RECEIPT_VERSION),
  ownership: z.enum(["host-private", "tenant-private"]),
  /** Opaque to ReceiptIQ. The host resolves it; the engine only carries it. */
  ownerRef: z.string().min(1),
  merchantName: z.string(),
  merchantKey: normalizedKeySchema.optional(),
  region: regionCodeSchema.optional(),
  /** Region exactly as printed, before normalization, e.g. "Brighton, CO". */
  regionText: z.string().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z.array(receiptLineSchema).default([]),
  subtotal: moneySchema.optional(),
  tax: moneySchema.optional(),
  total: moneySchema.optional(),
  source: z.enum(["photo", "guided", "email", "manual", "import"]).default("manual"),
  /** Identity across capture methods, so one receipt cannot be saved twice. */
  fingerprint: z.string().min(1),
  /** What the extractor could not read, so a host can say so honestly. */
  warnings: z.array(z.string()).default([]),
});
export type NormalizedReceipt = z.infer<typeof normalizedReceiptSchema>;

// ── Learning ─────────────────────────────────────────────────────────────────

/**
 * A human correction, carrying what was learned and not where it came from.
 *
 * This is the split the whole design turns on. "2X4X8 SPF" means
 * "2 × 4 × 8 SPF lumber" is knowledge about the world. That a particular
 * household bought one on a Tuesday is not, and is not in this shape.
 */
export const correctionSchema = z
  .object({
    ownership: z.literal("canonical").default("canonical"),
    kind: z.enum(["item-name", "item-category", "merchant-name", "unit", "sku-mapping"]),
    /** The normalized form that was misread. */
    fromKey: normalizedKeySchema,
    /** What it should be. */
    toValue: z.string().min(1),
    /** Scopes a correction to one merchant when it only holds there. */
    merchantKey: normalizedKeySchema.optional(),
    confidence: confidenceSchema.default(CONFIDENCE.corrected),
  })
  .strict();
export type Correction = z.infer<typeof correctionSchema>;

// ── Ports ────────────────────────────────────────────────────────────────────

/** What a host hands to an extractor. Images are bytes in flight, never stored. */
export type RawReceiptInput =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: string; base64: string }
  | { kind: "image-sections"; sections: Array<{ mediaType: string; base64: string }> };

/**
 * The result of reading a receipt, before normalization. Loose on purpose:
 * this is what a model or a parser saw, not yet what ReceiptIQ believes.
 */
export interface ExtractedReceipt {
  merchant?: string;
  regionText?: string;
  date?: string;
  total?: number;
  tax?: number;
  items: Array<{
    name: string;
    /** Line total as printed, in major units. Normalization converts it. */
    price?: number;
    qty?: number;
    unit?: string;
    sku?: string;
    onSale?: boolean;
    saleType?: "percentage" | "fixed" | "bogo" | "other" | null;
    originalPrice?: number;
    isTax?: boolean;
    /** The line exactly as printed, so a human can check the reading. */
    rawText?: string;
  }>;
  warnings?: string[];
}

/**
 * Turns a raw capture into an extraction. Implemented by a host, because the
 * choice of vision model — and who pays for it — is a deployment decision.
 * ReceiptIQ ships a deterministic text extractor so the pipeline is testable
 * and usable with no AI at all.
 */
export interface ReceiptExtractor {
  readonly name: string;
  extract(input: RawReceiptInput): Promise<ExtractedReceipt> | ExtractedReceipt;
}

/**
 * Private receipts. Every method is scoped to an owner, and there is
 * deliberately no "list all" — the absence is the isolation guarantee, since
 * an API that cannot express a cross-host query cannot accidentally run one.
 */
export interface ReceiptRepository {
  save(receipt: NormalizedReceipt): Promise<void> | void;
  findByFingerprint(
    ownerRef: string,
    fingerprint: string,
  ): Promise<NormalizedReceipt | null> | NormalizedReceipt | null;
  listByOwner(ownerRef: string, limit?: number): Promise<NormalizedReceipt[]> | NormalizedReceipt[];
}

/** Canonical merchant knowledge. Shared, so reads are not owner-scoped. */
export interface MerchantKnowledgeRepository {
  findByKey(key: string): Promise<MerchantIdentity | null> | MerchantIdentity | null;
  upsert(merchant: MerchantIdentity): Promise<MerchantIdentity> | MerchantIdentity;
}

/** Canonical item knowledge, including merchant SKU mappings and corrections. */
export interface ItemKnowledgeRepository {
  findByKey(key: string): Promise<CanonicalItem | null> | CanonicalItem | null;
  findByUpc(upc: string): Promise<CanonicalItem | null> | CanonicalItem | null;
  findBySku(merchantKey: string, sku: string): Promise<CanonicalItem | null> | CanonicalItem | null;
  upsert(item: CanonicalItem): Promise<CanonicalItem> | CanonicalItem;
  linkSku(ref: MerchantItemRef): Promise<void> | void;
  recordCorrection(correction: Correction): Promise<void> | void;
  listCorrections(): Promise<Correction[]> | Correction[];
}

export interface PriceObservationQuery {
  itemKey: string;
  merchantKey?: string;
  region?: RegionCode;
  /** Only observations at least this recent. */
  sinceDate?: string;
  limit?: number;
}

/** Canonical price observations. Contributed through the boundary, never directly. */
export interface PriceObservationRepository {
  record(observation: PriceObservation): Promise<void> | void;
  query(query: PriceObservationQuery): Promise<PriceObservation[]> | PriceObservation[];
}
