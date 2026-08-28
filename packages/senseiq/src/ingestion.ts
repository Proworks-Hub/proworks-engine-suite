// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { localObservationSchema, type LocalObservation } from "./observation.js";

// ─────────────────────────────────────────────────────────────────────────────
// Getting observations from a sensor to whoever needs them.
//
// Not everything deserves the same urgency. A machine going offline matters in
// the second it happens; a power reading every ten seconds matters as a trend
// over a week. Forcing both down one path means either flooding the bus with
// telemetry nobody reads in real time, or delaying a fault behind an
// aggregation window.
//
// So there are two lanes and the choice between them is a RULE, not a guess:
//
//   REAL TIME — state changed, health changed, a threshold was crossed. Things
//   that are interesting because they are *different from a moment ago*.
//
//   BATCHED — continuous measurement. Interesting in aggregate, uninteresting
//   individually.
//
// The rule has one deliberate exception: an anomaly in a batched stream is
// promoted to real time. A power draw at four times normal is a continuous
// measurement by type and an emergency by content, and burying it in an hourly
// roll-up is how an electrical fault gets noticed the next morning.
// ─────────────────────────────────────────────────────────────────────────────

export const deliveryLaneSchema = z.enum(["realtime", "batched"]);
export type DeliveryLane = z.infer<typeof deliveryLaneSchema>;

export interface LaneDecision {
  readonly lane: DeliveryLane;
  /** Why, so a surprising routing is explicable rather than mysterious. */
  readonly reason: string;
}

export interface LaneOptions {
  /** The last value seen for this device and kind, when there is one. */
  previous?: LocalObservation;
  /**
   * How far a continuous reading must move to be worth interrupting somebody.
   *
   * A multiple rather than an absolute, because the same rule has to work for
   * watts and for degrees. Default 4× — high enough that ordinary variation
   * stays batched, low enough that a stuck contactor does not.
   */
  anomalyFactor?: number;
}

const ALWAYS_REALTIME = new Set(["machineState", "deviceHealth", "occupancy"]);

/**
 * Decides which lane an observation belongs in.
 *
 * Kind first, then content. The kinds that are always real time are the ones
 * that describe a *change of condition* rather than a measurement — and the
 * anomaly check exists so content can override the type when it has to.
 */
export function classifyDelivery(
  observation: LocalObservation,
  options: LaneOptions = {},
): LaneDecision {
  if (ALWAYS_REALTIME.has(observation.kind)) {
    return {
      lane: "realtime",
      reason: `${observation.kind} describes a change of condition, which is only useful immediately.`,
    };
  }

  const factor = options.anomalyFactor ?? 4;
  const previous = options.previous;

  if (previous && previous.unit === observation.unit && Math.abs(previous.value) > 0) {
    const ratio = Math.abs(observation.value) / Math.abs(previous.value);
    if (ratio >= factor) {
      // Content overriding type. A continuous measurement that jumped this far
      // is an event, whatever its kind says.
      return {
        lane: "realtime",
        reason: `${observation.value}${observation.unit} is ${ratio.toFixed(1)}× the previous reading — an anomaly, not a trend.`,
      };
    }
  }

  return {
    lane: "batched",
    reason: "A continuous measurement, useful in aggregate rather than individually.",
  };
}

// ── Batching ─────────────────────────────────────────────────────────────────

export interface ObservationBatch {
  readonly deviceId: string;
  readonly kind: string;
  readonly capability: string;
  readonly unit: string;
  readonly ownerRef: string;
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

/**
 * Rolls a window of readings into one record.
 *
 * Keeps min and max alongside the mean, and that is the point of the shape. A
 * mean alone hides the spike that caused the incident — the ten-minute average
 * of a machine that briefly drew 40A looks entirely normal.
 *
 * Groups strictly by device, kind AND unit. Combining a reading in watts with
 * one in kilowatts produces a number that is confidently wrong, which is worse
 * than refusing.
 */
export function batchObservations(
  observations: readonly LocalObservation[],
): ObservationBatch[] {
  const groups = new Map<string, LocalObservation[]>();

  for (const observation of observations) {
    const key = `${observation.deviceId}|${observation.kind}|${observation.unit}|${observation.ownerRef}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }

  const batches: ObservationBatch[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    const values = sorted.map((observation) => observation.value);
    const sum = values.reduce((total, value) => total + value, 0);
    const first = sorted[0]!;

    batches.push({
      deviceId: first.deviceId,
      kind: first.kind,
      capability: first.capability,
      unit: first.unit,
      ownerRef: first.ownerRef,
      from: first.observedAt,
      to: sorted[sorted.length - 1]!.observedAt,
      count: sorted.length,
      sum,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: sum / sorted.length,
    });
  }

  return batches;
}

// ── Machine state from power ─────────────────────────────────────────────────

export const machineStateSchema = z.enum(["off", "idle", "active", "unknown"]);
export type MachineState = z.infer<typeof machineStateSchema>;

export interface MachineStateThresholds {
  /** At or below this, the machine is off. */
  offBelowWatts: number;
  /** Above `offBelowWatts` and at or below this, it is powered but not working. */
  idleBelowWatts: number;
}

export interface MachineStateReading {
  readonly state: MachineState;
  readonly at: string;
  readonly watts: number;
  /** How this was decided, since it is an inference rather than a report. */
  readonly basis: string;
}

/**
 * Infers what a machine is doing from what it is drawing.
 *
 * This is inference, and the type says so: `machine.state` reported by a
 * machine's own controller is a fact, and this is a reading of a proxy. It is
 * enormously useful anyway — it is what lets "the UV printer started at 10:43"
 * exist without anybody typing it — but it must never be presented as though
 * the machine said it.
 *
 * Returns `unknown` rather than guessing when the thresholds are unset. A
 * default threshold would be wrong for every machine except the one it was
 * chosen for, and confidently wrong at that.
 */
export function inferMachineState(
  observation: LocalObservation,
  thresholds?: MachineStateThresholds,
): MachineStateReading {
  if (observation.unit !== "W") {
    return {
      state: "unknown",
      at: observation.observedAt,
      watts: observation.value,
      basis: `Reading is in ${observation.unit}, not watts.`,
    };
  }

  if (!thresholds) {
    return {
      state: "unknown",
      at: observation.observedAt,
      watts: observation.value,
      basis: "No thresholds are configured for this machine, and a default would be wrong for every machine but one.",
    };
  }

  if (observation.value <= thresholds.offBelowWatts) {
    return {
      state: "off",
      at: observation.observedAt,
      watts: observation.value,
      basis: `${observation.value}W is at or below the ${thresholds.offBelowWatts}W off threshold.`,
    };
  }

  if (observation.value <= thresholds.idleBelowWatts) {
    return {
      state: "idle",
      at: observation.observedAt,
      watts: observation.value,
      basis: `${observation.value}W is between the off and idle thresholds — powered but not working.`,
    };
  }

  return {
    state: "active",
    at: observation.observedAt,
    watts: observation.value,
    basis: `${observation.value}W is above the ${thresholds.idleBelowWatts}W idle threshold.`,
  };
}

export interface StateTransition {
  readonly from: MachineState;
  readonly to: MachineState;
  readonly at: string;
  readonly basis: string;
}

/**
 * Finds where a machine changed state across a run of readings.
 *
 * `minimumHoldMs` exists because power draw is noisy: a machine idling near its
 * threshold will cross it repeatedly, and reporting each crossing produces a
 * timeline of forty state changes for a machine that sat still. A transition
 * has to hold to count.
 */
export function findTransitions(
  readings: readonly MachineStateReading[],
  minimumHoldMs = 30_000,
): StateTransition[] {
  const sorted = [...readings].sort((a, b) => a.at.localeCompare(b.at));
  const transitions: StateTransition[] = [];

  let settled: MachineStateReading | undefined = sorted[0];
  let candidate: MachineStateReading | undefined;

  for (const reading of sorted.slice(1)) {
    if (!settled) break;

    if (reading.state === settled.state) {
      // Back to where it was, so whatever was building never happened.
      candidate = undefined;
      continue;
    }

    if (!candidate || candidate.state !== reading.state) {
      candidate = reading;
      continue;
    }

    const held = Date.parse(reading.at) - Date.parse(candidate.at);
    if (held >= minimumHoldMs) {
      transitions.push({
        from: settled.state,
        to: candidate.state,
        // Timestamped from when the change STARTED, not when it was confirmed.
        // "The printer started at 10:43" is the useful fact; 10:44 is an
        // artefact of how long we waited to be sure.
        at: candidate.at,
        basis: `${candidate.basis} Held for ${Math.round(held / 1000)}s.`,
      });
      settled = candidate;
      candidate = undefined;
    }
  }

  return transitions;
}

/**
 * Turns a state reading into an observation for the pipeline.
 *
 * Kept explicit rather than inferred inside `record`, so an inferred state is
 * only ever stored when a caller deliberately asks for it — and it carries
 * `machineState`, which the lane classifier routes as real time.
 */
export function stateObservation(
  source: LocalObservation,
  reading: MachineStateReading,
): LocalObservation {
  return localObservationSchema.parse({
    ...source,
    observationId: `${source.deviceId}:state:${reading.at}`,
    kind: "machineState",
    capability: "machine.state",
    observedAt: reading.at,
    // 0 off, 1 idle, 2 active, -1 unknown. Numeric because the observation
    // shape is numeric; the meaning travels in the unit.
    value: reading.state === "off" ? 0 : reading.state === "idle" ? 1 : reading.state === "active" ? 2 : -1,
    unit: "machineState",
  });
}
