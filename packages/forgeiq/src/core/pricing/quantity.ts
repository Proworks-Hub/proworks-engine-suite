// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PricingRules } from "../schemas/productDefinition.js";

// Highest tier whose minQty <= quantity wins; tiers may arrive unsorted.
export function resolveQuantityTier(
  tiers: PricingRules["quantityTiers"],
  quantity: number,
): { minQty: number; unitMultiplier: number } {
  let best = { minQty: 1, unitMultiplier: 1 };
  for (const tier of tiers) {
    if (tier.minQty <= quantity && tier.minQty >= best.minQty) best = tier;
  }
  return best;
}
