/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED. No reproduction, distribution,
 *           public display, or derivative works permitted without the
 *           prior written consent of the owner.
 *
 * File:     packages/costiq/src/core/__tests__/costCalculator.test.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Layer-by-layer unit coverage of the Cost IQ cost
 *           calculator. Verifies each of the 6 cost layers in
 *           isolation, then a composed multi-layer scenario, then
 *           every overhead model variant.
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

import { calculateJobCost } from "../costCalculator";
import type {
  ConsumableUsage,
  JobCostInput,
  LaborTime,
  MaterialUsage,
  OverheadModel,
  WorkstationUsage,
} from "../../models/jobCostInputModel";
import type {
  WorkstationConsumable,
  WorkstationCostProfile,
} from "../../models/workstationCostModel";

// ---------- Fixture helpers ----------

function makeConsumable(overrides: Partial<WorkstationConsumable> & { id: string; stationId: string }): WorkstationConsumable {
  return {
    name: "Consumable",
    costMethod: "per_minute",
    unit: "min",
    costPerUnit: 0,
    wasteFactor: 1,
    active: true,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<WorkstationCostProfile> & { stationId: string }): WorkstationCostProfile {
  return {
    ratePerMinute: 0,
    ratePerUnit: 0,
    minimumCharge: null,
    setup: null,
    cleanup: null,
    consumables: [],
    ...overrides,
  };
}

function makeWorkstationUsage(overrides: Partial<WorkstationUsage> & { stationId: string }): WorkstationUsage {
  return {
    profile: makeProfile({ stationId: overrides.stationId }),
    minutes: 0,
    units: 0,
    consumables: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<JobCostInput> = {}): JobCostInput {
  return {
    workOrderId: "wo_1",
    tenantId: "tenant_1",
    quantity: 1,
    materials: [],
    labor: [],
    workstations: [],
    overhead: { kind: "none" },
    ...overrides,
  };
}

// ---------- Layer 0: empty input ----------

describe("calculateJobCost — empty input", () => {
  it("returns zero for every layer when nothing is supplied", () => {
    const out = calculateJobCost(makeInput());
    expect(out).toMatchObject({
      materialCost: 0,
      consumableCost: 0,
      stationUsageCost: 0,
      laborCost: 0,
      setupCleanupCost: 0,
      directCost: 0,
      overheadCost: 0,
      totalCost: 0,
    });
  });
});

// ---------- Layer 1: materials ----------

describe("calculateJobCost — Layer 1 materials", () => {
  it("sums quantity × unitCost × wasteFactor for each material", () => {
    const materials: MaterialUsage[] = [
      { materialId: "m1", name: "Vinyl", quantity: 10, unitCost: 2, wasteFactor: 1.1 },   // 22
      { materialId: "m2", name: "Ink",   quantity: 4,  unitCost: 5, wasteFactor: 1.0 },   // 20
    ];
    const out = calculateJobCost(makeInput({ materials }));
    expect(out.materialCost).toBeCloseTo(42, 6);
    expect(out.directCost).toBeCloseTo(42, 6);
  });
});

// ---------- Layer 2: workstation consumables ----------

describe("calculateJobCost — Layer 2 consumables", () => {
  it("computes per-minute consumables with waste factor", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      consumables: [
        makeConsumable({
          id: "ink",
          stationId,
          costMethod: "per_minute",
          costPerUnit: 0.5,
          wasteFactor: 1.2,
        }),
      ],
    });
    const ws = makeWorkstationUsage({
      stationId,
      profile,
      minutes: 30,
      consumables: [{ consumableId: "ink", basisUnits: 30 }],
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    // 30 × 0.5 × 1.2 = 18
    expect(out.consumableCost).toBeCloseTo(18, 6);
  });

  it("skips inactive consumables", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      consumables: [
        makeConsumable({
          id: "ink",
          stationId,
          costPerUnit: 1,
          wasteFactor: 1,
          active: false,
        }),
      ],
    });
    const ws = makeWorkstationUsage({
      stationId,
      profile,
      consumables: [{ consumableId: "ink", basisUnits: 100 }],
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.consumableCost).toBe(0);
  });

  it("skips consumable usage referencing an unknown consumable id", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      consumables: [], // empty profile
    });
    const ws = makeWorkstationUsage({
      stationId,
      profile,
      consumables: [{ consumableId: "ghost", basisUnits: 100 }],
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.consumableCost).toBe(0);
  });

  it("percent_of_station_use takes a fraction of the station's Layer-3 cost", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      ratePerMinute: 1, // station charges $1/min
      consumables: [
        makeConsumable({
          id: "wear",
          stationId,
          costMethod: "percent_of_station_use",
          costPerUnit: 0.1, // 10% of station-usage cost
          wasteFactor: 1,
        }),
      ],
    });
    const ws = makeWorkstationUsage({
      stationId,
      profile,
      minutes: 60,
      consumables: [{ consumableId: "wear", basisUnits: 0 }],
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    // station = 60 × 1 = 60; consumable = 60 × 0.1 = 6
    expect(out.stationUsageCost).toBeCloseTo(60, 6);
    expect(out.consumableCost).toBeCloseTo(6, 6);
  });
});

// ---------- Layer 3: station usage ----------

describe("calculateJobCost — Layer 3 station usage", () => {
  it("combines per-minute and per-unit rates additively", () => {
    const profile = makeProfile({
      stationId: "press_a",
      ratePerMinute: 2,
      ratePerUnit: 0.25,
    });
    const ws = makeWorkstationUsage({
      stationId: "press_a",
      profile,
      minutes: 10,
      units: 50,
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    // 10 × 2 + 50 × 0.25 = 20 + 12.5 = 32.5
    expect(out.stationUsageCost).toBeCloseTo(32.5, 6);
  });

  it("clamps up to minimumCharge when raw cost is below the floor", () => {
    const profile = makeProfile({
      stationId: "press_a",
      ratePerMinute: 1,
      minimumCharge: 25,
    });
    const ws = makeWorkstationUsage({
      stationId: "press_a",
      profile,
      minutes: 5, // raw = 5, but min charge = 25
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.stationUsageCost).toBe(25);
  });

  it("does not clamp when raw cost is above the minimum", () => {
    const profile = makeProfile({
      stationId: "press_a",
      ratePerMinute: 1,
      minimumCharge: 10,
    });
    const ws = makeWorkstationUsage({
      stationId: "press_a",
      profile,
      minutes: 30, // raw = 30, above min
    });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.stationUsageCost).toBe(30);
  });
});

// ---------- Layer 4: labor ----------

describe("calculateJobCost — Layer 4 labor", () => {
  it("sums minutes × loadedRatePerMinute across all labor entries", () => {
    const labor: LaborTime[] = [
      { stationId: "press_a", employeeId: "emp_1", minutes: 30, loadedRatePerMinute: 0.5 }, // 15
      { stationId: "qc",      employeeId: "emp_2", minutes: 12, loadedRatePerMinute: 0.75 }, // 9
    ];
    const out = calculateJobCost(makeInput({ labor }));
    expect(out.laborCost).toBeCloseTo(24, 6);
  });
});

// ---------- Layer 5: setup + cleanup ----------

describe("calculateJobCost — Layer 5 setup and cleanup", () => {
  it("uses flatCost when present, ignores time × rate", () => {
    const profile = makeProfile({
      stationId: "press_a",
      setup: { flatCost: 25, timeMinutes: 999, ratePerMinute: 999 },
      cleanup: null,
    });
    const ws = makeWorkstationUsage({ stationId: "press_a", profile });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.setupCleanupCost).toBe(25);
  });

  it("computes time × rate when flatCost is null", () => {
    const profile = makeProfile({
      stationId: "press_a",
      setup: { flatCost: null, timeMinutes: 10, ratePerMinute: 1.5 }, // 15
      cleanup: { flatCost: null, timeMinutes: 5, ratePerMinute: 0.8 }, // 4
    });
    const ws = makeWorkstationUsage({ stationId: "press_a", profile });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.setupCleanupCost).toBeCloseTo(19, 6);
  });
});

// ---------- Layer 6: overhead ----------

describe("calculateJobCost — Layer 6 overhead", () => {
  function inputWithDirectCost(): JobCostInput {
    // 10 × 1 × 1 = 10 material cost; everything else zero -> direct = 10
    return makeInput({
      materials: [{ materialId: "m", name: "x", quantity: 10, unitCost: 1, wasteFactor: 1 }],
    });
  }

  it("percent_of_direct multiplies the direct cost", () => {
    const overhead: OverheadModel = { kind: "percent_of_direct", percent: 0.25 };
    const out = calculateJobCost({ ...inputWithDirectCost(), overhead });
    expect(out.directCost).toBe(10);
    expect(out.overheadCost).toBeCloseTo(2.5, 6);
    expect(out.totalCost).toBeCloseTo(12.5, 6);
  });

  it("fixed_per_job adds the flat amount", () => {
    const overhead: OverheadModel = { kind: "fixed_per_job", amount: 7 };
    const out = calculateJobCost({ ...inputWithDirectCost(), overhead });
    expect(out.overheadCost).toBe(7);
    expect(out.totalCost).toBe(17);
  });

  it("per_labor_minute multiplies labor minutes by rate", () => {
    const overhead: OverheadModel = { kind: "per_labor_minute", ratePerMinute: 0.1 };
    const labor: LaborTime[] = [
      { stationId: "press_a", employeeId: null, minutes: 40, loadedRatePerMinute: 0.5 },
    ];
    const out = calculateJobCost(makeInput({ labor, overhead }));
    // labor cost = 40 × 0.5 = 20; overhead = 40 × 0.1 = 4
    expect(out.laborCost).toBe(20);
    expect(out.overheadCost).toBeCloseTo(4, 6);
    expect(out.totalCost).toBeCloseTo(24, 6);
  });

  it("per_machine_minute multiplies station minutes by rate", () => {
    const overhead: OverheadModel = { kind: "per_machine_minute", ratePerMinute: 0.05 };
    const profile = makeProfile({ stationId: "press_a", ratePerMinute: 0 });
    const ws = makeWorkstationUsage({ stationId: "press_a", profile, minutes: 60 });
    const out = calculateJobCost(makeInput({ workstations: [ws], overhead }));
    expect(out.overheadCost).toBeCloseTo(3, 6);
  });

  it("none returns zero overhead", () => {
    const out = calculateJobCost({ ...inputWithDirectCost(), overhead: { kind: "none" } });
    expect(out.overheadCost).toBe(0);
    expect(out.totalCost).toBe(out.directCost);
  });
});

// ---------- Composed multi-layer scenario ----------

describe("calculateJobCost — composed scenario", () => {
  it("rolls up all 6 layers and reports a consistent direct + total cost", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      ratePerMinute: 1,
      ratePerUnit: 0.1,
      minimumCharge: null,
      setup: { flatCost: 10, timeMinutes: 0, ratePerMinute: 0 },
      cleanup: { flatCost: null, timeMinutes: 5, ratePerMinute: 1 }, // 5
      consumables: [
        makeConsumable({
          id: "ink",
          stationId,
          costMethod: "per_minute",
          costPerUnit: 0.25,
          wasteFactor: 1,
        }),
      ],
    });
    const ws: WorkstationUsage = makeWorkstationUsage({
      stationId,
      profile,
      minutes: 20,
      units: 50,
      consumables: [{ consumableId: "ink", basisUnits: 20 }],
    });
    const labor: LaborTime[] = [
      { stationId, employeeId: "emp_1", minutes: 25, loadedRatePerMinute: 0.6 }, // 15
    ];
    const materials: MaterialUsage[] = [
      { materialId: "m1", name: "Sheet", quantity: 5, unitCost: 4, wasteFactor: 1.1 }, // 22
    ];
    const overhead: OverheadModel = { kind: "percent_of_direct", percent: 0.2 };

    const out = calculateJobCost(makeInput({
      materials,
      labor,
      workstations: [ws],
      overhead,
    }));

    // Layer 1: 22
    // Layer 2: 20 × 0.25 × 1 = 5
    // Layer 3: 20 × 1 + 50 × 0.1 = 25
    // Layer 4: 25 × 0.6 = 15
    // Layer 5: 10 + 5 = 15
    // direct = 22 + 5 + 25 + 15 + 15 = 82
    // overhead = 82 × 0.20 = 16.4
    // total = 98.4

    expect(out.materialCost).toBeCloseTo(22, 6);
    expect(out.consumableCost).toBeCloseTo(5, 6);
    expect(out.stationUsageCost).toBeCloseTo(25, 6);
    expect(out.laborCost).toBeCloseTo(15, 6);
    expect(out.setupCleanupCost).toBeCloseTo(15, 6);
    expect(out.directCost).toBeCloseTo(82, 6);
    expect(out.overheadCost).toBeCloseTo(16.4, 6);
    expect(out.totalCost).toBeCloseTo(98.4, 6);
  });
});

// ---------- Output is frozen ----------

describe("calculateJobCost — output", () => {
  it("returns a frozen object so callers cannot mutate the breakdown", () => {
    const out = calculateJobCost(makeInput());
    expect(Object.isFrozen(out)).toBe(true);
  });
});

// ---------- Multi-consumable / multi-station mix ----------

describe("calculateJobCost — multi-consumable usage", () => {
  it("handles multiple usage entries across multiple consumables", () => {
    const stationId = "press_a";
    const profile = makeProfile({
      stationId,
      consumables: [
        makeConsumable({ id: "ink", stationId, costMethod: "per_minute", costPerUnit: 0.5, wasteFactor: 1 }),
        makeConsumable({ id: "wipe", stationId, costMethod: "per_print", costPerUnit: 0.1, wasteFactor: 1 }),
      ],
    });
    const usages: ConsumableUsage[] = [
      { consumableId: "ink", basisUnits: 10 },  // 5
      { consumableId: "wipe", basisUnits: 20 }, // 2
    ];
    const ws = makeWorkstationUsage({ stationId, profile, consumables: usages });
    const out = calculateJobCost(makeInput({ workstations: [ws] }));
    expect(out.consumableCost).toBeCloseTo(7, 6);
  });
});
