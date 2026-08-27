/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/models/actualCostSnapshotModel.ts
 * Module:   cost-iq-engine / models
 * Purpose:  Type model for the continual-learning layer's foundation —
 *           per-WO snapshots of (estimated cost, actual cost) captured
 *           at completion. These snapshots are the data that feeds
 *           every learning loop: cycle-time tightening, waste-factor
 *           refinement, labor variance tracking, profitability
 *           analytics. Aligned with the audit doc's recommendation
 *           and §2.5 of docs/COST-IQ-ENGINE-SPEC.md (continual
 *           learning property).
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
 * Layer:        Model / Types (Cost IQ engine, continual-learning)
 * Imported by:  actualsTrackerService + future learning calculators
 * Stability:    CANONICAL (Continual Learning Phase 1)
 *
 * Why this matters
 * ----------------
 * The strategic evaluation identified the single highest-leverage
 * moat as the continual-learning loop: PRIME records what actually
 * happened, Cost IQ compares to what was estimated, and over time
 * the engine's predictions tighten. This file is the foundation —
 * the data shape that captures one comparison.
 *
 * Indexed by productId
 * --------------------
 * Snapshots are queried by productId because the learning loop
 * aggregates per product type ("widget X averages 12% over estimate
 * on labor"). For one-off WOs without a productId, the snapshot is
 * still recorded but won't influence per-product learning — those
 * one-offs feed the shop-wide variance averages instead.
 */

// ---------- Snapshot shape ----------

/**
 * One side-by-side comparison of estimated vs actual cost for a
 * single WO at a single point in time (typically captured when the
 * WO completes). Immutable — corrections create a new snapshot
 * rather than mutating the original.
 */
export interface ActualCostSnapshot {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly workOrderId: string;
  /**
   * Optional product reference. Present when the WO was built from
   * a finished-product recipe; absent for fully custom one-off jobs.
   * Per-product learning aggregates by this id.
   */
  readonly productId: string | null;
  /** Total cost the engine estimated when the WO was priced. */
  readonly estimatedTotalCost: number;
  /** Total cost the WO actually incurred (from labor / materials / overhead actuals). */
  readonly actualTotalCost: number;
  /**
   * Per-layer breakdown of estimated costs at the time of pricing.
   * Lets the learning layer attribute variance to the right layer
   * (e.g., "labor was 18% over estimate; materials were on target").
   */
  readonly estimatedBreakdown: ActualCostLayerBreakdown;
  /** Same breakdown shape, for the actual costs incurred. */
  readonly actualBreakdown: ActualCostLayerBreakdown;
  /** ISO-8601 timestamp at which the snapshot was captured. */
  readonly capturedAt: string;
  /**
   * Optional free-form note from the operator who finalized the WO
   * (e.g., "rush job — extra setup time expected"). Surfaces in
   * variance reports so analysts can sanity-check outliers.
   */
  readonly note: string | null;
}

/**
 * Per-layer cost slice. Mirrors the 6-layer cost calculator output
 * so estimates and actuals are directly comparable layer by layer.
 * Subset of `CostBreakdown` to avoid coupling — actuals don't carry
 * the derived `directCost` / `totalCost` rollups (re-derive at read
 * time).
 */
export interface ActualCostLayerBreakdown {
  readonly materialCost: number;
  readonly consumableCost: number;
  readonly stationUsageCost: number;
  readonly laborCost: number;
  readonly setupCleanupCost: number;
  readonly overheadCost: number;
}

// ---------- Variance summary ----------

/**
 * Rolled-up variance across multiple snapshots. The output the
 * learning layer (and the admin UI) consumes — answers questions
 * like "how often does this product run over estimate, and by how
 * much on average?"
 */
export interface VarianceSummary {
  /** Number of snapshots feeding this summary. */
  readonly sampleSize: number;
  /** Mean absolute variance: (sum of (actual − estimate)) / sampleSize. */
  readonly meanAbsoluteVariance: number;
  /** Mean relative variance: average of (actual − estimate) / estimate per snapshot. */
  readonly meanRelativeVariance: number;
  /** Max single-snapshot variance, for outlier visibility. */
  readonly maxAbsoluteVariance: number;
  /** Per-layer mean relative variance, so callers can attribute drift to the right layer. */
  readonly perLayerRelativeVariance: ActualCostLayerBreakdown;
  /** ISO-8601 of the earliest snapshot included. */
  readonly earliestSnapshotAt: string | null;
  /** ISO-8601 of the latest snapshot included. */
  readonly latestSnapshotAt: string | null;
}
