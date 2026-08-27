// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { salesChannelSchema, productSkuSchema } from "./catalog.js";
// ReceiptIQ already defined money for the suite, and one money type is the
// point of having contracts at all. A second one here would differ in some
// detail nobody noticed until two of them met in the same calculation.
import { moneySchema } from "./receipt.js";

// ─────────────────────────────────────────────────────────────────────────────
// An order that arrived from somewhere else.
//
// THE CHANNEL DOES NOT MATTER. THE CONTRACT DOES.
//
// Etsy, Shopify, a phone call written into an admin form, a spreadsheet from a
// wholesale customer — each has its own vocabulary, and every one of them is a
// host adapter's problem. By the time an order reaches an engine it looks like
// this, and nothing downstream contains the word "Etsy".
//
// That is the ReceiptIQ pattern, reused deliberately: a messy external artifact
// is normalized once, at the edge, by something that knows about that specific
// mess. What survives is clean and channel-free.
//
// This is the CANONICAL order boundary, and it is not named for a company or a
// host. The contract belongs to the ecosystem: every host and every engine
// reads the same shape regardless of who owns the business or which
// application happens to be in front of it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One line of an external order, as the channel described it.
 *
 * Everything except quantity is optional, because channels genuinely omit
 * things and an over-strict schema turns a recoverable gap into a rejected
 * order. Rejecting an order the customer has already paid for is the worst
 * available outcome.
 */
export const externalOrderLineSchema = z
  .object({
    /** The channel's own id for this line, for idempotent re-reads. */
    externalLineId: z.string().min(1),
    /** What the channel showed the buyer. Kept for humans, never matched on. */
    title: z.string().optional(),
    /** The channel's SKU field. Where a canonical product SKU comes back to us. */
    sku: z.string().optional(),
    listingId: z.string().optional(),
    variantId: z.string().optional(),
    quantity: z.number().int().positive(),
    unitPrice: moneySchema.optional(),
    /**
     * Buyer-supplied personalization: engraving text, a name, a colour note.
     *
     * The single most important field on a custom order and the one most often
     * lost, because it arrives as an unstructured note rather than an option.
     */
    personalization: z.string().optional(),
    /** Structured options where the channel had them. */
    selections: z.record(z.string()).optional(),
  })
  .strict();
export type ExternalOrderLine = z.infer<typeof externalOrderLineSchema>;

/**
 * The buyer, as much as the channel will say.
 *
 * Marketplaces withhold a real email behind a relay and often give no address
 * until the order ships. All optional, so the pipeline does not stall on
 * something the channel was never going to provide.
 */
export const externalBuyerSchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    /** Free-form, because address shapes are not universal. */
    shipTo: z.record(z.string()).optional(),
  })
  .strict();
export type ExternalBuyer = z.infer<typeof externalBuyerSchema>;

export const externalOrderSchema = z
  .object({
    channel: salesChannelSchema,
    /**
     * The channel's order id. Half of the idempotency key, and the reason the
     * same order can be pulled a hundred times safely.
     */
    externalOrderId: z.string().min(1),
    organizationId: z.string().min(1),
    /** What the buyer sees. Etsy's receipt number, Shopify's #1042. */
    externalOrderNumber: z.string().optional(),
    placedAt: z.string().datetime(),
    buyer: externalBuyerSchema.optional(),
    lines: z.array(externalOrderLineSchema).min(1),
    orderTotal: moneySchema.optional(),
    /** Whether the channel says it has been paid for. */
    paid: z.boolean().optional(),
    requestedShipBy: z.string().datetime().optional(),
    buyerNote: z.string().optional(),
  })
  .strict();
export type ExternalOrder = z.infer<typeof externalOrderSchema>;

// ---------- Normalized ----------

/**
 * Why a line could not be matched to a product.
 *
 * Named rather than a boolean, because the fix differs for each and the person
 * who has to act on it needs to know which one it is.
 */
export const lineMatchFailureSchema = z.enum([
  /** No SKU field at all — the listing was created outside the catalogue. */
  "no_sku",
  /** A SKU was present but is not ours. */
  "foreign_sku",
  /** Shaped like ours, but the check character disagrees — a typo. */
  "malformed_sku",
  /** Ours and well-formed, but no product carries it. */
  "unknown_sku",
  /** The product exists but belongs to another organization. */
  "wrong_organization",
  /** The product exists and has been retired. */
  "inactive_product",
]);
export type LineMatchFailure = z.infer<typeof lineMatchFailureSchema>;

export const normalizedOrderLineSchema = z
  .object({
    externalLineId: z.string().min(1),
    quantity: z.number().int().positive(),
    unitPrice: moneySchema.optional(),
    /**
     * The durable product id, present when the line matched.
     *
     * This is what downstream work references. The SKU is kept beside it for
     * humans and for reconciliation with the channel, but a work order built
     * against a business identifier detaches the day somebody reissues one.
     */
    productId: z.string().optional(),
    /** Present when the line matched. The business identifier. */
    sku: productSkuSchema.optional(),
    productDefinitionId: z.string().optional(),
    /**
     * True when the product needs a configuration before it can be made.
     *
     * The flag that lets one pipeline carry both an ornament and a fire pit:
     * a fixed SKU is ready to route, a configurable one needs its options
     * resolved first.
     */
    configurable: z.boolean().default(false),
    /** Absent when the line matched. */
    matchFailure: lineMatchFailureSchema.optional(),
    /** Never dropped, however the match went. Someone must read this. */
    personalization: z.string().optional(),
    selections: z.record(z.string()).optional(),
    /** The channel's own words, for the human resolving a failed match. */
    sourceTitle: z.string().optional(),
    sourceSku: z.string().optional(),
  })
  .strict();
export type NormalizedOrderLine = z.infer<typeof normalizedOrderLineSchema>;

export const normalizedOrderSchema = z
  .object({
    orderVersion: z.literal(1),
    /** Our id for this order, stable across re-reads of the same external one. */
    orderRef: z.string().min(1),
    organizationId: z.string().min(1),
    channel: salesChannelSchema,
    externalOrderId: z.string().min(1),
    externalOrderNumber: z.string().optional(),
    placedAt: z.string().datetime(),
    ingestedAt: z.string().datetime(),
    buyer: externalBuyerSchema.optional(),
    lines: z.array(normalizedOrderLineSchema).min(1),
    orderTotal: moneySchema.optional(),
    paid: z.boolean().optional(),
    requestedShipBy: z.string().datetime().optional(),
    buyerNote: z.string().optional(),
    /**
     * True when every line matched a product.
     *
     * An order with unmatched lines is still INGESTED — it is a real order a
     * customer paid for. It simply cannot be routed until a human maps the
     * lines, and this flag is what a queue filters on.
     */
    fullyMatched: z.boolean(),
  })
  .strict();
export type NormalizedOrder = z.infer<typeof normalizedOrderSchema>;

export const ORDER_CONTRACT_VERSION = 1 as const;

export function validateExternalOrder(input: unknown): ExternalOrder {
  return externalOrderSchema.parse(input);
}

export function validateNormalizedOrder(input: unknown): NormalizedOrder {
  return normalizedOrderSchema.parse(input);
}

/**
 * The idempotency key: channel, account and the channel's own order id.
 *
 * The account is in there because two Etsy shops under one organization can
 * both mint an order numbered 1001, and a key without it silently drops the
 * second shop's order as a duplicate of the first.
 */
export function externalOrderKey(
  channel: { channel: string; accountId?: string },
  externalOrderId: string,
): string {
  return `${channel.channel}::${channel.accountId ?? "default"}::${externalOrderId}`;
}
