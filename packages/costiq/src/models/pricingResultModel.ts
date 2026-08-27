/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/pricingResultModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Output type for the pricing engine — the full result a
 *           caller needs to display "what should I charge for this
 *           job and how was it built." Mirrors §16.1 of
 *           docs/COST-IQ-ENGINE-SPEC.md, narrowed to Phase 1 scope
 *           (no discounts/surcharges/benchmark — those arrive in
 *           Phase 2).
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
 * Layer:        Model / Types (Cost IQ engine)
 * Imported by:  cost-iq-engine/core/marginCalculator + pricingEngine
 * Depends on:   costBreakdownModel
 * Stability:    CANONICAL (Phase 1)
 */

import type { CostBreakdown } from "./costBreakdownModel.js";

/**
 * Profit calculation mode per §7 of the spec. Many shops confuse
 * markup and margin; the engine supports both natively so users pick
 * whichever they think in.
 *
 * - **markup**: profit added on TOP of cost.
 *   suggestedPrice = totalCost × (1 + percent)
 *   Example: cost $100, markup 0.40 → price $140.
 *
 * - **margin**: profit as a PERCENTAGE OF THE SELL PRICE.
 *   suggestedPrice = totalCost ÷ (1 − percent)
 *   Example: cost $100, margin 0.40 → price ≈ $166.67.
 *
 * Both interpretations of "40%" are common in the wild, hence the
 * explicit mode toggle.
 */
export type MarginMode = "markup" | "margin";

/**
 * Output of `applyMargin` — the pricing math, no cost breakdown
 * attached. Use `PricingResult` when you want the full picture.
 */
export interface MarginAppliedResult {
  /** The recommended sell price for the entire job. */
  readonly suggestedPrice: number;
  /** suggestedPrice − totalCost (always ≥ 0 for non-negative inputs). */
  readonly grossProfit: number;
  /**
   * grossProfit ÷ suggestedPrice, normalized to margin form so UIs
   * can display a single consistent "% margin" number regardless of
   * which mode the user requested. Returns 0 when suggestedPrice is 0.
   */
  readonly realizedMarginPercent: number;
}

/**
 * Full pricing result for a job. What the Cost IQ tab renders.
 *
 * `quantity` is carried through for per-unit reporting; the per-unit
 * values are pre-divided so consumers don't need to re-derive them.
 *
 * `capturedAt` is an ISO-8601 timestamp recorded at the time the
 * pricing was computed. Useful for snapshotting (a job's price as of
 * a given date) and for the future learning layer.
 */
export interface PricingResult {
  readonly workOrderId: string;
  readonly tenantId: string;
  readonly capturedAt: string;
  readonly quantity: number;
  readonly breakdown: CostBreakdown;
  readonly perUnitCost: number;
  readonly mode: MarginMode;
  readonly marginPercent: number;
  readonly suggestedPrice: number;
  readonly perUnitPrice: number;
  readonly grossProfit: number;
  readonly realizedMarginPercent: number;
}
