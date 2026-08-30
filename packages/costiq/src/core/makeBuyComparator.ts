/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/makeBuyComparator.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Make or buy — and the absorbed overhead that ruins the comparison.
 */

import {
  type Decimal,
  type RoundingMode,
  ZERO,
  add,
  compare,
  divide,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE MISTAKE THIS MODULE EXISTS TO PREVENT
//
// Somebody compares the fully absorbed cost to make a part — material, labour,
// and a share of factory overhead — against a supplier's quoted price. The
// supplier looks cheaper. The part is outsourced. The following year the
// overhead is unchanged, because the rent, the supervisors and the depreciation
// never depended on that part, and now it is spread over less work. Unit costs
// across the whole plant go UP, and nobody can point at the decision that did
// it.
//
// This is the single most expensive routine error in manufacturing costing, and
// it happens because absorbed cost is the number the accounting system produces
// and avoidable cost is not.
//
// So the comparison here is built on AVOIDABLE cost, and unavoidable overhead is
// carried as a separate, named figure that is reported and never netted off.
// The engine refuses to produce a make/buy verdict from an absorbed cost alone.
//
// THE OTHER THREE THINGS PEOPLE LEAVE OUT
//
//   - The price is not the cost of buying. Freight, duty, incoming inspection,
//     the inventory you now have to hold, and the buyer's time are all real.
//   - Making it uses capacity. If that capacity is scarce, whatever it displaces
//     is a genuine cost of making; if it is idle, that cost is zero. Both are
//     legitimate and the difference is enormous.
//   - Switching costs money once: tooling transfer, first-article qualification,
//     a redundancy, a dual-run period. A per-unit comparison hides it, so it is
//     reported separately along with how long it takes to pay back.
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeOption {
  /** Cost that genuinely disappears if the part is not made here. */
  readonly avoidableVariableCostPerUnit: Decimal;
  /**
   * Fixed cost that would actually be removed — a leased machine returned, a
   * line shut. Rarely as large as people assume.
   */
  readonly avoidableFixedCost: Decimal;
  /**
   * Overhead absorbed by this part that would NOT go away.
   *
   * Carried so it can be shown, never subtracted. This is the figure that makes
   * buying look cheaper than it is.
   */
  readonly unavoidableAbsorbedOverhead: Decimal;
  /**
   * What the capacity used to make this would otherwise earn.
   *
   * Zero when the capacity is idle, which is a real and common answer. Nonzero
   * when making this displaces work the shop would otherwise take.
   */
  readonly opportunityCostPerUnit: Decimal;
}

export interface BuyOption {
  readonly supplierPricePerUnit: Decimal;
  /** Freight, duty, inspection, holding cost — the cost of buying, not the price. */
  readonly acquisitionCostPerUnit: Decimal;
  /** One-off cost of switching: qualification, tooling transfer, dual running. */
  readonly transitionCost: Decimal;
  /**
   * Non-cost consequences of buying, recorded because they usually decide it.
   *
   * Lead time, a capability the shop stops practising, a single source of
   * supply. The engine cannot price these and does not try.
   */
  readonly nonCostConsequences: readonly string[];
}

export interface MakeBuyResult {
  readonly quantity: Decimal;
  /** Total cost that actually changes if the decision goes this way. */
  readonly makeAvoidableTotal: Decimal;
  readonly buyTotal: Decimal;
  /** Positive when buying costs more than making. */
  readonly difference: Decimal;
  readonly differencePerUnit: Decimal;
  readonly cheaperOnAvoidableCost: "MAKE" | "BUY" | "NEITHER";

  /** Reported, never netted. See the header. */
  readonly overheadThatDoesNotGoAway: Decimal;
  /** What a naive absorbed-cost comparison would have concluded. */
  readonly absorbedComparisonWouldSay: "MAKE" | "BUY" | "NEITHER";
  /** True when absorbed cost and avoidable cost point at different answers. */
  readonly absorbedCostMisleads: boolean;

  /** Units needed before the switching cost is repaid. Null when it never is. */
  readonly breakEvenUnits: Decimal | null;
  readonly explanation: string;
  readonly warnings: readonly string[];
  readonly nonCostConsequences: readonly string[];
}

/**
 * Compares making with buying, on the cost that actually changes.
 *
 * Requires a quantity because almost nothing here is per-unit: the transition
 * cost is a lump, the avoidable fixed cost is a lump, and which side wins
 * depends on how many units they are spread across.
 */
export function compareMakeBuy(
  make: MakeOption,
  buy: BuyOption,
  quantity: Decimal,
  scale: number,
  mode: RoundingMode,
): MakeBuyResult {
  if (compare(quantity, ZERO) <= 0) {
    throw new RangeError(
      "A make-or-buy comparison needs a quantity. The transition cost and the avoidable fixed cost are lump sums, and which option wins depends entirely on how many units they are spread across.",
    );
  }
  for (const [name, value] of [
    ["avoidable variable cost", make.avoidableVariableCostPerUnit],
    ["avoidable fixed cost", make.avoidableFixedCost],
    ["unavoidable absorbed overhead", make.unavoidableAbsorbedOverhead],
    ["opportunity cost", make.opportunityCostPerUnit],
    ["supplier price", buy.supplierPricePerUnit],
    ["acquisition cost", buy.acquisitionCostPerUnit],
    ["transition cost", buy.transitionCost],
  ] as const) {
    if (compare(value, ZERO) < 0) {
      throw new RangeError(
        `A negative ${name} (${decToString(value)}) is not a cost. If something genuinely pays money back, model it as a separate credit so it is visible rather than hidden inside a cost line.`,
      );
    }
  }

  const warnings: string[] = [];

  // What making actually costs, counting only what would stop.
  const makeAvoidableTotal = add(
    add(
      multiply(make.avoidableVariableCostPerUnit, quantity),
      multiply(make.opportunityCostPerUnit, quantity),
    ),
    make.avoidableFixedCost,
  );

  const buyTotal = add(
    multiply(add(buy.supplierPricePerUnit, buy.acquisitionCostPerUnit), quantity),
    buy.transitionCost,
  );

  const difference = subtract(buyTotal, makeAvoidableTotal);
  const differencePerUnit = divide(difference, quantity, scale, mode);
  const cheaperOnAvoidableCost =
    compare(difference, ZERO) === 0 ? "NEITHER" : compare(difference, ZERO) > 0 ? "MAKE" : "BUY";

  // The comparison somebody would make from the accounting system's number.
  const absorbedMakeTotal = add(makeAvoidableTotal, make.unavoidableAbsorbedOverhead);
  const absorbedDifference = subtract(buyTotal, absorbedMakeTotal);
  const absorbedComparisonWouldSay =
    compare(absorbedDifference, ZERO) === 0
      ? "NEITHER"
      : compare(absorbedDifference, ZERO) > 0
        ? "MAKE"
        : "BUY";

  const absorbedCostMisleads = absorbedComparisonWouldSay !== cheaperOnAvoidableCost;
  if (absorbedCostMisleads) {
    warnings.push(
      `On absorbed cost this looks like ${absorbedComparisonWouldSay}; on avoidable cost it is ${cheaperOnAvoidableCost}. The ${decToString(make.unavoidableAbsorbedOverhead)} of overhead attributed to this part does not go away if it is bought — it moves onto everything else the shop makes. This is the single most expensive routine error in make-or-buy, and it is happening here.`,
    );
  }

  if (compare(make.unavoidableAbsorbedOverhead, ZERO) === 0) {
    warnings.push(
      "No unavoidable overhead was declared. That is unusual: rent, supervision and depreciation rarely fall when one part is outsourced. If it was simply not separated out, this comparison is flattering whichever option looks cheaper.",
    );
  }

  if (compare(make.opportunityCostPerUnit, ZERO) === 0) {
    warnings.push(
      "Opportunity cost is zero, which says the capacity used to make this would otherwise sit idle. That is a legitimate answer and a strong claim — if the shop is near capacity, making this displaces work that earns money.",
    );
  }

  // How long the one-off switching cost takes to repay, at the per-unit saving.
  const savingPerUnitFromBuying = subtract(
    add(
      add(make.avoidableVariableCostPerUnit, make.opportunityCostPerUnit),
      divide(make.avoidableFixedCost, quantity, scale, mode),
    ),
    add(buy.supplierPricePerUnit, buy.acquisitionCostPerUnit),
  );

  const breakEvenUnits =
    compare(savingPerUnitFromBuying, ZERO) > 0 && compare(buy.transitionCost, ZERO) > 0
      ? divide(buy.transitionCost, savingPerUnitFromBuying, scale, mode)
      : null;

  const explanation = buildExplanation({
    cheaperOnAvoidableCost,
    difference,
    differencePerUnit,
    quantity,
    breakEvenUnits,
    transitionCost: buy.transitionCost,
    unavoidable: make.unavoidableAbsorbedOverhead,
  });

  return {
    quantity,
    makeAvoidableTotal,
    buyTotal,
    difference,
    differencePerUnit,
    cheaperOnAvoidableCost,
    overheadThatDoesNotGoAway: make.unavoidableAbsorbedOverhead,
    absorbedComparisonWouldSay,
    absorbedCostMisleads,
    breakEvenUnits,
    explanation,
    warnings,
    nonCostConsequences: buy.nonCostConsequences,
  };
}

function buildExplanation(parts: {
  cheaperOnAvoidableCost: "MAKE" | "BUY" | "NEITHER";
  difference: Decimal;
  differencePerUnit: Decimal;
  quantity: Decimal;
  breakEvenUnits: Decimal | null;
  transitionCost: Decimal;
  unavoidable: Decimal;
}): string {
  const magnitude =
    compare(parts.difference, ZERO) < 0 ? subtract(ZERO, parts.difference) : parts.difference;

  const head =
    parts.cheaperOnAvoidableCost === "NEITHER"
      ? `On avoidable cost the two are identical across ${decToString(parts.quantity)} units.`
      : `On avoidable cost, ${parts.cheaperOnAvoidableCost === "MAKE" ? "making" : "buying"} is ${decToString(magnitude)} cheaper across ${decToString(parts.quantity)} units — ${decToString(
          compare(parts.differencePerUnit, ZERO) < 0
            ? subtract(ZERO, parts.differencePerUnit)
            : parts.differencePerUnit,
        )} per unit.`;

  const overhead =
    compare(parts.unavoidable, ZERO) > 0
      ? ` ${decToString(parts.unavoidable)} of absorbed overhead is excluded from both sides, because it does not go away either way.`
      : "";

  const payback =
    parts.breakEvenUnits !== null
      ? ` The ${decToString(parts.transitionCost)} switching cost is repaid after ${decToString(parts.breakEvenUnits)} units.`
      : compare(parts.transitionCost, ZERO) > 0
        ? ` The ${decToString(parts.transitionCost)} switching cost is never repaid at these figures, because buying does not save anything per unit.`
        : "";

  return `${head}${overhead}${payback} This is cost evidence. Whether to move the work is a sourcing decision CostIQ does not own.`;
}
