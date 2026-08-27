// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical product identity — the SKU spine.
//
// A product is created once, in the maker's own catalogue, and the SAME
// identifier is pushed into every channel that sells it. When an order comes
// back from a channel, that identifier is what turns a line of text into a
// product definition with a route and a cost.
//
// NOTHING HERE IS NAMED FOR A COMPANY OR AN APPLICATION.
//
// An earlier draft called these "Interaxis" types. That was wrong: Interaxis is
// the company that owns the software, not a layer requests pass through, and a
// contract named after it would make every consumer depend on a corporate
// identity just to describe a product. The same argument rules out naming them
// for ProWorks or MakerOps — a portable engine must not require whichever host
// happens to ship first.
//
// WHY NOT MATCH ON TITLE. Titles are marketing copy. They get A/B tested,
// seasonally renamed, prefixed with "SALE", and translated. A matcher built on
// them works in development and degrades silently in production — silently,
// because an unmatched line looks exactly like a line for a deleted product.
//
// WHY NOT REQUIRE A UPC. A maker cutting one-off fire pits is not buying a GS1
// prefix, and a system that needs one excludes exactly the customer this is for.
//
// ONE DIRECTION. The catalogue is the source of truth; channels are mirrors.
// WHICH HOST edits the catalogue is a product decision — MakerOps, KSix, or
// something later — and deliberately not encoded here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a listing or an order came from.
 *
 * An open string rather than an enum, deliberately. A closed list makes adding
 * a marketplace a change to the contracts package and a version bump for every
 * consumer, in order to teach it a word. The channel is DATA — nothing in any
 * engine branches on which one it is.
 */
export const salesChannelSchema = z
  .object({
    /** Stable and lowercase: "etsy", "shopify", "ksix", "makerops", "walk_in". */
    channel: z.string().min(1).regex(/^[a-z0-9_]+$/),
    /** Which account, for a maker with two Etsy shops. */
    accountId: z.string().min(1).optional(),
  })
  .strict();
export type SalesChannel = z.infer<typeof salesChannelSchema>;

const SKU_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The prefix that marks a SKU as one of ours when a channel hands it back. */
export const SKU_PREFIX = "SKU-";

/**
 * A canonical product SKU: `SKU-`, eight characters, then a check character.
 *
 * OPAQUE ON PURPOSE. A SKU that encodes material and size has to be reissued
 * whenever either changes, and nobody ever reissues it — so within a year the
 * code says corten and the product is aluminium. Meaning belongs in the
 * ProductDefinition, which can be edited.
 *
 * The alphabet omits I, L, O and U: the first three because they are
 * indistinguishable from 1 and 0 in most fonts, and U because it turns ordinary
 * codes into unfortunate words.
 */
export const productSkuSchema = z
  .string()
  .regex(/^SKU-[0-9A-HJKMNP-TV-Z]{8}[0-9A-HJKMNP-TV-Z]$/, "not a canonical product SKU");
export type ProductSku = z.infer<typeof productSkuSchema>;

/**
 * The check character.
 *
 * These get read down a phone, typed into a channel field by hand, and copied
 * off a printed work order. A transposed pair is the common error and it is
 * invisible: the wrong SKU either matches nothing, which is merely annoying, or
 * matches ANOTHER REAL PRODUCT, which ships the wrong thing. Weighting the sum
 * by position is what makes a transposition fail the check rather than pass it.
 */
function checkCharacter(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const value = SKU_ALPHABET.indexOf(body[i]!);
    if (value < 0) throw new Error(`character "${body[i]}" is not valid in a SKU`);
    sum += value * (i + 2);
  }
  return SKU_ALPHABET[sum % SKU_ALPHABET.length]!;
}

/** Builds a SKU from eight body characters, appending the check character. */
export function buildProductSku(body: string): ProductSku {
  const upper = body.toUpperCase();
  if (upper.length !== 8) throw new Error("a SKU body is exactly 8 characters");
  return `${SKU_PREFIX}${upper}${checkCharacter(upper)}`;
}

/** True when the SKU is well-formed AND its check character agrees. */
export function isValidProductSku(sku: string): boolean {
  if (!productSkuSchema.safeParse(sku).success) return false;
  const body = sku.slice(SKU_PREFIX.length, SKU_PREFIX.length + 8);
  return sku[SKU_PREFIX.length + 8] === checkCharacter(body);
}

/** A new SKU. `random` is injectable so tests are not a coin flip. */
export function generateProductSku(random: () => number = Math.random): ProductSku {
  let body = "";
  for (let i = 0; i < 8; i += 1) {
    body += SKU_ALPHABET[Math.floor(random() * SKU_ALPHABET.length)]!;
  }
  return buildProductSku(body);
}

/**
 * Where one product is listed, on one channel.
 *
 * `listingId` is the channel's id for the listing; `variantId` distinguishes
 * size or colour within it. Both are stored because reconciliation runs both
 * ways: from an order back to a product, and from a product forward to the
 * listings that need updating when its price changes.
 */
export const channelListingSchema = z
  .object({
    /**
     * The durable internal id. This is what a listing is ABOUT.
     *
     * A SKU can be reissued — a product renumbered, a catalogue migrated,
     * somebody fixing a mistake — and a listing keyed only on the SKU silently
     * detaches when that happens.
     */
    productId: z.string().min(1),
    /** The business identifier, as pushed into the channel's own SKU field. */
    sku: productSkuSchema,
    channel: salesChannelSchema,
    listingId: z.string().min(1),
    variantId: z.string().optional(),
    /** What the channel is currently showing, for drift detection. */
    listedPriceCents: z.number().int().nonnegative().optional(),
    listedQuantity: z.number().int().nonnegative().optional(),
    lastSyncedAt: z.string().datetime().optional(),
    status: z.enum(["active", "draft", "ended", "error"]).default("active"),
  })
  .strict();
export type ChannelListing = z.infer<typeof channelListingSchema>;

/**
 * A product as the catalogue knows it.
 *
 * Deliberately thin. This is the ANCHOR, not the product definition — options,
 * materials, machines and constraints live in the ProductDefinition that
 * ForgeIQ consumes. Duplicating any of that here would create a second answer
 * to what the product is, and ForgeIQ owns that question.
 *
 * TWO IDENTIFIERS, ON PURPOSE. `productId` is durable and internal: everything
 * references it and it never changes. `sku` is a BUSINESS identifier —
 * printed, spoken, typed into a channel field, occasionally reissued. Using the
 * SKU as the key works right up until somebody renumbers a product, at which
 * point every listing and every historical order quietly detaches.
 *
 * SKU UNIQUENESS IS SCOPED PER ORGANIZATION, not globally. Two tenants may
 * legitimately mint the same code, and a global constraint would let one shop's
 * catalogue collide with another's for a reason neither could see.
 */
export const canonicalProductSchema = z
  .object({
    /** Durable, internal, referenced by everything. */
    productId: z.string().min(1),
    /** Business identifier. Unique within the organization, not globally. */
    sku: productSkuSchema,
    organizationId: z.string().min(1),
    name: z.string().min(1),
    /** Points at the versioned ProductDefinition that ForgeIQ consumes. */
    productDefinitionId: z.string().min(1).optional(),
    /**
     * Whether a customer must configure this before it can be made.
     *
     * The one flag that lets a stock ornament and a custom fire pit travel the
     * same pipeline. A fixed SKU does NOT get a synthetic empty configuration
     * invented for it — it simply skips the configuration step, and everything
     * downstream is identical.
     */
    configurable: z.boolean().default(false),
    basePriceCents: z.number().int().nonnegative().optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type CanonicalProduct = z.infer<typeof canonicalProductSchema>;

/**
 * Drift between the catalogue and what a channel is showing.
 *
 * Reported, never silently corrected. A shop that edited a price in a channel
 * did it for a reason, and a tool that overwrites it without saying so is a
 * tool they stop trusting. One-way sync is a rule about writes, not a licence
 * to clobber quietly.
 */
export interface ListingDrift {
  readonly productId: string;
  readonly sku: ProductSku;
  readonly channel: string;
  readonly listingId: string;
  readonly field: "price" | "quantity";
  readonly catalogValue: number;
  readonly channelValue: number;
}

export function detectListingDrift(
  product: CanonicalProduct,
  listings: ReadonlyArray<ChannelListing>,
  availableQuantity?: number,
): ListingDrift[] {
  const drift: ListingDrift[] = [];

  for (const listing of listings) {
    // Matched on the durable id, not the SKU, for the reason given above.
    if (listing.productId !== product.productId || listing.status !== "active") continue;

    if (
      product.basePriceCents !== undefined &&
      listing.listedPriceCents !== undefined &&
      listing.listedPriceCents !== product.basePriceCents
    ) {
      drift.push({
        productId: product.productId,
        sku: product.sku,
        channel: listing.channel.channel,
        listingId: listing.listingId,
        field: "price",
        catalogValue: product.basePriceCents,
        channelValue: listing.listedPriceCents,
      });
    }

    // Overselling is the expensive one: two channels each showing the last
    // unit, both selling it, and one customer told after the fact.
    if (
      availableQuantity !== undefined &&
      listing.listedQuantity !== undefined &&
      listing.listedQuantity > availableQuantity
    ) {
      drift.push({
        productId: product.productId,
        sku: product.sku,
        channel: listing.channel.channel,
        listingId: listing.listingId,
        field: "quantity",
        catalogValue: availableQuantity,
        channelValue: listing.listedQuantity,
      });
    }
  }

  return drift;
}
