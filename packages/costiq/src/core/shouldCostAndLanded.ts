/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/shouldCostAndLanded.ts
 * Module:   cost-iq-engine / core
 * Purpose:  What a thing OUGHT to cost, what it costs once it has arrived,
 *           and what it costs over its life.
 */

import {
  type Decimal,
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fromInteger,
  fromString,
  multiply,
  subtract,
  normalize,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// SHOULD-COST IS A DIFFERENT QUESTION FROM WHAT WE PAY
//
// "What does this cost?" has at least three answers and they are routinely
// confused:
//
//   PAID         what the invoice said.
//   STANDARD     what we have agreed to measure against.
//   SHOULD-COST  what it would cost a competent supplier to make, built up
//                from materials, process, labour rates and a reasonable
//                margin — regardless of what anybody is charging.
//
// The value of should-cost is entirely in the GAP. "We pay £42 and it should
// cost £31" is a negotiation. Merging the two numbers destroys the only thing
// should-cost was for, so they are separate in the model, separate in the
// explanation, and this module refuses to produce one labelled as the other.
//
// COSTIQ DOES NOT READ CAD
//
// The directive is explicit: no geometry recognition here. Should-cost
// consumes a process and material breakdown that ForgeIQ, VisionIQ or an
// industry adapter produced. Building feature recognition into a cost engine
// would be CostIQ taking ownership of something it cannot maintain.
//
// LANDED COST: THE PRICE IS NOT THE COST
//
// A part quoted at £10 from overseas is not £10. Freight, duty, insurance and
// handling arrive later, on different documents, allocated across a shipment
// containing other things. The allocation basis is a CHOICE — by value, by
// weight, by volume, by unit — and different bases give materially different
// answers for the same shipment. So the basis is recorded with the result.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fraction rendered as a percentage.
 *
 * Normalised, because multiplying by 100 keeps the input's scale and produces
 * "20.0%" and "15.00%" from the same code path — which reads as though the
 * two were measured to different precision when they were not.
 */
function asPercent(fraction: Decimal): string {
  return decToString(normalize(multiply(fraction, fromInteger(100))));
}

export interface ShouldCostInput {
  /** Material cost from a process/BOM breakdown produced elsewhere. */
  readonly materialCost: Decimal;
  /** Process time in minutes, from the same source. */
  readonly processMinutes: Decimal;
  /** A competent supplier's rate for that process, in this region. */
  readonly processRatePerMinute: Decimal;
  readonly setupCost: Decimal;
  readonly setupAmortizedOverUnits: Decimal | null;
  /** Overhead a competent supplier would carry, as a fraction of direct cost. */
  readonly overheadFraction: Decimal;
  /** The margin a supplier would reasonably expect, as a fraction of price. */
  readonly supplierMarginFraction: Decimal;
  readonly quantity: Decimal;
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];
  /** Where the rates came from, so the number is challengeable. */
  readonly rateSource: string;
}

export interface ShouldCostResult {
  readonly materialCost: Decimal;
  readonly processCost: Decimal;
  readonly setupShare: Decimal;
  readonly directCost: Decimal;
  readonly overhead: Decimal;
  /** What it costs the supplier to make. */
  readonly supplierCost: Decimal;
  /** What a supplier would reasonably charge, including their margin. */
  readonly shouldCostPrice: Decimal;
  readonly unitShouldCost: Decimal;
  readonly assumptions: readonly string[];
}

/**
 * What a competent supplier would need to charge.
 *
 * Bottom-up. Every input is stated, so the output is arguable — which is the
 * point: a should-cost nobody can challenge is a number nobody will act on in
 * a negotiation.
 */
export function computeShouldCost(input: ShouldCostInput): ShouldCostResult {
  if (compare(input.quantity, ZERO) <= 0) {
    throw new RangeError("Should-cost needs a quantity greater than zero; there is no per-unit answer for nothing.");
  }
  if (compare(input.supplierMarginFraction, ONE) >= 0) {
    throw new RangeError(
      `A supplier margin of ${decToString(input.supplierMarginFraction)} is not a margin — margin is a fraction of price and must be below 1.`,
    );
  }

  const assumptions: string[] = [`Rates taken from ${input.rateSource}.`];

  const processCost = multiply(input.processMinutes, input.processRatePerMinute);

  let setupShare = input.setupCost;
  if (input.setupAmortizedOverUnits !== null) {
    if (compare(input.setupAmortizedOverUnits, ZERO) <= 0) {
      throw new RangeError("Setup cannot be amortised over zero units.");
    }
    setupShare = multiply(
      divide(input.setupCost, input.setupAmortizedOverUnits, input.scale, input.mode),
      input.quantity,
    );
    assumptions.push(
      `Setup of ${decToString(input.setupCost)} amortised over ${decToString(input.setupAmortizedOverUnits)} units.`,
    );
  } else {
    assumptions.push(`Setup of ${decToString(input.setupCost)} charged wholly to this order.`);
  }

  const directCost = add(add(input.materialCost, processCost), setupShare);
  const overhead = multiply(directCost, input.overheadFraction);
  const supplierCost = add(directCost, overhead);
  assumptions.push(
    `Supplier overhead assumed at ${asPercent(input.overheadFraction)}% of direct cost.`,
  );

  // Margin is on PRICE, so it divides. Marking up here would understate what a
  // supplier needs to charge — the same error that costs sellers money, in
  // reverse.
  const shouldCostPrice = divide(
    supplierCost,
    subtract(ONE, input.supplierMarginFraction),
    input.scale,
    input.mode,
  );
  assumptions.push(
    `Supplier margin assumed at ${asPercent(input.supplierMarginFraction)}% of price.`,
  );

  return {
    materialCost: input.materialCost,
    processCost,
    setupShare,
    directCost,
    overhead,
    supplierCost,
    shouldCostPrice,
    unitShouldCost: divide(shouldCostPrice, input.quantity, input.scale, input.mode),
    assumptions,
  };
}

/**
 * The gap between what is paid and what it should cost.
 *
 * The only reason should-cost exists. Reported as evidence — never as an
 * instruction to renegotiate, which is a procurement decision the charter
 * places outside CostIQ.
 */
export function shouldCostGap(
  paid: Decimal,
  shouldCost: Decimal,
  scale: number,
  mode: Parameters<typeof divide>[3],
): {
  readonly gap: Decimal;
  readonly gapFraction: Decimal;
  readonly direction: "PAYING_MORE" | "PAYING_LESS" | "ALIGNED";
  readonly note: string;
} {
  const gap = subtract(paid, shouldCost);
  const direction =
    compare(gap, ZERO) > 0 ? "PAYING_MORE" : compare(gap, ZERO) < 0 ? "PAYING_LESS" : "ALIGNED";
  return {
    gap,
    gapFraction: compare(shouldCost, ZERO) === 0 ? ZERO : divide(gap, shouldCost, scale, mode),
    direction,
    note: "Economic evidence only. Whether to act on it — renegotiate, resource, accept — is a procurement decision CostIQ does not own.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDED COST
// ─────────────────────────────────────────────────────────────────────────────

export type AllocationBasis = "BY_VALUE" | "BY_WEIGHT" | "BY_VOLUME" | "BY_UNIT";

export interface ShipmentLine {
  readonly lineId: string;
  readonly label: string;
  readonly goodsValue: Decimal;
  readonly weight: Decimal;
  readonly volume: Decimal;
  readonly units: Decimal;
}

export interface LandedCostInput {
  readonly lines: readonly ShipmentLine[];
  /** Costs that arrive on separate documents and apply to the whole shipment. */
  readonly freight: Decimal;
  readonly insurance: Decimal;
  readonly handling: Decimal;
  /** Duty is usually a percentage of value per line, not a shipment total. */
  readonly dutyFractionByLine: ReadonlyMap<string, Decimal>;
  readonly basis: AllocationBasis;
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];
}

export interface LandedLine {
  readonly lineId: string;
  readonly label: string;
  readonly goodsValue: Decimal;
  readonly allocatedFreight: Decimal;
  readonly allocatedInsurance: Decimal;
  readonly allocatedHandling: Decimal;
  readonly duty: Decimal;
  readonly landedTotal: Decimal;
  readonly landedPerUnit: Decimal;
}

export interface LandedCostResult {
  readonly lines: readonly LandedLine[];
  readonly basis: AllocationBasis;
  readonly basisNote: string;
  readonly total: Decimal;
}

function basisWeight(line: ShipmentLine, basis: AllocationBasis): Decimal {
  switch (basis) {
    case "BY_VALUE":
      return line.goodsValue;
    case "BY_WEIGHT":
      return line.weight;
    case "BY_VOLUME":
      return line.volume;
    case "BY_UNIT":
      return line.units;
    default: {
      const unreachable: never = basis;
      throw new TypeError(`Unknown allocation basis ${String(unreachable)}.`);
    }
  }
}

const BASIS_NOTES: Readonly<Record<AllocationBasis, string>> = Object.freeze({
  BY_VALUE:
    "Allocated by goods value. Simple and common; it charges expensive light items more freight than they physically caused.",
  BY_WEIGHT:
    "Allocated by weight. Closest to what actually drives freight cost for dense goods; it under-charges bulky light items.",
  BY_VOLUME:
    "Allocated by volume. Right when a container fills up before it weighs out; it under-charges dense heavy items.",
  BY_UNIT:
    "Allocated per unit. Defensible only when the items are genuinely alike; otherwise it charges a washer the same as a casting.",
});

/**
 * Spreads shipment-level costs across the lines that caused them.
 *
 * THE BASIS IS A CHOICE AND IT MATTERS. The same shipment allocated by weight
 * and by value gives materially different per-item costs, and neither is
 * wrong — so the basis and its trade-off travel with the result rather than
 * being a setting somebody chose once and forgot.
 *
 * Uses the exact allocator, so the allocated parts sum to the shipment cost
 * with nothing lost.
 */
export function computeLandedCost(input: LandedCostInput): LandedCostResult {
  if (input.lines.length === 0) {
    return { lines: [], basis: input.basis, basisNote: BASIS_NOTES[input.basis], total: ZERO };
  }

  const weights = input.lines.map((l) => basisWeight(l, input.basis));
  const totalWeight = weights.reduce<Decimal>((acc, w) => add(acc, w), ZERO);

  if (compare(totalWeight, ZERO) <= 0) {
    throw new RangeError(
      `Cannot allocate ${input.basis} when every line's ${input.basis.replace("BY_", "").toLowerCase()} is zero. Choose a basis the shipment actually varies by.`,
    );
  }

  const share = (total: Decimal, weight: Decimal) =>
    divide(multiply(total, weight), totalWeight, input.scale, input.mode);

  const lines = input.lines.map((line, index) => {
    const weight = weights[index]!;
    const allocatedFreight = share(input.freight, weight);
    const allocatedInsurance = share(input.insurance, weight);
    const allocatedHandling = share(input.handling, weight);

    // Duty is per line on its own value, not a shipment total to spread — a
    // tariff applies to the goods it applies to.
    const dutyFraction = input.dutyFractionByLine.get(line.lineId) ?? ZERO;
    const duty = multiply(line.goodsValue, dutyFraction);

    const landedTotal = add(
      add(add(line.goodsValue, allocatedFreight), add(allocatedInsurance, allocatedHandling)),
      duty,
    );

    return {
      lineId: line.lineId,
      label: line.label,
      goodsValue: line.goodsValue,
      allocatedFreight,
      allocatedInsurance,
      allocatedHandling,
      duty,
      landedTotal,
      landedPerUnit:
        compare(line.units, ZERO) === 0 ? ZERO : divide(landedTotal, line.units, input.scale, input.mode),
    };
  });

  return {
    lines,
    basis: input.basis,
    basisNote: BASIS_NOTES[input.basis],
    total: lines.reduce<Decimal>((acc, l) => add(acc, l.landedTotal), ZERO),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE / TCO
// ─────────────────────────────────────────────────────────────────────────────

export interface LifecycleCost {
  readonly label: string;
  readonly amount: Decimal;
  /** Which year it falls in. 0 is today. */
  readonly year: number;
  readonly recurring: boolean;
}

export interface LifecycleInput {
  readonly costs: readonly LifecycleCost[];
  /** How many years the analysis covers. Stated, never assumed. */
  readonly horizonYears: number;
  /**
   * Discount rate as a fraction, or null for undiscounted.
   *
   * Null is a real choice, not a missing value. Discounting requires a rate
   * that is a FINANCIAL parameter — Finance IQ's to approve — and using one
   * CostIQ invented would be CostIQ making a financial assumption it does not
   * own.
   */
  readonly discountRate: Decimal | null;
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];
}

export interface LifecycleResult {
  readonly byYear: readonly { readonly year: number; readonly amount: Decimal; readonly discounted: Decimal }[];
  readonly undiscountedTotal: Decimal;
  readonly discountedTotal: Decimal;
  readonly horizonYears: number;
  readonly assumptions: readonly string[];
}

/**
 * Total cost of ownership across a stated horizon.
 *
 * THE HORIZON IS REQUIRED. A TCO with no horizon is not a number — five years
 * of running costs and fifteen years of running costs are different answers to
 * the same question, and comparing two alternatives over different horizons is
 * how a worse option wins.
 */
export function computeLifecycleCost(input: LifecycleInput): LifecycleResult {
  if (input.horizonYears <= 0 || !Number.isInteger(input.horizonYears)) {
    throw new RangeError("A lifecycle analysis needs a whole-number horizon greater than zero; without one the total is not a number.");
  }

  const assumptions: string[] = [`Analysed over ${input.horizonYears} year(s).`];

  // Recurring costs repeat every year within the horizon; one-offs fall in
  // their stated year. Anything beyond the horizon is EXCLUDED and said so —
  // silently dropping it would make a long-lived alternative look cheaper.
  const byYearMap = new Map<number, Decimal>();
  let excluded = 0;
  for (const cost of input.costs) {
    if (cost.recurring) {
      for (let year = cost.year; year < input.horizonYears; year += 1) {
        byYearMap.set(year, add(byYearMap.get(year) ?? ZERO, cost.amount));
      }
      if (cost.year >= input.horizonYears) excluded += 1;
    } else if (cost.year < input.horizonYears) {
      byYearMap.set(cost.year, add(byYearMap.get(cost.year) ?? ZERO, cost.amount));
    } else {
      excluded += 1;
    }
  }
  if (excluded > 0) {
    assumptions.push(
      `${excluded} cost(s) fall beyond the ${input.horizonYears}-year horizon and are excluded. A longer horizon would change this answer.`,
    );
  }

  if (input.discountRate === null) {
    assumptions.push("Undiscounted. Future money is treated as equal to money today.");
  } else {
    assumptions.push(
      `Discounted at ${asPercent(input.discountRate)}% per year. This rate is a financial parameter and must come from Finance IQ, not from CostIQ.`,
    );
  }

  const byYear = [...byYearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, amount]) => {
      if (input.discountRate === null) return { year, amount, discounted: amount };
      // Divide by (1 + r)^year, computed by repeated multiplication so the
      // whole calculation stays exact.
      let divisor = ONE;
      for (let i = 0; i < year; i += 1) divisor = multiply(divisor, add(ONE, input.discountRate));
      return { year, amount, discounted: divide(amount, divisor, input.scale, input.mode) };
    });

  return {
    byYear,
    undiscountedTotal: byYear.reduce<Decimal>((acc, y) => add(acc, y.amount), ZERO),
    discountedTotal: byYear.reduce<Decimal>((acc, y) => add(acc, y.discounted), ZERO),
    horizonYears: input.horizonYears,
    assumptions,
  };
}

/**
 * Compares lifecycle alternatives.
 *
 * REFUSES different horizons. Comparing five years of one option against
 * fifteen of another is how a worse option wins an analysis, and it is a
 * mistake that is almost invisible in a summary table.
 */
export function compareLifecycle(
  alternatives: ReadonlyArray<{ readonly label: string; readonly result: LifecycleResult }>,
): {
  readonly ranked: ReadonlyArray<{ readonly label: string; readonly discountedTotal: Decimal }>;
  readonly note: string;
} {
  const horizons = new Set(alternatives.map((a) => a.result.horizonYears));
  if (horizons.size > 1) {
    throw new RangeError(
      `Cannot compare lifecycle alternatives over different horizons (${[...horizons].sort().join(", ")} years). The shorter horizon flatters whichever option front-loads its costs.`,
    );
  }

  const ranked = [...alternatives]
    .map((a) => ({ label: a.label, discountedTotal: a.result.discountedTotal }))
    .sort((a, b) => compare(a.discountedTotal, b.discountedTotal) || (a.label < b.label ? -1 : 1));

  return {
    ranked,
    note: "Ranked by cost over the stated horizon. Which alternative to choose is a decision CostIQ informs and does not make.",
  };
}
