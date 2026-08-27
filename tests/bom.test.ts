import { describe, expect, it } from "vitest";
import { buildBillOfMaterials } from "../src/core/production/bom";
import { estimateSheets } from "../src/core/production/nesting";
import { computePrice } from "../src/core/pricing/pricingEngine";
import { baseConfig, definition, machine, materials, IDS } from "./helpers";

const bomFor = (config = baseConfig()) =>
  buildBillOfMaterials({
    definition,
    configuration: config,
    materials,
    materialName: 'Corten Steel 1/8"',
  });

describe("bill of materials", () => {
  it("expands per-surface and fixed components", () => {
    const bom = bomFor();
    const ids = bom.items.map((i) => i.id);
    // One side panel per editable surface (4), plus the fixed components.
    expect(ids.filter((id) => id.startsWith("side-panel:"))).toHaveLength(4);
    expect(ids).toContain("bottom-plate");
    expect(ids).toContain("leg");
    expect(bom.items.find((i) => i.id === "leg")?.quantity).toBe(4);
  });

  it("resolves component dimensions from surface, footprint, and fixed sources", () => {
    const bom = bomFor();
    // Surface source: the 24" preset's panels are 24×18
    expect(bom.items.find((i) => i.id === "side-panel:front")?.dimensionsIn).toEqual({
      widthIn: 24,
      heightIn: 18,
    });
    // Footprint source: preset width × depth = 24×24
    expect(bom.items.find((i) => i.id === "bottom-plate")?.dimensionsIn).toEqual({
      widthIn: 24,
      heightIn: 24,
    });
    // Fixed source
    expect(bom.items.find((i) => i.id === "leg")?.dimensionsIn).toEqual({
      widthIn: 3,
      heightIn: 8,
    });
  });

  it("scales quantities and hardware cost with order quantity", () => {
    const single = bomFor();
    const triple = bomFor(baseConfig({ quantity: 3 }));
    expect(triple.items.find((i) => i.id === "leg")?.quantity).toBe(12);
    expect(triple.hardwareCost).toBeCloseTo(single.hardwareCost * 3, 2);
    // fasteners 6.50 + weld 4 + packaging 14 = 24.50 per unit
    expect(single.hardwareCost).toBeCloseTo(24.5, 2);
  });

  it("nests cut parts onto real stock sheets", () => {
    const bom = bomFor();
    expect(bom.stock).not.toBeNull();
    expect(bom.stock!.sheetsNeeded).toBeGreaterThanOrEqual(1);
    // 4 panels (24×18 = 1728) + plate (24×24 = 576) + 4 legs (3×8 = 96)
    expect(bom.stock!.partAreaSqFt).toBeCloseTo(2400 / 144, 2);
    // A 48×96 sheet is 32 sq ft, so one sheet holds this build.
    expect(bom.stock!.sheetsNeeded).toBe(1);
    expect(bom.stock!.utilizationPct).toBeGreaterThan(0);
    expect(bom.stock!.utilizationPct).toBeLessThanOrEqual(1);
    expect(bom.stock!.oversizedPartIds).toEqual([]);
  });

  it("costs material by whole sheets, not raw part area", () => {
    const bom = bomFor();
    // 48×96 corten sheet at $5.50/sq ft = $176 per sheet
    expect(bom.stock!.sheetCost).toBeCloseTo(176, 2);
    expect(bom.materialCost).toBeCloseTo(bom.stock!.sheetsNeeded * 176, 2);
    expect(bom.estimatedFromArea).toBe(false);
  });

  it("falls back to area costing when a product has no BOM", () => {
    const noBom = structuredClone(definition);
    noBom.bom = [];
    const bom = buildBillOfMaterials({
      definition: noBom,
      configuration: baseConfig(),
      materials,
    });
    expect(bom.estimatedFromArea).toBe(true);
    expect(bom.items).toEqual([]);
    expect(bom.materialCost).toBeCloseTo(12 * 5.5, 2); // 12 sq ft of panels
  });

  it("tolerates definitions stored before the bom field existed", () => {
    // Persisted jsonb is read back by cast, so schema defaults were never
    // applied to older rows — the field is genuinely absent, not empty.
    const legacy = structuredClone(definition) as Record<string, unknown>;
    delete legacy.bom;
    const bom = buildBillOfMaterials({
      definition: legacy as typeof definition,
      configuration: baseConfig(),
      materials,
    });
    expect(bom.estimatedFromArea).toBe(true);
    expect(bom.materialCost).toBeCloseTo(12 * 5.5, 2);
  });

  it("feeds internal costing, including hardware", () => {
    const price = computePrice({
      definition,
      configuration: baseConfig(),
      materials,
      machine,
    });
    const bom = bomFor();
    expect(price.internal.materialCost).toBeCloseTo(bom.materialCost, 2);
    expect(price.internal.hardwareCost).toBeCloseTo(24.5, 2);
    expect(price.internal.sheetsNeeded).toBe(bom.stock!.sheetsNeeded);
    expect(price.internal.totalCost).toBeCloseTo(
      bom.materialCost + 24.5 + price.internal.machineTimeCost + price.internal.setupCost + price.internal.laborCost,
      2,
    );
  });
});

describe("sheet nesting", () => {
  const sheet = { sheetWidthIn: 48, sheetHeightIn: 96 };

  it("fits small parts on a single sheet", () => {
    const r = estimateSheets([{ id: "p", widthIn: 12, heightIn: 12, quantity: 4 }], sheet);
    expect(r.sheetsNeeded).toBe(1);
    expect(r.partAreaSqFt).toBeCloseTo(4, 2);
  });

  it("opens more sheets as parts exceed one sheet's yield", () => {
    const many = estimateSheets([{ id: "p", widthIn: 23, heightIn: 23, quantity: 40 }], sheet);
    expect(many.sheetsNeeded).toBeGreaterThan(1);
    // Never claims better yield than the sheets purchased allow.
    expect(many.partAreaSqFt).toBeLessThanOrEqual(many.sheetAreaSqFt);
  });

  it("rotates parts to fit the sheet", () => {
    // 90" long fits only along the 96" axis.
    const r = estimateSheets([{ id: "long", widthIn: 90, heightIn: 10, quantity: 1 }], sheet);
    expect(r.sheetsNeeded).toBe(1);
    expect(r.oversizedPartIds).toEqual([]);
  });

  it("flags parts too large for the stock", () => {
    const r = estimateSheets([{ id: "huge", widthIn: 200, heightIn: 200, quantity: 1 }], sheet);
    expect(r.oversizedPartIds).toEqual(["huge"]);
  });
});
