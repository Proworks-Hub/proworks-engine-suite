/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/marginPricing.ts
 * Module:   cost-iq-engine / core
 * Purpose:  A price derived from a cost — and nothing beyond that line.
 */

import {
  type Decimal,
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// MARGIN AND MARKUP ARE NOT THE SAME AND THE DIFFERENCE COSTS MONEY
//
// This is the most common arithmetic error in pricing, and it is always in the
// same direction — the seller earns less than they meant to.
//
//   MARKUP  is on COST:   price = cost x (1 + markup)
//   MARGIN  is on PRICE:  price = cost / (1 - margin)
//
// At 50% they differ enormously. £100 marked up 50% is £150, on which the
// margin is 33%. £100 at a 50% MARGIN is £200. Somebody who says "we work on
// 50%" and applies a markup has given away a quarter of the price.
//
// So both are implemented, named unambiguously, and neither is the default.
//
// WHAT THIS DOES NOT DO
//
// CostIQ derives a price FROM A COST. It does not decide what to charge.
// Willingness to pay, elasticity, discount strategy, competitive positioning
// and "what did we get away with last time" are commercial pricing, owned
// elsewhere, and explicitly excluded by the charter.
//
// The distinction is not pedantic: a cost-derived price is a FLOOR and a
// reference. Treating it as the answer is how a business prices itself out of
// work it wanted, or leaves money on the table for work it would have won
// anyway.
//
// PRICING NEVER CHANGES THE COST
//
// The functions here take a cost and return a price. None of them writes to a
// cost, and the tests assert it — because an engine where pricing could adjust
// the underlying cost would let a margin target quietly rewrite what something
// costs to make.
// ─────────────────────────────────────────────────────────────────────────────

export interface PricingPolicy {
  /** Digits for the resulting price. */
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];
  /** A price may never fall below cost by this much, as a fraction. */
  readonly minimumMarginFraction: Decimal | null;
  /** An absolute floor, whatever the margin says. */
  readonly priceFloor: Decimal | null;
}

export interface PriceResult {
  readonly cost: Decimal;
  readonly price: Decimal;
  readonly currency: string;
  /** Realised margin as a fraction of price. */
  readonly marginFraction: Decimal;
  /** Realised markup as a fraction of cost. */
  readonly markupFraction: Decimal;
  readonly marginAmount: Decimal;
  /** Set when a floor moved the price above what the rule alone produced. */
  readonly floorApplied: string | null;
  readonly warnings: readonly string[];
}

/** `price = cost × (1 + markup)`. Markup is on COST. */
export function priceFromMarkup(
  cost: Decimal,
  markupFraction: Decimal,
  currency: string,
  policy: PricingPolicy,
): PriceResult {
  if (compare(markupFraction, ZERO) < 0) {
    throw new RangeError("A negative markup is a discount below cost. State it as a price floor instead, so it is visible as a decision.");
  }
  const raw = multiply(cost, add(ONE, markupFraction));
  return finish(cost, raw, currency, policy);
}

/**
 * `price = cost / (1 - margin)`. Margin is on PRICE.
 *
 * Refuses a margin of 100% or more: dividing by zero or a negative produces
 * an infinite or negative price, and a business asking for a 100% margin has
 * made an arithmetic mistake rather than an ambitious request.
 */
export function priceFromMargin(
  cost: Decimal,
  marginFraction: Decimal,
  currency: string,
  policy: PricingPolicy,
): PriceResult {
  if (compare(marginFraction, ZERO) < 0) {
    throw new RangeError("A negative margin is a price below cost. State it as a price floor instead, so it is visible as a decision.");
  }
  if (compare(marginFraction, ONE) >= 0) {
    throw new RangeError(
      `A margin of ${decToString(marginFraction)} means price = cost / ${decToString(subtract(ONE, marginFraction))}, which is not a price. Margin is a fraction OF THE PRICE, so it must be below 1 — a 100% margin would mean the cost is zero.`,
    );
  }
  const raw = divide(cost, subtract(ONE, marginFraction), policy.scale + 4, policy.mode);
  return finish(cost, raw, currency, policy);
}

/** A price stated directly, still checked against the floors. */
export function priceFromTarget(
  cost: Decimal,
  target: Decimal,
  currency: string,
  policy: PricingPolicy,
): PriceResult {
  return finish(cost, target, currency, policy);
}

function finish(cost: Decimal, raw: Decimal, currency: string, policy: PricingPolicy): PriceResult {
  const warnings: string[] = [];
  let price = raw;
  let floorApplied: string | null = null;

  if (policy.minimumMarginFraction !== null) {
    const minimum = divide(cost, subtract(ONE, policy.minimumMarginFraction), policy.scale + 4, policy.mode);
    if (compare(price, minimum) < 0) {
      floorApplied = `Raised to ${decToString(minimum)} by the minimum margin of ${decToString(policy.minimumMarginFraction)}.`;
      price = minimum;
    }
  }

  if (policy.priceFloor !== null && compare(price, policy.priceFloor) < 0) {
    floorApplied = `Raised to the absolute price floor of ${decToString(policy.priceFloor)}.`;
    price = policy.priceFloor;
  }

  price = divide(price, ONE, policy.scale, policy.mode);

  const marginAmount = subtract(price, cost);
  if (compare(marginAmount, ZERO) < 0) {
    // Said out loud rather than corrected. Selling below cost is sometimes a
    // deliberate decision, and an engine that silently prevented it would be
    // making a commercial choice it does not own.
    warnings.push(
      `This price is ${decToString(subtract(ZERO, marginAmount))} BELOW cost. That is sometimes deliberate; it is never accidental-looking, so it is reported rather than corrected.`,
    );
  }

  return {
    cost,
    price,
    currency,
    marginFraction:
      compare(price, ZERO) === 0 ? ZERO : divide(marginAmount, price, policy.scale + 4, policy.mode),
    markupFraction:
      compare(cost, ZERO) === 0 ? ZERO : divide(marginAmount, cost, policy.scale + 4, policy.mode),
    marginAmount,
    floorApplied,
    warnings,
  };
}

/**
 * A price table across quantities.
 *
 * Takes the per-quantity COSTS as input rather than computing them, so pricing
 * stays a pure function of cost and cannot reach back into the cost model.
 */
export function priceTable(
  costs: ReadonlyArray<{ quantity: Decimal; unitCost: Decimal }>,
  rule: { readonly kind: "MARKUP" | "MARGIN"; readonly fraction: Decimal },
  currency: string,
  policy: PricingPolicy,
): ReadonlyArray<{ readonly quantity: Decimal; readonly unitCost: Decimal; readonly unitPrice: Decimal; readonly marginFraction: Decimal }> {
  return [...costs]
    .sort((a, b) => compare(a.quantity, b.quantity))
    .map((row) => {
      const result =
        rule.kind === "MARKUP"
          ? priceFromMarkup(row.unitCost, rule.fraction, currency, policy)
          : priceFromMargin(row.unitCost, rule.fraction, currency, policy);
      return {
        quantity: row.quantity,
        unitCost: row.unitCost,
        unitPrice: result.price,
        marginFraction: result.marginFraction,
      };
    });
}

/**
 * Whether a previously quoted price still clears the current cost.
 *
 * The question that matters when a quote is a month old and steel has moved.
 * Reports; does not re-quote — re-quoting is a commercial act.
 */
export function priceStillViable(
  quotedPrice: Decimal,
  currentCost: Decimal,
  policy: PricingPolicy,
): { readonly viable: boolean; readonly currentMargin: Decimal; readonly reason: string } {
  const margin = subtract(quotedPrice, currentCost);
  const fraction =
    compare(quotedPrice, ZERO) === 0 ? ZERO : divide(margin, quotedPrice, policy.scale + 4, policy.mode);

  if (compare(margin, ZERO) < 0) {
    return {
      viable: false,
      currentMargin: fraction,
      reason: `The quoted price is now BELOW cost by ${decToString(subtract(ZERO, margin))}. Honouring it is a commercial decision, not a costing one.`,
    };
  }
  if (policy.minimumMarginFraction !== null && compare(fraction, policy.minimumMarginFraction) < 0) {
    return {
      viable: false,
      currentMargin: fraction,
      reason: `The quoted price now yields ${decToString(fraction)} margin, below the minimum of ${decToString(policy.minimumMarginFraction)}.`,
    };
  }
  return {
    viable: true,
    currentMargin: fraction,
    reason: `The quoted price still yields ${decToString(fraction)} margin against current cost.`,
  };
}
