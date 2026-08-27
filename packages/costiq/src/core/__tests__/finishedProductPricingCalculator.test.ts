/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/__tests__/finishedProductPricingCalculator.test.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Unit coverage for the finished-product pricing
 *           recalculator. Verifies recipe scaling by batch quantity,
 *           minimumPrice clamping, manual-override honoring, and
 *           priceDelta reporting.
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

import { describe, expect, it } from "vitest";

import { recalculateFinishedProductPricing } from "../finishedProductPricingCalculator.js";
import type {
  FinishedProductPricingRecord,
  FinishedProductRecipe,
  RecipeMaterial,
  RecipeStation,
} from "../../models/finishedProductPricingModel.js";
import type { WorkstationCostProfile } from "../../models/workstationCostModel.js";

// ---------- Fixtures ----------

const FROZEN_CLOCK = () => new Date("2026-04-25T09:00:00.000Z");

function makeProfile(stationId: string): WorkstationCostProfile {
  return {
    stationId,
    ratePerMinute: 1,
    ratePerUnit: 0,
    minimumCharge: null,
    setup: null,
    cleanup: null,
    consumables: [],
  };
}

function makeStation(stationId: string, overrides: Partial<RecipeStation> = {}): RecipeStation {
  return {
    stationId,
    profile: makeProfile(stationId),
    minutesPerUnit: 2,
    laborMinutesPerUnit: 3,
    loadedLaborRatePerMinute: 0.5,
    ...overrides,
  };
}

function makeMaterial(materialId: string, overrides: Partial<RecipeMaterial> = {}): RecipeMaterial {
  return {
    materialId,
    name: materialId,
    quantityPerUnit: 1,
    unitCost: 5,
    wasteFactor: 1,
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<FinishedProductRecipe> = {}): FinishedProductRecipe {
  return {
    materials: [makeMaterial("m1")],
    stations: [makeStation("press_a")],
    overhead: { kind: "none" },
    ...overrides,
  };
}

function makeProduct(overrides: Partial<FinishedProductPricingRecord> = {}): FinishedProductPricingRecord {
  return {
    productId: "prod_1",
    tenantId: "tenant_1",
    name: "Widget",
    sku: null,
    recipe: makeRecipe(),
    target: { mode: "markup", percent: 0.5 },
    minimumPrice: null,
    approvedSellPrice: null,
    manualOverride: false,
    liveSuggestedPrice: null,
    lastRecalculatedAt: null,
    ...overrides,
  };
}

// ---------- Recipe scaling ----------

describe("recalculateFinishedProductPricing — recipe scaling", () => {
  it("scales material quantity, station minutes, and labor minutes by batchQuantity", () => {
    const result = recalculateFinishedProductPricing(makeProduct(), 10, { now: FROZEN_CLOCK });
    // Per-unit recipe: 1 material × $5 + 2 station-min × $1 + 3 labor-min × $0.5 = 5 + 2 + 1.5 = 8.5
    // Batch of 10: 85
    expect(result.pricing.breakdown.totalCost).toBeCloseTo(85, 6);
    // Markup 50% → suggested = 127.5
    expect(result.pricing.suggestedPrice).toBeCloseTo(127.5, 6);
    expect(result.batchQuantity).toBe(10);
  });

  it("treats batchQuantity <= 0 as 1", () => {
    const result = recalculateFinishedProductPricing(makeProduct(), 0, { now: FROZEN_CLOCK });
    expect(result.batchQuantity).toBe(1);
    expect(result.pricing.breakdown.totalCost).toBeCloseTo(8.5, 6);
  });

  it("propagates the recalculated timestamp", () => {
    const result = recalculateFinishedProductPricing(makeProduct(), 1, { now: FROZEN_CLOCK });
    expect(result.recalculatedAt).toBe("2026-04-25T09:00:00.000Z");
  });
});

// ---------- Multi-station recipes ----------

describe("recalculateFinishedProductPricing — multi-station", () => {
  it("aggregates cost across multiple stations", () => {
    const recipe = makeRecipe({
      stations: [
        makeStation("press_a", { minutesPerUnit: 1, laborMinutesPerUnit: 2 }),
        makeStation("qc", { minutesPerUnit: 0.5, laborMinutesPerUnit: 1, loadedLaborRatePerMinute: 0.4 }),
      ],
    });
    const result = recalculateFinishedProductPricing(makeProduct({ recipe }), 1, { now: FROZEN_CLOCK });
    // Station press_a: 1 min × $1 = 1; labor 2 × $0.5 = 1
    // Station qc:      0.5 min × $1 = 0.5; labor 1 × $0.4 = 0.4
    // Material: 1 × $5 = 5
    // Total = 1 + 1 + 0.5 + 0.4 + 5 = 7.9
    expect(result.pricing.breakdown.totalCost).toBeCloseTo(7.9, 6);
  });

  it("skips labor for stations with zero labor minutes or zero rate", () => {
    const recipe = makeRecipe({
      materials: [],
      stations: [
        makeStation("press_a", { laborMinutesPerUnit: 0 }),
      ],
    });
    const result = recalculateFinishedProductPricing(makeProduct({ recipe }), 1, { now: FROZEN_CLOCK });
    // Only station usage cost: 2 min × $1 = 2
    expect(result.pricing.breakdown.laborCost).toBe(0);
    expect(result.pricing.breakdown.totalCost).toBeCloseTo(2, 6);
  });
});

// ---------- minimumPrice clamping ----------

describe("recalculateFinishedProductPricing — minimumPrice clamping", () => {
  it("clamps suggested price up to the floor when below", () => {
    const product = makeProduct({
      minimumPrice: 50, // floor much higher than the 12.75 suggestion
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.pricing.suggestedPrice).toBe(50);
  });

  it("does not clamp when suggested price is already above the floor", () => {
    const product = makeProduct({
      minimumPrice: 5, // floor below the 12.75 suggestion
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.pricing.suggestedPrice).toBeCloseTo(12.75, 6); // 8.5 × 1.5
  });

  it("recomputes gross profit + realized margin from the clamped price", () => {
    const product = makeProduct({ minimumPrice: 100 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    // Clamped to 100; cost 8.5 → grossProfit 91.5; realized = 91.5 / 100 = 0.915
    expect(result.pricing.suggestedPrice).toBe(100);
    expect(result.pricing.grossProfit).toBeCloseTo(91.5, 6);
    expect(result.pricing.realizedMarginPercent).toBeCloseTo(0.915, 6);
  });
});

// ---------- Manual override ----------

describe("recalculateFinishedProductPricing — manual override", () => {
  it("returns approvedSellPrice when manualOverride is on", () => {
    const product = makeProduct({
      manualOverride: true,
      approvedSellPrice: 99,
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.manualOverrideHonored).toBe(true);
    expect(result.pricing.suggestedPrice).toBe(99);
    // priceDelta is zero (suggestion equals approved by definition)
    expect(result.priceDelta).toBe(0);
  });

  it("recomputes gross profit + realized margin against the override price", () => {
    const product = makeProduct({
      manualOverride: true,
      approvedSellPrice: 50,
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    // cost = 8.5; override = 50; grossProfit = 41.5; realized = 0.83
    expect(result.pricing.grossProfit).toBeCloseTo(41.5, 6);
    expect(result.pricing.realizedMarginPercent).toBeCloseTo(41.5 / 50, 6);
  });

  it("emits zero suggested price when manualOverride is on but no approved price exists", () => {
    const product = makeProduct({
      manualOverride: true,
      approvedSellPrice: null,
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.manualOverrideHonored).toBe(true);
    expect(result.pricing.suggestedPrice).toBe(0);
  });
});

// ---------- Price delta vs approved ----------

describe("recalculateFinishedProductPricing — priceDelta", () => {
  it("reports null when approvedSellPrice is not set", () => {
    const product = makeProduct({ approvedSellPrice: null });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceDelta).toBe(null);
  });

  it("reports a positive delta when costs went up since the last approval", () => {
    const product = makeProduct({ approvedSellPrice: 10 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    // suggested 12.75 - approved 10 = 2.75
    expect(result.priceDelta).toBeCloseTo(2.75, 6);
  });

  it("reports a negative delta when costs dropped (or sell price was set high)", () => {
    const product = makeProduct({ approvedSellPrice: 20 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    // suggested 12.75 - approved 20 = -7.25
    expect(result.priceDelta).toBeCloseTo(-7.25, 6);
  });
});

// ---------- Output integrity ----------

describe("recalculateFinishedProductPricing — output integrity", () => {
  it("returns a frozen result", () => {
    const result = recalculateFinishedProductPricing(makeProduct(), 1, { now: FROZEN_CLOCK });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses a synthetic workOrderId for the embedded pricing result", () => {
    const product = makeProduct({ productId: "prod_demo_42" });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.pricing.workOrderId).toBe("finished-product:prod_demo_42");
  });
});

// ---------- Price status (PR 2) ----------

describe("recalculateFinishedProductPricing — priceStatus", () => {
  it("returns 'current' when no approvedSellPrice exists", () => {
    const product = makeProduct({ approvedSellPrice: null });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("current");
  });

  it("returns 'manual_override_active' when manualOverride is on", () => {
    const product = makeProduct({ manualOverride: true, approvedSellPrice: 50 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("manual_override_active");
  });

  it("returns 'cost_increased' when suggested price is well above approved", () => {
    // Per-unit cost = 8.5; markup 0.5 → suggested = 12.75
    // Approved = 10 → suggested 12.75 is 27.5% above (well over 5% threshold)
    const product = makeProduct({ approvedSellPrice: 10 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("cost_increased");
  });

  it("returns 'review_needed' when suggested is materially below approved", () => {
    // Suggested = 12.75; approved = 20 → suggested is 36% below
    // That's NOT cost_increased (suggested < approved), and at approved=20
    // realized margin is (20-8.5)/20 = 0.575 which exceeds the markup-0.5
    // target normalized to margin (0.333). So margin isn't dropped either.
    // Status: review_needed.
    const product = makeProduct({ approvedSellPrice: 20 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("review_needed");
  });

  it("returns 'current' when suggested ≈ approved within the review threshold", () => {
    // Suggested = 12.75; approved = 12.80 → 0.39% delta, well under 5%
    const product = makeProduct({ approvedSellPrice: 12.8 });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("current");
  });

  it("returns 'margin_dropped' when realized margin at approved price is well below target", () => {
    // When a shop is severely underpriced, BOTH cost_increased AND
    // margin_dropped naturally fire — and precedence gives the win to
    // cost_increased. To isolate margin_dropped (the realistic case is
    // a target raised after approval, not a cost spike), bump the
    // cost-increase threshold above the suggested-vs-approved gap so
    // that check is suppressed.
    const recipe = makeRecipe({
      materials: [makeMaterial("m1", { quantityPerUnit: 1, unitCost: 100 })],
      stations: [makeStation("press_a", { minutesPerUnit: 0, laborMinutesPerUnit: 0 })],
    });
    // Cost = 100; target margin 50% → suggested = 200
    // Approved = 110 → realized margin = 9.1% (way below target × 0.9 = 45%)
    // Default costIncreaseThreshold 0.05 → cost_increased fires
    //   (200 > 110 × 1.05 = 115.5).
    // Raise costIncreaseThreshold to 1.0 → check becomes
    //   (200 > 110 × 2.0 = 220), which is false → cost_increased suppressed.
    // Margin_dropped then fires as expected.
    const product = makeProduct({
      recipe,
      target: { mode: "margin", percent: 0.5 },
      approvedSellPrice: 110,
    });
    const result = recalculateFinishedProductPricing(product, 1, {
      now: FROZEN_CLOCK,
      statusThresholds: { costIncreaseThreshold: 1.0 },
    });
    expect(result.priceStatus).toBe("margin_dropped");
  });

  it("respects custom threshold overrides", () => {
    // Same scenario as the 'review_needed' case (12.75 suggested, 20 approved,
    // 36% delta) but raise the review threshold above 36%.
    const product = makeProduct({ approvedSellPrice: 20 });
    const result = recalculateFinishedProductPricing(product, 1, {
      now: FROZEN_CLOCK,
      statusThresholds: { reviewThreshold: 0.5 }, // 50% — bigger than the actual 36%
    });
    expect(result.priceStatus).toBe("current");
  });

  it("cost_increased takes precedence over margin_dropped when both could apply", () => {
    // Heavy material recipe; approve a low price so margin is bad AND
    // suggested is much higher than approved.
    const recipe = makeRecipe({
      materials: [makeMaterial("m1", { quantityPerUnit: 1, unitCost: 100 })],
      stations: [makeStation("press_a", { minutesPerUnit: 0, laborMinutesPerUnit: 0 })],
    });
    // Cost = 100; target margin 50%; suggested via margin mode = 200
    // Approved = 105 → suggested 200 is +90% above (cost_increased fires).
    // Realized margin at 105 = (105-100)/105 ≈ 4.8%, way below target
    // (margin_dropped would also be true). Precedence picks cost_increased.
    const product = makeProduct({
      recipe,
      target: { mode: "margin", percent: 0.5 },
      approvedSellPrice: 105,
    });
    const result = recalculateFinishedProductPricing(product, 1, { now: FROZEN_CLOCK });
    expect(result.priceStatus).toBe("cost_increased");
  });
});
