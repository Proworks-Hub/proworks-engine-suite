// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The SKU spine.
//
// A product is created once, in the maker's own catalogue, and the SAME
// identifier is pushed into every channel that sells it. When an order comes
// back from a channel, the identifier is what turns a line of text into a
// product definition with a route and a cost.
//
// WHY NOT MATCH ON TITLE. Because titles are marketing copy. They get A/B
// tested, seasonally renamed, prefixed with "SALE", and translated. A matcher
// built on them works in development and degrades silently in production —
// silently, because an unmatched line looks exactly like a line for a product
// that was deleted.
//
// WHY NOT REQUIRE A UPC. A maker cutting one-off fire pits is not buying a GS1
// prefix, and a system that needs one excludes exactly the customer this is for.
//
// ONE DIRECTION. The catalogue is the source of truth; channels are mirrors.
// Bidirectional edits sound helpful and produce drift, and drift is why shops
// abandon multi-channel tools — a price edited in one place, not the other, and
// no answer to which is right.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a listing or an order came from.
 *
 * Open string rather than an enum, deliberately. A closed list means adding a
 * channel is a change to the contracts package and a version bump for every
 * consumer, to teach it a word. The channel is DATA — the engine never branches
 * on which one it is.
 */
export const channelRefSchema = z
  .object({
    /** Stable and lowercase: "etsy", "shopify", "makerops", "walk_in". */
    channel: z.string().min(1).regex(/^[a-z0-9_]+$/),
    /** Which account, for a maker with two Etsy shops. */
    accountId: z.string().min(1).optional(),
  })
  .strict();
export type ChannelRef = z.infer<typeof channelRefSchema>;

const SKU_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * An Interaxis SKU: `IX-` followed by eight characters and a check character.
 *
 * OPAQUE ON PURPOSE. A SKU that encodes material and size has to be reissued
 * when either changes, and nobody ever reissues it — so within a year the code
 * says corten and the product is aluminium. Meaning belongs in the product
 * definition, which can be edited.
 *
 * The alphabet omits I, L, O and U: the first three because they are
 * indistinguishable from 1 and 0 in most fonts, and U because it turns
 * ordinary words into unfortunate ones.
 */
export const interaxisSkuSchema = z
  .string()
  .regex(/^IX-[0-9A-HJKMNP-TV-Z]{8}[0-9A-HJKMNP-TV-Z]$/, "not an Interaxis SKU");
export type InteraxisSku = z.infer<typeof interaxisSkuSchema>;

/**
 * The check character.
 *
 * These get read down a phone, typed into an Etsy field by hand, and copied off
 * a printed work order. A transposed pair is the common error and it is
 * invisible: the wrong SKU either matches nothing, which is merely annoying, or
 * matches ANOTHER REAL PRODUCT, which ships the wrong thing. Position-weighting
 * the sum is what makes a transposition fail the check rather than pass it.
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
export function buildInteraxisSku(body: string): InteraxisSku {
  const upper = body.toUpperCase();
  if (upper.length !== 8) throw new Error("a SKU body is exactly 8 characters");
  return `IX-${upper}${checkCharacter(upper)}`;
}

/** True when the SKU is well-formed AND its check character agrees. */
export function isValidInteraxisSku(sku: string): boolean {
  if (!interaxisSkuSchema.safeParse(sku).success) return false;
  const body = sku.slice(3, 11);
  return sku[11] === checkCharacter(body);
}

/** A new SKU. `random` is injectable so tests are not a coin flip. */
export function generateInteraxisSku(random: () => number = Math.random): InteraxisSku {
  let body = "";
  for (let i = 0; i < 8; i += 1) {
    body += SKU_ALPHABET[Math.floor(random() * SKU_ALPHABET.length)]!;
  }
  return buildInteraxisSku(body);
}

/**
 * Where one product is listed, on one channel.
 *
 * `listingId` is the channel's id for the listing; `variantId` distinguishes
 * the size or colour within it. Both are stored because reconciliation runs in
 * both directions: from an order back to a product, and from a product forward
 * to the listings that need updating when its price changes.
 */
export const channelListingSchema = z
  .object({
    sku: interaxisSkuSchema,
    channel: channelRefSchema,
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
 * materials, machines and constraints live in the definition that ForgeIQ and
 * the builder read. Duplicating any of that here would create a second answer
 * to what the product is.
 */
export const catalogProductSchema = z
  .object({
    sku: interaxisSkuSchema,
    organizationId: z.string().min(1),
    name: z.string().min(1),
    /** Points at the versioned product definition. */
    productDefinitionId: z.string().min(1).optional(),
    /**
     * A configurable product needs a configuration before it can be made; a
     * fixed one is ready as it stands. This single flag is what lets the same
     * pipeline carry an ornament and a custom fire pit.
     */
    configurable: z.boolean().default(false),
    basePriceCents: z.number().int().nonnegative().optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

/**
 * Drift between the catalogue and what a channel is showing.
 *
 * Reported, never silently corrected. A shop that edited a price in Etsy did it
 * for a reason, and a tool that overwrites it without saying so is a tool they
 * stop trusting — one direction of sync is a rule about writes, not a licence
 * to clobber quietly.
 */
export interface ListingDrift {
  readonly sku: InteraxisSku;
  readonly channel: string;
  readonly listingId: string;
  readonly field: "price" | "quantity";
  readonly catalogValue: number;
  readonly channelValue: number;
}

export function detectListingDrift(
  product: CatalogProduct,
  listings: ReadonlyArray<ChannelListing>,
  availableQuantity?: number,
): ListingDrift[] {
  const drift: ListingDrift[] = [];

  for (const listing of listings) {
    if (listing.sku !== product.sku || listing.status !== "active") continue;

    if (
      product.basePriceCents !== undefined &&
      listing.listedPriceCents !== undefined &&
      listing.listedPriceCents !== product.basePriceCents
    ) {
      drift.push({
        sku: product.sku,
        channel: listing.channel.channel,
        listingId: listing.listingId,
        field: "price",
        catalogValue: product.basePriceCents,
        channelValue: listing.listedPriceCents,
      });
    }

    // Overselling is the expensive one: two channels each showing the last
    // unit, both selling it, and one customer being told after the fact.
    if (
      availableQuantity !== undefined &&
      listing.listedQuantity !== undefined &&
      listing.listedQuantity > availableQuantity
    ) {
      drift.push({
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
