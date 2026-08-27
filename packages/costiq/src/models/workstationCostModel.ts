/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/workstationCostModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Type model for a workstation's cost configuration —
 *           per-minute / per-unit station rates, optional minimum
 *           charge, setup + cleanup rules, and the per-station
 *           consumable line items. Mirrors §5.2 of
 *           docs/COST-IQ-ENGINE-SPEC.md.
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
 * Layer:        Model / Types (Cost IQ engine)
 * Imported by:  cost-iq-engine/core/* + jobCostInputModel
 * Depends on:   —
 * Stability:    CANONICAL (Phase 1)
 *
 * Cost methods describe HOW a consumable's cost scales with usage. The
 * `basisUnits` value supplied at calculation time must already be in
 * the unit implied by the cost method — the engine does NOT convert
 * units (e.g., minutes → hours, square inches → square feet). Callers
 * normalize units when they construct the input.
 *
 * The `percent_of_station_use` method is special: it computes its cost
 * as a percentage of the station's own usage cost, not as a per-basis
 * line. Used for things like "consumables wear allowance = 5% of
 * station hours" without forcing a separate basis-unit calculation.
 */
export type ConsumableCostMethod =
  | "per_minute"
  | "per_cycle"
  | "per_square_inch"
  | "per_linear_foot"
  | "per_sheet"
  | "per_print"
  | "per_pass"
  | "per_order"
  | "fixed_per_job"
  | "percent_of_station_use";

/**
 * Single recurring-cost line item attached to a workstation. Active
 * lines contribute to Layer 2 (workstation consumable cost) per
 * §6 of the spec. Inactive lines are stored for history but skipped
 * by the calculator.
 */
export interface WorkstationConsumable {
  readonly id: string;
  readonly stationId: string;
  readonly name: string;
  readonly costMethod: ConsumableCostMethod;
  /** Display-only unit label — "ml", "in²", "sheet", etc. The engine never reads this. */
  readonly unit: string;
  /** Cost per one unit of `costMethod` basis. For `percent_of_station_use`, this is a 0..1 fraction. */
  readonly costPerUnit: number;
  /** Multiplier compensating for material loss. 1.0 = no waste, 1.10 = 10% extra. */
  readonly wasteFactor: number;
  readonly active: boolean;
}

/**
 * Time-cost rule used for setup or cleanup. Either supply a flat cost
 * (e.g., "setup is always $25 regardless of how long it takes") or
 * leave `flatCost` null and provide `timeMinutes × ratePerMinute`.
 *
 * The engine prefers `flatCost` when present so shops with strict
 * line-item billing can lock the number. Otherwise it computes from
 * the time × rate pair.
 */
export interface TimedCostRule {
  readonly flatCost: number | null;
  readonly timeMinutes: number;
  readonly ratePerMinute: number;
}

/**
 * Full cost configuration for a single workstation. The same profile
 * is reused across every job that touches the station; per-job usage
 * is supplied separately via `WorkstationUsage`.
 *
 * `ratePerMinute` and `ratePerUnit` are independent and additive —
 * shops that bill purely by time leave `ratePerUnit` at 0; shops that
 * bill per-piece leave `ratePerMinute` at 0; hybrid shops set both.
 *
 * `minimumCharge`, when present, raises the station's contribution to
 * Layer 3 if the computed time + unit cost falls below the floor.
 */
export interface WorkstationCostProfile {
  readonly stationId: string;
  /** Per-minute rate for station usage. Set to 0 if station charges per-unit only. */
  readonly ratePerMinute: number;
  /** Per-unit rate for station usage. Set to 0 if station charges per-minute only. */
  readonly ratePerUnit: number;
  /** Minimum Layer-3 charge regardless of computed time/unit cost. Null = no minimum. */
  readonly minimumCharge: number | null;
  readonly setup: TimedCostRule | null;
  readonly cleanup: TimedCostRule | null;
  readonly consumables: ReadonlyArray<WorkstationConsumable>;
}
