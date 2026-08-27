/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/__tests__/pricingEngine.test.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Integration tests for the Phase-1 pricing engine. Verifies
 *           that calculateJobPricing composes the cost calculator and
 *           margin calculator correctly and reports per-unit values,
 *           captured timestamp, and pass-through identity fields.
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

import { describe, expect, it } from "vitest";

import { calculateJobPricing } from "../pricingEngine";
import type { JobCostInput } from "../../models/jobCostInputModel";

const FROZEN_CLOCK = () => new Date("2026-04-25T08:30:00.000Z");

function makeBasicInput(overrides: Partial<JobCostInput> = {}): JobCostInput {
  return {
    workOrderId: "wo_1",
    tenantId: "tenant_1",
    quantity: 10,
    materials: [
      { materialId: "m1", name: "Sheet", quantity: 5, unitCost: 4, wasteFactor: 1 }, // 20
    ],
    labor: [],
    workstations: [],
    overhead: { kind: "none" },
    ...overrides,
  };
}

describe("calculateJobPricing — composition", () => {
  it("rolls up cost + applies markup + reports per-unit values", () => {
    const input = makeBasicInput({ quantity: 10 }); // direct cost = 20, total = 20
    const result = calculateJobPricing(
      input,
      { mode: "markup", marginPercent: 0.5 },
      { now: FROZEN_CLOCK },
    );

    expect(result.workOrderId).toBe("wo_1");
    expect(result.tenantId).toBe("tenant_1");
    expect(result.quantity).toBe(10);
    expect(result.capturedAt).toBe("2026-04-25T08:30:00.000Z");
    expect(result.breakdown.totalCost).toBeCloseTo(20, 6);
    expect(result.perUnitCost).toBeCloseTo(2, 6); // 20 / 10
    expect(result.mode).toBe("markup");
    expect(result.marginPercent).toBe(0.5);
    expect(result.suggestedPrice).toBeCloseTo(30, 6); // 20 × 1.5
    expect(result.perUnitPrice).toBeCloseTo(3, 6); // 30 / 10
    expect(result.grossProfit).toBeCloseTo(10, 6);
    expect(result.realizedMarginPercent).toBeCloseTo(10 / 30, 6);
  });

  it("applies margin mode correctly through the orchestrator", () => {
    const input = makeBasicInput({ quantity: 1 });
    const result = calculateJobPricing(
      input,
      { mode: "margin", marginPercent: 0.4 },
      { now: FROZEN_CLOCK },
    );
    // Cost = 20; price = 20 / (1 - 0.4) = 33.333...
    expect(result.suggestedPrice).toBeCloseTo(33.3333, 4);
    expect(result.perUnitPrice).toBeCloseTo(33.3333, 4);
    expect(result.realizedMarginPercent).toBeCloseTo(0.4, 6);
  });
});

describe("calculateJobPricing — per-unit math", () => {
  it("divides total cost and price by quantity for per-unit values", () => {
    const input = makeBasicInput({ quantity: 4 }); // cost = 20
    const result = calculateJobPricing(
      input,
      { mode: "markup", marginPercent: 0 },
      { now: FROZEN_CLOCK },
    );
    expect(result.perUnitCost).toBeCloseTo(5, 6);   // 20 / 4
    expect(result.perUnitPrice).toBeCloseTo(5, 6);  // price = cost since markup 0
  });

  it("reports zero per-unit values when quantity is zero (no /0)", () => {
    const input = makeBasicInput({ quantity: 0 });
    const result = calculateJobPricing(
      input,
      { mode: "markup", marginPercent: 0.5 },
      { now: FROZEN_CLOCK },
    );
    expect(result.quantity).toBe(0);
    expect(result.perUnitCost).toBe(0);
    expect(result.perUnitPrice).toBe(0);
    // Job-level totals still accurate
    expect(result.suggestedPrice).toBeCloseTo(30, 6);
    expect(result.breakdown.totalCost).toBeCloseTo(20, 6);
  });
});

describe("calculateJobPricing — clock injection", () => {
  it("uses the injected clock for capturedAt", () => {
    const input = makeBasicInput();
    const fixedDate = new Date("2027-01-15T12:00:00.000Z");
    const result = calculateJobPricing(
      input,
      { mode: "markup", marginPercent: 0 },
      { now: () => fixedDate },
    );
    expect(result.capturedAt).toBe("2027-01-15T12:00:00.000Z");
  });

  it("falls back to wall clock when no clock is injected", () => {
    const input = makeBasicInput();
    const before = Date.now();
    const result = calculateJobPricing(
      input,
      { mode: "markup", marginPercent: 0 },
    );
    const after = Date.now();
    const captured = Date.parse(result.capturedAt);
    expect(captured).toBeGreaterThanOrEqual(before);
    expect(captured).toBeLessThanOrEqual(after);
  });
});

describe("calculateJobPricing — output integrity", () => {
  it("returns a frozen object", () => {
    const result = calculateJobPricing(
      makeBasicInput(),
      { mode: "markup", marginPercent: 0.2 },
      { now: FROZEN_CLOCK },
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("embeds the full cost breakdown object", () => {
    const result = calculateJobPricing(
      makeBasicInput(),
      { mode: "markup", marginPercent: 0 },
      { now: FROZEN_CLOCK },
    );
    expect(result.breakdown).toMatchObject({
      materialCost: 20,
      consumableCost: 0,
      stationUsageCost: 0,
      laborCost: 0,
      setupCleanupCost: 0,
      directCost: 20,
      overheadCost: 0,
      totalCost: 20,
    });
  });
});

describe("calculateJobPricing — Phase-1 deliverable scenario", () => {
  it("end-to-end: a custom work order quote with all 6 cost layers + markup", () => {
    // Real-ish scenario: 25 widgets, 1 station, materials, labor, overhead.
    const stationId = "press_a";
    const input: JobCostInput = {
      workOrderId: "wo_demo",
      tenantId: "tenant_1",
      quantity: 25,
      materials: [
        { materialId: "m_vinyl", name: "Vinyl", quantity: 25, unitCost: 1.5, wasteFactor: 1.1 }, // 41.25
      ],
      labor: [
        { stationId, employeeId: "emp_1", minutes: 45, loadedRatePerMinute: 0.7 }, // 31.5
      ],
      workstations: [
        {
          stationId,
          profile: {
            stationId,
            ratePerMinute: 1,      // 30 × 1 = 30
            ratePerUnit: 0,
            minimumCharge: null,
            setup: { flatCost: 15, timeMinutes: 0, ratePerMinute: 0 }, // 15
            cleanup: null,
            consumables: [
              {
                id: "ink",
                stationId,
                name: "Ink",
                costMethod: "per_minute",
                unit: "ml",
                costPerUnit: 0.2,    // 30 × 0.2 × 1 = 6
                wasteFactor: 1,
                active: true,
              },
            ],
          },
          minutes: 30,
          units: 25,
          consumables: [{ consumableId: "ink", basisUnits: 30 }],
        },
      ],
      overhead: { kind: "percent_of_direct", percent: 0.15 },
    };

    const result = calculateJobPricing(
      input,
      { mode: "margin", marginPercent: 0.35 },
      { now: FROZEN_CLOCK },
    );

    // Layer math:
    //   materials      = 25 × 1.5 × 1.1 = 41.25
    //   consumables    = 30 × 0.2 × 1   = 6
    //   stationUsage   = 30 × 1         = 30
    //   labor          = 45 × 0.7       = 31.5
    //   setupCleanup   = 15
    //   direct         = 41.25 + 6 + 30 + 31.5 + 15 = 123.75
    //   overhead       = 123.75 × 0.15  = 18.5625
    //   total          = 142.3125
    // Margin mode @ 35%:
    //   suggestedPrice = 142.3125 / (1 - 0.35) = 218.9423...
    //   grossProfit    = 76.6298...
    //   realized       = 0.35
    // Per-unit:
    //   perUnitCost    = 142.3125 / 25 = 5.6925
    //   perUnitPrice   = 218.9423 / 25 = 8.7577

    expect(result.breakdown.materialCost).toBeCloseTo(41.25, 6);
    expect(result.breakdown.consumableCost).toBeCloseTo(6, 6);
    expect(result.breakdown.stationUsageCost).toBeCloseTo(30, 6);
    expect(result.breakdown.laborCost).toBeCloseTo(31.5, 6);
    expect(result.breakdown.setupCleanupCost).toBeCloseTo(15, 6);
    expect(result.breakdown.directCost).toBeCloseTo(123.75, 6);
    expect(result.breakdown.overheadCost).toBeCloseTo(18.5625, 6);
    expect(result.breakdown.totalCost).toBeCloseTo(142.3125, 6);
    expect(result.suggestedPrice).toBeCloseTo(218.9423, 4);
    expect(result.perUnitCost).toBeCloseTo(5.6925, 4);
    expect(result.perUnitPrice).toBeCloseTo(8.7577, 4);
    expect(result.realizedMarginPercent).toBeCloseTo(0.35, 6);
  });
});
