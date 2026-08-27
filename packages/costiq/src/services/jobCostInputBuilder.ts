/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/jobCostInputBuilder.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Adapter that turns a WorkOrder into a JobCostInput so the
 *           Cost IQ tab can render meaningful numbers on any WO today,
 *           even before the full shop-config surface (workstation cost
 *           profiles, labor rates per role, material unit costs) is
 *           populated. Uses defaults for what the shop hasn't entered;
 *           callers can override any default per call.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. AI tools were used strictly as coding assistants —
 * comparable to working with a hired developer — and hold no rights,
 * claim, license, or beneficial interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 */

/**
 * Layer:        Service / Adapter (Cost IQ engine, Phase 2)
 * Imported by:  Future Cost IQ tab parent in WorkOrderDetailPage
 *               (Phase 2 PR 3); demo / sandbox pages that mount the
 *               tab against a real WO.
 * Depends on:   cost-iq-engine model types
 * Stability:    CANONICAL (Phase 2)
 *
 * Design intent
 * -------------
 * Cost IQ is currency-, shop-, and config-agnostic. The CALCULATOR
 * doesn't fetch any data — that's a deliberate purity boundary. This
 * adapter is the OPPOSITE side of that boundary: it knows about the
 * existing WorkOrder shape, fills in the gaps where the shop hasn't
 * configured something yet (using the named defaults below), and
 * hands the engine a valid input.
 *
 * As real data sources come online (workstation cost profiles store,
 * loaded labor-rate service, material unit-cost lookups), this file
 * grows additional optional dependencies that override the defaults.
 * The defaults stay as the LAST-RESORT fallback so the tab always
 * renders SOMETHING — never a blank screen waiting on shop setup.
 *
 * Why defaults instead of zeros?
 * ------------------------------
 * Zero-everything would render `$0.00` in every row of the breakdown,
 * which makes the tab look broken to a new shop that hasn't entered
 * config. Demo defaults produce realistic-ish numbers that read as
 * "estimate pending real shop configuration" and give the user
 * something to react to immediately.
 */

import type {
  JobCostInput,
  LaborTime,
  MaterialUsage,
  WorkstationUsage,
} from "../models/jobCostInputModel.js";

// ---------- Public types ----------

/**
 * Minimal WorkOrder shape this adapter reads. Narrow on purpose so
 * callers can pass either the full WorkOrder (structural typing
 * matches) or a hand-built fixture. The adapter never introspects
 * `items[]` — it only counts them to derive a quantity.
 */
export interface WorkOrderLike {
  readonly id: string;
  readonly tenantId: string;
  readonly machineSequence?: ReadonlyArray<string> | null;
  readonly items?: ReadonlyArray<unknown> | null;
  readonly quantity?: number | null;
}

/**
 * Per-rate fallbacks used when shop config isn't populated yet.
 * Every field is a sensible placeholder, not a "true" default — the
 * shop is expected to override these as soon as its config is set up.
 */
export interface JobCostInputBuilderDefaults {
  /** Per-minute station usage rate when the workstation has no profile yet. */
  readonly stationRatePerMinute: number;
  /** Default minutes assumed at each station when no time tracking exists. */
  readonly stationDefaultMinutes: number;
  /** Per-minute loaded labor rate when no employee/role rate is wired. */
  readonly laborRatePerMinute: number;
  /** Default labor minutes per station when no time tracking exists. */
  readonly laborDefaultMinutes: number;
  /** Per-unit material cost used when WO has line items but no costed materials. */
  readonly materialUnitCost: number;
  /** Overhead model fraction (0..1) when shop hasn't picked an overhead model. */
  readonly overheadPercent: number;
}

export interface BuildJobCostInputOptions {
  /**
   * Override any subset of the defaults. Anything omitted falls back
   * to `DEFAULT_BUILDER_DEFAULTS`.
   */
  readonly defaults?: Partial<JobCostInputBuilderDefaults>;
}

// ---------- Defaults ----------

export const DEFAULT_BUILDER_DEFAULTS: JobCostInputBuilderDefaults = Object.freeze({
  stationRatePerMinute: 1.0,
  stationDefaultMinutes: 30,
  laborRatePerMinute: 0.5,
  laborDefaultMinutes: 45,
  materialUnitCost: 5.0,
  overheadPercent: 0.1,
});

// ---------- Builder ----------

/**
 * Build a complete `JobCostInput` from a WorkOrder. Pure: same
 * inputs always produce the same output.
 *
 * Quantity resolution order:
 *   1. `workOrder.quantity` if set and > 0
 *   2. `workOrder.items.length` if items array is non-empty
 *   3. fallback: 1
 *
 * Materials:
 *   - When the WO has items[], one MaterialUsage row is emitted with
 *     `quantity = resolvedQuantity` and `unitCost = materialUnitCost`
 *     default. The row is named "Job materials (estimated)" so users
 *     immediately see this is a placeholder.
 *   - When the WO has no items, materials[] is empty (clean breakdown).
 *
 * Workstations + labor:
 *   - One WorkstationUsage + one LaborTime per stationId in
 *     `machineSequence`. All use the defaults for rates and time.
 *   - When `machineSequence` is empty, both arrays are empty — the
 *     calculator will return $0 for those layers, which is the right
 *     behavior for a WO that hasn't been routed yet.
 */
export function buildJobCostInputFromWorkOrder(
  workOrder: WorkOrderLike,
  options: BuildJobCostInputOptions = {},
): JobCostInput {
  const d: JobCostInputBuilderDefaults = {
    ...DEFAULT_BUILDER_DEFAULTS,
    ...options.defaults,
  };

  const quantity = resolveQuantity(workOrder);
  const stationIds = workOrder.machineSequence ?? [];
  const materials = buildMaterials(workOrder, quantity, d);
  const workstations = buildWorkstations(stationIds, quantity, d);
  const labor = buildLabor(stationIds, d);

  return {
    workOrderId: workOrder.id,
    tenantId: workOrder.tenantId,
    quantity,
    materials,
    labor,
    workstations,
    overhead: { kind: "percent_of_direct", percent: d.overheadPercent },
  };
}

// ---------- Internals ----------

function resolveQuantity(workOrder: WorkOrderLike): number {
  if (typeof workOrder.quantity === "number" && workOrder.quantity > 0) {
    return workOrder.quantity;
  }
  if (workOrder.items && workOrder.items.length > 0) {
    return workOrder.items.length;
  }
  return 1;
}

function buildMaterials(
  workOrder: WorkOrderLike,
  quantity: number,
  d: JobCostInputBuilderDefaults,
): ReadonlyArray<MaterialUsage> {
  if (!workOrder.items || workOrder.items.length === 0) return [];
  return [
    {
      materialId: "default-material",
      name: "Job materials (estimated)",
      quantity,
      unitCost: d.materialUnitCost,
      wasteFactor: 1,
    },
  ];
}

function buildWorkstations(
  stationIds: ReadonlyArray<string>,
  quantity: number,
  d: JobCostInputBuilderDefaults,
): ReadonlyArray<WorkstationUsage> {
  return stationIds.map((stationId) => ({
    stationId,
    profile: {
      stationId,
      ratePerMinute: d.stationRatePerMinute,
      ratePerUnit: 0,
      minimumCharge: null,
      setup: null,
      cleanup: null,
      consumables: [],
    },
    minutes: d.stationDefaultMinutes,
    units: quantity,
    consumables: [],
  }));
}

function buildLabor(
  stationIds: ReadonlyArray<string>,
  d: JobCostInputBuilderDefaults,
): ReadonlyArray<LaborTime> {
  return stationIds.map((stationId) => ({
    stationId,
    employeeId: null,
    minutes: d.laborDefaultMinutes,
    loadedRatePerMinute: d.laborRatePerMinute,
  }));
}
