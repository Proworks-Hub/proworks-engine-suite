/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/actualsTrackerService.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Continual-learning Phase 1 PR 1 — service that records
 *           per-WO ActualCostSnapshots and computes rolled-up
 *           variance summaries per product. The data layer the
 *           PRIME→Cost-IQ feedback loop reads from. PR 2 wires
 *           PRIME event subscription to actually populate it; PR 3
 *           surfaces variance in the admin UI; PR 4 feeds the
 *           variance back into Cost IQ defaults.
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
 * Layer:        Service / Storage (Cost IQ engine, continual-learning)
 * Imported by:  Future PRIME→Cost-IQ bridge (Phase 1 PR 2) + admin UI
 * Depends on:   actualCostSnapshotModel
 * Stability:    CANONICAL (Continual Learning Phase 1)
 *
 * Storage today: in-memory
 * ------------------------
 * PR 1 ships an in-memory tracker — Map indexed by snapshotId, with
 * per-product index maintained on insert. PR 2+ swaps the storage
 * for an IDB-backed adapter (offline-first) and a SQLite-backed
 * adapter on the Hub (durable, queryable across clients). The
 * service interface stays the same so consumers don't change.
 *
 * Design notes
 * ------------
 * - Snapshots are immutable. `recordSnapshot` appends; there is no
 *   `updateSnapshot`. Corrections record a new snapshot referencing
 *   the same WO; the variance summary uses the most recent snapshot
 *   per WO when multiple exist.
 * - All math is pure: variance summaries are computed from the
 *   currently-stored snapshots at query time. No materialized
 *   cache (yet — that's an optimization for PR 3+ when volumes grow).
 * - Empty-input safety: querying a productId with no snapshots
 *   returns a zeroed `VarianceSummary` with `sampleSize: 0` rather
 *   than null. Callers can render "no data yet" cleanly without a
 *   null-check at every site.
 */

import type {
  ActualCostLayerBreakdown,
  ActualCostSnapshot,
  VarianceSummary,
} from "../models/actualCostSnapshotModel";

// ---------- Public service interface ----------

/**
 * Input for `recordSnapshot`. Mirrors `ActualCostSnapshot` minus the
 * derived/system-assigned fields (`snapshotId`, `capturedAt`). The
 * service generates those at insert time so callers can't mis-set them.
 */
export interface RecordSnapshotInput {
  readonly tenantId: string;
  readonly workOrderId: string;
  readonly productId: string | null;
  readonly estimatedTotalCost: number;
  readonly actualTotalCost: number;
  readonly estimatedBreakdown: ActualCostLayerBreakdown;
  readonly actualBreakdown: ActualCostLayerBreakdown;
  readonly note?: string | null;
}

export interface ActualsTracker {
  readonly recordSnapshot: (input: RecordSnapshotInput) => ActualCostSnapshot;
  readonly getSnapshotById: (snapshotId: string) => ActualCostSnapshot | null;
  readonly getSnapshotsForWorkOrder: (
    workOrderId: string,
  ) => ReadonlyArray<ActualCostSnapshot>;
  readonly getSnapshotsForProduct: (
    productId: string,
  ) => ReadonlyArray<ActualCostSnapshot>;
  readonly getVarianceForProduct: (productId: string) => VarianceSummary;
  /**
   * Total snapshot count across the tracker. Useful for "no data yet"
   * empty states and admin diagnostics.
   */
  readonly size: () => number;
  /**
   * Test / diagnostic helper — clears every snapshot. Production code
   * should never call this.
   */
  readonly _clearForTests: () => void;
}

// ---------- Dependencies ----------

export interface CreateActualsTrackerDeps {
  /** Clock override for deterministic tests. Defaults to wall clock. */
  readonly now?: () => Date;
  /** Id-gen override for deterministic tests. Defaults to crypto.randomUUID. */
  readonly idGenerator?: () => string;
}

// ---------- Factory ----------

/**
 * Create an in-memory actuals tracker. Each call returns an
 * independent instance — useful for tests and per-tenant isolation.
 */
export function createActualsTracker(
  deps: CreateActualsTrackerDeps = {},
): ActualsTracker {
  const now = deps.now ?? (() => new Date());
  const generateId =
    deps.idGenerator
    ?? (() => {
      // Avoid an explicit `globalThis.crypto` reference so the file
      // works in test envs that polyfill differently. The only
      // requirement is uniqueness within process lifetime.
      const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
      if (c?.randomUUID) return c.randomUUID();
      return `snap_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    });

  const byId = new Map<string, ActualCostSnapshot>();
  const byWorkOrderId = new Map<string, ActualCostSnapshot[]>();
  const byProductId = new Map<string, ActualCostSnapshot[]>();

  function indexAdd(map: Map<string, ActualCostSnapshot[]>, key: string, snap: ActualCostSnapshot): void {
    const list = map.get(key);
    if (list) {
      list.push(snap);
    } else {
      map.set(key, [snap]);
    }
  }

  function recordSnapshot(input: RecordSnapshotInput): ActualCostSnapshot {
    const snapshot: ActualCostSnapshot = Object.freeze({
      snapshotId: generateId(),
      tenantId: input.tenantId,
      workOrderId: input.workOrderId,
      productId: input.productId,
      estimatedTotalCost: input.estimatedTotalCost,
      actualTotalCost: input.actualTotalCost,
      estimatedBreakdown: Object.freeze({ ...input.estimatedBreakdown }),
      actualBreakdown: Object.freeze({ ...input.actualBreakdown }),
      capturedAt: now().toISOString(),
      note: input.note ?? null,
    });
    byId.set(snapshot.snapshotId, snapshot);
    indexAdd(byWorkOrderId, snapshot.workOrderId, snapshot);
    if (snapshot.productId) {
      indexAdd(byProductId, snapshot.productId, snapshot);
    }
    return snapshot;
  }

  function getSnapshotById(snapshotId: string): ActualCostSnapshot | null {
    return byId.get(snapshotId) ?? null;
  }

  function getSnapshotsForWorkOrder(
    workOrderId: string,
  ): ReadonlyArray<ActualCostSnapshot> {
    return byWorkOrderId.get(workOrderId) ?? [];
  }

  function getSnapshotsForProduct(
    productId: string,
  ): ReadonlyArray<ActualCostSnapshot> {
    return byProductId.get(productId) ?? [];
  }

  function getVarianceForProduct(productId: string): VarianceSummary {
    const snaps = byProductId.get(productId) ?? [];
    return computeVarianceSummary(snaps);
  }

  function size(): number {
    return byId.size;
  }

  function _clearForTests(): void {
    byId.clear();
    byWorkOrderId.clear();
    byProductId.clear();
  }

  return Object.freeze({
    recordSnapshot,
    getSnapshotById,
    getSnapshotsForWorkOrder,
    getSnapshotsForProduct,
    getVarianceForProduct,
    size,
    _clearForTests,
  });
}

// ---------- Pure variance math (exported for tests) ----------

/**
 * Compute a `VarianceSummary` from a collection of snapshots. Pure:
 * same input → same output. Empty input returns the zeroed summary.
 *
 * Mean relative variance is computed per snapshot then averaged
 * (NOT total-actual / total-estimate − 1) so each snapshot weighs
 * equally regardless of its absolute size — a single huge WO
 * doesn't dominate the per-product average.
 */
export function computeVarianceSummary(
  snapshots: ReadonlyArray<ActualCostSnapshot>,
): VarianceSummary {
  if (snapshots.length === 0) {
    return {
      sampleSize: 0,
      meanAbsoluteVariance: 0,
      meanRelativeVariance: 0,
      maxAbsoluteVariance: 0,
      perLayerRelativeVariance: zeroBreakdown(),
      earliestSnapshotAt: null,
      latestSnapshotAt: null,
    };
  }

  let sumAbsolute = 0;
  let sumRelative = 0;
  let maxAbsolute = 0;
  let earliest = snapshots[0]!.capturedAt;
  let latest = snapshots[0]!.capturedAt;

  const layerSums: Record<keyof ActualCostLayerBreakdown, number> = {
    materialCost: 0,
    consumableCost: 0,
    stationUsageCost: 0,
    laborCost: 0,
    setupCleanupCost: 0,
    overheadCost: 0,
  };

  for (const s of snapshots) {
    const absolute = s.actualTotalCost - s.estimatedTotalCost;
    const relative = s.estimatedTotalCost === 0
      ? 0
      : absolute / s.estimatedTotalCost;
    sumAbsolute += absolute;
    sumRelative += relative;
    if (Math.abs(absolute) > Math.abs(maxAbsolute)) maxAbsolute = absolute;

    if (s.capturedAt < earliest) earliest = s.capturedAt;
    if (s.capturedAt > latest) latest = s.capturedAt;

    for (const key of LAYER_KEYS) {
      const est = s.estimatedBreakdown[key];
      const act = s.actualBreakdown[key];
      const rel = est === 0 ? 0 : (act - est) / est;
      layerSums[key] += rel;
    }
  }

  const n = snapshots.length;
  const perLayer: ActualCostLayerBreakdown = {
    materialCost: layerSums.materialCost / n,
    consumableCost: layerSums.consumableCost / n,
    stationUsageCost: layerSums.stationUsageCost / n,
    laborCost: layerSums.laborCost / n,
    setupCleanupCost: layerSums.setupCleanupCost / n,
    overheadCost: layerSums.overheadCost / n,
  };

  return {
    sampleSize: n,
    meanAbsoluteVariance: sumAbsolute / n,
    meanRelativeVariance: sumRelative / n,
    maxAbsoluteVariance: maxAbsolute,
    perLayerRelativeVariance: perLayer,
    earliestSnapshotAt: earliest,
    latestSnapshotAt: latest,
  };
}

// ---------- Internals ----------

const LAYER_KEYS: ReadonlyArray<keyof ActualCostLayerBreakdown> = [
  "materialCost",
  "consumableCost",
  "stationUsageCost",
  "laborCost",
  "setupCleanupCost",
  "overheadCost",
];

function zeroBreakdown(): ActualCostLayerBreakdown {
  return {
    materialCost: 0,
    consumableCost: 0,
    stationUsageCost: 0,
    laborCost: 0,
    setupCleanupCost: 0,
    overheadCost: 0,
  };
}
