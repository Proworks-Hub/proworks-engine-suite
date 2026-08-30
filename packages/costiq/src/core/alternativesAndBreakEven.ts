/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/alternativesAndBreakEven.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Answering "why not the other one?" and "at what point does it flip?"
 */

import {
  type Decimal,
  ZERO,
  add,
  compare,
  divide,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";
import type { RoundingMode } from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// "WHY NOT THE OTHER ONE?" IS THE QUESTION PEOPLE ACTUALLY ASK
//
// A cost engine that reports "£412.80" answers a question nobody asked. The
// real questions are comparative and conditional:
//
//   - Why not the other machine?
//   - Why not the cheaper supplier?
//   - At what quantity does the expensive tooling pay for itself?
//   - How wrong would that rate have to be to change the answer?
//
// The last one matters most. A recommendation that flips when a rate moves 2%
// is not a recommendation, it is a coin toss with a decimal point. A person
// deciding needs to know WHICH of the two it is, and no summary number tells
// them.
//
// So this module reports the MARGIN OF THE DECISION, not just the decision.
//
// BREAK-EVEN IS WHERE FIXED COST STOPS DOMINATING
//
// Two options with different fixed and variable costs cross exactly once. Below
// the crossing the low-fixed option wins; above it the low-variable one does.
// Quoting one quantity's answer as though it held everywhere is how a shop
// buys tooling that never pays back, and how it declines tooling that would
// have.
//
// The crossing point is computed exactly, then reported ALONGSIDE whether the
// quantities anyone actually runs are near it.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostAlternative {
  readonly id: string;
  readonly label: string;
  /** Cost that does not vary with quantity — tooling, setup, changeover. */
  readonly fixedCost: Decimal;
  /** Cost per unit. */
  readonly variableCostPerUnit: Decimal;
  /**
   * Reasons this option might be rejected for something other than cost.
   *
   * Recorded because the cheapest option is frequently the wrong one, and an
   * engine that reported only money would make that invisible.
   */
  readonly nonCostConstraints: readonly string[];
}

export interface AlternativeAtQuantity {
  readonly id: string;
  readonly label: string;
  readonly quantity: Decimal;
  readonly totalCost: Decimal;
  readonly unitCost: Decimal;
  readonly fixedShare: Decimal;
  readonly nonCostConstraints: readonly string[];
}

export interface WhyNotAnswer {
  readonly rejectedId: string;
  readonly chosenId: string;
  /** How much more the rejected option costs at this quantity. Negative if it is cheaper. */
  readonly costDifference: Decimal;
  /** The difference as a fraction of the chosen option's cost. */
  readonly costDifferenceFraction: Decimal;
  /**
   * The quantity at which the two swap places, or null if they never do.
   *
   * Null when the lines are parallel (identical variable cost) — one is simply
   * always cheaper, and saying "break-even at infinity" would be worse than
   * saying there isn't one.
   */
  readonly breakEvenQuantity: Decimal | null;
  readonly breakEvenNote: string;
  readonly explanation: string;
  /** Set when the rejected option is cheaper and was rejected for another reason. */
  readonly cheaperButRejected: boolean;
}

/** Total and unit cost of one option at one quantity. */
export function evaluateAlternative(
  alternative: CostAlternative,
  quantity: Decimal,
  scale: number,
  mode: RoundingMode,
): AlternativeAtQuantity {
  if (compare(quantity, ZERO) <= 0) {
    throw new RangeError(
      `Alternative "${alternative.label}" cannot be evaluated at quantity ${decToString(quantity)}. Fixed cost spread over nothing is not a unit cost.`,
    );
  }
  const total = add(alternative.fixedCost, multiply(alternative.variableCostPerUnit, quantity));
  return {
    id: alternative.id,
    label: alternative.label,
    quantity,
    totalCost: total,
    unitCost: divide(total, quantity, scale, mode),
    fixedShare: divide(alternative.fixedCost, quantity, scale, mode),
    nonCostConstraints: alternative.nonCostConstraints,
  };
}

/**
 * The quantity at which two options cost the same.
 *
 *     fixedA + varA·q = fixedB + varB·q
 *     q = (fixedA − fixedB) / (varB − varA)
 *
 * Returns null when the variable costs are equal (parallel lines, no crossing)
 * or when the crossing is at a negative quantity — mathematically real, but
 * "these cross at −40 units" is not an answer anybody can use, and reporting
 * it as though it were a decision point would be misleading.
 */
export function breakEvenQuantity(
  a: CostAlternative,
  b: CostAlternative,
  scale: number,
  mode: RoundingMode,
): { readonly quantity: Decimal | null; readonly note: string } {
  const variableGap = subtract(b.variableCostPerUnit, a.variableCostPerUnit);

  if (compare(variableGap, ZERO) === 0) {
    const fixedGap = subtract(a.fixedCost, b.fixedCost);
    if (compare(fixedGap, ZERO) === 0) {
      return {
        quantity: null,
        note: `"${a.label}" and "${b.label}" cost the same at every quantity. The choice between them is not a cost decision.`,
      };
    }
    const cheaper = compare(fixedGap, ZERO) < 0 ? a.label : b.label;
    return {
      quantity: null,
      note: `These never cross — the per-unit costs are identical, so "${cheaper}" is cheaper at every quantity by a flat ${decToString(
        compare(fixedGap, ZERO) < 0 ? subtract(ZERO, fixedGap) : fixedGap,
      )}. There is no quantity that changes the answer.`,
    };
  }

  const crossing = divide(subtract(a.fixedCost, b.fixedCost), variableGap, scale, mode);

  if (compare(crossing, ZERO) < 0) {
    return {
      quantity: null,
      note: `These cross only at a negative quantity, which is not a real production run. Within any quantity you could actually make, one of them is always cheaper.`,
    };
  }

  return {
    quantity: crossing,
    note: `They cost the same at ${decToString(crossing)} units. Below that, the option with lower fixed cost wins; above it, the option with lower per-unit cost does. Rounding means the exact crossing may fall between two makeable quantities.`,
  };
}

/**
 * Why one option was not chosen.
 *
 * Deliberately phrased from the rejected option's point of view, because that
 * is how the question arrives: somebody asks why their preferred option lost.
 */
export function whyNot(
  rejected: CostAlternative,
  chosen: CostAlternative,
  quantity: Decimal,
  scale: number,
  mode: RoundingMode,
): WhyNotAnswer {
  const rejectedAt = evaluateAlternative(rejected, quantity, scale, mode);
  const chosenAt = evaluateAlternative(chosen, quantity, scale, mode);

  const difference = subtract(rejectedAt.totalCost, chosenAt.totalCost);
  const fraction =
    compare(chosenAt.totalCost, ZERO) === 0 ? ZERO : divide(difference, chosenAt.totalCost, scale, mode);

  const breakEven = breakEvenQuantity(rejected, chosen, scale, mode);
  const cheaperButRejected = compare(difference, ZERO) < 0;

  let explanation: string;
  if (cheaperButRejected) {
    // The honest case. A cheaper option that lost must have lost on something
    // other than money, and if nobody wrote down what, the decision is not
    // explainable and the engine should say so rather than invent a reason.
    const reasons = rejected.nonCostConstraints.length > 0
      ? rejected.nonCostConstraints.join("; ")
      : "no non-cost reason was recorded, so on cost alone this choice is not explained";
    explanation = `"${rejected.label}" is actually ${decToString(subtract(ZERO, difference))} CHEAPER than "${chosen.label}" at ${decToString(quantity)} units. It was not chosen on cost grounds: ${reasons}.`;
  } else if (compare(difference, ZERO) === 0) {
    explanation = `"${rejected.label}" and "${chosen.label}" cost exactly the same at ${decToString(quantity)} units. Cost does not decide this one.`;
  } else {
    explanation = `"${rejected.label}" costs ${decToString(difference)} more than "${chosen.label}" at ${decToString(quantity)} units (${decToString(rejectedAt.unitCost)} vs ${decToString(chosenAt.unitCost)} per unit).`;
  }

  return {
    rejectedId: rejected.id,
    chosenId: chosen.id,
    costDifference: difference,
    costDifferenceFraction: fraction,
    breakEvenQuantity: breakEven.quantity,
    breakEvenNote: breakEven.note,
    explanation: `${explanation} ${breakEven.note}`,
    cheaperButRejected,
  };
}

export interface RankedAlternatives {
  readonly quantity: Decimal;
  readonly ranked: readonly AlternativeAtQuantity[];
  readonly whyNotEach: readonly WhyNotAnswer[];
  /**
   * How much the winner's cost would have to move before it stopped winning,
   * as a fraction of its own cost. Null when there is nothing to compare to.
   */
  readonly decisionMarginFraction: Decimal | null;
  readonly robustnessNote: string;
}

/**
 * Ranks alternatives at a quantity and explains every rejection.
 *
 * Also reports HOW CLOSE the decision was. A 0.4% gap between first and second
 * is inside the error bar of most cost models, and presenting it as a ranking
 * gives a false impression of certainty — so the margin is reported and, when
 * it is small, the note says plainly that the ranking should not be relied on.
 */
export function rankAlternatives(
  alternatives: readonly CostAlternative[],
  quantity: Decimal,
  scale: number,
  mode: RoundingMode,
  /** Below this fraction, the ranking is called too close to rely on. */
  materialityFraction: Decimal,
): RankedAlternatives {
  if (alternatives.length === 0) {
    throw new RangeError("There are no alternatives to rank. An empty comparison has no winner, and returning one would be an invention.");
  }

  const evaluated = alternatives.map((a) => evaluateAlternative(a, quantity, scale, mode));
  const ranked = [...evaluated].sort((x, y) => {
    const byCost = compare(x.totalCost, y.totalCost);
    // Ties broken by id so the ranking is deterministic. Two options at the
    // same cost must not swap places between runs, or a replay comparison
    // reports a difference that is really just Array.sort's instability.
    return byCost !== 0 ? byCost : x.id.localeCompare(y.id);
  });

  const winner = ranked[0]!;
  const winnerAlternative = alternatives.find((a) => a.id === winner.id)!;

  const whyNotEach = ranked
    .slice(1)
    .map((r) => whyNot(alternatives.find((a) => a.id === r.id)!, winnerAlternative, quantity, scale, mode));

  if (ranked.length === 1) {
    return {
      quantity,
      ranked,
      whyNotEach,
      decisionMarginFraction: null,
      robustnessNote: "There is only one alternative. It wins by default, which is not the same as being a good option.",
    };
  }

  const runnerUp = ranked[1]!;
  const gap = subtract(runnerUp.totalCost, winner.totalCost);
  const margin =
    compare(winner.totalCost, ZERO) === 0 ? ZERO : divide(gap, winner.totalCost, scale, mode);

  const robustnessNote =
    compare(margin, materialityFraction) < 0
      ? `TOO CLOSE TO CALL. "${winner.label}" leads "${runnerUp.label}" by ${decToString(margin)} — inside the ${decToString(materialityFraction)} materiality threshold. A rate that is slightly wrong would reverse this ranking, so it should not be presented as a clear answer.`
      : `"${winner.label}" leads "${runnerUp.label}" by ${decToString(margin)} of its own cost. The ranking holds unless a cost input is wrong by more than that.`;

  return { quantity, ranked, whyNotEach, decisionMarginFraction: margin, robustnessNote };
}

/**
 * How wrong one input would have to be to change the answer.
 *
 * The sensitivity question, asked backwards. Instead of "what if this rate were
 * 10% higher", it answers "how much would it take", which is the form a person
 * can check against their own judgement of how reliable the number is.
 */
export function decisionFlipThreshold(
  winner: CostAlternative,
  runnerUp: CostAlternative,
  quantity: Decimal,
  scale: number,
  mode: RoundingMode,
): { readonly variableCostIncrease: Decimal | null; readonly fixedCostIncrease: Decimal; readonly note: string } {
  const winnerTotal = add(winner.fixedCost, multiply(winner.variableCostPerUnit, quantity));
  const runnerTotal = add(runnerUp.fixedCost, multiply(runnerUp.variableCostPerUnit, quantity));
  const gap = subtract(runnerTotal, winnerTotal);

  if (compare(gap, ZERO) <= 0) {
    return {
      variableCostIncrease: null,
      fixedCostIncrease: ZERO,
      note: `"${winner.label}" does not currently win at ${decToString(quantity)} units, so there is no threshold to cross.`,
    };
  }

  // The whole gap sits on fixed cost, or is spread across the units.
  const variableIncrease =
    compare(quantity, ZERO) === 0 ? null : divide(gap, quantity, scale, mode);

  return {
    variableCostIncrease: variableIncrease,
    fixedCostIncrease: gap,
    note: `"${winner.label}" stops winning if its fixed cost rises by ${decToString(gap)}, or its per-unit cost by ${
      variableIncrease === null ? "n/a" : decToString(variableIncrease)
    }. Judge whether the inputs are that uncertain — the engine cannot judge that for you.`,
  };
}
