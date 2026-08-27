import { describe, expect, it } from "vitest";
import { computePrice, toPublicBreakdown } from "../src/core/pricing/pricingEngine";
import { resolveQuantityTier } from "../src/core/pricing/quantity";
import { totalSurfaceAreaSqFt } from "../src/core/resolve";
import { baseConfig, definition, machine, materials } from "./helpers";

const price = (config = baseConfig()) =>
  computePrice({ definition, configuration: config, materials, machine });

describe("pricing engine", () => {
  it("prices the default 24\" corten configuration", () => {
    const b = price();
    // base 429 + corten upcharge (4 × 24×18 sqin = 12 sqft × $1.25 = $15)
    expect(b.unitPrice).toBeCloseTo(444, 2);
    expect(b.customerPrice).toBe(b.unitPrice);
    expect(b.lines.find((l) => l.kind === "base")?.amount).toBe(429);
    expect(b.lines.find((l) => l.kind === "material")?.amount).toBeCloseTo(15, 2);
  });

  it("applies flat option modifiers (size and material)", () => {
    const small = price(
      baseConfig({ selections: { ...baseConfig().selections, size: "size_20" } }),
    );
    // base 429 - 60 size + corten upcharge (4 × 18×12 = 6 sqft × 1.25 = 7.5)
    expect(small.unitPrice).toBeCloseTo(376.5, 2);

    const mild = price(
      baseConfig({ selections: { ...baseConfig().selections, material: "mat_mild" } }),
    );
    // base 429 - 40 material, no upcharge for mild steel
    expect(mild.unitPrice).toBeCloseTo(389, 2);
  });

  it("applies percent modifiers to the running subtotal in group order", () => {
    const def = structuredClone(definition);
    def.optionGroups[2].values.push({
      id: "fin_pct",
      label: "Premium +10%",
      priceModifier: { kind: "percent", amount: 0.1 },
      meta: {},
    });
    const b = computePrice({
      definition: def,
      configuration: baseConfig({
        selections: { ...baseConfig().selections, finish: "fin_pct" },
      }),
      materials,
      machine,
    });
    // (429 + 15 corten) × 1.10
    expect(b.unitPrice).toBeCloseTo(488.4, 2);
  });

  it("charges per element", () => {
    const b = price(
      baseConfig({
        surfaces: {
          front: [
            { id: "t", type: "text", text: "THOMPSON", fontFamily: "Arial", xIn: 4, yIn: 5, heightIn: 3, rotationDeg: 0 },
            { id: "i", type: "image", url: "/u/x.png", naturalWidthPx: 3000, naturalHeightPx: 1500, xIn: 2, yIn: 9, widthIn: 6, heightIn: 3, rotationDeg: 0 },
          ],
        },
      }),
    );
    // 444 + 5 text + 15 image
    expect(b.unitPrice).toBeCloseTo(464, 2);
    expect(b.lines.find((l) => l.kind === "element")?.amount).toBe(20);
  });

  it("applies quantity tiers", () => {
    expect(resolveQuantityTier(definition.pricing.quantityTiers, 2).unitMultiplier).toBe(1);
    expect(resolveQuantityTier(definition.pricing.quantityTiers, 3).unitMultiplier).toBe(0.92);
    const b = price(baseConfig({ quantity: 3 }));
    expect(b.customerPrice).toBeCloseTo(444 * 3 * 0.92, 2);
    expect(b.lines.some((l) => l.kind === "quantity")).toBe(true);
  });

  it("estimates internal cost and margin", () => {
    const b = price();
    const areaSqFt = totalSurfaceAreaSqFt(definition, baseConfig());
    expect(areaSqFt).toBeCloseTo(12, 5);
    // Material follows the bill of materials: one 48×96 corten sheet at
    // $5.50/sq ft = $176, not raw panel area.
    expect(b.internal.sheetsNeeded).toBe(1);
    expect(b.internal.materialCost).toBeCloseTo(176, 2);
    expect(b.internal.hardwareCost).toBeCloseTo(24.5, 2); // fasteners + weld + crate
    expect(b.internal.machineTimeCost).toBeCloseTo(((4 * 12) / 60) * 45, 2); // 36
    expect(b.internal.setupCost).toBeCloseTo((20 / 60) * 45, 2); // 15
    expect(b.internal.laborCost).toBeCloseTo((45 / 60) * 30, 2); // 22.5
    const expectedTotal = 176 + 24.5 + 36 + 15 + 22.5; // 274
    expect(b.internal.totalCost).toBeCloseTo(expectedTotal, 2);
    expect(b.internal.margin).toBeCloseTo(b.customerPrice - expectedTotal, 2);
    expect(b.internal.marginPct).toBeGreaterThan(0.3);
  });

  it("toPublicBreakdown strips internal cost", () => {
    const pub = toPublicBreakdown(price());
    expect("internal" in pub).toBe(false);
    expect(pub.customerPrice).toBeGreaterThan(0);
  });
});
