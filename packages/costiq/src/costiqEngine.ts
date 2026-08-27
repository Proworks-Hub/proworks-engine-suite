import type { ManufacturingPlan } from "@proworks/contracts";
import type { CostEngine, CostLine, CostResult } from "@proworks/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// CostIQ — cost it, margin it, price it.
//
// A first, deliberately simple costing engine. It consumes a ManufacturingPlan
// and nothing else: note that every import above is `import type`, so this
// engine has ZERO runtime dependency on ForgeIQ. It can be lifted out with its
// contracts and dropped into another application unchanged.
//
// What it does NOT do yet is listed in `assumptions` on every result, so a
// caller always knows what the number does and does not include. Machine-rate
// management, labor databases, real overhead accounting, supplier pricing,
// quantity economics, and wholesale/dealer tiers are all deferred.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostIqConfig {
  currency?: string;
  /** Applied to the sum of direct costs. CostIQ's own figure — ForgeIQ has none. */
  overheadPct?: number;
  /** Drives the recommended price: price = cost / (1 - margin). */
  targetMarginPct?: number;
  /** Used when a plan carries no advisory machine rate. */
  fallbackMachineRatePerHour?: number;
  /** Used when a plan carries no advisory labor rate. */
  fallbackLaborRatePerHour?: number;
}

const DEFAULTS = {
  currency: "USD",
  overheadPct: 0.15,
  targetMarginPct: 0.5,
  fallbackMachineRatePerHour: 0,
  fallbackLaborRatePerHour: 0,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A CostIQ instance. Narrower than the CostEngine port: this implementation is
 * synchronous, so callers get a CostResult without awaiting. It still satisfies
 * the port, so it can be injected anywhere a CostEngine is expected.
 */
export interface CostIqEngine extends CostEngine {
  calculate(plan: ManufacturingPlan): CostResult;
}

export function createCostIqEngine(config: CostIqConfig = {}): CostIqEngine {
  const settings = { ...DEFAULTS, ...config };

  return {
    name: "costiq",
    calculate(plan: ManufacturingPlan): CostResult {
      const lines: CostLine[] = [];
      const assumptions: string[] = [];
      const unpriced: string[] = [];
      const rates = plan.advisoryRates;

      // ── Material ────────────────────────────────────────────────────────
      // Stock is bought by the sheet, so the job carries the whole sheet.
      // Splitting it into consumed and wasted shows the shop what poor
      // nesting actually costs; the two lines sum to the sheets purchased.
      if (plan.stock && rates.materialCostPerSqFt !== undefined) {
        const rate = rates.materialCostPerSqFt;
        lines.push({
          code: "material-consumed",
          label: `${plan.stock.materialCategory} consumed by parts`,
          amount: round2(plan.stock.partAreaSqFt * rate),
          category: "material",
        });
        if (plan.stock.wasteAreaSqFt > 0) {
          lines.push({
            code: "material-waste",
            label: `Unused stock (${Math.round((1 - plan.stock.utilizationPct) * 100)}% of purchased sheets)`,
            amount: round2(plan.stock.wasteAreaSqFt * rate),
            category: "material",
          });
        }
        assumptions.push(
          `${plan.stock.sheetsNeeded} full sheet(s) charged to this job at $${rate.toFixed(2)}/sq ft; offcuts are not credited back to stock.`,
        );
      } else if (plan.stock) {
        unpriced.push("stock");
        assumptions.push("No material rate available — stock is not costed.");
      }

      // ── Bought-in parts ─────────────────────────────────────────────────
      for (const part of plan.parts) {
        if (part.kind === "cut-part") continue; // covered by stock
        if (part.knownUnitCost === undefined) {
          unpriced.push(part.id);
          continue;
        }
        lines.push({
          code: part.id,
          label: part.name,
          amount: round2(part.knownUnitCost * part.quantity),
          category: part.kind === "packaging" ? "packaging" : "consumable",
        });
      }

      // ── Operations: machine time, setup, and bench labor ────────────────
      // Each operation is costed at the rate that matches who does it. A job
      // may cross several machines at different hourly rates, so a machine
      // step uses its own rate before falling back to the plan's headline
      // rate — otherwise bending would be billed at laser prices.
      const machineRate = rates.machineCostPerHour ?? settings.fallbackMachineRatePerHour;
      const laborRate = rates.laborRatePerHour ?? settings.fallbackLaborRatePerHour;
      const rateFor = (op: (typeof plan.operations)[number]) =>
        op.isLabor ? laborRate : (op.advisoryRatePerHour ?? machineRate);
      const laborOps = plan.operations.filter((op) => op.isLabor);
      const unratedMachineOps = plan.operations.filter(
        (op) => !op.isLabor && rateFor(op) <= 0,
      );

      if (unratedMachineOps.length > 0) {
        unpriced.push("machine-time");
        assumptions.push(
          `No machine rate available for: ${unratedMachineOps.map((o) => o.name ?? o.id).join(", ")}.`,
        );
      }
      if (laborRate <= 0 && laborOps.length > 0) {
        unpriced.push("bench-labor");
        assumptions.push("No labor rate available — bench operations are not costed.");
      }

      for (const op of plan.operations) {
        const rate = rateFor(op);
        if (rate <= 0) continue;
        const where = op.isLabor ? "bench" : (op.machineName ?? op.machineProcess);
        lines.push({
          code: `run-${op.id}`,
          label: `${op.name ?? op.type} — ${where}`,
          amount: round2((op.estimatedMinutes / 60) * rate),
          category: op.isLabor ? "labor" : "machine",
        });
        if (op.setupMinutes > 0) {
          lines.push({
            code: `setup-${op.id}`,
            label: `${op.name ?? op.type} setup`,
            amount: round2((op.setupMinutes / 60) * rate),
            category: "setup",
          });
        }
      }
      if (plan.operations.length > 0) {
        assumptions.push(
          "Operation times are ForgeIQ's estimates; actual runtime is not yet fed back from production.",
        );
      }

      // ── Labor not already covered by the routing ────────────────────────
      // When the plan derived its labor total from labor operations, those
      // minutes are already costed above — charging the block again would
      // double count.
      if (!plan.labor.derivedFromOperations && plan.labor.estimatedMinutes > 0) {
        if (laborRate > 0) {
          lines.push({
            code: "labor",
            label: "Production labor",
            amount: round2((plan.labor.estimatedMinutes / 60) * laborRate),
            category: "labor",
          });
        } else {
          unpriced.push("labor");
          assumptions.push("No labor rate available — labor is not costed.");
        }
      }

      // ── Finishing ───────────────────────────────────────────────────────
      // ForgeIQ knows which finish was chosen but carries no finishing rates,
      // so it is reported rather than guessed at.
      for (const finish of plan.finishing) {
        unpriced.push(finish.id);
      }
      if (plan.finishing.length > 0) {
        assumptions.push(
          `Finishing (${plan.finishing.map((f) => f.name).join(", ")}) is not costed — no finishing rates exist yet.`,
        );
      }

      // ── Overhead ────────────────────────────────────────────────────────
      const directCost = lines.reduce((sum, l) => sum + l.amount, 0);
      if (settings.overheadPct > 0) {
        lines.push({
          code: "overhead",
          label: `Shop overhead (${Math.round(settings.overheadPct * 100)}%)`,
          amount: round2(directCost * settings.overheadPct),
          category: "overhead",
        });
        assumptions.push(
          `Overhead applied as a flat ${Math.round(settings.overheadPct * 100)}% of direct cost, not allocated from real shop expenses.`,
        );
      }

      // ── Totals ──────────────────────────────────────────────────────────
      const totalCost = round2(lines.reduce((sum, l) => sum + l.amount, 0));
      // CostIQ owns the economics, so an explicitly configured target margin
      // always wins. A margin recorded on the product is advisory, like every
      // other rate on the plan, and is used only when CostIQ was given none.
      const targetMarginPct =
        config.targetMarginPct ?? rates.targetMarginPct ?? DEFAULTS.targetMarginPct;
      const recommendedPrice =
        targetMarginPct < 1 ? round2(totalCost / (1 - targetMarginPct)) : totalCost;
      const margin = round2(recommendedPrice - totalCost);

      if (unpriced.length > 0) {
        assumptions.push(
          "This estimate excludes the unpriced items listed; treat it as a floor, not a complete cost.",
        );
      }

      return {
        engine: "costiq",
        resultVersion: 1,
        currency: settings.currency,
        totalCost,
        lines,
        recommendedPrice,
        margin,
        marginPct: recommendedPrice > 0 ? round2(margin / recommendedPrice) : 0,
        assumptions,
        unpriced,
      };
    },
  };
}
