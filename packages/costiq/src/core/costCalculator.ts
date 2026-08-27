/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/costCalculator.ts
 * Module:   cost-iq-engine / core
 * Purpose:  The 6-layer job cost calculation engine. Pure function:
 *           given a fully-resolved `JobCostInput`, returns a complete
 *           `CostBreakdown`. No I/O, no async, no service lookups.
 *           This is the foundational math piece that the pricing /
 *           margin / batch calculators (Phase 1 PR 2 + 3) layer on top.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. All product decisions, business logic, domain rules,
 * workflows, and architecture were defined by Steven. AI tools (Cursor,
 * Claude, Codex, ChatGPT, Perplexity) were used strictly as coding
 * assistants — comparable to working with a hired developer — and hold
 * no rights, claim, license, or beneficial interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 * Library and framework imports remain governed by their respective
 * licenses; no third-party source code has been copied, adapted, or
 * paraphrased into this file.
 */

/**
 * Layer:        Pure calculator (Cost IQ engine, Phase 1 foundation)
 * Imported by:  cost-iq-engine/core/pricingEngine (PR 3) + tests
 * Depends on:   models/jobCostInputModel + models/workstationCostModel
 *               + models/costBreakdownModel
 * Stability:    CANONICAL (Phase 1)
 *
 * Algorithm overview (matches §6 of docs/COST-IQ-ENGINE-SPEC.md)
 * --------------------------------------------------------------
 *   Layer 1 — Materials:        Σ(quantity × unitCost × wasteFactor)
 *   Layer 2 — Consumables:      Σ over each workstation's active
 *                               consumables, indexed by usage entry.
 *                               Most methods are linear; the
 *                               `percent_of_station_use` method takes
 *                               a cut of Layer 3's station cost.
 *   Layer 3 — Station usage:    minutes × ratePerMinute
 *                             + units   × ratePerUnit
 *                             clamped up to `minimumCharge` if set.
 *   Layer 4 — Labor:            Σ(minutes × loadedRatePerMinute)
 *   Layer 5 — Setup + cleanup:  flatCost OR (timeMinutes × ratePerMinute)
 *                               per workstation that has a rule.
 *   directCost = sum(L1..L5)
 *   Layer 6 — Overhead:         derived from `OverheadModel` against
 *                               directCost / labor minutes / machine
 *                               minutes (whichever the model needs).
 *   totalCost = directCost + overheadCost
 *
 * Determinism, purity, and rounding
 * ---------------------------------
 * The calculator is fully deterministic — same input, same output. No
 * date, no random, no mutable state. Every value is a Number; the
 * engine does NOT round at intermediate steps. Callers that need to
 * present rounded prices to users are responsible for rounding at the
 * display boundary.
 *
 * Defensive behaviors
 * -------------------
 * - Empty arrays produce zero contribution (sum of nothing).
 * - Inactive consumables are skipped silently.
 * - A `ConsumableUsage` referencing a `consumableId` that is not on
 *   the workstation's profile is skipped silently. (This protects
 *   against the rare race where a consumable was removed mid-job.)
 * - Negative inputs are NOT validated — the calculator trusts callers
 *   to supply non-negative quantities and rates. Validation is the
 *   intake layer's responsibility.
 */

import type { CostBreakdown } from "../models/costBreakdownModel.js";
import type {
  JobCostInput,
  LaborTime,
  MaterialUsage,
  OverheadModel,
  WorkstationUsage,
} from "../models/jobCostInputModel.js";
import type {
  TimedCostRule,
  WorkstationConsumable,
} from "../models/workstationCostModel.js";

// ---------- Public entry ----------

/**
 * Compute a complete cost breakdown for a job. Synchronous and pure.
 */
export function calculateJobCost(input: JobCostInput): CostBreakdown {
  const materialCost = sumMaterialCost(input.materials);
  const consumableCost = sumConsumableCost(input.workstations);
  const stationUsageCost = sumStationUsageCost(input.workstations);
  const laborCost = sumLaborCost(input.labor);
  const setupCleanupCost = sumSetupCleanupCost(input.workstations);

  const directCost =
    materialCost
    + consumableCost
    + stationUsageCost
    + laborCost
    + setupCleanupCost;

  const overheadCost = applyOverhead(input.overhead, {
    directCost,
    laborMinutes: sumLaborMinutes(input.labor),
    machineMinutes: sumMachineMinutes(input.workstations),
  });

  const totalCost = directCost + overheadCost;

  return Object.freeze({
    materialCost,
    consumableCost,
    stationUsageCost,
    laborCost,
    setupCleanupCost,
    directCost,
    overheadCost,
    totalCost,
  });
}

// ---------- Layer 1 — Materials ----------

function sumMaterialCost(materials: ReadonlyArray<MaterialUsage>): number {
  let total = 0;
  for (const m of materials) {
    total += m.quantity * m.unitCost * m.wasteFactor;
  }
  return total;
}

// ---------- Layer 2 — Workstation consumables ----------

function sumConsumableCost(workstations: ReadonlyArray<WorkstationUsage>): number {
  let total = 0;
  for (const ws of workstations) {
    const consumablesById = new Map<string, WorkstationConsumable>();
    for (const c of ws.profile.consumables) {
      consumablesById.set(c.id, c);
    }
    for (const usage of ws.consumables) {
      const consumable = consumablesById.get(usage.consumableId);
      if (!consumable || !consumable.active) continue;
      total += computeConsumableLineCost(consumable, usage.basisUnits, ws);
    }
  }
  return total;
}

function computeConsumableLineCost(
  consumable: WorkstationConsumable,
  basisUnits: number,
  ws: WorkstationUsage,
): number {
  // Special case: percent_of_station_use is a cut of the workstation's
  // own Layer-3 cost, not a per-basis line. costPerUnit is interpreted
  // as a 0..1 fraction here (e.g., 0.05 = 5%).
  if (consumable.costMethod === "percent_of_station_use") {
    const stationCost = computeStationUsageCost(ws);
    return stationCost * consumable.costPerUnit * consumable.wasteFactor;
  }
  return basisUnits * consumable.costPerUnit * consumable.wasteFactor;
}

// ---------- Layer 3 — Station usage ----------

function sumStationUsageCost(workstations: ReadonlyArray<WorkstationUsage>): number {
  let total = 0;
  for (const ws of workstations) {
    total += computeStationUsageCost(ws);
  }
  return total;
}

function computeStationUsageCost(ws: WorkstationUsage): number {
  const minuteCost = ws.minutes * ws.profile.ratePerMinute;
  const unitCost = ws.units * ws.profile.ratePerUnit;
  const raw = minuteCost + unitCost;
  if (ws.profile.minimumCharge !== null && raw < ws.profile.minimumCharge) {
    return ws.profile.minimumCharge;
  }
  return raw;
}

// ---------- Layer 4 — Labor ----------

function sumLaborCost(labor: ReadonlyArray<LaborTime>): number {
  let total = 0;
  for (const l of labor) {
    total += l.minutes * l.loadedRatePerMinute;
  }
  return total;
}

function sumLaborMinutes(labor: ReadonlyArray<LaborTime>): number {
  let total = 0;
  for (const l of labor) total += l.minutes;
  return total;
}

// ---------- Layer 5 — Setup + cleanup ----------

function sumSetupCleanupCost(workstations: ReadonlyArray<WorkstationUsage>): number {
  let total = 0;
  for (const ws of workstations) {
    if (ws.profile.setup) total += computeTimedCost(ws.profile.setup);
    if (ws.profile.cleanup) total += computeTimedCost(ws.profile.cleanup);
  }
  return total;
}

function computeTimedCost(rule: TimedCostRule): number {
  if (rule.flatCost !== null) return rule.flatCost;
  return rule.timeMinutes * rule.ratePerMinute;
}

// ---------- Layer 6 — Overhead ----------

function sumMachineMinutes(workstations: ReadonlyArray<WorkstationUsage>): number {
  let total = 0;
  for (const ws of workstations) total += ws.minutes;
  return total;
}

interface OverheadContext {
  readonly directCost: number;
  readonly laborMinutes: number;
  readonly machineMinutes: number;
}

function applyOverhead(model: OverheadModel, ctx: OverheadContext): number {
  switch (model.kind) {
    case "percent_of_direct":
      return ctx.directCost * model.percent;
    case "fixed_per_job":
      return model.amount;
    case "per_labor_minute":
      return ctx.laborMinutes * model.ratePerMinute;
    case "per_machine_minute":
      return ctx.machineMinutes * model.ratePerMinute;
    case "none":
      return 0;
  }
}
