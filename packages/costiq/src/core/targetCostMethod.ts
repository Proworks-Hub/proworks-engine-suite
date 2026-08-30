/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/targetCostMethod.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Working backwards from a price the market sets.
 */

import {
  type Decimal,
  type RoundingMode,
  ONE,
  ZERO,
  add,
  allocate,
  compare,
  divide,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// TARGET COSTING RUNS THE OTHER WAY
//
// Cost-plus asks "what does it cost, and what shall we add?". Target costing
// asks the question a competitive market actually poses:
//
//     allowable cost = market price − required margin
//
// The price is not an output here. It is an input, set by what customers will
// pay, and the engine's job is to say what the thing must cost for the
// business to survive selling it at that price — and how far away that is.
//
// This is the same arithmetic as `marginPricing` rearranged, and it is a
// SEPARATE module because it is a different decision. Nobody rearranges a
// pricing formula under pressure and gets it right; they reach for the
// function whose name matches the question.
//
// THE GAP IS THE DELIVERABLE
//
// A target cost on its own is a number on a slide. What a shop can act on is
// the gap between the target and what the thing costs today, split across the
// components that make it up — because "reduce cost by £14.20" is not a task
// and "take £9.40 out of the fabrication step" is.
//
// AND THE ENGINE DOES NOT DECIDE WHERE TO CUT
//
// It allocates the required reduction on a stated basis and says which basis
// it used. Proportional allocation is the default because it is neutral, not
// because it is right: in practice some components are fixed by regulation and
// some have years of slack. The engine cannot know which, so it exposes the
// basis and refuses to pretend the split is a recommendation.
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetCostInput {
  /** What the market will pay. An input, not a result. */
  readonly marketPrice: Decimal;
  /**
   * The margin the business requires, as a fraction OF PRICE.
   *
   * Margin, not markup — the same distinction `marginPricing` exists to keep,
   * and getting it backwards here understates the allowable cost, which is the
   * error that lets a doomed product look viable.
   */
  readonly requiredMarginFraction: Decimal;
  /** What it costs today, if it is already being made. */
  readonly currentCost: Decimal | null;
  readonly currency: string;
  readonly scale: number;
  readonly mode: RoundingMode;
}

export interface TargetCostResult {
  readonly marketPrice: Decimal;
  readonly requiredMargin: Decimal;
  /** What the thing must cost. `price × (1 − margin)`. */
  readonly allowableCost: Decimal;
  readonly currency: string;
  /** Positive when today's cost exceeds what is allowable. Null when unknown. */
  readonly gap: Decimal | null;
  /** The gap as a fraction of the current cost — the size of the ask. */
  readonly gapFraction: Decimal | null;
  readonly feasibility: "WITHIN_TARGET" | "GAP_TO_CLOSE" | "NOT_YET_COSTED";
  readonly note: string;
}

/**
 * The cost a product must reach to be worth selling at a given price.
 *
 * Refuses a margin at or above 100%: `price × (1 − 1)` is zero and anything
 * beyond is negative, and a business asking for it has made an arithmetic
 * mistake rather than an ambitious request.
 */
export function computeTargetCost(input: TargetCostInput): TargetCostResult {
  if (compare(input.requiredMarginFraction, ZERO) < 0) {
    throw new RangeError(
      "A negative required margin means selling below cost by design. State that as a deliberate price floor instead, so it is visible as a decision rather than buried in a target.",
    );
  }
  if (compare(input.requiredMarginFraction, ONE) >= 0) {
    throw new RangeError(
      `A required margin of ${decToString(input.requiredMarginFraction)} leaves an allowable cost of zero or less. Margin is a fraction OF THE PRICE, so it must be below 1.`,
    );
  }
  if (compare(input.marketPrice, ZERO) <= 0) {
    throw new RangeError(
      "A market price of zero or less has no allowable cost to derive. Target costing starts from what customers will pay.",
    );
  }

  const allowableCost = divide(
    multiply(input.marketPrice, subtract(ONE, input.requiredMarginFraction)),
    ONE,
    input.scale,
    input.mode,
  );
  const requiredMargin = subtract(input.marketPrice, allowableCost);

  if (input.currentCost === null) {
    return {
      marketPrice: input.marketPrice,
      requiredMargin,
      allowableCost,
      currency: input.currency,
      gap: null,
      gapFraction: null,
      feasibility: "NOT_YET_COSTED",
      note: `To hold a ${decToString(input.requiredMarginFraction)} margin at ${decToString(input.marketPrice)} ${input.currency}, this must cost no more than ${decToString(allowableCost)}. Nothing is costed yet, so whether that is reachable is still an open question.`,
    };
  }

  const gap = subtract(input.currentCost, allowableCost);
  const gapFraction =
    compare(input.currentCost, ZERO) === 0
      ? ZERO
      : divide(gap, input.currentCost, input.scale, input.mode);

  if (compare(gap, ZERO) <= 0) {
    return {
      marketPrice: input.marketPrice,
      requiredMargin,
      allowableCost,
      currency: input.currency,
      gap,
      gapFraction,
      feasibility: "WITHIN_TARGET",
      note: `Current cost ${decToString(input.currentCost)} is within the allowable ${decToString(allowableCost)}, with ${decToString(subtract(ZERO, gap))} to spare. That headroom is a fact about today's cost, not a licence to spend it.`,
    };
  }

  return {
    marketPrice: input.marketPrice,
    requiredMargin,
    allowableCost,
    currency: input.currency,
    gap,
    gapFraction,
    feasibility: "GAP_TO_CLOSE",
    note: `Current cost ${decToString(input.currentCost)} exceeds the allowable ${decToString(allowableCost)} by ${decToString(gap)} — ${decToString(gapFraction)} of what it costs today. At this price and margin the product does not work until that closes.`,
  };
}

/** How the required reduction is spread across components. */
export type ReductionBasis =
  /** In proportion to what each component costs. Neutral, not correct. */
  | "PROPORTIONAL"
  /** Equally across every component, whatever its size. */
  | "EQUAL"
  /** Only across the components the caller marked as addressable. */
  | "ADDRESSABLE_ONLY";

export interface ComponentCost {
  readonly componentId: string;
  readonly label: string;
  readonly cost: Decimal;
  /**
   * Whether this component can realistically be reduced.
   *
   * The caller's judgement, not the engine's. A regulated coating and a
   * hand-finishing step both cost money; only one of them is negotiable, and
   * nothing in a cost model says which.
   */
  readonly addressable: boolean;
}

export interface ReductionTarget {
  readonly componentId: string;
  readonly label: string;
  readonly currentCost: Decimal;
  readonly reduction: Decimal;
  readonly targetCost: Decimal;
  /** The reduction as a fraction of this component — how hard the ask is here. */
  readonly reductionFraction: Decimal;
}

export interface ReductionPlan {
  readonly basis: ReductionBasis;
  readonly basisNote: string;
  readonly totalReduction: Decimal;
  readonly targets: readonly ReductionTarget[];
  /** Warnings a person should read before acting. Empty is a real answer. */
  readonly warnings: readonly string[];
}

const BASIS_NOTES: Readonly<Record<ReductionBasis, string>> = Object.freeze({
  PROPORTIONAL:
    "Spread in proportion to what each component costs. Neutral rather than correct — it assumes every part of the product has the same slack, which is almost never true.",
  EQUAL:
    "Spread equally across components regardless of size. Asks the same absolute saving from a £2 fastener and a £200 casting, which is usually impossible on the small one.",
  ADDRESSABLE_ONLY:
    "Spread only across the components the caller marked addressable, in proportion to their cost. The most honest of the three, and only as good as that marking.",
});

/**
 * Splits a required cost reduction across the components that make it up.
 *
 * Uses largest-remainder allocation, so the parts re-sum EXACTLY to the total
 * reduction. A plan whose lines add up to £14.19 against a £14.20 target
 * invites somebody to spend an afternoon finding the penny.
 */
export function planReduction(
  components: readonly ComponentCost[],
  totalReduction: Decimal,
  basis: ReductionBasis,
  scale: number,
  mode: RoundingMode,
): ReductionPlan {
  const warnings: string[] = [];

  if (compare(totalReduction, ZERO) <= 0) {
    return {
      basis,
      basisNote: BASIS_NOTES[basis],
      totalReduction: ZERO,
      targets: [],
      warnings: ["There is no reduction to plan — the cost is already within target."],
    };
  }

  const eligible =
    basis === "ADDRESSABLE_ONLY" ? components.filter((c) => c.addressable) : [...components];

  if (eligible.length === 0) {
    return {
      basis,
      basisNote: BASIS_NOTES[basis],
      totalReduction,
      targets: [],
      warnings: [
        `A reduction of ${decToString(totalReduction)} is needed and no component is available to take it. On this basis there is nothing to plan, which is itself the finding: the target is not reachable by trimming.`,
      ],
    };
  }

  const eligibleTotal = eligible.reduce<Decimal>((acc, c) => add(acc, c.cost), ZERO);
  if (compare(totalReduction, eligibleTotal) > 0) {
    // Said out loud rather than scaled away. A reduction larger than the cost
    // it is taken from cannot be achieved by reducing anything.
    warnings.push(
      `The required reduction of ${decToString(totalReduction)} is larger than the ${decToString(eligibleTotal)} those components cost in total. No allocation makes this reachable — the product needs a different design, a different process, or a different price.`,
    );
  }

  const weights =
    basis === "EQUAL" ? eligible.map(() => ONE) : eligible.map((c) => c.cost);

  // Every weight zero means nothing to divide by. Falls back to equal shares
  // rather than throwing, because "these components are all free" is a strange
  // model but not an unanswerable question.
  const allZero = weights.every((w) => compare(w, ZERO) === 0);
  if (allZero && basis !== "EQUAL") {
    warnings.push(
      "Every eligible component costs zero, so a proportional split has nothing to be proportional to. Shares were spread equally instead.",
    );
  }

  const shares = allocate(
    totalReduction,
    allZero ? eligible.map(() => ONE) : weights,
    scale,
    mode,
  );

  const targets = eligible.map((component, index) => {
    const reduction = shares[index] ?? ZERO;
    const targetCost = subtract(component.cost, reduction);
    if (compare(targetCost, ZERO) < 0) {
      warnings.push(
        `"${component.label}" would have to fall below zero to meet its share of ${decToString(reduction)}. Its share is shown as calculated rather than clipped, because a clipped number hides that the plan does not add up.`,
      );
    }
    return {
      componentId: component.componentId,
      label: component.label,
      currentCost: component.cost,
      reduction,
      targetCost,
      reductionFraction:
        compare(component.cost, ZERO) === 0
          ? ZERO
          : divide(reduction, component.cost, scale, mode),
    };
  });

  if (basis === "ADDRESSABLE_ONLY" && eligible.length < components.length) {
    warnings.push(
      `${components.length - eligible.length} component${components.length - eligible.length === 1 ? " was" : "s were"} excluded as not addressable, so the whole reduction falls on the rest. That concentration is the consequence of the marking, not a judgement by the engine.`,
    );
  }

  return { basis, basisNote: BASIS_NOTES[basis], totalReduction, targets, warnings };
}
