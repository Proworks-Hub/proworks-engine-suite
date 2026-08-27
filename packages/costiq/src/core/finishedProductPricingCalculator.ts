/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/finishedProductPricingCalculator.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Recalculate cost + suggested price for a finished-product
 *           recipe at a given production batch quantity. Pure
 *           function: scales the recipe to the requested quantity,
 *           builds a JobCostInput, runs the pricing engine,
 *           applies minimumPrice + manualOverride, and reports the
 *           delta vs. the operator-approved sell price.
 *
 *           Phase 3 PR 1 of docs/COST-IQ-ENGINE-SPEC.md.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. AI tools (Cursor, Claude, Codex, ChatGPT, Perplexity)
 * were used strictly as coding assistants — comparable to working with
 * a hired developer — and hold no rights, claim, license, or beneficial
 * interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 */

/**
 * Layer:        Pure calculator (Cost IQ engine, Phase 3 entry point)
 * Imported by:  Future finished-product UI + price-recalc background jobs
 * Depends on:   pricingEngine + jobCostInputModel + finishedProductPricingModel
 * Stability:    CANONICAL (Phase 3)
 *
 * Algorithm overview
 * ------------------
 *   1. If `manualOverride` is true → emit a result that mirrors the
 *      approved price (no math), set `manualOverrideHonored: true`.
 *   2. Otherwise, scale the recipe to `batchQuantity`:
 *        - materials: quantityPerUnit × batchQuantity
 *        - station minutes: minutesPerUnit × batchQuantity
 *        - labor minutes: laborMinutesPerUnit × batchQuantity
 *      Build a JobCostInput from the scaled values + the recipe's
 *      overhead model.
 *   3. Run `calculateJobPricing(input, target)` to produce a complete
 *      PricingResult.
 *   4. If `minimumPrice` is set and the suggested price is below the
 *      floor, swap in the floor as the suggested price (and recompute
 *      gross profit / margin from the clamped value).
 *   5. Report the delta vs. `approvedSellPrice` (null when no
 *      approval has happened yet).
 *
 * Determinism + purity
 * --------------------
 * Same inputs always produce the same output (modulo the clock dep
 * which defaults to wall-clock for the recalculatedAt timestamp).
 * No I/O, no fetches, no service calls.
 *
 * Defensive behaviors
 * -------------------
 * - `batchQuantity <= 0` is treated as 1 (matches the rest of the
 *   engine — "you can't price zero units").
 * - Empty materials / stations produce zero contribution to those
 *   layers and yield a near-zero suggested price (just overhead).
 * - When `manualOverride` is true and `approvedSellPrice` is null,
 *   the override is honored but the result emits a zero suggested
 *   price with a note in the log — the operator hasn't actually set
 *   a price yet, so there's nothing to honor.
 */

import { calculateJobPricing } from "./pricingEngine";
import type {
  JobCostInput,
  LaborTime,
  MaterialUsage,
  WorkstationUsage,
} from "../models/jobCostInputModel";
import {
  DEFAULT_PRICE_STATUS_THRESHOLDS,
  type FinishedProductPricingRecord,
  type FinishedProductRecalcResult,
  type PriceStatus,
  type PriceStatusThresholds,
  type RecipeMaterial,
  type RecipeStation,
} from "../models/finishedProductPricingModel";
import type { MarginMode, PricingResult } from "../models/pricingResultModel";

export interface RecalculateFinishedProductPricingDeps {
  readonly now?: () => Date;
  /**
   * Override the default thresholds used to derive `priceStatus`.
   * Any subset is accepted; missing fields fall back to
   * `DEFAULT_PRICE_STATUS_THRESHOLDS`.
   */
  readonly statusThresholds?: Partial<PriceStatusThresholds>;
}

/**
 * Recalculate cost + suggested price for one finished product at
 * the given batch quantity. Pure (modulo the clock dep).
 */
export function recalculateFinishedProductPricing(
  product: FinishedProductPricingRecord,
  batchQuantity: number,
  deps: RecalculateFinishedProductPricingDeps = {},
): FinishedProductRecalcResult {
  const now = deps.now ?? (() => new Date());
  const safeQuantity = batchQuantity > 0 ? batchQuantity : 1;
  const thresholds = resolveThresholds(deps.statusThresholds);

  if (product.manualOverride) {
    return buildManualOverrideResult(product, safeQuantity, now());
  }

  const input = buildInputFromRecipe(product, safeQuantity);
  let pricing = calculateJobPricing(
    input,
    { mode: product.target.mode, marginPercent: product.target.percent },
    { now },
  );

  // Apply minimumPrice floor — clamps suggested price up if needed.
  // Recompute gross profit + realized margin from the clamped value
  // so downstream consumers see a self-consistent PricingResult.
  if (product.minimumPrice !== null && pricing.suggestedPrice < product.minimumPrice) {
    pricing = clampToMinimum(pricing, product.minimumPrice, safeQuantity);
  }

  const priceDelta = product.approvedSellPrice !== null
    ? pricing.suggestedPrice - product.approvedSellPrice
    : null;

  const priceStatus = derivePriceStatus({
    manualOverride: false,
    suggestedPrice: pricing.suggestedPrice,
    totalCost: pricing.breakdown.totalCost,
    approvedSellPrice: product.approvedSellPrice,
    target: product.target,
    thresholds,
  });

  return Object.freeze({
    productId: product.productId,
    tenantId: product.tenantId,
    recalculatedAt: now().toISOString(),
    batchQuantity: safeQuantity,
    pricing,
    priceDelta,
    priceStatus,
    manualOverrideHonored: false,
  });
}

// ---------- Internals ----------

function buildInputFromRecipe(
  product: FinishedProductPricingRecord,
  batchQuantity: number,
): JobCostInput {
  const recipe = product.recipe;

  const materials: ReadonlyArray<MaterialUsage> = recipe.materials.map(
    (m: RecipeMaterial) => ({
      materialId: m.materialId,
      name: m.name,
      quantity: m.quantityPerUnit * batchQuantity,
      unitCost: m.unitCost,
      wasteFactor: m.wasteFactor,
    }),
  );

  const workstations: ReadonlyArray<WorkstationUsage> = recipe.stations.map(
    (s: RecipeStation) => ({
      stationId: s.stationId,
      profile: s.profile,
      minutes: s.minutesPerUnit * batchQuantity,
      units: batchQuantity,
      consumables: [],
    }),
  );

  const labor: ReadonlyArray<LaborTime> = recipe.stations
    .filter((s) => s.laborMinutesPerUnit > 0 && s.loadedLaborRatePerMinute > 0)
    .map((s) => ({
      stationId: s.stationId,
      employeeId: null,
      minutes: s.laborMinutesPerUnit * batchQuantity,
      loadedRatePerMinute: s.loadedLaborRatePerMinute,
    }));

  return {
    workOrderId: `finished-product:${product.productId}`,
    tenantId: product.tenantId,
    quantity: batchQuantity,
    materials,
    labor,
    workstations,
    overhead: recipe.overhead,
  };
}

function clampToMinimum(
  pricing: PricingResult,
  floor: number,
  batchQuantity: number,
): PricingResult {
  const suggestedPrice = floor;
  const grossProfit = suggestedPrice - pricing.breakdown.totalCost;
  const realizedMarginPercent =
    suggestedPrice === 0 ? 0 : grossProfit / suggestedPrice;
  const perUnitPrice = batchQuantity > 0 ? suggestedPrice / batchQuantity : 0;

  return Object.freeze({
    ...pricing,
    suggestedPrice,
    perUnitPrice,
    grossProfit,
    realizedMarginPercent,
  });
}

function buildManualOverrideResult(
  product: FinishedProductPricingRecord,
  batchQuantity: number,
  recalculatedAt: Date,
): FinishedProductRecalcResult {
  // Build the recipe-driven input + breakdown so consumers still see
  // the underlying cost picture even when the price is locked.
  const input = buildInputFromRecipe(product, batchQuantity);
  const fallbackPricing = calculateJobPricing(
    input,
    { mode: product.target.mode, marginPercent: product.target.percent },
    { now: () => recalculatedAt },
  );

  const overrideSellPrice = product.approvedSellPrice ?? 0;
  const grossProfit = overrideSellPrice - fallbackPricing.breakdown.totalCost;
  const realizedMarginPercent =
    overrideSellPrice === 0 ? 0 : grossProfit / overrideSellPrice;
  const perUnitPrice = batchQuantity > 0 ? overrideSellPrice / batchQuantity : 0;

  const pricing: PricingResult = Object.freeze({
    ...fallbackPricing,
    suggestedPrice: overrideSellPrice,
    perUnitPrice,
    grossProfit,
    realizedMarginPercent,
  });

  return Object.freeze({
    productId: product.productId,
    tenantId: product.tenantId,
    recalculatedAt: recalculatedAt.toISOString(),
    batchQuantity,
    pricing,
    priceDelta: 0,
    priceStatus: "manual_override_active" as PriceStatus,
    manualOverrideHonored: true,
  });
}

// ---------- Status derivation ----------

function resolveThresholds(
  overrides: Partial<PriceStatusThresholds> | undefined,
): PriceStatusThresholds {
  return {
    ...DEFAULT_PRICE_STATUS_THRESHOLDS,
    ...overrides,
  };
}

interface DeriveStatusInput {
  readonly manualOverride: boolean;
  readonly suggestedPrice: number;
  readonly totalCost: number;
  readonly approvedSellPrice: number | null;
  readonly target: { readonly mode: MarginMode; readonly percent: number };
  readonly thresholds: PriceStatusThresholds;
}

/**
 * Derive a `PriceStatus` from the recalculated pricing + the
 * operator's approved price. Pure function; precedence per the
 * spec's §5.6:
 *
 *   1. manualOverride        → manual_override_active
 *   2. no approvedSellPrice  → current
 *   3. suggested > approved × (1 + costIncreaseThreshold)
 *                            → cost_increased
 *   4. realized margin at approved < target × (1 - marginDropThreshold)
 *                            → margin_dropped
 *   5. |suggested − approved| > approved × reviewThreshold
 *                            → review_needed
 *   6. else                  → current
 */
function derivePriceStatus(input: DeriveStatusInput): PriceStatus {
  if (input.manualOverride) return "manual_override_active";
  if (input.approvedSellPrice === null) return "current";

  const approved = input.approvedSellPrice;
  const suggested = input.suggestedPrice;

  // Case 3: cost_increased
  if (suggested > approved * (1 + input.thresholds.costIncreaseThreshold)) {
    return "cost_increased";
  }

  // Case 4: margin_dropped
  // Compare realized margin AT THE APPROVED PRICE against the target,
  // normalizing target into margin form so markup-mode targets compare
  // on the same scale (e.g., markup 0.5 → margin 0.333).
  if (approved > 0) {
    const realizedMarginAtApproved = (approved - input.totalCost) / approved;
    const targetAsMargin = normalizeTargetToMargin(input.target);
    if (
      realizedMarginAtApproved
      < targetAsMargin * (1 - input.thresholds.marginDropThreshold)
    ) {
      return "margin_dropped";
    }
  }

  // Case 5: review_needed (significant drift either direction)
  const absoluteDelta = Math.abs(suggested - approved);
  if (absoluteDelta > approved * input.thresholds.reviewThreshold) {
    return "review_needed";
  }

  return "current";
}

/**
 * Convert a target into margin form so it can be compared against a
 * realized margin. Markup target X equates to margin X / (1 + X).
 */
function normalizeTargetToMargin(target: {
  readonly mode: MarginMode;
  readonly percent: number;
}): number {
  if (target.mode === "margin") return target.percent;
  return target.percent / (1 + target.percent);
}
