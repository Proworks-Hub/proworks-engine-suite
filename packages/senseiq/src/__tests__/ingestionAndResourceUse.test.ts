// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  batchObservations,
  classifyDelivery,
  findTransitions,
  inferMachineState,
  stateObservation,
  type MachineStateReading,
} from "../ingestion.js";
import { localObservationSchema, type LocalObservation } from "../observation.js";
import {
  assertNoMonetaryFields,
  buildEnergyReport,
  buildRuntimeReport,
  resourceUseReportSchema,
} from "../resourceUse.js";

const NOW = Date.parse("2026-08-28T10:00:00.000Z");
const at = (msAfter = 0) => new Date(NOW + msAfter).toISOString();

const observation = (over: Partial<LocalObservation> = {}): LocalObservation =>
  localObservationSchema.parse({
    observationId: `o-${Math.random()}`,
    kind: "power",
    capability: "power.measure",
    deviceId: "simulated:plug-1",
    ownerRef: "org:1",
    observedAt: at(),
    value: 120,
    unit: "W",
    ...over,
  });

describe("which lane an observation belongs in", () => {
  it("sends a change of condition immediately", () => {
    for (const kind of ["machineState", "deviceHealth", "occupancy"] as const) {
      expect(classifyDelivery(observation({ kind })).lane, kind).toBe("realtime");
    }
  });

  it("batches a continuous measurement", () => {
    expect(classifyDelivery(observation()).lane).toBe("batched");
  });

  it("promotes an anomaly out of the batch", () => {
    // A power draw at four times normal is a continuous measurement by type and
    // an emergency by content. Burying it in an hourly roll-up is how an
    // electrical fault gets noticed the next morning.
    const decision = classifyDelivery(observation({ value: 600 }), {
      previous: observation({ value: 120 }),
    });
    expect(decision.lane).toBe("realtime");
    expect(decision.reason).toContain("anomaly");
  });

  it("does not promote ordinary variation", () => {
    expect(
      classifyDelivery(observation({ value: 150 }), { previous: observation({ value: 120 }) }).lane,
    ).toBe("batched");
  });

  it("will not compare across units", () => {
    // 1.2 kWh against 120 W is not a 100× drop.
    expect(
      classifyDelivery(observation({ value: 1.2, unit: "kWh", kind: "energy" }), {
        previous: observation({ value: 120, unit: "W" }),
      }).lane,
    ).toBe("batched");
  });

  it("survives a previous reading of zero", () => {
    expect(() =>
      classifyDelivery(observation({ value: 100 }), { previous: observation({ value: 0 }) }),
    ).not.toThrow();
  });
});

describe("rolling readings into a batch", () => {
  it("keeps min and max, not just the mean", () => {
    // A mean alone hides the spike that caused the incident.
    const batches = batchObservations([
      observation({ value: 100, observedAt: at(0) }),
      observation({ value: 4_000, observedAt: at(1_000) }),
      observation({ value: 100, observedAt: at(2_000) }),
    ]);

    expect(batches[0]!.max).toBe(4_000);
    expect(batches[0]!.min).toBe(100);
    expect(batches[0]!.mean).toBeCloseTo(1_400);
  });

  it("refuses to mix units into one number", () => {
    // Combining watts with kilowatt-hours produces a confidently wrong figure.
    const batches = batchObservations([
      observation({ value: 100, unit: "W" }),
      observation({ value: 2, unit: "kWh", kind: "energy" }),
    ]);
    expect(batches).toHaveLength(2);
  });

  it("keeps different owners apart", () => {
    const batches = batchObservations([
      observation({ ownerRef: "org:1" }),
      observation({ ownerRef: "org:2" }),
    ]);
    expect(batches).toHaveLength(2);
  });

  it("orders the window by time regardless of arrival order", () => {
    const batches = batchObservations([
      observation({ observedAt: at(5_000) }),
      observation({ observedAt: at(0) }),
    ]);
    expect(batches[0]!.from).toBe(at(0));
    expect(batches[0]!.to).toBe(at(5_000));
  });
});

describe("inferring what a machine is doing", () => {
  const thresholds = { offBelowWatts: 5, idleBelowWatts: 80 };

  it("reads off, idle and active from the draw", () => {
    expect(inferMachineState(observation({ value: 2 }), thresholds).state).toBe("off");
    expect(inferMachineState(observation({ value: 40 }), thresholds).state).toBe("idle");
    expect(inferMachineState(observation({ value: 900 }), thresholds).state).toBe("active");
  });

  it("refuses to guess without thresholds", () => {
    // A default would be wrong for every machine except the one it was chosen
    // for, and confidently wrong at that.
    const reading = inferMachineState(observation({ value: 900 }));
    expect(reading.state).toBe("unknown");
    expect(reading.basis).toContain("default would be wrong");
  });

  it("refuses a reading that is not in watts", () => {
    expect(inferMachineState(observation({ value: 2, unit: "kWh" }), thresholds).state).toBe("unknown");
  });

  it("always explains itself", () => {
    // This is inference from a proxy, never the machine reporting its own
    // state, and it must not be presented as though it were.
    expect(inferMachineState(observation({ value: 900 }), thresholds).basis).toContain("above");
  });

  it("carries machineState into the real-time lane", () => {
    const reading = inferMachineState(observation({ value: 900 }), thresholds);
    const derived = stateObservation(observation({ value: 900 }), reading);
    expect(derived.kind).toBe("machineState");
    expect(classifyDelivery(derived).lane).toBe("realtime");
  });
});

describe("finding when a machine actually started", () => {
  const reading = (state: MachineStateReading["state"], msAfter: number): MachineStateReading => ({
    state,
    at: at(msAfter),
    watts: state === "active" ? 900 : 40,
    basis: "test",
  });

  it("ignores noise around a threshold", () => {
    // A machine idling near its threshold crosses it repeatedly. Reporting each
    // crossing produces forty state changes for a machine that sat still.
    const transitions = findTransitions(
      [
        reading("idle", 0),
        reading("active", 1_000),
        reading("idle", 2_000),
        reading("active", 3_000),
        reading("idle", 4_000),
      ],
      30_000,
    );
    expect(transitions).toEqual([]);
  });

  it("reports a transition that holds", () => {
    const transitions = findTransitions(
      [reading("idle", 0), reading("active", 10_000), reading("active", 60_000)],
      30_000,
    );
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.to).toBe("active");
  });

  it("timestamps from when the change started, not when it was confirmed", () => {
    // "The printer started at 10:43" is the useful fact. The confirmation time
    // is an artefact of how long we waited to be sure.
    const transitions = findTransitions(
      [reading("idle", 0), reading("active", 10_000), reading("active", 60_000)],
      30_000,
    );
    expect(transitions[0]!.at).toBe(at(10_000));
  });

  it("sorts before analysing", () => {
    const transitions = findTransitions(
      [reading("active", 60_000), reading("idle", 0), reading("active", 10_000)],
      30_000,
    );
    expect(transitions[0]!.from).toBe("idle");
  });
});

describe("the CostIQ boundary", () => {
  it("refuses a report that has started pricing things", () => {
    // The temptation is real: SenseIQ knows the kilowatt-hours and multiplying
    // by a rate is one line. Then two engines both price energy and disagree
    // the first time a tariff changes.
    expect(() => assertNoMonetaryFields({ quantity: 1.3, costUsd: 0.19 })).toThrow(/does not price/);
    expect(() => assertNoMonetaryFields({ quantity: 1.3, meta: { ratePerKwh: 0.14 } })).toThrow();
    expect(() => assertNoMonetaryFields({ quantity: 1.3, unit: "kWh" })).not.toThrow();
  });

  it("refuses a monetary field anywhere in the schema", () => {
    expect(() =>
      resourceUseReportSchema.parse({
        reportId: "r1", ownerRef: "org:1", equipmentRef: "uv-2", equipmentClass: "uv-flatbed",
        kind: "energy", quantity: 1.3, unit: "kWh", from: at(), to: at(1_000),
        basis: "measured", sampleCount: 4, costUsd: 0.19,
      }),
    ).toThrow();
  });

  it("costs equipment, not the sensor watching it", () => {
    // Passing a device id would make the financial model depend on which plug
    // happened to be monitoring the machine.
    const report = buildEnergyReport({
      observations: [
        observation({ kind: "energy", unit: "kWh", value: 0.7, capability: "energy.measure" }),
        observation({ kind: "energy", unit: "kWh", value: 0.6, capability: "energy.measure", observedAt: at(60_000) }),
      ],
      equipmentRef: "uv-printer-2",
      equipmentClass: "uv-flatbed-printer",
      reportId: "r1",
    });

    expect(report?.equipmentRef).toBe("uv-printer-2");
    expect(report?.quantity).toBeCloseTo(1.3);
    expect(JSON.stringify(report)).not.toContain("simulated:plug-1");
  });

  it("marks metered energy as measured", () => {
    const report = buildEnergyReport({
      observations: [observation({ kind: "energy", unit: "kWh", value: 1, capability: "energy.measure" })],
      equipmentRef: "uv-2", equipmentClass: "uv-flatbed-printer", reportId: "r1",
    });
    expect(report?.basis).toBe("measured");
  });

  it("returns nothing rather than a zero report", () => {
    // Zero kilowatt-hours claims the machine ran and used nothing, which reads
    // as a saving in an actual-versus-estimate comparison.
    expect(
      buildEnergyReport({ observations: [], equipmentRef: "uv-2", equipmentClass: "x", reportId: "r1" }),
    ).toBeNull();
  });

  it("refuses to sum across mixed units", () => {
    expect(
      buildEnergyReport({
        observations: [
          observation({ kind: "energy", unit: "kWh", value: 1 }),
          observation({ kind: "energy", unit: "Wh", value: 900 }),
        ],
        equipmentRef: "uv-2", equipmentClass: "x", reportId: "r1",
      }),
    ).toBeNull();
  });

  it("always marks runtime as inferred", () => {
    // Derived from power crossing a threshold, not from the machine reporting
    // itself. A per-job cost built on this is an estimate dressed as an actual
    // unless the basis travels with it.
    const report = buildRuntimeReport({
      transitions: [
        { from: "idle", to: "active", at: at(0), basis: "test" },
        { from: "active", to: "idle", at: at(43 * 60_000), basis: "test" },
      ],
      ownerRef: "org:1", equipmentRef: "uv-2", equipmentClass: "uv-flatbed-printer",
      reportId: "r2", until: at(60 * 60_000),
    });

    expect(report?.basis).toBe("inferred");
    expect(report?.quantity).toBe(43);
    expect(report?.unit).toBe("minutes");
  });

  it("counts a machine still running when the window closed", () => {
    // Dropping it systematically undercounts the longest jobs — exactly the
    // ones costing most.
    const report = buildRuntimeReport({
      transitions: [{ from: "idle", to: "active", at: at(0), basis: "test" }],
      ownerRef: "org:1", equipmentRef: "uv-2", equipmentClass: "x",
      reportId: "r3", until: at(30 * 60_000),
    });
    expect(report?.quantity).toBe(30);
  });

  it("returns nothing when the machine never ran", () => {
    expect(
      buildRuntimeReport({
        transitions: [{ from: "active", to: "idle", at: at(0), basis: "test" }],
        ownerRef: "org:1", equipmentRef: "uv-2", equipmentClass: "x",
        reportId: "r4", until: at(60_000),
      }),
    ).toBeNull();
  });

  it("carries a correlation id so a report can be tied to the work", () => {
    const report = buildEnergyReport({
      observations: [observation({ kind: "energy", unit: "kWh", value: 1 })],
      equipmentRef: "uv-2", equipmentClass: "x", reportId: "r1", correlationId: "wo-3819",
    });
    expect(report?.correlationId).toBe("wo-3819");
  });
});
