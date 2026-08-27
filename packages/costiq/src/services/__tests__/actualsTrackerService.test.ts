/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/__tests__/actualsTrackerService.test.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Unit coverage for the actuals tracker service. Storage
 *           round-trips, per-product / per-WO indexing, variance
 *           summary math (mean absolute, mean relative, per-layer,
 *           outlier capture), and the empty-input safety case.
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

import { beforeEach, describe, expect, it } from "vitest";

import {
  computeVarianceSummary,
  createActualsTracker,
  type ActualsTracker,
} from "../actualsTrackerService.js";
import type {
  ActualCostLayerBreakdown,
  ActualCostSnapshot,
} from "../../models/actualCostSnapshotModel.js";

// ---------- Fixtures ----------

const FROZEN_CLOCK = () => new Date("2026-04-25T10:00:00.000Z");

let nextIdCounter = 0;
function deterministicId(): string {
  nextIdCounter += 1;
  return `snap_${nextIdCounter.toString().padStart(4, "0")}`;
}

function makeBreakdown(overrides: Partial<ActualCostLayerBreakdown> = {}): ActualCostLayerBreakdown {
  return {
    materialCost: 0,
    consumableCost: 0,
    stationUsageCost: 0,
    laborCost: 0,
    setupCleanupCost: 0,
    overheadCost: 0,
    ...overrides,
  };
}

function makeRecordInput(overrides: Partial<Parameters<ActualsTracker["recordSnapshot"]>[0]> = {}) {
  return {
    tenantId: "tenant_1",
    workOrderId: "wo_1",
    productId: "prod_1" as string | null,
    estimatedTotalCost: 100,
    actualTotalCost: 110,
    estimatedBreakdown: makeBreakdown({ materialCost: 50, laborCost: 30, overheadCost: 20 }),
    actualBreakdown: makeBreakdown({ materialCost: 55, laborCost: 35, overheadCost: 20 }),
    ...overrides,
  };
}

beforeEach(() => {
  nextIdCounter = 0;
});

// ---------- Storage round-trip ----------

describe("createActualsTracker — storage", () => {
  it("records a snapshot with id + timestamp assigned, retrievable by id", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const snap = tracker.recordSnapshot(makeRecordInput());
    expect(snap.snapshotId).toBe("snap_0001");
    expect(snap.capturedAt).toBe("2026-04-25T10:00:00.000Z");
    expect(tracker.getSnapshotById("snap_0001")).toEqual(snap);
  });

  it("returns null for an unknown snapshot id", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    expect(tracker.getSnapshotById("missing")).toBeNull();
  });

  it("freezes the snapshot to prevent caller mutation", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    const snap = tracker.recordSnapshot(makeRecordInput());
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.estimatedBreakdown)).toBe(true);
    expect(Object.isFrozen(snap.actualBreakdown)).toBe(true);
  });

  it("normalizes missing note to null", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    const snap = tracker.recordSnapshot(makeRecordInput());
    expect(snap.note).toBeNull();
  });
});

// ---------- Indexing ----------

describe("createActualsTracker — indexing", () => {
  it("returns all snapshots for a workOrderId in insert order", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    tracker.recordSnapshot(makeRecordInput({ workOrderId: "wo_a" }));
    tracker.recordSnapshot(makeRecordInput({ workOrderId: "wo_a", actualTotalCost: 120 }));
    tracker.recordSnapshot(makeRecordInput({ workOrderId: "wo_b" }));

    const aSnaps = tracker.getSnapshotsForWorkOrder("wo_a");
    expect(aSnaps).toHaveLength(2);
    expect(aSnaps[0]!.snapshotId).toBe("snap_0001");
    expect(aSnaps[1]!.snapshotId).toBe("snap_0002");
  });

  it("returns empty array for an unknown workOrderId", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    expect(tracker.getSnapshotsForWorkOrder("ghost")).toEqual([]);
  });

  it("indexes by productId only when productId is present", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    tracker.recordSnapshot(makeRecordInput({ productId: "prod_a" }));
    tracker.recordSnapshot(makeRecordInput({ productId: null })); // one-off WO
    tracker.recordSnapshot(makeRecordInput({ productId: "prod_a", workOrderId: "wo_2" }));

    expect(tracker.getSnapshotsForProduct("prod_a")).toHaveLength(2);
    expect(tracker.size()).toBe(3); // all three stored, only two indexed by product
  });
});

// ---------- Variance: empty input ----------

describe("computeVarianceSummary — empty input", () => {
  it("returns a zeroed summary when no snapshots exist", () => {
    const out = computeVarianceSummary([]);
    expect(out.sampleSize).toBe(0);
    expect(out.meanAbsoluteVariance).toBe(0);
    expect(out.meanRelativeVariance).toBe(0);
    expect(out.maxAbsoluteVariance).toBe(0);
    expect(out.earliestSnapshotAt).toBeNull();
    expect(out.latestSnapshotAt).toBeNull();
    expect(out.perLayerRelativeVariance.materialCost).toBe(0);
  });
});

// ---------- Variance: single snapshot ----------

describe("computeVarianceSummary — single snapshot", () => {
  it("reports the snapshot's variance directly", () => {
    const snap: ActualCostSnapshot = Object.freeze({
      snapshotId: "s1",
      tenantId: "t1",
      workOrderId: "wo1",
      productId: "p1",
      estimatedTotalCost: 100,
      actualTotalCost: 120,
      estimatedBreakdown: makeBreakdown({ materialCost: 50, laborCost: 50 }),
      actualBreakdown: makeBreakdown({ materialCost: 55, laborCost: 65 }),
      capturedAt: "2026-04-25T10:00:00.000Z",
      note: null,
    });
    const out = computeVarianceSummary([snap]);
    expect(out.sampleSize).toBe(1);
    expect(out.meanAbsoluteVariance).toBe(20);
    expect(out.meanRelativeVariance).toBeCloseTo(0.2, 6);
    expect(out.maxAbsoluteVariance).toBe(20);
    // Material went from 50 → 55, +10%; labor 50 → 65, +30%
    expect(out.perLayerRelativeVariance.materialCost).toBeCloseTo(0.1, 6);
    expect(out.perLayerRelativeVariance.laborCost).toBeCloseTo(0.3, 6);
  });
});

// ---------- Variance: multi-snapshot averaging ----------

describe("computeVarianceSummary — multi-snapshot", () => {
  it("averages relative variance per snapshot, not weighted by total cost", () => {
    const small: ActualCostSnapshot = Object.freeze({
      snapshotId: "s1",
      tenantId: "t1",
      workOrderId: "wo1",
      productId: "p1",
      estimatedTotalCost: 10,
      actualTotalCost: 12, // +20%
      estimatedBreakdown: makeBreakdown(),
      actualBreakdown: makeBreakdown(),
      capturedAt: "2026-04-24T10:00:00.000Z",
      note: null,
    });
    const big: ActualCostSnapshot = Object.freeze({
      snapshotId: "s2",
      tenantId: "t1",
      workOrderId: "wo2",
      productId: "p1",
      estimatedTotalCost: 1000,
      actualTotalCost: 1000, // 0%
      estimatedBreakdown: makeBreakdown(),
      actualBreakdown: makeBreakdown(),
      capturedAt: "2026-04-25T10:00:00.000Z",
      note: null,
    });
    const out = computeVarianceSummary([small, big]);
    expect(out.sampleSize).toBe(2);
    // mean relative = (20% + 0%) / 2 = 10% — NOT total-actual / total-estimate − 1
    expect(out.meanRelativeVariance).toBeCloseTo(0.1, 6);
    // mean absolute = (2 + 0) / 2 = 1
    expect(out.meanAbsoluteVariance).toBeCloseTo(1, 6);
  });

  it("captures the largest absolute variance for outlier visibility", () => {
    const snaps: ActualCostSnapshot[] = [
      makeSnap("s1", 100, 105),  // +5
      makeSnap("s2", 100, 80),   // −20 (largest absolute)
      makeSnap("s3", 100, 110),  // +10
    ];
    const out = computeVarianceSummary(snaps);
    expect(out.maxAbsoluteVariance).toBe(-20);
  });

  it("tracks earliest + latest snapshot timestamps", () => {
    const snaps: ActualCostSnapshot[] = [
      makeSnapAt("s1", "2026-04-20T00:00:00.000Z"),
      makeSnapAt("s2", "2026-04-25T00:00:00.000Z"),
      makeSnapAt("s3", "2026-04-22T00:00:00.000Z"),
    ];
    const out = computeVarianceSummary(snaps);
    expect(out.earliestSnapshotAt).toBe("2026-04-20T00:00:00.000Z");
    expect(out.latestSnapshotAt).toBe("2026-04-25T00:00:00.000Z");
  });

  it("handles zero-estimate snapshots without dividing by zero", () => {
    const snaps: ActualCostSnapshot[] = [
      makeSnap("s1", 0, 50),    // 0 → 50; relative = 0 (degenerate, treated as 0)
      makeSnap("s2", 100, 110), // +10%
    ];
    const out = computeVarianceSummary(snaps);
    // mean relative = (0 + 0.1) / 2 = 0.05
    expect(out.meanRelativeVariance).toBeCloseTo(0.05, 6);
  });
});

// ---------- Per-product variance ----------

describe("createActualsTracker — getVarianceForProduct", () => {
  it("returns the variance summary across all snapshots for a product", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    tracker.recordSnapshot(makeRecordInput({ productId: "p1", actualTotalCost: 110 })); // +10
    tracker.recordSnapshot(makeRecordInput({ productId: "p1", workOrderId: "wo_2", actualTotalCost: 120 })); // +20
    tracker.recordSnapshot(makeRecordInput({ productId: "p2", workOrderId: "wo_3", actualTotalCost: 100 })); // 0% — different product
    const summary = tracker.getVarianceForProduct("p1");
    expect(summary.sampleSize).toBe(2);
    expect(summary.meanAbsoluteVariance).toBe(15); // (10 + 20) / 2
  });

  it("returns the zeroed summary for a product with no snapshots", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    const summary = tracker.getVarianceForProduct("ghost");
    expect(summary.sampleSize).toBe(0);
    expect(summary.meanRelativeVariance).toBe(0);
  });
});

// ---------- size + diagnostics ----------

describe("createActualsTracker — bookkeeping", () => {
  it("size reflects total snapshots stored", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    expect(tracker.size()).toBe(0);
    tracker.recordSnapshot(makeRecordInput());
    tracker.recordSnapshot(makeRecordInput({ workOrderId: "wo_2" }));
    expect(tracker.size()).toBe(2);
  });

  it("_clearForTests empties the tracker", () => {
    const tracker = createActualsTracker({ idGenerator: deterministicId });
    tracker.recordSnapshot(makeRecordInput());
    tracker._clearForTests();
    expect(tracker.size()).toBe(0);
    expect(tracker.getSnapshotsForWorkOrder("wo_1")).toEqual([]);
  });
});

// ---------- Helpers used by multi-snapshot tests ----------

function makeSnap(id: string, est: number, actual: number): ActualCostSnapshot {
  return Object.freeze({
    snapshotId: id,
    tenantId: "t1",
    workOrderId: "wo_" + id,
    productId: "p1",
    estimatedTotalCost: est,
    actualTotalCost: actual,
    estimatedBreakdown: makeBreakdown(),
    actualBreakdown: makeBreakdown(),
    capturedAt: "2026-04-25T10:00:00.000Z",
    note: null,
  });
}

function makeSnapAt(id: string, isoTimestamp: string): ActualCostSnapshot {
  return Object.freeze({
    snapshotId: id,
    tenantId: "t1",
    workOrderId: "wo_" + id,
    productId: "p1",
    estimatedTotalCost: 100,
    actualTotalCost: 100,
    estimatedBreakdown: makeBreakdown(),
    actualBreakdown: makeBreakdown(),
    capturedAt: isoTimestamp,
    note: null,
  });
}
