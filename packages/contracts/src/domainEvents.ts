// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { moneySchema, priceObservationSchema } from "./receipt.js";

// ─────────────────────────────────────────────────────────────────────────────
// The first domain events.
//
// Five, not fifty. The directive is explicit that not every method should
// become an event, and it is right: an event is a public contract, and a
// vocabulary nobody has needed yet is a vocabulary that will be wrong.
//
// These five are the ones that already have a real consumer waiting, or that
// close a loop the ecosystem was built for. Everything else waits until
// something needs it.
//
// Each payload is versioned independently of the envelope. Add fields freely;
// cut a new version rather than changing what an existing field means.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The registry. Consumers subscribe by these constants rather than by string
 * literals, so a rename is a compile error instead of a subscription that
 * silently stops matching.
 */
export const EVENT_TYPES = {
  /** ForgeIQ worked out how something can be made. */
  manufacturingPlanGenerated: "manufacturing.plan.generated",
  /** CostIQ priced a plan, or a job. */
  costCalculationCompleted: "cost.calculation.completed",
  /** A receipt was captured and read, but not yet normalized. */
  receiptIngested: "receipt.ingested",
  /** A receipt became a structured, private record. */
  receiptNormalized: "receipt.normalized",
  /**
   * Someone bought a material. The event that closes the loop the ecosystem
   * was built for: a receipt scanned in one application becomes a real cost
   * basis in another, with neither able to see the other's records.
   */
  materialPurchaseDetected: "material.purchase.detected",
} as const;

export type PlatformEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

// ── manufacturing.plan.generated ─────────────────────────────────────────────

export const manufacturingPlanGeneratedV1 = z
  .object({
    productSlug: z.string().min(1),
    configurationId: z.union([z.string(), z.number()]).optional(),
    quantity: z.number().int().positive(),
    /** Counts, not the plan. A consumer that needs the plan fetches it. */
    partCount: z.number().int().nonnegative(),
    operationCount: z.number().int().nonnegative(),
    /** Whether ForgeIQ believes this can actually be made. */
    manufacturable: z.boolean(),
  })
  .strict();
export type ManufacturingPlanGeneratedV1 = z.infer<typeof manufacturingPlanGeneratedV1>;

// ── cost.calculation.completed ───────────────────────────────────────────────

export const costCalculationCompletedV1 = z
  .object({
    engine: z.string().min(1),
    subject: z.string().min(1),
    totalCost: moneySchema,
    recommendedPrice: moneySchema.optional(),
    /**
     * Carried deliberately. A cost with unpriced items is a floor, not a
     * total, and a consumer acting on it should know that without re-deriving
     * it.
     */
    unpricedCount: z.number().int().nonnegative().default(0),
    assumptionCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type CostCalculationCompletedV1 = z.infer<typeof costCalculationCompletedV1>;

// ── receipt.ingested ─────────────────────────────────────────────────────────

export const receiptIngestedV1 = z
  .object({
    /** Identity of the receipt, so redelivery and re-capture both dedupe. */
    fingerprint: z.string().min(1),
    source: z.enum(["photo", "guided", "email", "manual", "import"]),
    /** Which extractor read it — the deterministic one, or a host's model. */
    extractor: z.string().min(1),
    lineCount: z.number().int().nonnegative(),
  })
  .strict();
export type ReceiptIngestedV1 = z.infer<typeof receiptIngestedV1>;

// ── receipt.normalized ───────────────────────────────────────────────────────

export const receiptNormalizedV1 = z
  .object({
    fingerprint: z.string().min(1),
    merchantKey: z.string().min(1),
    merchantName: z.string().min(1),
    purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lineCount: z.number().int().nonnegative(),
    total: moneySchema.optional(),
    /** Lines a human should look at. Non-zero means do not act automatically. */
    needsReviewCount: z.number().int().nonnegative().default(0),
  })
  .strict();
export type ReceiptNormalizedV1 = z.infer<typeof receiptNormalizedV1>;

// ── material.purchase.detected ───────────────────────────────────────────────

/**
 * The one that closes the loop.
 *
 * Note what the payload is: a `PriceObservation`, which is canonical by
 * construction and cannot carry an identifier — the schema is `.strict()` and
 * the guard refuses anything named like one. So this event is publishable with
 * NO tenant on the envelope, and a consumer learns the price without learning
 * who paid it.
 *
 * That is the property that lets a household's receipt improve a fabrication
 * shop's cost basis while neither can see the other's records.
 */
export const materialPurchaseDetectedV1 = z
  .object({
    observation: priceObservationSchema,
    /** Set only when the publishing host mapped it to something it owns. */
    hostMaterialRef: z.string().min(1).optional(),
  })
  .strict();
export type MaterialPurchaseDetectedV1 = z.infer<typeof materialPurchaseDetectedV1>;

/** Payload schemas by event type and version, for validation at the boundary. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [EVENT_TYPES.manufacturingPlanGenerated]: { 1: manufacturingPlanGeneratedV1 },
  [EVENT_TYPES.costCalculationCompleted]: { 1: costCalculationCompletedV1 },
  [EVENT_TYPES.receiptIngested]: { 1: receiptIngestedV1 },
  [EVENT_TYPES.receiptNormalized]: { 1: receiptNormalizedV1 },
  [EVENT_TYPES.materialPurchaseDetected]: { 1: materialPurchaseDetectedV1 },
} as const;

/**
 * Events whose payload is canonical knowledge, and which therefore must be
 * published WITHOUT a tenant.
 *
 * Kept as data so the bus can enforce it rather than relying on every
 * publisher remembering.
 */
export const CANONICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  EVENT_TYPES.materialPurchaseDetected,
]);
