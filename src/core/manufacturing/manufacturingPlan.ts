import { z } from "zod";
import {
  operationTypeSchema,
  type ProductDefinition,
  type ProductOperation,
} from "../schemas/productDefinition";
import type { ProductConfiguration } from "../schemas/configuration";
import type { MaterialProfileSpecs } from "../schemas/materialProfile";
import type { MachineProfileSpecs } from "../schemas/machineProfile";
import type { ValidationResult } from "../validation/types";
import {
  resolveMachineProfileId,
  resolveMaterialProfileId,
  selectedOptionValues,
  totalSurfaceAreaSqFt,
} from "../resolve";
import { buildBillOfMaterials } from "../production/bom";

// ─────────────────────────────────────────────────────────────────────────────
// ManufacturingPlan — ForgeIQ's normalized output, and the contract a costing
// engine (CostIQ) consumes.
//
// ForgeIQ answers: what is being built, can we make it, and what does making
// it require? The plan therefore describes REQUIREMENTS AND QUANTITIES —
// parts, sheets, minutes, operations — not money.
//
// Rates the host happens to have recorded on its machine and material
// profiles are passed through under `advisoryRates`, clearly marked: a
// costing engine may use them when it has nothing better, but it owns the
// economics and is free to ignore them entirely.
//
// A consumer of this plan needs no knowledge of the builder UI, the host
// application, or how the customer arrived at this configuration.
// ─────────────────────────────────────────────────────────────────────────────

export const PLAN_VERSION = 1;

export const planPartSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "cut-part" parts are nested onto stock; the rest are bought in. */
  kind: z.enum(["cut-part", "hardware", "consumable", "packaging"]),
  /** Total across the whole order (perUnit × quantity). */
  quantity: z.number().int().min(0),
  perUnit: z.number().min(0),
  widthIn: z.number().positive().optional(),
  heightIn: z.number().positive().optional(),
  /** Area of a single part, when it has dimensions. */
  areaSqFt: z.number().min(0).optional(),
  /** Cost the host recorded for a bought-in item, if any. Advisory. */
  knownUnitCost: z.number().min(0).optional(),
  note: z.string().optional(),
});

export const planStockSchema = z.object({
  materialName: z.string().optional(),
  materialCategory: z.string(),
  thicknessIn: z.number().positive(),
  sheetWidthIn: z.number().positive(),
  sheetHeightIn: z.number().positive(),
  sheetsNeeded: z.number().int().min(0),
  partAreaSqFt: z.number().min(0),
  sheetAreaSqFt: z.number().min(0),
  /** Purchased area the parts do not consume. */
  wasteAreaSqFt: z.number().min(0),
  utilizationPct: z.number().min(0).max(1),
  /** Parts that do not fit the stock in any orientation. */
  oversizedPartIds: z.array(z.string()),
});

export const planOperationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: operationTypeSchema,
  /** Machine process this runs on; "bench" when no machine is involved. */
  machineProcess: z.string(),
  machineName: z.string().optional(),
  /** Run time across the whole order, excluding setup. */
  estimatedMinutes: z.number().min(0),
  /** Once-per-job setup, not multiplied by quantity. */
  setupMinutes: z.number().min(0),
  /**
   * Bench work — costed at a labor rate, not a machine rate. Its minutes are
   * also summed into `labor.estimatedMinutes`, so a costing engine must not
   * charge both (see `labor.derivedFromOperations`).
   */
  isLabor: z.boolean().default(false),
  note: z.string().optional(),
});

export const planLaborSchema = z.object({
  estimatedMinutes: z.number().min(0),
  /**
   * True when this total is the sum of the plan's own labor operations. A
   * costing engine should then cost those operations and skip this block,
   * rather than counting the same minutes twice.
   */
  derivedFromOperations: z.boolean().default(false),
  note: z.string().optional(),
});

// Rates ForgeIQ happens to know from the host's profiles. Present so a
// costing engine can bootstrap; never authoritative.
export const planAdvisoryRatesSchema = z.object({
  materialCostPerSqFt: z.number().min(0).optional(),
  sheetCost: z.number().min(0).optional(),
  machineCostPerHour: z.number().min(0).optional(),
  laborRatePerHour: z.number().min(0).optional(),
  targetMarginPct: z.number().min(0).max(1).optional(),
});

export const manufacturingPlanSchema = z.object({
  planVersion: z.literal(PLAN_VERSION),
  product: z.object({
    definitionId: z.number().int().optional(),
    slug: z.string(),
    name: z.string(),
    version: z.number().int().optional(),
    category: z.string(),
    manufacturingProcess: z.string(),
  }),
  configurationId: z.number().int().optional(),
  quantity: z.number().int().min(1),
  /** Resolved customer choices, id → label, for traceability. */
  selections: z.record(z.string()),
  material: z
    .object({
      profileId: z.number().int().optional(),
      name: z.string().optional(),
      category: z.string(),
      thicknessIn: z.number().positive(),
    })
    .nullable(),
  machine: z
    .object({
      profileId: z.number().int().optional(),
      name: z.string().optional(),
      process: z.string(),
      workAreaWidthIn: z.number().positive(),
      workAreaHeightIn: z.number().positive(),
    })
    .nullable(),
  parts: z.array(planPartSchema),
  stock: planStockSchema.nullable(),
  operations: z.array(planOperationSchema),
  labor: planLaborSchema,
  /** Finishing selected by the customer, e.g. "High-temp black coating". */
  finishing: z.array(z.object({ id: z.string(), name: z.string() })),
  advisoryRates: planAdvisoryRatesSchema,
  manufacturability: z.object({
    valid: z.boolean(),
    errors: z.number().int().min(0),
    warnings: z.number().int().min(0),
  }),
  /**
   * True when no bill of materials was defined and quantities were inferred
   * from panel area alone. A costing engine should treat such a plan as a
   * rough estimate.
   */
  estimatedFromArea: z.boolean(),
});

export type ManufacturingPlan = z.infer<typeof manufacturingPlanSchema>;
export type PlanPart = z.infer<typeof planPartSchema>;
export type PlanStock = z.infer<typeof planStockSchema>;
export type PlanOperation = z.infer<typeof planOperationSchema>;

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Run time for one declared operation, measured against whatever it actually
 * scales with. Part-based operations count the parts already expanded into
 * the plan, so a per-surface component contributes once per surface.
 */
function operationMinutes(
  op: ProductOperation,
  ctx: { areaSqFt: number; quantity: number; parts: PlanPart[] },
): number {
  switch (op.time.basis) {
    case "per-sq-ft":
      return op.time.minutesPerSqFt * ctx.areaSqFt * ctx.quantity;
    case "per-unit":
      return op.time.minutesPerUnit * ctx.quantity;
    case "fixed":
      return op.time.minutes;
    case "per-part": {
      const wanted = op.time.partIds;
      const count = ctx.parts
        .filter((part) => {
          if (part.kind !== "cut-part") return false;
          if (!wanted) return true;
          // Per-surface components expand to "<componentId>:<surfaceId>".
          const componentId = part.id.split(":")[0];
          return wanted.includes(componentId) || wanted.includes(part.id);
        })
        .reduce((sum, part) => sum + part.quantity, 0);
      return op.time.minutesPerPart * count;
    }
  }
}

export interface BuildManufacturingPlanInput {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
  materials: Map<number, MaterialProfileSpecs>;
  machine: MachineProfileSpecs;
  /** Identity from the host's persistence layer, when available. */
  productDefinitionId?: number;
  productVersion?: number;
  configurationId?: number;
  materialName?: string;
  machineName?: string;
  /** Result of a validation pass, when the caller already ran one. */
  validation?: ValidationResult;
}

/**
 * Normalizes a configured product into the manufacturing requirements a
 * costing engine needs. Contains no pricing and no host concepts.
 */
export function buildManufacturingPlan(
  input: BuildManufacturingPlanInput,
): ManufacturingPlan {
  const { definition, configuration, materials, machine } = input;
  const quantity = configuration.quantity;

  const materialId = resolveMaterialProfileId(definition, configuration);
  const material = materialId !== undefined ? materials.get(materialId) : undefined;
  const machineId = resolveMachineProfileId(definition, configuration);

  const bom = buildBillOfMaterials({
    definition,
    configuration,
    materials,
    materialName: input.materialName,
  });

  // Selections, and the finishing among them, in customer-facing labels.
  const selected = selectedOptionValues(definition, configuration);
  const selections: Record<string, string> = {};
  for (const group of definition.optionGroups) {
    const value = selected.find((v) => group.values.some((gv) => gv.id === v.id));
    if (value) selections[group.id] = value.label;
  }
  const finishGroup = definition.optionGroups.find((g) => /finish/i.test(g.id));
  const finishValue = finishGroup
    ? selected.find((v) => finishGroup.values.some((gv) => gv.id === v.id))
    : undefined;

  const parts: PlanPart[] = bom.items.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    quantity: item.quantity,
    perUnit: item.perUnit,
    widthIn: item.dimensionsIn?.widthIn,
    heightIn: item.dimensionsIn?.heightIn,
    areaSqFt: item.dimensionsIn
      ? round4((item.dimensionsIn.widthIn * item.dimensionsIn.heightIn) / 144)
      : undefined,
    knownUnitCost: item.unitCost,
    note: item.note,
  }));

  const stock: PlanStock | null =
    bom.stock && material
      ? {
          materialName: input.materialName,
          materialCategory: material.category,
          thicknessIn: material.thicknessIn,
          sheetWidthIn: material.sheetWidthIn,
          sheetHeightIn: material.sheetHeightIn,
          sheetsNeeded: bom.stock.sheetsNeeded,
          partAreaSqFt: round4(bom.stock.partAreaSqFt),
          sheetAreaSqFt: round4(bom.stock.sheetAreaSqFt),
          wasteAreaSqFt: round4(Math.max(0, bom.stock.sheetAreaSqFt - bom.stock.partAreaSqFt)),
          utilizationPct: round4(bom.stock.utilizationPct),
          oversizedPartIds: bom.stock.oversizedPartIds,
        }
      : null;

  // Time estimates currently live in the definition's pricing block (see the
  // note in README about relocating them to a production block later); they
  // are manufacturing facts, so the plan reports them as such.
  const knobs = definition.pricing.internalCost;
  const areaSqFt = totalSurfaceAreaSqFt(definition, configuration);

  // A product declares its own routing. Definitions written before routing
  // existed — including rows already persisted — fall back to the single
  // derived operation the plan has always reported.
  const declared = definition.operations ?? [];
  const selectedValueIds = new Set(selected.map((v) => v.id));
  const operations: PlanOperation[] = declared.length
    ? declared
        .filter(
          (op) => !op.requiresOptionValueId || selectedValueIds.has(op.requiresOptionValueId),
        )
        .map((op) => ({
          id: op.id,
          name: op.name,
          type: op.type,
          machineProcess: op.process ?? (op.labor ? "bench" : machine.process),
          machineName: op.process === undefined && !op.labor ? input.machineName : undefined,
          estimatedMinutes: round4(
            operationMinutes(op, { areaSqFt, quantity, parts }),
          ),
          setupMinutes: op.setupMinutes,
          isLabor: op.labor,
          note: op.note,
        }))
    : [
        {
          id: "primary",
          type: operationTypeSchema.parse(
            definition.manufacturingProcess.includes("cut") ? "cut" : "engrave",
          ),
          machineProcess: machine.process,
          machineName: input.machineName,
          estimatedMinutes: round4(knobs.estMachineMinutesPerSqFt * areaSqFt * quantity),
          setupMinutes: knobs.setupMinutes,
          isLabor: false,
          note: "Derived from the product's time estimate; no routing is declared.",
        },
      ];

  // Labor follows the routing when there is any, so the two never disagree.
  const laborOperations = operations.filter((op) => op.isLabor);
  const labor = laborOperations.length
    ? {
        estimatedMinutes: round4(
          laborOperations.reduce((sum, op) => sum + op.estimatedMinutes + op.setupMinutes, 0),
        ),
        derivedFromOperations: true,
      }
    : { estimatedMinutes: round4(knobs.laborMinutes * quantity), derivedFromOperations: false };

  return manufacturingPlanSchema.parse({
    planVersion: PLAN_VERSION,
    product: {
      definitionId: input.productDefinitionId,
      slug: definition.slug,
      name: definition.name,
      version: input.productVersion,
      category: definition.category,
      manufacturingProcess: definition.manufacturingProcess,
    },
    configurationId: input.configurationId,
    quantity,
    selections,
    material: material
      ? {
          profileId: materialId,
          name: input.materialName,
          category: material.category,
          thicknessIn: material.thicknessIn,
        }
      : null,
    machine: {
      profileId: machineId,
      name: input.machineName,
      process: machine.process,
      workAreaWidthIn: machine.workAreaWidthIn,
      workAreaHeightIn: machine.workAreaHeightIn,
    },
    parts,
    stock,
    operations,
    labor,
    finishing: finishValue ? [{ id: finishValue.id, name: finishValue.label }] : [],
    advisoryRates: {
      materialCostPerSqFt: material?.costPerSqFt,
      sheetCost: bom.stock?.sheetCost,
      machineCostPerHour: machine.costPerHour,
      laborRatePerHour: knobs.laborRatePerHour,
      targetMarginPct: knobs.targetMarginPct,
    },
    manufacturability: {
      valid: input.validation?.valid ?? true,
      errors: input.validation?.issues.filter((i) => i.severity === "error").length ?? 0,
      warnings: input.validation?.issues.filter((i) => i.severity === "warning").length ?? 0,
    },
    estimatedFromArea: bom.estimatedFromArea,
  });
}
