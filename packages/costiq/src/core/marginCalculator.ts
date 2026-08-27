/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/marginCalculator.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Markup vs margin pricing math. Pure function: given a
 *           total cost, a mode, and a percentage, returns the
 *           suggested price + gross profit + realized-margin %.
 *           Layered on top of the cost calculator. Mirrors §7 of
 *           docs/COST-IQ-ENGINE-SPEC.md.
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
 * Layer:        Pure calculator (Cost IQ engine, Phase 1)
 * Imported by:  cost-iq-engine/core/pricingEngine (PR 3) + tests
 * Depends on:   models/pricingResultModel
 * Stability:    CANONICAL (Phase 1)
 *
 * Rounding & precision
 * --------------------
 * The calculator does NOT round at any step. Display rounding is the
 * caller's responsibility (UI / report formatter). This keeps the math
 * deterministic and chainable with downstream calculators (discounts,
 * surcharges) without compounding rounding error.
 *
 * Defensive behaviors
 * --------------------
 * - `marginPercent` is treated as a fraction (0.40 = 40%). Callers
 *   that store percentages as 0..100 must divide by 100 first.
 * - In `margin` mode, a `marginPercent ≥ 1` is mathematically
 *   undefined (would divide by zero or by a negative number) — the
 *   calculator throws. Use `markup` mode if a > 100% gross-profit
 *   markup is intended (e.g., 1.5 markup = 150% added on top).
 * - Negative `marginPercent` is allowed and yields a price BELOW cost
 *   (a discount sale). The realized-margin reporting will be
 *   negative; warning generation is the pricing engine's job (PR 3).
 * - Zero `totalCost` yields zero everywhere; `realizedMarginPercent`
 *   defaults to 0 to avoid NaN when `suggestedPrice` is also zero.
 */

import type {
  MarginAppliedResult,
  MarginMode,
} from "../models/pricingResultModel";

export interface MarginInput {
  readonly mode: MarginMode;
  /** Percentage as a fraction. 0.40 = 40%. */
  readonly marginPercent: number;
}

/**
 * Apply a markup or margin percentage to a total cost.
 *
 * @throws Error when `mode === "margin"` and `marginPercent >= 1`.
 */
export function applyMargin(
  totalCost: number,
  input: MarginInput,
): MarginAppliedResult {
  let suggestedPrice: number;

  if (input.mode === "markup") {
    suggestedPrice = totalCost * (1 + input.marginPercent);
  } else {
    if (input.marginPercent >= 1) {
      throw new Error(
        `applyMargin: margin mode requires marginPercent < 1; got ${input.marginPercent}`,
      );
    }
    suggestedPrice = totalCost / (1 - input.marginPercent);
  }

  const grossProfit = suggestedPrice - totalCost;
  const realizedMarginPercent =
    suggestedPrice === 0 ? 0 : grossProfit / suggestedPrice;

  return Object.freeze({
    suggestedPrice,
    grossProfit,
    realizedMarginPercent,
  });
}
