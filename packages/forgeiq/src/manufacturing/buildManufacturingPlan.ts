import type { ProductDefinition, ProductOperation } from "../core/schemas/productDefinition.js";
import { operationTypeSchema } from "../core/schemas/productDefinition.js";
import type { ProductConfiguration } from "../core/schemas/configuration.js";
import type { MaterialProfileSpecs } from "../core/schemas/materialProfile.js";
import type { MachineProfileSpecs } from "../core/schemas/machineProfile.js";
import type { ValidationResult } from "../core/validation/types.js";
import {
  resolveMachineProfileId,
  resolveMaterialProfileId,
  selectedOptionValues,
  totalSurfaceAreaSqFt,
} from "../core/resolve.js";
import { buildBillOfMaterials } from "../core/production/bom.js";
import {
  manufacturingPlanSchema,
  PLAN_VERSION,
  type ManufacturingPlan,
  type PlanOperation,
  type PlanPart,
  type PlanStock,
} from "@proworks/contracts";

// ForgeIQ's producer for the shared ManufacturingPlan contract. The contract
// itself lives in @proworks/contracts so CostIQ, Prime, and hosts can consume
// a plan without depending on the engine that built it.

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
  /**
   * Every machine profile the product's operations may reference, so a job
   * can route across several. Omit for single-machine products: operations
   * then resolve to `machine`, which is how plans behaved before routing
   * could name a machine.
   */
  machines?: Map<number, { name?: string; specs: MachineProfileSpecs }>;
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

  // An operation runs on the machine it names, falling back to the product's
  // primary machine. Bench work names none.
  const resolveOperationMachine = (op: ProductOperation) => {
    if (op.labor) return undefined;
    if (op.machineProfileId !== undefined) {
      const entry = input.machines?.get(op.machineProfileId);
      if (entry) {
        return { profileId: op.machineProfileId, name: entry.name, specs: entry.specs };
      }
    }
    return { profileId: machineId, name: input.machineName, specs: machine };
  };

  const operations: PlanOperation[] = declared.length
    ? declared
        .filter(
          (op) => !op.requiresOptionValueId || selectedValueIds.has(op.requiresOptionValueId),
        )
        .map((op) => {
          const on = resolveOperationMachine(op);
          return {
            id: op.id,
            name: op.name,
            type: op.type,
            machineProcess: op.process ?? on?.specs.process ?? "bench",
            machineName: on?.name,
            machineProfileId: on?.profileId,
            advisoryRatePerHour: on?.specs.costPerHour,
            estimatedMinutes: round4(operationMinutes(op, { areaSqFt, quantity, parts })),
            setupMinutes: op.setupMinutes,
            isLabor: op.labor,
            note: op.note,
          };
        })
    : [
        {
          id: "primary",
          type: operationTypeSchema.parse(
            definition.manufacturingProcess.includes("cut") ? "cut" : "engrave",
          ),
          machineProcess: machine.process,
          machineName: input.machineName,
          machineProfileId: machineId,
          advisoryRatePerHour: machine.costPerHour,
          estimatedMinutes: round4(knobs.estMachineMinutesPerSqFt * areaSqFt * quantity),
          setupMinutes: knobs.setupMinutes,
          isLabor: false,
          note: "Derived from the product's time estimate; no routing is declared.",
        },
      ];

  // Every distinct machine the routing touches, in first-use order — what a
  // scheduler needs to know before it can slot this job anywhere.
  const machinesUsed: ManufacturingPlan["machines"] = [];
  for (const op of operations) {
    if (op.isLabor) continue;
    const alreadyListed = machinesUsed.some((m) =>
      op.machineProfileId !== undefined
        ? m.profileId === op.machineProfileId
        : m.process === op.machineProcess,
    );
    if (alreadyListed) continue;
    const specs =
      op.machineProfileId !== undefined
        ? (input.machines?.get(op.machineProfileId)?.specs ?? machine)
        : machine;
    machinesUsed.push({
      profileId: op.machineProfileId,
      name: op.machineName,
      process: op.machineProcess,
      workAreaWidthIn: specs.workAreaWidthIn,
      workAreaHeightIn: specs.workAreaHeightIn,
    });
  }

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
    machines: machinesUsed,
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
