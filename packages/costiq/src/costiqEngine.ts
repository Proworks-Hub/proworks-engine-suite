// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  CostEngine,
  CostLine,
  CostResult,
  EventBus,
  EventSource,
  ManufacturingPlan,
  TenantContext,
  TraceContext,
} from "@proworks-hub/contracts";
import {
  EVENT_TYPES,
  createEnginePublisher,
  newCorrelationId,
} from "@proworks-hub/contracts";
import { calculateJobCost } from "./core/costCalculator.js";
import type { OverheadModel } from "./models/jobCostInputModel.js";
import {
  manufacturingPlanToJobCostInput,
  type PlanToJobCostOptions,
} from "./adapters/manufacturingPlanAdapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// CostIQ — cost it, margin it, price it.
//
// This file is the public boundary: it consumes a ManufacturingPlan and
// returns a CostResult, and nothing else about CostIQ is visible to a caller.
// Behind it sits the mature 6-layer calculator, reached through the plan
// adapter. Every contract import above is `import type`, so CostIQ carries no
// runtime dependency on ForgeIQ.
//
// What it does NOT do yet is stated in `assumptions` on every result, so a
// caller always knows what the number does and does not include. Machine-rate
// management, labor databases, real overhead allocation, supplier pricing,
// quantity economics, and wholesale/dealer tiers remain ahead.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostIqConfig {
  currency?: string;
  /** Applied to the sum of direct costs. CostIQ's own figure — ForgeIQ has none. */
  overheadPct?: number;
  /** Drives the recommended price: price = cost / (1 - margin). */
  targetMarginPct?: number;
  /** Used when the plan carries no advisory machine rate. */
  fallbackMachineRatePerHour?: number;
  /** Used when the plan carries no advisory labor rate. */
  fallbackLaborRatePerHour?: number;
  /** Identifies the shop when a plan is costed for a specific tenant. */
  tenantId?: string;
  /**
   * Where to announce a completed calculation. Optional: with no bus, CostIQ
   * publishes nothing and behaves exactly as before.
   */
  eventBus?: EventBus;
  eventSource?: EventSource;
  /** Publication is best-effort; failures are reported here, never thrown. */
  onPublishError?: (error: Error, eventType: string) => void;
}

const DEFAULTS = {
  currency: "USD",
  overheadPct: 0.15,
  targetMarginPct: 0.5,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A CostIQ instance. Narrower than the CostEngine port: this implementation is
 * synchronous, so callers get a CostResult without awaiting. It still satisfies
 * the port, so it can be injected anywhere a CostEngine is expected.
 */
export interface CostIqEngine extends CostEngine {
  calculate(plan: ManufacturingPlan, context?: CostPublishContext): CostResult;
}

/** Request-scoped context. Supplied per call, because a tenant is not a config. */
export interface CostPublishContext {
  tenant?: TenantContext;
  trace?: TraceContext;
}

export function createCostIqEngine(config: CostIqConfig = {}): CostIqEngine {
  const overheadPct = config.overheadPct ?? DEFAULTS.overheadPct;
  const overhead: OverheadModel =
    overheadPct > 0 ? { kind: "percent_of_direct", percent: overheadPct } : { kind: "none" };

  const adapterOptions: PlanToJobCostOptions = {
    tenantId: config.tenantId,
    overhead,
    fallbackMachineRatePerHour: config.fallbackMachineRatePerHour,
    fallbackLaborRatePerHour: config.fallbackLaborRatePerHour,
  };

  const publish = createEnginePublisher({
    ...(config.eventBus ? { bus: config.eventBus } : {}),
    source: config.eventSource ?? { service: "costiq" },
    ...(config.onPublishError ? { onPublishError: config.onPublishError } : {}),
  });

  return {
    name: "costiq",
    calculate(plan: ManufacturingPlan, context: CostPublishContext = {}): CostResult {
      const { input, materialCategories, unpriced, assumptions } =
        manufacturingPlanToJobCostInput(plan, adapterOptions);

      // The mature 6-layer calculator owns the arithmetic.
      const breakdown = calculateJobCost(input);

      // Lines are built from the same input the calculator consumed, so they
      // reconcile to its total by construction rather than by coincidence.
      const lines: CostLine[] = [];

      for (const material of input.materials) {
        lines.push({
          code: material.materialId,
          label: material.name,
          amount: round2(material.quantity * material.unitCost * material.wasteFactor),
          category: materialCategories[material.materialId] ?? "material",
        });
      }

      for (const station of input.workstations) {
        lines.push({
          code: `run-${station.stationId}`,
          label: `${station.stationId} run time`,
          amount: round2(station.minutes * station.profile.ratePerMinute),
          category: "machine",
        });
        const setup = station.profile.setup;
        if (setup) {
          lines.push({
            code: `setup-${station.stationId}`,
            label: `${station.stationId} setup`,
            amount: round2(setup.flatCost ?? setup.timeMinutes * setup.ratePerMinute),
            category: "setup",
          });
        }
      }

      for (const entry of input.labor) {
        lines.push({
          code: `labor-${entry.stationId}`,
          label: `${entry.stationId} labor`,
          amount: round2(entry.minutes * entry.loadedRatePerMinute),
          category: "labor",
        });
      }

      if (breakdown.overheadCost > 0) {
        lines.push({
          code: "overhead",
          label: `Shop overhead (${Math.round(overheadPct * 100)}%)`,
          amount: round2(breakdown.overheadCost),
          category: "overhead",
        });
      }

      const totalCost = round2(breakdown.totalCost);
      // CostIQ owns the economics, so an explicitly configured target margin
      // always wins. A margin recorded on the product is advisory, like every
      // other rate on the plan, and is used only when CostIQ was given none.
      const targetMarginPct =
        config.targetMarginPct ?? plan.advisoryRates.targetMarginPct ?? DEFAULTS.targetMarginPct;
      const recommendedPrice =
        targetMarginPct < 1 ? round2(totalCost / (1 - targetMarginPct)) : totalCost;
      const margin = round2(recommendedPrice - totalCost);

      if (unpriced.length > 0) {
        assumptions.push(
          "This estimate excludes the unpriced items listed; treat it as a floor, not a complete cost.",
        );
      }

      const result: CostResult = {
        engine: "costiq",
        resultVersion: 1,
        currency: config.currency ?? DEFAULTS.currency,
        totalCost,
        lines,
        recommendedPrice,
        margin,
        marginPct: recommendedPrice > 0 ? round2(margin / recommendedPrice) : 0,
        assumptions,
        unpriced,
      };

      publish({
        eventType: EVENT_TYPES.costCalculationCompleted,
        ...(context.tenant ? { tenant: context.tenant } : {}),
        trace: context.trace ?? plan.trace ?? { correlationId: newCorrelationId() },
        aggregate: { type: "cost-result", id: String(plan.configurationId ?? plan.product.slug) },
        payload: {
          engine: "costiq",
          subject: String(plan.configurationId ?? plan.product.slug),
          totalCost: { cents: Math.round(totalCost * 100), currency: result.currency },
          ...(result.recommendedPrice !== undefined
            ? {
                recommendedPrice: {
                  cents: Math.round(result.recommendedPrice * 100),
                  currency: result.currency,
                },
              }
            : {}),
          // Carried so a consumer knows this is a floor, not a total, without
          // having to re-derive it from the lines.
          unpricedCount: unpriced.length,
          assumptionCount: assumptions.length,
        },
      });

      return result;
    },
  };
}
