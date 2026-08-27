import { describe, expect, it } from "vitest";
import type { ManufacturingPlan } from "@proworks/contracts";
import { createCostIqEngine } from "../src/costiqEngine";
import { manufacturingPlanToJobCostInput } from "../src/adapters/manufacturingPlanAdapter";
import { calculateJobCost } from "../src/core/costCalculator";

// ─────────────────────────────────────────────────────────────────────────────
// The join between the two CostIQ layers.
//
// The plan below is authored by hand rather than produced by ForgeIQ, which is
// the point: CostIQ costs the contract, not the engine that happens to produce
// it. Nothing in this file imports ForgeIQ.
// ─────────────────────────────────────────────────────────────────────────────

const plan: ManufacturingPlan = {
  planVersion: 1,
  product: {
    slug: "firepit-24",
    name: "Custom Metal Fire Pit",
    category: "fire-pit",
    manufacturingProcess: "fiber-laser-cut",
  },
  configurationId: 7,
  quantity: 1,
  selections: { size: '24"', material: 'Corten Steel 1/8"' },
  material: { category: "corten", thicknessIn: 0.125 },
  machine: { process: "fiber-laser", workAreaWidthIn: 24, workAreaHeightIn: 24 },
  machines: [
    { process: "fiber-laser", workAreaWidthIn: 24, workAreaHeightIn: 24 },
    { process: "press-brake", workAreaWidthIn: 48, workAreaHeightIn: 48 },
  ],
  parts: [
    { id: "side-panel:front", name: "Side panel", kind: "cut-part", quantity: 1, perUnit: 1, widthIn: 24, heightIn: 18 },
    { id: "fasteners", name: "Fastener set", kind: "hardware", quantity: 1, perUnit: 1, knownUnitCost: 6.5 },
    { id: "packaging", name: "Crate", kind: "packaging", quantity: 1, perUnit: 1, knownUnitCost: 14 },
    { id: "unpriced-widget", name: "Mystery part", kind: "hardware", quantity: 2, perUnit: 2 },
  ],
  stock: {
    materialCategory: "corten",
    thicknessIn: 0.125,
    sheetWidthIn: 48,
    sheetHeightIn: 96,
    sheetsNeeded: 1,
    partAreaSqFt: 16.6667,
    sheetAreaSqFt: 32,
    wasteAreaSqFt: 15.3333,
    utilizationPct: 0.5208,
    oversizedPartIds: [],
  },
  operations: [
    {
      id: "laser-cut",
      name: "Laser cut panels",
      type: "cut",
      machineProcess: "fiber-laser",
      machineName: "Gweike M3 Ultra (fiber)",
      advisoryRatePerHour: 45,
      estimatedMinutes: 48,
      setupMinutes: 20,
      isLabor: false,
    },
    {
      id: "form-flange",
      name: "Form top flange",
      type: "bend",
      machineProcess: "press-brake",
      machineName: "Press brake",
      advisoryRatePerHour: 32,
      estimatedMinutes: 10,
      setupMinutes: 15,
      isLabor: false,
    },
    {
      id: "weld",
      name: "Weld and assemble",
      type: "weld",
      machineProcess: "bench",
      estimatedMinutes: 35,
      setupMinutes: 10,
      isLabor: true,
    },
  ],
  labor: { estimatedMinutes: 45, derivedFromOperations: true },
  finishing: [{ id: "fin_raw", name: "Raw / natural" }],
  advisoryRates: {
    materialCostPerSqFt: 5.5,
    sheetCost: 176,
    machineCostPerHour: 45,
    laborRatePerHour: 30,
    targetMarginPct: 0.55,
  },
  manufacturability: { valid: true, errors: 0, warnings: 0 },
  estimatedFromArea: false,
};

describe("ManufacturingPlan → JobCostInput adapter", () => {
  const { input, materialCategories, unpriced, assumptions } =
    manufacturingPlanToJobCostInput(plan);

  it("splits stock into consumed and wasted, summing to the sheets bought", () => {
    const stockLines = input.materials.filter((m) => m.materialId.startsWith("stock"));
    expect(stockLines).toHaveLength(2);
    const total = stockLines.reduce((s, m) => s + m.quantity * m.unitCost * m.wasteFactor, 0);
    expect(total).toBeCloseTo(1 * 176, 1); // sheetsNeeded × sheetCost
  });

  it("carries bought-in parts with their own cost categories", () => {
    expect(materialCategories["fasteners"]).toBe("consumable");
    expect(materialCategories["packaging"]).toBe("packaging");
    expect(input.materials.find((m) => m.materialId === "fasteners")?.unitCost).toBe(6.5);
  });

  it("routes each machine step to its own rate", () => {
    const laser = input.workstations.find((w) => w.stationId === "laser-cut")!;
    const brake = input.workstations.find((w) => w.stationId === "form-flange")!;
    expect(laser.profile.ratePerMinute).toBeCloseTo(45 / 60, 6);
    expect(brake.profile.ratePerMinute).toBeCloseTo(32 / 60, 6);
    // Setup rides on the profile so it is charged once per job, not per unit.
    expect(laser.profile.setup).toMatchObject({ timeMinutes: 20 });
    expect(brake.profile.setup).toMatchObject({ timeMinutes: 15 });
  });

  it("turns bench steps into labor, not machine time", () => {
    expect(input.workstations.map((w) => w.stationId)).not.toContain("weld");
    const weld = input.labor.find((l) => l.stationId === "weld")!;
    // Run plus setup, at the labor rate.
    expect(weld.minutes).toBe(45);
    expect(weld.loadedRatePerMinute).toBeCloseTo(30 / 60, 6);
  });

  it("does not charge the labor block when the routing already covers it", () => {
    expect(input.labor.map((l) => l.stationId)).not.toContain("production-labor");
  });

  it("reports what it could not price rather than guessing", () => {
    expect(unpriced).toContain("unpriced-widget");
    expect(unpriced).toContain("fin_raw");
    expect(assumptions.some((a) => a.includes("offcuts are not credited"))).toBe(true);
  });
});

describe("CostIQ boundary over the mature calculator", () => {
  const engine = createCostIqEngine();
  const result = engine.calculate(plan);

  it("reconciles its lines to the calculator's total, exactly", () => {
    const sum = result.lines.reduce((s, l) => s + l.amount, 0);
    expect(Math.round(sum * 100) / 100).toBeCloseTo(result.totalCost, 2);
  });

  it("produces the same total as the calculator called directly", () => {
    const { input: direct } = manufacturingPlanToJobCostInput(plan, {
      overhead: { kind: "percent_of_direct", percent: 0.15 },
    });
    expect(calculateJobCost(direct).totalCost).toBeCloseTo(result.totalCost, 2);
  });

  it("costs the six layers the mature engine models", () => {
    // material 176 + hardware 6.50 + crate 14
    // + laser (48+20)min @ $45/h = 51 + brake (10+15)min @ $32/h = 13.33
    // + bench 45min @ $30/h = 22.50  →  283.33 direct, ×1.15 = 325.83
    const direct = result.lines
      .filter((l) => l.category !== "overhead")
      .reduce((s, l) => s + l.amount, 0);
    expect(direct).toBeCloseTo(283.33, 1);
    expect(result.totalCost).toBeCloseTo(325.83, 1);
    const categories = new Set(result.lines.map((l) => l.category));
    for (const expected of ["material", "consumable", "packaging", "machine", "setup", "labor", "overhead"]) {
      expect(categories).toContain(expected);
    }
  });

  it("lets CostIQ's own target margin beat the plan's advisory one", () => {
    const cheap = createCostIqEngine({ targetMarginPct: 0.1 }).calculate(plan);
    expect(cheap.marginPct).toBeCloseTo(0.1, 2);
    // Left to itself it falls back to the plan's advisory 55%.
    expect(result.marginPct).toBeCloseTo(0.55, 2);
  });

  it("still satisfies the CostEngine port", () => {
    expect(engine.name).toBe("costiq");
    expect(result.resultVersion).toBe(1);
    expect(result.currency).toBe("USD");
  });
});
