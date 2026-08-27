/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/__tests__/marginCalculator.test.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Unit coverage for the markup/margin pricing math. Both
 *           modes plus edge cases (zero cost, negative percent, the
 *           >= 1 margin guard, realized-margin normalization).
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

import { applyMargin } from "../marginCalculator";

describe("applyMargin — markup mode", () => {
  it("adds the markup percentage on top of cost", () => {
    const out = applyMargin(100, { mode: "markup", marginPercent: 0.4 });
    expect(out.suggestedPrice).toBeCloseTo(140, 6);
    expect(out.grossProfit).toBeCloseTo(40, 6);
    // Realized margin from $40 profit on $140 sale = 0.2857...
    expect(out.realizedMarginPercent).toBeCloseTo(40 / 140, 6);
  });

  it("returns the cost unchanged when markup is zero", () => {
    const out = applyMargin(100, { mode: "markup", marginPercent: 0 });
    expect(out.suggestedPrice).toBe(100);
    expect(out.grossProfit).toBe(0);
    expect(out.realizedMarginPercent).toBe(0);
  });

  it("supports markups > 100%", () => {
    const out = applyMargin(50, { mode: "markup", marginPercent: 1.5 });
    expect(out.suggestedPrice).toBeCloseTo(125, 6); // 50 × 2.5
    expect(out.grossProfit).toBeCloseTo(75, 6);
  });

  it("supports negative markup as a discount sale (price below cost)", () => {
    const out = applyMargin(100, { mode: "markup", marginPercent: -0.1 });
    expect(out.suggestedPrice).toBeCloseTo(90, 6);
    expect(out.grossProfit).toBeCloseTo(-10, 6);
    expect(out.realizedMarginPercent).toBeCloseTo(-10 / 90, 6);
  });
});

describe("applyMargin — margin mode", () => {
  it("computes price so that the requested percentage IS the realized margin", () => {
    const out = applyMargin(100, { mode: "margin", marginPercent: 0.4 });
    // 100 / (1 - 0.4) = 166.6666...
    expect(out.suggestedPrice).toBeCloseTo(166.6667, 4);
    expect(out.grossProfit).toBeCloseTo(66.6667, 4);
    // Realized margin should equal the requested 40% (within float tolerance)
    expect(out.realizedMarginPercent).toBeCloseTo(0.4, 6);
  });

  it("returns the cost unchanged when margin is zero", () => {
    const out = applyMargin(100, { mode: "margin", marginPercent: 0 });
    expect(out.suggestedPrice).toBe(100);
    expect(out.grossProfit).toBe(0);
    expect(out.realizedMarginPercent).toBe(0);
  });

  it("throws when marginPercent is >= 1 (mathematically undefined)", () => {
    expect(() => applyMargin(100, { mode: "margin", marginPercent: 1 })).toThrow();
    expect(() => applyMargin(100, { mode: "margin", marginPercent: 1.5 })).toThrow();
  });

  it("supports negative margin as a discount sale", () => {
    const out = applyMargin(100, { mode: "margin", marginPercent: -0.25 });
    // 100 / (1 - (-0.25)) = 100 / 1.25 = 80
    expect(out.suggestedPrice).toBeCloseTo(80, 6);
    expect(out.grossProfit).toBeCloseTo(-20, 6);
    // Realized margin = -20 / 80 = -0.25 (round-trips)
    expect(out.realizedMarginPercent).toBeCloseTo(-0.25, 6);
  });
});

describe("applyMargin — edge cases", () => {
  it("handles zero totalCost without producing NaN", () => {
    const out = applyMargin(0, { mode: "markup", marginPercent: 0.4 });
    expect(out.suggestedPrice).toBe(0);
    expect(out.grossProfit).toBe(0);
    expect(out.realizedMarginPercent).toBe(0);
  });

  it("handles zero totalCost in margin mode", () => {
    const out = applyMargin(0, { mode: "margin", marginPercent: 0.4 });
    expect(out.suggestedPrice).toBe(0);
    expect(out.grossProfit).toBe(0);
    expect(out.realizedMarginPercent).toBe(0);
  });

  it("returns a frozen object so callers cannot mutate the result", () => {
    const out = applyMargin(100, { mode: "markup", marginPercent: 0.2 });
    expect(Object.isFrozen(out)).toBe(true);
  });
});

describe("applyMargin — markup vs margin equivalence at boundary cases", () => {
  it("markup 0% and margin 0% both yield price = cost", () => {
    const m1 = applyMargin(50, { mode: "markup", marginPercent: 0 });
    const m2 = applyMargin(50, { mode: "margin", marginPercent: 0 });
    expect(m1.suggestedPrice).toBe(m2.suggestedPrice);
  });

  it("markup and margin produce DIFFERENT prices for the same percent (the user-confusion case)", () => {
    // This test exists to lock the intentional difference between modes
    // — it's exactly the confusion the dual-mode toggle was designed to
    // prevent.
    const markup = applyMargin(100, { mode: "markup", marginPercent: 0.4 });
    const margin = applyMargin(100, { mode: "margin", marginPercent: 0.4 });
    expect(markup.suggestedPrice).toBeCloseTo(140, 6);
    expect(margin.suggestedPrice).toBeCloseTo(166.6667, 4);
    expect(markup.suggestedPrice).not.toBeCloseTo(margin.suggestedPrice, 2);
  });
});
