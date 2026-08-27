import { describe, expect, it } from "vitest";
import { runValidation } from "../src/core/validation/validationEngine";
import {
  buildManufacturingPlan,
  manufacturingPlanSchema,
} from "../src/core/manufacturing/manufacturingPlan";
import { costResultSchema } from "../src/core/cost/costEngine";
import {
  decisionContextSchema,
  decisionResultSchema,
  DECISION_CONTEXT_VERSION,
} from "../src/core/decision/decisionEngine";
import { createCostIqEngine } from "../src/costiq/costiqEngine";
import { createPrimeEngine } from "../src/prime/primeEngine";
import { productConfigurationSchema } from "../src/core/schemas/configuration";
import {
  buildFirepitDefinition,
  demoCortenSpecs,
  demoFiberLaserSpecs,
  demoMildSteelSpecs,
} from "../src/demo/firepit";
import type { MaterialProfileSpecs } from "../src/core/schemas/materialProfile";

// ─────────────────────────────────────────────────────────────────────────────
// The vertical slice: one real product travelling the whole intelligence path.
//
//   ForgeIQ  → validation → ManufacturingPlan
//            → CostIQ     → CostResult
//            → Prime      → DecisionResult
//
// Everything here runs at the engine level. There is no host, no database, no
// HTTP, no React, and no ProWorks Hub or MakerOps — copy these engines and
// their contracts into another TypeScript project and this test still runs.
// ─────────────────────────────────────────────────────────────────────────────

const IDS = { cortenMaterialId: 1, mildSteelMaterialId: 2, fiberLaserMachineId: 1 };
const definition = buildFirepitDefinition(IDS);
const machine = demoFiberLaserSpecs;
const materials = new Map<number, MaterialProfileSpecs>([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.mildSteelMaterialId, demoMildSteelSpecs],
]);

/** A customer's 24" Corten fire pit with a name cut through the front panel. */
const firePitConfiguration = productConfigurationSchema.parse({
  selections: {
    size: "size_24",
    material: "mat_corten",
    finish: "fin_raw",
    style: "style_mountain",
  },
  surfaces: {
    front: [
      {
        id: "front-name",
        type: "text",
        text: "KREUTZER",
        fontFamily: "Impact",
        xIn: 3,
        yIn: 6,
        heightIn: 4,
        rotationDeg: 0,
      },
    ],
  },
  quantity: 1,
});

/** Runs the full chain and hands back every intermediate contract. */
function runIntelligenceChain(
  configuration = firePitConfiguration,
  options: {
    costiq?: Parameters<typeof createCostIqEngine>[0];
    prime?: Parameters<typeof createPrimeEngine>[0];
  } = {},
) {
  // 1–3. ForgeIQ validates the configuration.
  const validation = runValidation({ definition, configuration, materials, machine });

  // 4. ForgeIQ normalizes it into a manufacturing plan.
  const plan = buildManufacturingPlan({
    definition,
    configuration,
    materials,
    machine,
    productDefinitionId: 3,
    productVersion: 3,
    configurationId: 1001,
    materialName: 'Corten Steel 1/8"',
    machineName: "Gweike M3 Ultra (fiber)",
    validation,
  });

  // 5–6. CostIQ costs the plan.
  const cost = createCostIqEngine(options.costiq).calculate(plan);

  // 7–9. Prime decides, from normalized context only.
  const context = decisionContextSchema.parse({
    contextVersion: DECISION_CONTEXT_VERSION,
    subject: { type: "order", reference: "KS-VERTICAL-1" },
    manufacturing: plan,
    cost,
  });
  const decision = createPrimeEngine(options.prime).decide(context);

  return { validation, plan, cost, context, decision };
}

describe("vertical slice: fire pit through ForgeIQ → CostIQ → Prime", () => {
  const { validation, plan, cost, decision } = runIntelligenceChain();

  it("ForgeIQ validates the configuration as manufacturable", () => {
    expect(validation.valid).toBe(true);
    expect(validation.issues.every((i) => i.severity !== "error")).toBe(true);
  });

  it("ForgeIQ produces a plan describing the real physical product", () => {
    expect(() => manufacturingPlanSchema.parse(plan)).not.toThrow();
    expect(plan.product.slug).toBe("firepit-24");
    expect(plan.selections.size).toBe('24"');
    expect(plan.selections.material).toBe('Corten Steel 1/8"');
    expect(plan.material?.category).toBe("corten");
    expect(plan.machine?.process).toBe("fiber-laser");

    // Real parts, from the product's own bill of materials.
    expect(plan.parts.filter((p) => p.kind === "cut-part").length).toBeGreaterThan(0);
    expect(plan.parts.find((p) => p.id === "side-panel:front")?.widthIn).toBe(24);

    // Real stock requirement, from nesting.
    expect(plan.stock?.sheetsNeeded).toBe(1);
    expect(plan.stock?.utilizationPct).toBeGreaterThan(0);
    expect(plan.stock?.oversizedPartIds).toEqual([]);

    // Real operations and manufacturability verdict.
    expect(plan.operations[0].machineProcess).toBe("fiber-laser");
    expect(plan.operations[0].estimatedMinutes).toBeGreaterThan(0);
    expect(plan.manufacturability.valid).toBe(true);
  });

  it("CostIQ costs the plan and recommends a price", () => {
    expect(() => costResultSchema.parse(cost)).not.toThrow();
    expect(cost.engine).toBe("costiq");
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(cost.recommendedPrice).toBeGreaterThan(cost.totalCost);

    // The categories the shop actually spends money in.
    const categories = new Set(cost.lines.map((l) => l.category));
    expect(categories).toContain("material");
    expect(categories).toContain("machine");
    expect(categories).toContain("labor");
    expect(categories).toContain("overhead");

    // Material splits into consumed and wasted, and the two together equal
    // the sheets actually purchased.
    const materialTotal = cost.lines
      .filter((l) => l.category === "material")
      .reduce((sum, l) => sum + l.amount, 0);
    expect(materialTotal).toBeCloseTo(
      plan.stock!.sheetsNeeded * plan.advisoryRates.sheetCost!,
      1,
    );

    // It says what it did not cost rather than inventing a number.
    expect(cost.unpriced).toContain("fin_raw");
    expect(cost.assumptions.length).toBeGreaterThan(0);
  });

  it("Prime decides from the downstream intelligence", () => {
    expect(() => decisionResultSchema.parse(decision)).not.toThrow();
    expect(decision.engine).toBe("prime");
    // Uncosted finishing means this configuration is not a clean auto-approve.
    expect(decision.status).toBe("review");
    expect(decision.reasons.map((r) => r.code)).toContain("cost-incomplete");
  });

  it("auto-approves once costing is complete", () => {
    // Same product, same plan — only the costing gaps are closed, by telling
    // Prime that incomplete costing is acceptable.
    const { decision: approved } = runIntelligenceChain(firePitConfiguration, {
      prime: { reviewWhenCostIncomplete: false },
    });
    expect(approved.status).toBe("proceed");
    expect(approved.priority).toBe("normal");
    expect(approved.reasons.map((r) => r.code)).toContain("auto-approved");
    expect(approved.actions).toEqual([]);
  });

  it("prints the end-to-end result for inspection", () => {
    const summary = {
      forgeiq: {
        product: plan.product.name,
        size: plan.selections.size,
        material: plan.selections.material,
        manufacturable: plan.manufacturability.valid,
        parts: plan.parts.length,
        sheets: plan.stock?.sheetsNeeded,
        utilization: `${Math.round((plan.stock?.utilizationPct ?? 0) * 100)}%`,
        machineMinutes: plan.operations[0].estimatedMinutes,
      },
      costiq: {
        totalCost: cost.totalCost,
        recommendedPrice: cost.recommendedPrice,
        marginPct: `${Math.round((cost.marginPct ?? 0) * 100)}%`,
        unpriced: cost.unpriced,
      },
      prime: { status: decision.status, reasons: decision.reasons.map((r) => r.code) },
    };
    // eslint-disable-next-line no-console
    console.log("\nVERTICAL SLICE\n" + JSON.stringify(summary, null, 2));
    expect(summary.forgeiq.manufacturable).toBe(true);
  });
});

describe("vertical slice: review and block paths", () => {
  it("sends a thin-margin job to review", () => {
    // Valid configuration, poor economics: a costing engine targeting a 10%
    // margin lands under Prime's 35% minimum.
    const { decision, cost } = runIntelligenceChain(firePitConfiguration, {
      costiq: { targetMarginPct: 0.1 },
      prime: { reviewWhenCostIncomplete: false },
    });
    expect(cost.marginPct).toBeLessThan(0.35);
    expect(decision.status).toBe("review");
    expect(decision.reasons.map((r) => r.code)).toContain("margin-below-minimum");
    expect(decision.actions.map((a) => a.code)).toContain("review-pricing");
  });

  it("blocks an unmanufacturable configuration before economics matter", () => {
    const tooSmall = productConfigurationSchema.parse({
      ...firePitConfiguration,
      surfaces: {
        front: [
          {
            id: "tiny",
            type: "text",
            text: "KREUTZER",
            fontFamily: "Impact",
            xIn: 3,
            yIn: 6,
            heightIn: 0.1, // below the minimum cut height
            rotationDeg: 0,
          },
        ],
      },
    });
    const { validation, decision } = runIntelligenceChain(tooSmall);
    expect(validation.valid).toBe(false);
    expect(decision.status).toBe("blocked");
    expect(decision.reasons.map((r) => r.code)).toContain("not-manufacturable");
    expect(decision.actions.map((a) => a.code)).toContain("return-to-design");
  });

  it("raises purchasing and outsourcing actions from operational signals", () => {
    const { plan, cost } = runIntelligenceChain();
    const decision = createPrimeEngine().decide(
      decisionContextSchema.parse({
        contextVersion: DECISION_CONTEXT_VERSION,
        subject: { type: "order", reference: "KS-2" },
        manufacturing: plan,
        cost,
        capacity: [{ process: "fiber-laser", status: "overloaded", queuedMinutes: 1200 }],
        inventory: [{ materialCategory: "corten", sufficient: false, onHandSheets: 0 }],
        commercial: { rush: true },
      }),
    );
    expect(decision.status).toBe("review");
    expect(decision.priority).toBe("expedite");
    expect(decision.actions.map((a) => a.code)).toContain("purchase-material");
    expect(decision.actions.map((a) => a.code)).toContain("consider-outsourcing");
  });

  it("scales the whole chain with order quantity", () => {
    const five = productConfigurationSchema.parse({ ...firePitConfiguration, quantity: 5 });
    const single = runIntelligenceChain();
    const batch = runIntelligenceChain(five);
    expect(batch.plan.quantity).toBe(5);
    expect(batch.plan.stock!.sheetsNeeded).toBeGreaterThanOrEqual(
      single.plan.stock!.sheetsNeeded,
    );
    expect(batch.cost.totalCost).toBeGreaterThan(single.cost.totalCost);
  });
});
