/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/finishedProductPricingModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Type model for finished-product pricing — pre-configured
 *           recipes that the Cost IQ engine can recalculate cost +
 *           suggested price for whenever underlying costs change.
 *           Mirrors §12 + §16.1 of docs/COST-IQ-ENGINE-SPEC.md.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. AI tools were used strictly as coding assistants —
 * comparable to working with a hired developer — and hold no rights,
 * claim, license, or beneficial interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 */

/**
 * Layer:        Model / Types (Cost IQ engine, Phase 3)
 * Imported by:  finishedProductPricingCalculator + future UI
 * Depends on:   workstationCostModel + jobCostInputModel + pricingResultModel
 * Stability:    CANONICAL (Phase 3)
 */

import type {
  OverheadModel,
} from "./jobCostInputModel";
import type {
  MarginMode,
  PricingResult,
} from "./pricingResultModel";
import type {
  WorkstationCostProfile,
} from "./workstationCostModel";

// ---------- Recipe pieces ----------

/**
 * One material consumed PER UNIT of the finished product. The
 * calculator scales `quantityPerUnit` by the production batch
 * quantity at recalc time.
 */
export interface RecipeMaterial {
  readonly materialId: string;
  readonly name: string;
  readonly quantityPerUnit: number;
  readonly unitCost: number;
  readonly wasteFactor: number;
}

/**
 * One station the product routes through. Carries the expected
 * minutes per unit (drives Layer 3 station usage), the expected labor
 * minutes per unit (drives Layer 4 labor), and the full workstation
 * cost profile so consumables + setup + cleanup are included.
 *
 * For products with no labor at this station (e.g., a fully automated
 * cure cycle), set `laborMinutesPerUnit: 0` and `loadedLaborRate: 0`.
 */
export interface RecipeStation {
  readonly stationId: string;
  readonly profile: WorkstationCostProfile;
  readonly minutesPerUnit: number;
  readonly laborMinutesPerUnit: number;
  readonly loadedLaborRatePerMinute: number;
}

/**
 * The complete production recipe for a finished product. Everything
 * needed to drive the cost calculator — given a quantity, the recipe
 * scales material quantities + station/labor minutes accordingly.
 */
export interface FinishedProductRecipe {
  readonly materials: ReadonlyArray<RecipeMaterial>;
  readonly stations: ReadonlyArray<RecipeStation>;
  readonly overhead: OverheadModel;
}

// ---------- Pricing record ----------

/**
 * Catalog record for a sellable finished product. Combines the
 * recipe (what it costs to make) with the pricing target (how much
 * margin the shop wants), the operator-approved sell price, and a
 * manual-override flag.
 *
 * `liveSuggestedPrice` and `lastRecalculatedAt` are MUTABLE state
 * the recalculator updates. The rest is shop-config the operator
 * edits in the finished-product UI (Phase 3 PR 3).
 */
export interface FinishedProductPricingRecord {
  readonly productId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly sku: string | null;
  readonly recipe: FinishedProductRecipe;
  readonly target: { readonly mode: MarginMode; readonly percent: number };
  /** Floor below which the suggested price is clamped up. Null = no minimum. */
  readonly minimumPrice: number | null;
  /** What the shop currently sells the product for. Null = never approved yet. */
  readonly approvedSellPrice: number | null;
  /**
   * When true, the recalculator skips price computation and reports
   * the approvedSellPrice as the live suggestion. Operator has
   * explicitly chosen to lock the price; cost changes don't disturb it.
   */
  readonly manualOverride: boolean;
  readonly liveSuggestedPrice: number | null;
  readonly lastRecalculatedAt: string | null;
}

// ---------- Price status ----------

/**
 * Operational status flag the UI surfaces in finished-product lists,
 * dashboards, and the review queue. Mirrors §5.6 of the spec.
 *
 *   current                  — recalculated; suggested price ≈ approved price.
 *                              Nothing for the operator to do.
 *   review_needed            — suggested price drifted from approved by
 *                              more than the review threshold (could be up
 *                              OR down). Operator should look.
 *   cost_increased           — costs went up enough that the suggested
 *                              price is materially HIGHER than the approved
 *                              price. Shop is leaving money on the table at
 *                              the current sell price.
 *   margin_dropped           — at the current approved sell price, the
 *                              realized margin is materially BELOW target.
 *                              Either the shop is losing margin or the
 *                              target moved.
 *   manual_override_active   — operator has explicitly locked the price.
 *                              Cost / margin alerts are suppressed; nothing
 *                              auto-triggers a review.
 *
 * Precedence (most specific wins):
 *   manual_override_active → cost_increased → margin_dropped → review_needed → current
 */
export type PriceStatus =
  | "current"
  | "review_needed"
  | "cost_increased"
  | "margin_dropped"
  | "manual_override_active";

/**
 * Tunable thresholds for status derivation. Defaults match common
 * shop-floor sensibility — small drifts are noise, larger ones warrant
 * review. Future PRs can wire these into a per-shop config.
 */
export interface PriceStatusThresholds {
  /**
   * Suggested price must exceed approved price by AT LEAST this fraction
   * before `cost_increased` fires. 0.05 = 5%.
   */
  readonly costIncreaseThreshold: number;
  /**
   * Realized margin at the approved price must be BELOW
   * `target × (1 - marginDropThreshold)` before `margin_dropped` fires.
   * 0.10 = 10% relative drop.
   */
  readonly marginDropThreshold: number;
  /**
   * Absolute fractional difference between suggested and approved
   * before `review_needed` fires (in either direction). 0.05 = 5%.
   */
  readonly reviewThreshold: number;
}

export const DEFAULT_PRICE_STATUS_THRESHOLDS: PriceStatusThresholds = Object.freeze({
  costIncreaseThreshold: 0.05,
  marginDropThreshold: 0.1,
  reviewThreshold: 0.05,
});

// ---------- Recalc result ----------

/**
 * Output of `recalculateFinishedProductPricing`. Carries the full
 * pricing result for the recalculated batch, a `priceDelta` field
 * comparing the new suggestion to the operator-approved price (null
 * when no approved price exists yet), the `priceStatus` flag for
 * UI surfacing, and a `manualOverrideHonored` boolean.
 */
export interface FinishedProductRecalcResult {
  readonly productId: string;
  readonly tenantId: string;
  readonly recalculatedAt: string;
  readonly batchQuantity: number;
  readonly pricing: PricingResult;
  /**
   * `pricing.suggestedPrice − approvedSellPrice` (positive = costs
   * went up, suggestion is higher than approved). Null when there
   * is no approvedSellPrice to compare against.
   */
  readonly priceDelta: number | null;
  /**
   * Operational flag for review queues + dashboards. Derived from
   * (manualOverride, suggested vs approved, realized margin vs target).
   */
  readonly priceStatus: PriceStatus;
  /**
   * True when the recalculator emitted the approvedSellPrice instead
   * of computing a fresh suggestion (i.e., manualOverride was on).
   */
  readonly manualOverrideHonored: boolean;
}
