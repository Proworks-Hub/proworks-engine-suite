/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/actualsCapturePipeline.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Continual-learning Phase 1 PR 2 — pure composition layer
 *           that takes a completed WorkOrder + its actual cost
 *           breakdown + the actuals tracker, computes the estimated
 *           breakdown via the existing cost calculator, records a
 *           snapshot, and returns the resulting variance.
 *
 *           This is the function the eventual PRIME→Cost-IQ event
 *           bridge (Phase 1 PR 3) will call when a
 *           `work_order.completed` event lands.
 * Created:  2026-04-25
 *
 * Authorship Statement
 * --------------------
 * This file was authored under the sole direction and product vision of
 * Steven Kreutzer. AI tools (Cursor, Claude, Codex, ChatGPT, Perplexity)
 * were used strictly as coding assistants — comparable to working with
 * a hired developer — and hold no rights, claim, license, or beneficial
 * interest in this work product.
 *
 * Originality
 * -----------
 * All code in this file is original work composed for ProWorks Hub.
 */

/**
 * Layer:        Service / Pipeline (Cost IQ engine, continual-learning)
 * Imported by:  Future PRIME-event-driven runtime (Phase 1 PR 3)
 *               + tests + admin UIs that want to "snapshot now."
 * Depends on:   actualsTrackerService + cost calculator + input builder
 *               + actualCostSnapshotModel
 * Stability:    CANONICAL (Continual Learning Phase 1)
 *
 * Responsibility split
 * --------------------
 * The pipeline does NOT know about PRIME events, SSE streams, or
 * the WO module's metadata shape. Its caller is responsible for:
 *   1. Detecting that a WO completed (via PRIME event or polling).
 *   2. Extracting the WO's actual cost breakdown from whatever
 *      data layer holds it (today: WO `metadata.costing`; future:
 *      a dedicated actuals service driven by tablet labor entries
 *      + material consumption events).
 *   3. Calling this pipeline.
 *
 * Keeping that separation lets the pipeline ship NOW with pure-
 * function tests, before the surrounding wiring exists.
 *
 * Estimate strategy
 * -----------------
 * The estimated breakdown is computed by re-running the cost
 * calculator over the WO at completion time, using the same
 * `buildJobCostInputFromWorkOrder` adapter the live UI uses. This
 * gives us "what does Cost IQ estimate this job at right now?" vs
 * "what did the job actually cost." A future enhancement (PR 4+)
 * will store an authoritative "estimate at quote time" snapshot per
 * WO so the variance reflects ORIGINAL estimate drift, not
 * current-config drift. For the first learning loop, current-config
 * vs actual is enough signal.
 *
 * Defensive behaviors
 * -------------------
 * - Negative variance is allowed (actuals can come in BELOW
 *   estimate; that's a positive signal).
 * - When `estimatedTotalCost` is zero, relative variance reports
 *   zero rather than dividing by zero (matches the
 *   `computeVarianceSummary` convention).
 * - The pipeline is best-effort: if `tracker.recordSnapshot` throws
 *   the caller's error handler sees it (we don't swallow). PRIME
 *   events should NOT silently lose actuals.
 */

import { calculateJobCost } from "../core/costCalculator.js";
import type { CostBreakdown } from "../models/costBreakdownModel.js";
import type {
  ActualCostLayerBreakdown,
  ActualCostSnapshot,
} from "../models/actualCostSnapshotModel.js";
import {
  buildJobCostInputFromWorkOrder,
  type JobCostInputBuilderDefaults,
  type WorkOrderLike,
} from "./jobCostInputBuilder.js";
import type { ActualsTracker } from "./actualsTrackerService.js";

// ---------- Public types ----------

export interface CaptureActualsForCompletedWorkOrderInput {
  readonly tracker: ActualsTracker;
  readonly workOrder: WorkOrderLike;
  /** Per-layer actual cost breakdown for the WO. Required input. */
  readonly actualBreakdown: ActualCostLayerBreakdown;
  /**
   * Total actual cost. When omitted, defaults to the sum of
   * `actualBreakdown` fields. Allows callers to override when their
   * actuals model carries a separately-tracked total (e.g., includes
   * adjustments not captured per-layer).
   */
  readonly actualTotalCost?: number;
  /**
   * Optional product reference. Set when the WO was built from a
   * finished-product recipe; null/undefined for one-off custom jobs.
   */
  readonly productId?: string | null;
  /** Optional free-form note attached to the snapshot. */
  readonly note?: string | null;
  /**
   * Optional override for the input-builder defaults. Useful when
   * the shop's real workstation profiles + labor rates aren't yet
   * stored — the caller can supply better defaults than the demo
   * placeholders that ship with `buildJobCostInputFromWorkOrder`.
   */
  readonly estimateDefaults?: Partial<JobCostInputBuilderDefaults>;
}

export interface CaptureActualsForCompletedWorkOrderResult {
  readonly snapshot: ActualCostSnapshot;
  readonly variance: {
    /** Actual minus estimated. Positive = WO ran over estimate. */
    readonly absolute: number;
    /** Absolute / estimated. Zero when estimated is zero. */
    readonly relative: number;
  };
  /** Echo of the estimated breakdown the calculator produced. */
  readonly estimatedBreakdown: ActualCostLayerBreakdown;
  /** Echo of the estimated total the calculator produced. */
  readonly estimatedTotalCost: number;
}

// ---------- Pipeline ----------

/**
 * Compose the actuals capture for one completed WorkOrder. Pure:
 * given the same inputs (and a deterministic tracker), the same
 * snapshot lands every call.
 */
export function captureActualsForCompletedWorkOrder(
  input: CaptureActualsForCompletedWorkOrderInput,
): CaptureActualsForCompletedWorkOrderResult {
  // 1. Build the JobCostInput the same way the live UI does.
  const jobCostInput = buildJobCostInputFromWorkOrder(input.workOrder, {
    defaults: input.estimateDefaults,
  });

  // 2. Run the cost calculator to derive the estimated breakdown.
  const estimatedFull = calculateJobCost(jobCostInput);
  const estimatedBreakdown = costBreakdownToLayerBreakdown(estimatedFull);
  const estimatedTotalCost = estimatedFull.totalCost;

  // 3. Resolve actual total: explicit override > sum of layers.
  const actualTotalCost =
    input.actualTotalCost ?? sumLayerBreakdown(input.actualBreakdown);

  // 4. Record the snapshot (this is the only side effect).
  const snapshot = input.tracker.recordSnapshot({
    tenantId: input.workOrder.tenantId,
    workOrderId: input.workOrder.id,
    productId: input.productId ?? null,
    estimatedTotalCost,
    actualTotalCost,
    estimatedBreakdown,
    actualBreakdown: input.actualBreakdown,
    note: input.note ?? null,
  });

  // 5. Compute variance for the caller's convenience.
  const absolute = actualTotalCost - estimatedTotalCost;
  const relative = estimatedTotalCost === 0 ? 0 : absolute / estimatedTotalCost;

  return Object.freeze({
    snapshot,
    variance: Object.freeze({ absolute, relative }),
    estimatedBreakdown,
    estimatedTotalCost,
  });
}

// ---------- Helpers (exported so tests + future callers can reuse) ----------

/**
 * Project a full `CostBreakdown` (which carries derived `directCost`
 * and `totalCost` rollups) down to the layer-only `ActualCostLayerBreakdown`
 * the snapshot model uses. Pure projection; no math.
 */
export function costBreakdownToLayerBreakdown(
  breakdown: CostBreakdown,
): ActualCostLayerBreakdown {
  return {
    materialCost: breakdown.materialCost,
    consumableCost: breakdown.consumableCost,
    stationUsageCost: breakdown.stationUsageCost,
    laborCost: breakdown.laborCost,
    setupCleanupCost: breakdown.setupCleanupCost,
    overheadCost: breakdown.overheadCost,
  };
}

/**
 * Sum the 6 layer values of an `ActualCostLayerBreakdown`. Used to
 * derive `actualTotalCost` when callers don't pass one explicitly.
 */
export function sumLayerBreakdown(b: ActualCostLayerBreakdown): number {
  return (
    b.materialCost
    + b.consumableCost
    + b.stationUsageCost
    + b.laborCost
    + b.setupCleanupCost
    + b.overheadCost
  );
}
