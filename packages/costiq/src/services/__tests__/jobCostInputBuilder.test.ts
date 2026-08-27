/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/services/__tests__/jobCostInputBuilder.test.ts
 * Module:   cost-iq-engine / services
 * Purpose:  Unit coverage for the WorkOrder → JobCostInput adapter.
 *           Verifies quantity resolution order, default rate
 *           application, override hooks, and degenerate inputs
 *           (no items, no stations, partial overrides).
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

import {
  buildJobCostInputFromWorkOrder,
  DEFAULT_BUILDER_DEFAULTS,
  type WorkOrderLike,
} from "../jobCostInputBuilder.js";
import { calculateJobCost } from "../../core/costCalculator.js";

function makeWO(overrides: Partial<WorkOrderLike> = {}): WorkOrderLike {
  return {
    id: "wo_demo",
    tenantId: "tenant_1",
    machineSequence: ["press_a", "qc"],
    items: [{}, {}, {}, {}, {}], // 5 items
    ...overrides,
  };
}

// ---------- Quantity resolution ----------

describe("buildJobCostInputFromWorkOrder — quantity resolution", () => {
  it("uses workOrder.quantity when set and > 0", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ quantity: 25 }),
    );
    expect(out.quantity).toBe(25);
  });

  it("falls back to items.length when quantity is missing", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ quantity: undefined, items: [{}, {}, {}] }),
    );
    expect(out.quantity).toBe(3);
  });

  it("defaults to 1 when neither quantity nor items are populated", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ quantity: undefined, items: [] }),
    );
    expect(out.quantity).toBe(1);
  });

  it("ignores zero / negative quantity values and falls through", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ quantity: 0, items: [{}, {}] }),
    );
    expect(out.quantity).toBe(2);
  });
});

// ---------- Identity pass-through ----------

describe("buildJobCostInputFromWorkOrder — identity", () => {
  it("propagates workOrderId and tenantId unchanged", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ id: "wo_xyz", tenantId: "tenant_42" }),
    );
    expect(out.workOrderId).toBe("wo_xyz");
    expect(out.tenantId).toBe("tenant_42");
  });
});

// ---------- Default-driven workstations + labor ----------

describe("buildJobCostInputFromWorkOrder — workstations + labor", () => {
  it("emits one workstation + one labor entry per station in machineSequence", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: ["a", "b", "c"] }),
    );
    expect(out.workstations).toHaveLength(3);
    expect(out.labor).toHaveLength(3);
    expect(out.workstations.map((w) => w.stationId)).toEqual(["a", "b", "c"]);
    expect(out.labor.map((l) => l.stationId)).toEqual(["a", "b", "c"]);
  });

  it("uses the default rates and times on every station/labor entry", () => {
    const d = DEFAULT_BUILDER_DEFAULTS;
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: ["press_a"] }),
    );
    expect(out.workstations[0].profile.ratePerMinute).toBe(d.stationRatePerMinute);
    expect(out.workstations[0].minutes).toBe(d.stationDefaultMinutes);
    expect(out.labor[0].minutes).toBe(d.laborDefaultMinutes);
    expect(out.labor[0].loadedRatePerMinute).toBe(d.laborRatePerMinute);
  });

  it("returns empty workstations + labor when machineSequence is missing", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: undefined }),
    );
    expect(out.workstations).toHaveLength(0);
    expect(out.labor).toHaveLength(0);
  });

  it("returns empty workstations + labor when machineSequence is empty", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: [] }),
    );
    expect(out.workstations).toHaveLength(0);
    expect(out.labor).toHaveLength(0);
  });
});

// ---------- Materials ----------

describe("buildJobCostInputFromWorkOrder — materials", () => {
  it("emits a single estimated-materials row when WO has items", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ items: [{}, {}, {}], quantity: 3 }),
    );
    expect(out.materials).toHaveLength(1);
    expect(out.materials[0].materialId).toBe("default-material");
    expect(out.materials[0].name).toContain("estimated");
    expect(out.materials[0].quantity).toBe(3);
    expect(out.materials[0].unitCost).toBe(DEFAULT_BUILDER_DEFAULTS.materialUnitCost);
  });

  it("returns empty materials when WO has no items", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ items: [] }),
    );
    expect(out.materials).toHaveLength(0);
  });
});

// ---------- Override hook ----------

describe("buildJobCostInputFromWorkOrder — override hook", () => {
  it("applies a single default override and inherits the rest", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: ["press_a"] }),
      { defaults: { stationRatePerMinute: 5 } },
    );
    expect(out.workstations[0].profile.ratePerMinute).toBe(5);
    // Other fields still inherit defaults.
    expect(out.labor[0].loadedRatePerMinute).toBe(
      DEFAULT_BUILDER_DEFAULTS.laborRatePerMinute,
    );
  });

  it("applies a custom overhead percent", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO(),
      { defaults: { overheadPercent: 0.2 } },
    );
    expect(out.overhead).toEqual({ kind: "percent_of_direct", percent: 0.2 });
  });
});

// ---------- End-to-end with calculator ----------

describe("buildJobCostInputFromWorkOrder — end-to-end with calculator", () => {
  it("produces a valid input that the cost calculator accepts", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: ["press_a"], items: [{}, {}], quantity: 2 }),
    );
    const breakdown = calculateJobCost(out);
    // direct cost should be > 0 because all defaults are positive
    expect(breakdown.directCost).toBeGreaterThan(0);
    // total cost = direct + overhead (10% by default)
    expect(breakdown.totalCost).toBeGreaterThan(breakdown.directCost);
  });

  it("yields zero cost when no stations are routed and no items exist", () => {
    const out = buildJobCostInputFromWorkOrder(
      makeWO({ machineSequence: [], items: [] }),
    );
    const breakdown = calculateJobCost(out);
    expect(breakdown.directCost).toBe(0);
    expect(breakdown.totalCost).toBe(0);
  });
});
