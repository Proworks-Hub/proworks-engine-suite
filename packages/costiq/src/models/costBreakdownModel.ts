/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/costBreakdownModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Output type from the cost calculator. Each layer is
 *           reported separately so the UI can show "this is exactly
 *           where the cost came from." Mirrors §6 of the spec.
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
 * Imported by:  cost-iq-engine/core/costCalculator + downstream
 *               pricing/margin calculators (Phase 1 PR 2)
 * Depends on:   —
 * Stability:    CANONICAL (Phase 1)
 *
 * Layer mapping:
 *   materialCost       — Layer 1 (materials × waste)
 *   consumableCost     — Layer 2 (per-station consumables)
 *   stationUsageCost   — Layer 3 (machine wear / utilities reserve)
 *   laborCost          — Layer 4 (loaded labor minutes)
 *   setupCleanupCost   — Layer 5 (setup + cleanup, both stations)
 *   directCost         — sum of layers 1-5
 *   overheadCost       — Layer 6 (per the chosen overhead model)
 *   totalCost          — directCost + overheadCost
 *
 * Every value is in shop-currency dollars (the engine is currency-
 * agnostic — the caller's responsibility to keep currency consistent).
 */
export interface CostBreakdown {
  readonly materialCost: number;
  readonly consumableCost: number;
  readonly stationUsageCost: number;
  readonly laborCost: number;
  readonly setupCleanupCost: number;
  readonly directCost: number;
  readonly overheadCost: number;
  readonly totalCost: number;
}
