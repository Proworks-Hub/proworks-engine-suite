import { describe, expect, it } from "vitest";
import { runValidation } from "../src/core/validation/validationEngine";
import { buildManufacturingPlan } from "../src/manufacturing/buildManufacturingPlan";
import { productConfigurationSchema } from "../src/core/schemas/configuration";
import { productDefinitionSchema } from "../src/core/schemas/productDefinition";
import { createCostIqEngine } from "@proworks-hub/costiq";
import { createPrimeEngine } from "@proworks-hub/prime";
import {
  decisionContextSchema,
  DECISION_CONTEXT_VERSION,
} from "@proworks-hub/contracts";
import { buildMetalSignDefinition, demoAluminumSpecs } from "../src/demo/metalSign";
import { demoCortenSpecs, demoFiberLaserSpecs } from "../src/demo/firepit";
import type { MaterialProfileSpecs } from "../src/core/schemas/materialProfile";

// ─────────────────────────────────────────────────────────────────────────────
// Generalization: a second, structurally different product runs the identical
// pipeline. One flat face instead of four panels, an optional engraving pass,
// no welding, different stock — and not a line of engine code changes. If any
// of this required engine edits, the engines would be product-specific.
// ─────────────────────────────────────────────────────────────────────────────

const IDS = { cortenMaterialId: 1, aluminumMaterialId: 3, fiberLaserMachineId: 1 };
const definition = buildMetalSignDefinition(IDS);
const machine = demoFiberLaserSpecs;
const materials = new Map<number, MaterialProfileSpecs>([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.aluminumMaterialId, demoAluminumSpecs],
]);

const signConfiguration = (overrides: Record<string, string> = {}, quantity = 1) =>
  productConfigurationSchema.parse({
    selections: {
      size: "size_18x12",
      material: "mat_corten",
      detail: "detail_cut",
      ...overrides,
    },
    surfaces: {
      face: [
        {
          id: "title",
          type: "text",
          text: "THE KREUTZERS",
          fontFamily: "Impact",
          xIn: 1.5,
          yIn: 4,
          heightIn: 2,
          rotationDeg: 0,
        },
      ],
    },
    quantity,
  });

function runChain(configuration = signConfiguration(), primeConfig = {}) {
  const validation = runValidation({ definition, configuration, materials, machine });
  const plan = buildManufacturingPlan({
    definition,
    configuration,
    materials,
    machine,
    materialName: 'Corten Steel 1/8"',
    machineName: "Gweike M3 Ultra (fiber)",
    validation,
  });
  const cost = createCostIqEngine().calculate(plan);
  const decision = createPrimeEngine(primeConfig).decide(
    decisionContextSchema.parse({
      contextVersion: DECISION_CONTEXT_VERSION,
      subject: { type: "order", reference: "KS-SIGN-1" },
      manufacturing: plan,
      cost,
    }),
  );
  return { validation, plan, cost, decision };
}

describe("second product: metal sign", () => {
  it("is a valid product definition", () => {
    expect(() => productDefinitionSchema.parse(definition)).not.toThrow();
    // Structurally unlike the fire pit: one editable surface, not four.
    expect(definition.surfaces).toHaveLength(1);
  });

  it("runs the same pipeline end to end", () => {
    const { validation, plan, cost, decision } = runChain();
    expect(validation.valid).toBe(true);
    expect(plan.product.slug).toBe("metal-sign");
    expect(cost.totalCost).toBeGreaterThan(0);
    expect(["proceed", "review", "blocked"]).toContain(decision.status);
  });

  it("produces its own bill of materials and stock requirement", () => {
    const { plan } = runChain();
    expect(plan.parts.map((p) => p.id)).toEqual(["face-panel:face", "hardware", "packaging"]);
    expect(plan.parts[0]).toMatchObject({ kind: "cut-part", widthIn: 18, heightIn: 12 });
    // A single small face uses very little of a 48×96 sheet.
    expect(plan.stock?.sheetsNeeded).toBe(1);
    expect(plan.stock?.utilizationPct).toBeLessThan(0.1);
  });

  it("routes through its own operations, not the fire pit's", () => {
    const { plan } = runChain();
    expect(plan.operations.map((o) => o.id)).toEqual(["laser-cut", "deburr", "pack"]);
    expect(plan.operations.some((o) => o.type === "weld")).toBe(false);
    // per-sq-ft: 3 min × 1.5 sq ft
    expect(plan.operations[0].estimatedMinutes).toBeCloseTo(4.5, 3);
    // per-part: 2 min × 1 face panel
    expect(plan.operations[1]).toMatchObject({ isLabor: true });
    expect(plan.operations[1].estimatedMinutes).toBeCloseTo(2, 3);
  });

  it("adds the engraving pass only when that detail is chosen", () => {
    const plain = runChain();
    const engraved = runChain(signConfiguration({ detail: "detail_engraved" }));
    expect(plain.plan.operations.map((o) => o.id)).not.toContain("engrave");
    expect(engraved.plan.operations.map((o) => o.id)).toContain("engrave");
    // The extra machine pass costs more to produce.
    expect(engraved.cost.totalCost).toBeGreaterThan(plain.cost.totalCost);
  });

  it("reflects a different material's stock cost", () => {
    const corten = runChain();
    const aluminum = runChain(signConfiguration({ material: "mat_aluminum" }));
    // Aluminum is $7.25/sq ft against corten's $5.50.
    expect(aluminum.cost.totalCost).toBeGreaterThan(corten.cost.totalCost);
    expect(aluminum.plan.material?.category).toBe("aluminum");
  });

  it("blocks an unmanufacturable sign for the same reason a fire pit would", () => {
    const oversized = productConfigurationSchema.parse({
      ...signConfiguration(),
      surfaces: {
        face: [
          {
            id: "title",
            type: "text",
            text: "THE KREUTZERS",
            fontFamily: "Impact",
            xIn: 1.5,
            yIn: 4,
            heightIn: 0.2, // below the minimum cut height
            rotationDeg: 0,
          },
        ],
      },
    });
    const { decision } = runChain(oversized);
    expect(decision.status).toBe("blocked");
    expect(decision.reasons.map((r) => r.code)).toContain("not-manufacturable");
  });

  it("prints the second product's end-to-end result", () => {
    const { plan, cost, decision } = runChain(
      signConfiguration({ detail: "detail_engraved" }, 5),
    );
    const summary = {
      forgeiq: {
        product: plan.product.name,
        size: plan.selections.size,
        detail: plan.selections.detail,
        quantity: plan.quantity,
        parts: plan.parts.length,
        sheets: plan.stock?.sheetsNeeded,
        utilization: `${Math.round((plan.stock?.utilizationPct ?? 0) * 100)}%`,
        operations: plan.operations.map((o) => `${o.id}:${Math.round(o.estimatedMinutes)}m`),
      },
      costiq: {
        totalCost: cost.totalCost,
        recommendedPrice: cost.recommendedPrice,
        marginPct: `${Math.round((cost.marginPct ?? 0) * 100)}%`,
      },
      prime: { status: decision.status, reasons: decision.reasons.map((r) => r.code) },
    };
    // eslint-disable-next-line no-console
    console.log("\nSECOND PRODUCT — METAL SIGN\n" + JSON.stringify(summary, null, 2));
    expect(summary.forgeiq.quantity).toBe(5);
  });
});
