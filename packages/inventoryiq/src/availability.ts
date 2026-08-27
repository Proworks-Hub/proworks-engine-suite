// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  addQuantity,
  compareQuantity,
  isNegativeQuantity,
  subtractQuantity,
  sumQuantities,
  zeroQuantity,
  type Quantity,
  type StockPosition,
} from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// What is actually available, which is not what is on the shelf.
//
// available = onHand − reserved
//
// The whole engine turns on that one line, and on refusing to let it go
// negative silently. A shop that promises the same sheet of aluminium to two
// jobs finds out at the machine, and the second job is already set up.
// ─────────────────────────────────────────────────────────────────────────────

export interface Availability {
  readonly materialId: string;
  readonly unit: Quantity["unit"];
  readonly onHand: Quantity;
  readonly reserved: Quantity;
  /** `onHand − reserved`, floored at nothing. See `oversold`. */
  readonly available: Quantity;
  /**
   * True when more is reserved than exists.
   *
   * This is a real state, not an impossible one: stock gets counted wrong,
   * material gets damaged, someone reserves against a delivery that then
   * arrives short. Representing it is what lets the shop be told. Clamping
   * `available` at zero and saying nothing is how it becomes a surprise at a
   * machine instead of a message in an office.
   */
  readonly oversold: boolean;
  readonly locations: ReadonlyArray<{
    readonly locationId: string;
    readonly onHand: Quantity;
    readonly reserved: Quantity;
    readonly available: Quantity;
  }>;
}

/**
 * Rolls up every location holding a material.
 *
 * Locations are summed rather than picked between, because "is there enough"
 * is a different question from "where do I get it". Answering the first with
 * one location's stock is how a shop with material in two bins decides it has
 * none.
 */
export function computeAvailability(
  materialId: string,
  positions: ReadonlyArray<StockPosition>,
): Availability {
  const relevant = positions.filter((p) => p.materialId === materialId);

  if (relevant.length === 0) {
    // Nothing known about this material, which is not the same as zero — but
    // for the purpose of "can I promise it", it is. The unit is unknowable
    // here, so it takes the caller's word later.
    return {
      materialId,
      unit: "each",
      onHand: zeroQuantity("each"),
      reserved: zeroQuantity("each"),
      available: zeroQuantity("each"),
      oversold: false,
      locations: [],
    };
  }

  const unit = relevant[0]!.onHand.unit;

  // A material stocked in two units in two bins is a data problem that must
  // surface here rather than be averaged into a plausible wrong number.
  const onHand = sumQuantities(
    relevant.map((p) => p.onHand),
    unit,
  );
  const reserved = sumQuantities(
    relevant.map((p) => p.reserved),
    unit,
  );

  const net = subtractQuantity(onHand, reserved);
  const oversold = isNegativeQuantity(net);

  return {
    materialId,
    unit,
    onHand,
    reserved,
    available: oversold ? zeroQuantity(unit) : net,
    oversold,
    locations: relevant.map((p) => {
      const locationNet = subtractQuantity(p.onHand, p.reserved);
      return {
        locationId: p.locationId,
        onHand: p.onHand,
        reserved: p.reserved,
        available: isNegativeQuantity(locationNet) ? zeroQuantity(unit) : locationNet,
      };
    }),
  };
}

/** What a work order needs of one material. */
export interface MaterialRequirement {
  readonly materialId: string;
  readonly required: Quantity;
}

export interface Shortage {
  readonly materialId: string;
  readonly required: Quantity;
  readonly available: Quantity;
  /** How much is missing. Always positive. */
  readonly short: Quantity;
  /** True when the material is not stocked at all, rather than merely low. */
  readonly unknownMaterial: boolean;
}

/**
 * Compares what a job needs against what a shop can promise.
 *
 * Returns shortages only. A caller that wants the whole picture asks for
 * availability; a caller that wants to know whether to start work wants this,
 * and giving it a list that is usually empty makes the check cheap to do often.
 */
export function detectShortages(
  requirements: ReadonlyArray<MaterialRequirement>,
  positions: ReadonlyArray<StockPosition>,
): Shortage[] {
  const shortages: Shortage[] = [];

  for (const requirement of requirements) {
    const availability = computeAvailability(requirement.materialId, positions);
    const unknownMaterial = availability.locations.length === 0;

    // An unstocked material is short by everything asked for. Its unit comes
    // from the requirement, since there is no stock to take one from.
    const available = unknownMaterial
      ? zeroQuantity(requirement.required.unit)
      : availability.available;

    if (compareQuantity(requirement.required, available) <= 0) continue;

    shortages.push({
      materialId: requirement.materialId,
      required: requirement.required,
      available,
      short: subtractQuantity(requirement.required, available),
      unknownMaterial,
    });
  }

  return shortages;
}

/** Materials at or below their reorder point. */
export interface ReorderSignal {
  readonly materialId: string;
  readonly locationId: string;
  readonly available: Quantity;
  readonly reorderPoint: Quantity;
  readonly suggestedOrder: Quantity;
}

/**
 * Which materials to buy more of.
 *
 * Compares against AVAILABLE rather than on-hand, deliberately. A shelf with
 * ten sheets that are all promised to jobs is an empty shelf as far as the next
 * job is concerned, and a reorder rule that looks at on-hand will not notice
 * until the shelf is physically bare — which is a week too late.
 */
export function detectReorderSignals(
  positions: ReadonlyArray<StockPosition>,
): ReorderSignal[] {
  const signals: ReorderSignal[] = [];

  for (const position of positions) {
    if (!position.reorderPoint) continue;

    const net = subtractQuantity(position.onHand, position.reserved);
    const available = isNegativeQuantity(net) ? zeroQuantity(position.onHand.unit) : net;
    if (compareQuantity(available, position.reorderPoint) > 0) continue;

    // Top back up to the reorder point when no explicit quantity is configured,
    // rather than ordering an arbitrary amount.
    const suggestedOrder =
      position.reorderQuantity ?? subtractQuantity(position.reorderPoint, available);

    signals.push({
      materialId: position.materialId,
      locationId: position.locationId,
      available,
      reorderPoint: position.reorderPoint,
      suggestedOrder,
    });
  }

  return signals;
}

/** Applies a delta to a position's on-hand, keeping reserved untouched. */
export function applyStockDelta(position: StockPosition, delta: Quantity): StockPosition {
  return { ...position, onHand: addQuantity(position.onHand, delta) };
}
