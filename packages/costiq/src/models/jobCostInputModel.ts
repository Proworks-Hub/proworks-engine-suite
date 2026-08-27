/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/jobCostInputModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Type model for the COMPLETE input to the cost calculator.
 *           Materials, labor, per-workstation usage, overhead model.
 *           All values are pre-resolved by the caller — the calculator
 *           does not fetch from inventory, employee, or workstation
 *           services. That separation keeps the math pure and testable.
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
 * Layer:        Model / Types (Cost IQ engine)
 * Imported by:  cost-iq-engine/core/costCalculator
 * Depends on:   workstationCostModel
 * Stability:    CANONICAL (Phase 1)
 */

import type { WorkstationCostProfile } from "./workstationCostModel";

// ---------- Material usage (Layer 1) ----------

/**
 * One material consumed by the job. Quantities are in the unit
 * implied by the material's `unitCost` basis — the engine never
 * converts units; the caller normalizes when constructing the input.
 *
 * `wasteFactor` is the multiplier applied to compensate for normal
 * loss (cuts, drops, rework). 1.0 = perfect yield, 1.15 = 15% extra
 * material assumed.
 */
export interface MaterialUsage {
  readonly materialId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitCost: number;
  readonly wasteFactor: number;
}

// ---------- Labor (Layer 4) ----------

/**
 * One slice of labor performed at a workstation. The loaded rate is
 * the per-minute fully-burdened rate (wage + taxes + benefits +
 * burden) so the calculator never has to know about employees, roles,
 * or benefit programs. Employee attribution is optional and exists
 * only for downstream reporting.
 */
export interface LaborTime {
  readonly stationId: string;
  readonly employeeId: string | null;
  readonly minutes: number;
  readonly loadedRatePerMinute: number;
}

// ---------- Per-workstation consumable usage (Layer 2) ----------

/**
 * How much of one consumable was used on this job at one workstation.
 * The basis units must match the consumable's `costMethod` — e.g.,
 * minutes for `per_minute`, square inches for `per_square_inch`. For
 * `percent_of_station_use`, basisUnits is ignored (the percentage is
 * applied to the station's own usage cost).
 */
export interface ConsumableUsage {
  readonly consumableId: string;
  readonly basisUnits: number;
}

// ---------- Per-workstation activity (Layers 2, 3, 5) ----------

/**
 * What happened at one workstation during this job. Carries the time
 * and unit counts that drive Layer 3 (station usage cost) and the
 * explicit consumable usage that drives Layer 2 (consumable cost).
 *
 * Setup and cleanup costs (Layer 5) come from the profile's
 * `setup` / `cleanup` rules and are applied whenever this workstation
 * is touched, regardless of `minutes` or `units`.
 *
 * The `profile` is embedded inline rather than looked up from a
 * separate registry. That keeps the input self-contained: a test or
 * a caller can construct a complete `JobCostInput` without setting
 * up a profile cache.
 */
export interface WorkstationUsage {
  readonly stationId: string;
  readonly profile: WorkstationCostProfile;
  /** Total minutes of station activity for this job. */
  readonly minutes: number;
  /** Units processed (drives `ratePerUnit` in the profile). */
  readonly units: number;
  readonly consumables: ReadonlyArray<ConsumableUsage>;
}

// ---------- Overhead (Layer 6) ----------

/**
 * Discriminated union of overhead allocation models per §5.5 of the
 * spec. Shops pick whichever matches how they think about overhead.
 * `none` is supported for shops that absorb overhead elsewhere or
 * apply it at a higher level (e.g., on the suggested price, not the
 * cost).
 */
export type OverheadModel =
  | { readonly kind: "percent_of_direct"; readonly percent: number }
  | { readonly kind: "fixed_per_job"; readonly amount: number }
  | { readonly kind: "per_labor_minute"; readonly ratePerMinute: number }
  | { readonly kind: "per_machine_minute"; readonly ratePerMinute: number }
  | { readonly kind: "none" };

// ---------- Top-level input ----------

/**
 * The complete, pre-resolved input to `calculateJobCost`. Every value
 * is final — no fetches, no async lookups. The calculator returns a
 * `CostBreakdown` synchronously.
 *
 * Quantity is the job's overall production count (e.g., "make 50
 * widgets"). It is used for per-unit price reporting downstream; the
 * cost layers themselves consume the per-workstation `units` value
 * because some stations may process subsets of the total quantity
 * (e.g., QC samples 20% of the run).
 */
export interface JobCostInput {
  readonly workOrderId: string;
  readonly tenantId: string;
  readonly quantity: number;
  readonly materials: ReadonlyArray<MaterialUsage>;
  readonly labor: ReadonlyArray<LaborTime>;
  readonly workstations: ReadonlyArray<WorkstationUsage>;
  readonly overhead: OverheadModel;
}
