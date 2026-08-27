import { describe, expect, it } from "vitest";
import {
  costResultSchema,
  type CostEngine,
  type CostResult,
} from "@proworks-hub/contracts";
import {
  decisionContextSchema,
  decisionResultSchema,
  DECISION_CONTEXT_VERSION,
  type DecisionContext,
  type DecisionEngine,
  type DecisionResult,
} from "@proworks-hub/contracts";
import { manufacturingPlanSchema, PLAN_VERSION, type ManufacturingPlan } from "@proworks-hub/contracts";
import { buildManufacturingPlan } from "../src/manufacturing/buildManufacturingPlan";
import { baseConfig, definition, machine, materials } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Suite portability.
//
// These tests exercise the engine-to-engine contracts the way a foreign
// system would: by constructing contract objects directly, with no product
// definition, no builder, and no host. If any of them ever needs to import
// ForgeIQ's internals to compile, the contracts have leaked.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plan authored by hand, as a non-ForgeIQ system would produce it. Proves
 * ForgeIQ is the preferred producer of a ManufacturingPlan, not the only one.
 */
const foreignPlan: ManufacturingPlan = manufacturingPlanSchema.parse({
  planVersion: PLAN_VERSION,
  product: {
    slug: "bracket-a",
    name: "Weld-on Bracket",
    category: "fabrication",
    manufacturingProcess: "plasma-cut",
  },
  quantity: 10,
  selections: { gauge: "10ga" },
  material: { category: "mild-steel", thicknessIn: 0.135 },
  machine: {
    process: "plasma",
    workAreaWidthIn: 60,
    workAreaHeightIn: 120,
  },
  parts: [
    { id: "bracket", name: "Bracket", kind: "cut-part", quantity: 10, perUnit: 1, widthIn: 6, heightIn: 4, areaSqFt: 0.1667 },
    { id: "bolts", name: "Bolt pack", kind: "hardware", quantity: 10, perUnit: 1, knownUnitCost: 2 },
  ],
  stock: {
    materialCategory: "mild-steel",
    thicknessIn: 0.135,
    sheetWidthIn: 48,
    sheetHeightIn: 96,
    sheetsNeeded: 1,
    partAreaSqFt: 1.667,
    sheetAreaSqFt: 32,
    wasteAreaSqFt: 30.333,
    utilizationPct: 0.0521,
    oversizedPartIds: [],
  },
  operations: [
    { id: "primary", type: "cut", machineProcess: "plasma", estimatedMinutes: 25, setupMinutes: 10 },
  ],
  labor: { estimatedMinutes: 30 },
  finishing: [],
  advisoryRates: { sheetCost: 90, machineCostPerHour: 60, laborRatePerHour: 28 },
  manufacturability: { valid: true, errors: 0, warnings: 0 },
  estimatedFromArea: false,
});

/** Stand-in for CostIQ. Consumes a plan and nothing else. */
const mockCostIQ = {
  name: "mock-costiq",
  calculate(plan) {
    const rates = plan.advisoryRates;
    const material = (plan.stock?.sheetsNeeded ?? 0) * (rates.sheetCost ?? 0);
    const hardware = plan.parts
      .filter((p) => p.kind !== "cut-part" && p.knownUnitCost !== undefined)
      .reduce((sum, p) => sum + p.knownUnitCost! * p.quantity, 0);
    const machineMinutes = plan.operations.reduce(
      (sum, op) => sum + op.estimatedMinutes + op.setupMinutes,
      0,
    );
    const machineCost = (machineMinutes / 60) * (rates.machineCostPerHour ?? 0);
    const labor = (plan.labor.estimatedMinutes / 60) * (rates.laborRatePerHour ?? 0);
    const totalCost = Math.round((material + hardware + machineCost + labor) * 100) / 100;
    const marginPct = 0.45;
    const recommendedPrice = Math.round((totalCost / (1 - marginPct)) * 100) / 100;
    return {
      engine: "mock-costiq",
      resultVersion: 1,
      currency: "USD",
      totalCost,
      lines: [
        { code: "material", label: "Stock", amount: material, category: "material" },
        { code: "hardware", label: "Bought-in parts", amount: hardware, category: "consumable" },
        { code: "machine", label: "Machine time", amount: machineCost, category: "machine" },
        { code: "labor", label: "Labor", amount: labor, category: "labor" },
      ],
      recommendedPrice,
      margin: Math.round((recommendedPrice - totalCost) * 100) / 100,
      marginPct,
      assumptions: [],
      unpriced: [],
    } satisfies CostResult;
  },
} satisfies CostEngine;

/**
 * Stand-in for Prime. Consumes normalized outputs from the other engines plus
 * operational signals — never their internals.
 */
const mockPrime = {
  name: "mock-prime",
  decide(context) {
    const reasons: DecisionResult["reasons"] = [];
    const actions: DecisionResult["actions"] = [];
    let status: DecisionResult["status"] = "proceed";
    let priority: DecisionResult["priority"] = "normal";

    if (context.manufacturing && !context.manufacturing.manufacturability.valid) {
      status = "blocked";
      reasons.push({
        code: "not-manufacturable",
        message: "The configuration failed manufacturability validation.",
        severity: "critical",
      });
    }

    const margin = context.cost?.marginPct;
    if (margin !== undefined && margin < 0.3) {
      status = status === "blocked" ? status : "review";
      reasons.push({
        code: "thin-margin",
        message: `Margin of ${Math.round(margin * 100)}% is below the review threshold.`,
        severity: "warning",
      });
      actions.push({ code: "manual-review", label: "Send to sales for review", target: "review" });
    }

    // Capacity is matched against the plan's own operations — contract to
    // contract, with no shared implementation.
    for (const op of context.manufacturing?.operations ?? []) {
      const signal = context.capacity?.find((c) => c.process === op.machineProcess);
      if (signal && (signal.status === "overloaded" || signal.status === "unavailable")) {
        status = status === "blocked" ? status : "review";
        reasons.push({
          code: "capacity",
          message: `${op.machineProcess} is ${signal.status}.`,
          severity: "warning",
        });
        actions.push({
          code: "consider-outsourcing",
          label: `Consider outsourcing ${op.type}`,
          target: "production",
        });
      }
    }

    const stock = context.manufacturing?.stock;
    const inventory = stock
      ? context.inventory?.find((i) => i.materialCategory === stock.materialCategory)
      : undefined;
    if (inventory?.sufficient === false) {
      actions.push({
        code: "purchase-material",
        label: `Purchase ${stock!.sheetsNeeded} × ${stock!.materialCategory}`,
        target: "purchasing",
      });
      reasons.push({
        code: "material-shortfall",
        message: "On-hand stock is insufficient for this job.",
        severity: "warning",
      });
    }

    if (context.commercial?.rush) priority = "expedite";

    return decisionResultSchema.parse({ engine: "mock-prime", status, priority, reasons, actions });
  },
} satisfies DecisionEngine;

describe("CostIQ seam", () => {
  it("costs a plan authored outside ForgeIQ", () => {
    const result = mockCostIQ.calculate(foreignPlan);
    expect(() => costResultSchema.parse(result)).not.toThrow();
    // stock 90 + bolts 20 + machine (35min @ $60 = 35) + labor (30min @ $28 = 14)
    expect(result.totalCost).toBeCloseTo(159, 2);
    expect(result.recommendedPrice).toBeGreaterThan(result.totalCost);
  });

  it("costs a plan ForgeIQ produced, through the same contract", () => {
    const plan = buildManufacturingPlan({
      definition,
      configuration: baseConfig(),
      materials,
      machine,
      materialName: 'Corten Steel 1/8"',
    });
    const result = mockCostIQ.calculate(plan);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.engine).toBe("mock-costiq");
  });

  it("stamps a version so the contract can evolve", () => {
    const parsed = costResultSchema.parse({
      engine: "x",
      totalCost: 0,
      lines: [],
    });
    expect(parsed.resultVersion).toBe(1);
    expect(parsed.unpriced).toEqual([]);
  });
});

describe("Prime seam", () => {
  const contextFor = (overrides: Partial<DecisionContext> = {}): DecisionContext =>
    decisionContextSchema.parse({
      contextVersion: DECISION_CONTEXT_VERSION,
      subject: { type: "order", reference: "KS-1234" },
      manufacturing: foreignPlan,
      cost: mockCostIQ.calculate(foreignPlan),
      ...overrides,
    });

  it("proceeds when nothing is wrong", () => {
    const result = mockPrime.decide(contextFor());
    expect(() => decisionResultSchema.parse(result)).not.toThrow();
    expect(result.status).toBe("proceed");
    expect(result.priority).toBe("normal");
    expect(result.actions).toEqual([]);
  });

  it("blocks an unmanufacturable job on ForgeIQ's verdict alone", () => {
    const unbuildable = {
      ...foreignPlan,
      manufacturability: { valid: false, errors: 2, warnings: 0 },
    };
    const result = mockPrime.decide(contextFor({ manufacturing: unbuildable }));
    expect(result.status).toBe("blocked");
    expect(result.reasons.map((r) => r.code)).toContain("not-manufacturable");
  });

  it("combines cost, capacity, and inventory signals into one decision", () => {
    const thin: CostResult = { ...mockCostIQ.calculate(foreignPlan), marginPct: 0.12 };
    const result = mockPrime.decide(
      contextFor({
        cost: thin,
        capacity: [{ process: "plasma", status: "overloaded", queuedMinutes: 900 }],
        inventory: [{ materialCategory: "mild-steel", sufficient: false, onHandSheets: 0 }],
        commercial: { rush: true, dueDate: "2026-09-04" },
      }),
    );
    expect(result.status).toBe("review");
    expect(result.priority).toBe("expedite");
    expect(result.reasons.map((r) => r.code).sort()).toEqual([
      "capacity",
      "material-shortfall",
      "thin-margin",
    ]);
    expect(result.actions.map((a) => a.code)).toContain("purchase-material");
    expect(result.actions.map((a) => a.code)).toContain("consider-outsourcing");
  });

  it("decides on partial information — no plan, no cost", () => {
    const result = mockPrime.decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "quote", reference: "Q-9" },
      }),
    );
    expect(result.status).toBe("proceed");
  });
});

describe("suite portability", () => {
  it("contracts carry explicit versions", () => {
    expect(foreignPlan.planVersion).toBe(1);
    expect(mockCostIQ.calculate(foreignPlan).resultVersion).toBe(1);
    expect(mockPrime.decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "job", reference: "J-1" },
      }),
    ).resultVersion).toBe(1);
  });

  it("the full chain runs with no host, no database, and no UI", () => {
    // ForgeIQ → plan → CostIQ → cost → Prime → decision, in-process.
    const plan = buildManufacturingPlan({
      definition,
      configuration: baseConfig({ quantity: 5 }),
      materials,
      machine,
      materialName: 'Corten Steel 1/8"',
    });
    const cost = mockCostIQ.calculate(plan);
    const decision = mockPrime.decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "order", reference: "KS-1" },
        manufacturing: plan,
        cost,
      }),
    );
    expect(plan.quantity).toBe(5);
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(["proceed", "review", "blocked"]).toContain(decision.status);
  });
});
