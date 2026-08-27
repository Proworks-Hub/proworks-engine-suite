import { describe, expect, it } from "vitest";
import {
  buildManufacturingPlan,
  manufacturingPlanSchema,
  PLAN_VERSION,
  type ManufacturingPlan,
} from "../src/core/manufacturing/manufacturingPlan";
import {
  costResultSchema,
  type CostEngine,
  type CostLine,
} from "../src/core/cost/costEngine";
import { runValidation } from "../src/core/validation/validationEngine";
import { buildBillOfMaterials } from "../src/core/production/bom";
import type { SurfaceElement } from "../src/core/schemas/configuration";
import { baseConfig, definition, machine, materials, IDS } from "./helpers";

const planFor = (config = baseConfig(), extra = {}) =>
  buildManufacturingPlan({
    definition,
    configuration: config,
    materials,
    machine,
    materialName: 'Corten Steel 1/8"',
    machineName: "Gweike M3 Ultra (fiber)",
    ...extra,
  });

describe("ManufacturingPlan", () => {
  it("normalizes a configured product into a valid plan", () => {
    const plan = planFor(baseConfig(), {
      productDefinitionId: 3,
      productVersion: 3,
      configurationId: 42,
    });
    expect(() => manufacturingPlanSchema.parse(plan)).not.toThrow();
    expect(plan.planVersion).toBe(PLAN_VERSION);
    expect(plan.product).toMatchObject({
      definitionId: 3,
      version: 3,
      slug: "firepit-24",
      manufacturingProcess: "fiber-laser-cut",
    });
    expect(plan.configurationId).toBe(42);
    expect(plan.quantity).toBe(1);
    expect(plan.selections.size).toBe('24"');
    expect(plan.material).toMatchObject({
      profileId: IDS.cortenMaterialId,
      category: "corten",
      thicknessIn: 0.125,
    });
    expect(plan.machine).toMatchObject({ process: "fiber-laser", workAreaWidthIn: 24 });
  });

  it("carries the bill of materials into the plan", () => {
    const plan = planFor();
    const bom = buildBillOfMaterials({
      definition,
      configuration: baseConfig(),
      materials,
    });
    expect(plan.parts).toHaveLength(bom.items.length);

    const sidePanels = plan.parts.filter((p) => p.id.startsWith("side-panel:"));
    expect(sidePanels).toHaveLength(4);
    expect(sidePanels[0]).toMatchObject({ kind: "cut-part", widthIn: 24, heightIn: 18 });
    expect(sidePanels[0].areaSqFt).toBeCloseTo(3, 4);

    const legs = plan.parts.find((p) => p.id === "leg");
    expect(legs).toMatchObject({ quantity: 4, perUnit: 4, widthIn: 3, heightIn: 8 });

    // Bought-in items keep their kind and the host's recorded unit cost.
    const fasteners = plan.parts.find((p) => p.id === "fasteners");
    expect(fasteners).toMatchObject({ kind: "hardware", knownUnitCost: 6.5 });
    expect(plan.estimatedFromArea).toBe(false);
  });

  it("carries sheet nesting and stock requirements into the plan", () => {
    const plan = planFor();
    expect(plan.stock).not.toBeNull();
    expect(plan.stock!).toMatchObject({
      materialCategory: "corten",
      sheetWidthIn: 48,
      sheetHeightIn: 96,
      sheetsNeeded: 1,
      oversizedPartIds: [],
    });
    expect(plan.stock!.partAreaSqFt).toBeCloseTo(2400 / 144, 3);
    expect(plan.stock!.sheetAreaSqFt).toBeCloseTo(32, 3);
    // Waste is the purchased area the parts do not consume.
    expect(plan.stock!.wasteAreaSqFt).toBeCloseTo(32 - 2400 / 144, 3);
    expect(plan.stock!.utilizationPct).toBeGreaterThan(0.5);
    expect(plan.stock!.utilizationPct).toBeLessThan(1);
  });

  it("reports operations, labor, and finishing as manufacturing facts", () => {
    const plan = planFor(baseConfig({ quantity: 2 }));
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toMatchObject({
      type: "cut",
      machineProcess: "fiber-laser",
      setupMinutes: 20,
    });
    // 4 min/sq ft × 12 sq ft × qty 2
    expect(plan.operations[0].estimatedMinutes).toBeCloseTo(96, 3);
    expect(plan.labor.estimatedMinutes).toBeCloseTo(90, 3);
    expect(plan.finishing).toEqual([{ id: "fin_raw", name: "Raw / natural" }]);
  });

  it("passes through the host's rates as advisory only", () => {
    const plan = planFor();
    expect(plan.advisoryRates).toMatchObject({
      materialCostPerSqFt: 5.5,
      machineCostPerHour: 45,
      laborRatePerHour: 30,
    });
    expect(plan.advisoryRates.sheetCost).toBeCloseTo(176, 2);
    // The plan itself states no money.
    expect(JSON.stringify(plan)).not.toContain("customerPrice");
    expect(JSON.stringify(plan)).not.toContain("totalCost");
  });

  it("summarizes manufacturability without duplicating the validation engine", () => {
    const bad = baseConfig({
      surfaces: {
        front: [
          { id: "t1", type: "text", text: "SMITH", fontFamily: "Arial", xIn: 6, yIn: 6, heightIn: 0.1, rotationDeg: 0 },
        ] as SurfaceElement[],
      },
    });
    const validation = runValidation({
      definition,
      configuration: bad,
      materials,
      machine,
    });
    const plan = planFor(bad, { validation });
    expect(validation.valid).toBe(false);
    expect(plan.manufacturability).toMatchObject({ valid: false });
    expect(plan.manufacturability.errors).toBeGreaterThan(0);
  });

  it("flags plans estimated from area when a product has no bill of materials", () => {
    const noBom = structuredClone(definition);
    noBom.bom = [];
    const plan = buildManufacturingPlan({
      definition: noBom,
      configuration: baseConfig(),
      materials,
      machine,
    });
    expect(plan.estimatedFromArea).toBe(true);
    expect(plan.parts).toEqual([]);
    expect(plan.stock).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A stand-in for CostIQ. It consumes ONLY the manufacturing plan — no product
// definition, no configuration, no builder UI — which is the whole point of
// the seam. If this test ever needs another import to compute a cost, the
// contract is incomplete.
// ─────────────────────────────────────────────────────────────────────────────
const mockCostIQ: CostEngine = {
  name: "mock-costiq",
  calculate(plan: ManufacturingPlan) {
    const lines: CostLine[] = [];
    const unpriced: string[] = [];

    if (plan.stock) {
      const sheetCost = plan.advisoryRates.sheetCost ?? 0;
      lines.push({
        code: "stock",
        label: `${plan.stock.sheetsNeeded} × ${plan.stock.materialCategory} sheet`,
        amount: plan.stock.sheetsNeeded * sheetCost,
        category: "material",
      });
    }

    for (const part of plan.parts) {
      if (part.kind === "cut-part") continue; // covered by stock
      if (part.knownUnitCost === undefined) {
        unpriced.push(part.id);
        continue;
      }
      lines.push({
        code: part.id,
        label: part.name,
        amount: part.knownUnitCost * part.quantity,
        category: part.kind === "packaging" ? "packaging" : "consumable",
      });
    }

    const machineRate = plan.advisoryRates.machineCostPerHour ?? 0;
    for (const op of plan.operations) {
      lines.push({
        code: `op-${op.id}`,
        label: `${op.type} on ${op.machineProcess}`,
        amount: (op.estimatedMinutes / 60) * machineRate,
        category: "machine",
      });
      lines.push({
        code: `setup-${op.id}`,
        label: `${op.type} setup`,
        amount: (op.setupMinutes / 60) * machineRate,
        category: "setup",
      });
    }

    lines.push({
      code: "labor",
      label: "Assembly labor",
      amount: (plan.labor.estimatedMinutes / 60) * (plan.advisoryRates.laborRatePerHour ?? 0),
      category: "labor",
    });

    if (plan.finishing.length > 0) unpriced.push(...plan.finishing.map((f) => f.id));

    const totalCost = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
    const targetMargin = plan.advisoryRates.targetMarginPct ?? 0.5;
    const recommendedPrice = Math.round((totalCost / (1 - targetMargin)) * 100) / 100;
    return {
      engine: "mock-costiq",
      currency: "USD",
      totalCost,
      lines,
      recommendedPrice,
      margin: Math.round((recommendedPrice - totalCost) * 100) / 100,
      marginPct: targetMargin,
      unpriced,
    };
  },
};

describe("CostEngine seam", () => {
  it("a cost engine can price a plan using only the plan", async () => {
    const plan = planFor();
    const result = await mockCostIQ.calculate(plan);
    expect(() => costResultSchema.parse(result)).not.toThrow();
    expect(result.engine).toBe("mock-costiq");

    // 1 sheet ($176) + fasteners 6.50 + weld 4 + crate 14
    // + machine 48min@$45 ($36) + setup 20min@$45 ($15) + labor 45min@$30 ($22.50)
    expect(result.totalCost).toBeCloseTo(274, 2);
    expect(result.recommendedPrice).toBeGreaterThan(result.totalCost);
    expect(result.lines.some((l) => l.category === "material")).toBe(true);
    expect(result.lines.some((l) => l.category === "machine")).toBe(true);
    expect(result.lines.some((l) => l.category === "labor")).toBe(true);
  });

  it("scales with quantity through the plan alone", async () => {
    const single = await mockCostIQ.calculate(planFor());
    const triple = await mockCostIQ.calculate(planFor(baseConfig({ quantity: 3 })));
    expect(triple.totalCost).toBeGreaterThan(single.totalCost);
  });

  it("reports what it could not cost instead of inventing a number", async () => {
    const result = await mockCostIQ.calculate(planFor());
    // The demo product's finish carries no rate anywhere in ForgeIQ.
    expect(result.unpriced).toContain("fin_raw");
  });
});
