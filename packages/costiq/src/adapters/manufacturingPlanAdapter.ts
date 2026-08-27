import type { CostLine, ManufacturingPlan } from "@proworks/contracts";
import type {
  JobCostInput,
  LaborTime,
  MaterialUsage,
  OverheadModel,
  WorkstationUsage,
} from "../models/jobCostInputModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// The join between the two CostIQ layers.
//
// ForgeIQ describes what manufacturing REQUIRES — sheets, parts, operations,
// minutes. The mature calculator costs what a job CONSUMES — materials, labor,
// workstation time, setup, overhead. This adapter translates the first into
// the second so a ForgeIQ plan can be costed by the same engine that costs a
// shop-floor work order.
//
// It exists in neither implementation on its own: ForgeIQ never knew about
// JobCostInput, and the calculator never knew about ManufacturingPlan.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanToJobCostOptions {
  tenantId?: string;
  /** How overhead is applied. Defaults to 15% of direct cost. */
  overhead?: OverheadModel;
  /** Used when the plan carries no machine rate for an operation. */
  fallbackMachineRatePerHour?: number;
  /** Used when the plan carries no labor rate. */
  fallbackLaborRatePerHour?: number;
}

export interface PlanToJobCostResult {
  input: JobCostInput;
  /** Cost-line category per material id, so the engine can label correctly. */
  materialCategories: Record<string, CostLine["category"]>;
  /** Anything the plan could not supply a rate or price for. */
  unpriced: string[];
  /** What the translation assumed, carried through to the CostResult. */
  assumptions: string[];
}

const DEFAULT_OVERHEAD: OverheadModel = { kind: "percent_of_direct", percent: 0.15 };

/** No waste multiplier — the plan already accounts for stock yield explicitly. */
const NO_WASTE_MULTIPLIER = 1;

export function manufacturingPlanToJobCostInput(
  plan: ManufacturingPlan,
  options: PlanToJobCostOptions = {},
): PlanToJobCostResult {
  const rates = plan.advisoryRates;
  const materials: MaterialUsage[] = [];
  const materialCategories: Record<string, CostLine["category"]> = {};
  const workstations: WorkstationUsage[] = [];
  const labor: LaborTime[] = [];
  const unpriced: string[] = [];
  const assumptions: string[] = [];

  // ── Stock ────────────────────────────────────────────────────────────────
  // Split into what the parts consume and what the purchased sheets waste.
  // The two sum to the sheets actually bought, so the total is unchanged while
  // the shop can see what poor nesting costs.
  if (plan.stock && rates.materialCostPerSqFt !== undefined) {
    const rate = rates.materialCostPerSqFt;
    const consumedId = `stock:${plan.stock.materialCategory}`;
    materials.push({
      materialId: consumedId,
      name: `${plan.stock.materialCategory} consumed by parts`,
      quantity: plan.stock.partAreaSqFt,
      unitCost: rate,
      wasteFactor: NO_WASTE_MULTIPLIER,
    });
    materialCategories[consumedId] = "material";

    if (plan.stock.wasteAreaSqFt > 0) {
      const wasteId = `stock-waste:${plan.stock.materialCategory}`;
      materials.push({
        materialId: wasteId,
        name: `Unused stock (${Math.round((1 - plan.stock.utilizationPct) * 100)}% of purchased sheets)`,
        quantity: plan.stock.wasteAreaSqFt,
        unitCost: rate,
        wasteFactor: NO_WASTE_MULTIPLIER,
      });
      materialCategories[wasteId] = "material";
    }
    assumptions.push(
      `${plan.stock.sheetsNeeded} full sheet(s) charged to this job at $${rate.toFixed(2)}/sq ft; offcuts are not credited back to stock.`,
    );
  } else if (plan.stock) {
    unpriced.push("stock");
    assumptions.push("No material rate available — stock is not costed.");
  }

  // ── Bought-in parts ──────────────────────────────────────────────────────
  for (const part of plan.parts) {
    if (part.kind === "cut-part") continue; // covered by stock
    if (part.knownUnitCost === undefined) {
      unpriced.push(part.id);
      continue;
    }
    materials.push({
      materialId: part.id,
      name: part.name,
      quantity: part.quantity,
      unitCost: part.knownUnitCost,
      wasteFactor: NO_WASTE_MULTIPLIER,
    });
    materialCategories[part.id] = part.kind === "packaging" ? "packaging" : "consumable";
  }

  // ── Operations ───────────────────────────────────────────────────────────
  // Machine steps become workstation usage at their own machine's rate; bench
  // steps become labor. Setup rides on the workstation profile so the
  // calculator charges it once per job rather than per unit.
  const laborRate = rates.laborRatePerHour ?? options.fallbackLaborRatePerHour ?? 0;

  for (const op of plan.operations) {
    if (op.isLabor) {
      if (laborRate <= 0) {
        unpriced.push(`labor:${op.id}`);
        continue;
      }
      labor.push({
        stationId: op.id,
        employeeId: null,
        minutes: op.estimatedMinutes + op.setupMinutes,
        loadedRatePerMinute: laborRate / 60,
      });
      continue;
    }

    const ratePerHour =
      op.advisoryRatePerHour ?? rates.machineCostPerHour ?? options.fallbackMachineRatePerHour ?? 0;
    if (ratePerHour <= 0) {
      unpriced.push(`machine:${op.id}`);
      continue;
    }
    const ratePerMinute = ratePerHour / 60;
    workstations.push({
      stationId: op.id,
      profile: {
        stationId: op.id,
        ratePerMinute,
        ratePerUnit: 0,
        minimumCharge: null,
        setup:
          op.setupMinutes > 0
            ? { flatCost: null, timeMinutes: op.setupMinutes, ratePerMinute }
            : null,
        cleanup: null,
        consumables: [],
      },
      minutes: op.estimatedMinutes,
      units: plan.quantity,
      consumables: [],
    });
  }

  // Labor the routing did not already account for.
  if (!plan.labor.derivedFromOperations && plan.labor.estimatedMinutes > 0) {
    if (laborRate > 0) {
      labor.push({
        stationId: "production-labor",
        employeeId: null,
        minutes: plan.labor.estimatedMinutes,
        loadedRatePerMinute: laborRate / 60,
      });
    } else {
      unpriced.push("labor");
    }
  }

  if (plan.operations.length > 0) {
    assumptions.push(
      "Operation times are ForgeIQ's estimates; actual runtime is not yet fed back from production.",
    );
  }

  // ── Finishing ────────────────────────────────────────────────────────────
  // The plan names the finish but carries no finishing rates, so it is
  // reported rather than guessed at.
  for (const finish of plan.finishing) unpriced.push(finish.id);
  if (plan.finishing.length > 0) {
    assumptions.push(
      `Finishing (${plan.finishing.map((f) => f.name).join(", ")}) is not costed — no finishing rates exist yet.`,
    );
  }

  const overhead = options.overhead ?? DEFAULT_OVERHEAD;
  if (overhead.kind === "percent_of_direct") {
    assumptions.push(
      `Overhead applied as a flat ${Math.round(overhead.percent * 100)}% of direct cost, not allocated from real shop expenses.`,
    );
  }

  return {
    input: {
      workOrderId:
        plan.configurationId !== undefined
          ? `configuration-${plan.configurationId}`
          : plan.product.slug,
      tenantId: options.tenantId ?? "default",
      quantity: plan.quantity,
      materials,
      labor,
      workstations,
      overhead,
    },
    materialCategories,
    unpriced,
    assumptions,
  };
}
