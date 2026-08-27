/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/__tests__/actualsCapturePipeline.test.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Tests for the captureActualsForCompletedWorkOrder pipeline.
 *           Verifies estimate derivation via the input builder + cost
 *           calculator, snapshot recording through the tracker,
 *           variance math (positive / negative / zero estimate), and
 *           the actualTotalCost override behavior.
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
  captureActualsForCompletedWorkOrder,
  costBreakdownToLayerBreakdown,
  sumLayerBreakdown,
} from "../actualsCapturePipeline";
import { createActualsTracker } from "../actualsTrackerService";
import { calculateJobCost } from "../../core/costCalculator";
import { buildJobCostInputFromWorkOrder } from "../jobCostInputBuilder";
import type { ActualCostLayerBreakdown } from "../../models/actualCostSnapshotModel";
import type { WorkOrderLike } from "../jobCostInputBuilder";

// ---------- Fixtures ----------

const FROZEN_CLOCK = () => new Date("2026-04-25T11:00:00.000Z");

let nextIdCounter = 0;
function deterministicId(): string {
  nextIdCounter += 1;
  return `snap_${nextIdCounter.toString().padStart(4, "0")}`;
}

function makeWO(overrides: Partial<WorkOrderLike> = {}): WorkOrderLike {
  return {
    id: "wo_demo",
    tenantId: "tenant_1",
    machineSequence: ["press_a"],
    items: [{}, {}],
    ...overrides,
  };
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

beforeEach(() => {
  nextIdCounter = 0;
});

// ---------- Estimate derivation ----------

describe("captureActualsForCompletedWorkOrder — estimate derivation", () => {
  it("derives the estimated breakdown via the existing builder + calculator", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO();
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown({ materialCost: 30, laborCost: 20, overheadCost: 5 }),
    });

    // Same as running the live UI calculator over this WO.
    const expectedInput = buildJobCostInputFromWorkOrder(workOrder);
    const expectedBreakdown = calculateJobCost(expectedInput);
    expect(result.estimatedTotalCost).toBeCloseTo(expectedBreakdown.totalCost, 6);
    expect(result.estimatedBreakdown.materialCost).toBeCloseTo(expectedBreakdown.materialCost, 6);
    expect(result.estimatedBreakdown.laborCost).toBeCloseTo(expectedBreakdown.laborCost, 6);
  });

  it("respects the estimateDefaults override when provided", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO();
    // Crank up the station rate so the estimate jumps measurably.
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown(),
      estimateDefaults: { stationRatePerMinute: 100 }, // huge rate
    });
    // Default station rate is 1; with 100 the station usage cost
    // jumps to 30 × 100 = 3000.
    expect(result.estimatedBreakdown.stationUsageCost).toBeCloseTo(3000, 6);
  });
});

// ---------- Snapshot recording ----------

describe("captureActualsForCompletedWorkOrder — snapshot recording", () => {
  it("records the snapshot via the tracker and indexes it by workOrderId", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO({ id: "wo_alpha" });
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown({ laborCost: 25 }),
    });
    expect(result.snapshot.snapshotId).toBe("snap_0001");
    expect(tracker.size()).toBe(1);
    expect(tracker.getSnapshotsForWorkOrder("wo_alpha")).toHaveLength(1);
  });

  it("records productId when supplied and indexes by it", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: makeWO(),
      actualBreakdown: makeBreakdown(),
      productId: "prod_widget_a",
    });
    expect(tracker.getSnapshotsForProduct("prod_widget_a")).toHaveLength(1);
  });

  it("records productId as null when omitted (one-off WO)", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: makeWO(),
      actualBreakdown: makeBreakdown(),
    });
    expect(result.snapshot.productId).toBeNull();
  });

  it("attaches the optional note to the snapshot", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: makeWO(),
      actualBreakdown: makeBreakdown(),
      note: "Rush job — extra setup time expected",
    });
    expect(result.snapshot.note).toBe("Rush job — extra setup time expected");
  });
});

// ---------- actualTotalCost resolution ----------

describe("captureActualsForCompletedWorkOrder — actualTotalCost", () => {
  it("derives actualTotalCost from sum of breakdown when not provided", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: makeWO(),
      actualBreakdown: makeBreakdown({
        materialCost: 10,
        laborCost: 20,
        overheadCost: 5,
      }),
    });
    expect(result.snapshot.actualTotalCost).toBe(35);
  });

  it("uses actualTotalCost override when provided", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: makeWO(),
      actualBreakdown: makeBreakdown({ materialCost: 10, laborCost: 20 }), // sum = 30
      actualTotalCost: 50, // override (e.g., for adjustments not in breakdown)
    });
    expect(result.snapshot.actualTotalCost).toBe(50);
  });
});

// ---------- Variance reporting ----------

describe("captureActualsForCompletedWorkOrder — variance", () => {
  it("reports positive variance when actual exceeds estimate", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO();
    // Estimate this WO to know the target — defaults yield a known cost.
    const baseline = calculateJobCost(buildJobCostInputFromWorkOrder(workOrder));
    const overrun = baseline.totalCost + 25; // 25 over

    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown(), // doesn't matter
      actualTotalCost: overrun,
    });
    expect(result.variance.absolute).toBeCloseTo(25, 6);
    expect(result.variance.relative).toBeCloseTo(25 / baseline.totalCost, 6);
  });

  it("reports negative variance when actual undershoots estimate", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO();
    const baseline = calculateJobCost(buildJobCostInputFromWorkOrder(workOrder));
    const underrun = baseline.totalCost - 10;

    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown(),
      actualTotalCost: underrun,
    });
    expect(result.variance.absolute).toBeCloseTo(-10, 6);
    expect(result.variance.relative).toBeLessThan(0);
  });

  it("returns zero relative variance when estimate is zero (no /0)", () => {
    // Build a WO with no stations / items so the estimate is 0.
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const workOrder = makeWO({ machineSequence: [], items: [] });
    const baseline = calculateJobCost(buildJobCostInputFromWorkOrder(workOrder));
    expect(baseline.totalCost).toBe(0);

    const result = captureActualsForCompletedWorkOrder({
      tracker,
      workOrder,
      actualBreakdown: makeBreakdown({ laborCost: 50 }),
    });
    expect(result.variance.relative).toBe(0); // not Infinity / NaN
    expect(result.variance.absolute).toBe(50);
  });
});

// ---------- Helpers ----------

describe("costBreakdownToLayerBreakdown", () => {
  it("projects only the 6 layer fields, dropping derived rollups", () => {
    const breakdown = {
      materialCost: 10,
      consumableCost: 5,
      stationUsageCost: 20,
      laborCost: 15,
      setupCleanupCost: 8,
      directCost: 58,  // derived — should NOT appear in output
      overheadCost: 5,
      totalCost: 63,   // derived — should NOT appear in output
    };
    const layered = costBreakdownToLayerBreakdown(breakdown);
    expect(layered).toEqual({
      materialCost: 10,
      consumableCost: 5,
      stationUsageCost: 20,
      laborCost: 15,
      setupCleanupCost: 8,
      overheadCost: 5,
    });
    expect("directCost" in layered).toBe(false);
    expect("totalCost" in layered).toBe(false);
  });
});

describe("sumLayerBreakdown", () => {
  it("sums the 6 layer values", () => {
    expect(
      sumLayerBreakdown({
        materialCost: 10,
        consumableCost: 5,
        stationUsageCost: 20,
        laborCost: 15,
        setupCleanupCost: 8,
        overheadCost: 5,
      }),
    ).toBe(63);
  });

  it("returns 0 for an all-zero breakdown", () => {
    expect(
      sumLayerBreakdown({
        materialCost: 0,
        consumableCost: 0,
        stationUsageCost: 0,
        laborCost: 0,
        setupCleanupCost: 0,
        overheadCost: 0,
      }),
    ).toBe(0);
  });
});

// ---------- End-to-end: tracker + capture + variance summary ----------

describe("captureActualsForCompletedWorkOrder — end-to-end with VarianceSummary", () => {
  it("multiple captures for the same product feed the variance summary", () => {
    const tracker = createActualsTracker({ now: FROZEN_CLOCK, idGenerator: deterministicId });
    const wo1 = makeWO({ id: "wo_1" });
    const wo2 = makeWO({ id: "wo_2" });
    const baseline = calculateJobCost(buildJobCostInputFromWorkOrder(wo1));

    captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: wo1,
      actualBreakdown: makeBreakdown(),
      actualTotalCost: baseline.totalCost + 10,
      productId: "prod_widget",
    });
    captureActualsForCompletedWorkOrder({
      tracker,
      workOrder: wo2,
      actualBreakdown: makeBreakdown(),
      actualTotalCost: baseline.totalCost + 20,
      productId: "prod_widget",
    });

    const summary = tracker.getVarianceForProduct("prod_widget");
    expect(summary.sampleSize).toBe(2);
    expect(summary.meanAbsoluteVariance).toBeCloseTo(15, 6); // (10 + 20) / 2
  });
});
