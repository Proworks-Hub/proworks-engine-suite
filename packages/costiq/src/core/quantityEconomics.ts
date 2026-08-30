/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/quantityEconomics.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Why ten costs less each than one, and exactly where the price
 *           per unit stops falling.
 */

import {
  type Decimal,
  type RoundingMode,
  ONE,
  ZERO,
  add,
  compare,
  divide,
  fromInteger,
  fromString,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// PER-UNIT COST IS NOT TOTAL DIVIDED BY QUANTITY
//
// It nearly is, and the difference is the entire subject. Setup happens once
// however many you make. Tooling is bought once. Material comes in sheets, so
// wanting 3 means buying 4. Suppliers price in tiers, and a machine has a
// minimum charge whether you use a minute or an hour.
//
// The result is a curve with STEPS in it, and the steps are where money is
// made and lost. A customer asking "what about 50?" is asking where the next
// step is, and a cost engine that answers with a smooth division is guessing.
//
// EVERY DISCONTINUITY MUST BE EXPLAINABLE
//
// The directive requires it and it is the useful part: "unit cost drops from
// £14.20 to £11.80 at 25 because that is where the second sheet stops being
// wasted" is a sentence somebody can sell with. A quantity table that shows
// the drop and cannot explain it is a table people stop trusting.
// ─────────────────────────────────────────────────────────────────────────────

/** A cost that happens once regardless of how many are made. */
export interface NonRecurringCost {
  readonly id: string;
  readonly label: string;
  readonly amount: Decimal;
  /**
   * Units to spread it across, or null to charge it wholly to this order.
   *
   * Null is not "spread over one" — it is a different decision. Charging a
   * £900 die entirely to a batch of 3 is sometimes right, and it should be
   * visible as a choice rather than emerge from a default.
   */
  readonly amortizeOverUnits: Decimal | null;
}

/** A price that changes at a quantity threshold. */
export interface RateTier {
  /** Applies from this quantity upward. */
  readonly fromQuantity: Decimal;
  readonly unitRate: Decimal;
  readonly label: string;
}

/** Material bought in fixed sizes, so wanting 3 can mean buying 4. */
export interface PackSizing {
  readonly id: string;
  readonly label: string;
  /** How many units one pack yields. */
  readonly unitsPerPack: Decimal;
  readonly packCost: Decimal;
}

export interface QuantityEconomicsInput {
  readonly quantity: Decimal;
  /** Cost that scales linearly with quantity — material, labour per piece. */
  readonly variableUnitCost: Decimal;
  readonly nonRecurring: readonly NonRecurringCost[];
  /** Tiers for the variable cost, best match wins. Order does not matter. */
  readonly tiers: readonly RateTier[];
  readonly packs: readonly PackSizing[];
  /** A floor on the whole order, if the shop or supplier charges one. */
  readonly minimumOrderCharge: Decimal | null;
  readonly scale: number;
  readonly mode: RoundingMode;
}

export interface QuantityEconomicsResult {
  readonly quantity: Decimal;
  readonly totalCost: Decimal;
  readonly unitCost: Decimal;
  /** Every reason this quantity costs what it does. */
  readonly effects: readonly string[];
  /** True when a floor, not the work, set the price. */
  readonly minimumApplied: boolean;
}

/**
 * The applicable tier for a quantity.
 *
 * The HIGHEST threshold at or below the quantity. Sorting by threshold rather
 * than trusting input order means two callers who list tiers differently get
 * the same answer, which matters because tier tables are usually pasted in.
 */
export function tierFor(tiers: readonly RateTier[], quantity: Decimal): RateTier | null {
  const applicable = tiers
    .filter((t) => compare(quantity, t.fromQuantity) >= 0)
    .sort((a, b) => compare(b.fromQuantity, a.fromQuantity));
  return applicable[0] ?? null;
}

/** Packs needed to yield `quantity`, always rounding up. */
export function packsRequired(pack: PackSizing, quantity: Decimal, scale: number): Decimal {
  if (compare(pack.unitsPerPack, ZERO) <= 0) {
    throw new RangeError(
      `Pack ${pack.id} yields ${decToString(pack.unitsPerPack)} units. A pack that yields nothing cannot satisfy any quantity.`,
    );
  }
  // CEILING, always. Wanting 3 of something sold in fours means buying 4, and
  // the fourth is paid for whether or not it is used. Rounding to nearest
  // would produce a cost that cannot be purchased.
  const exact = divide(quantity, pack.unitsPerPack, scale, "CEILING");
  return divide(exact, ONE, 0, "CEILING");
}

/**
 * What one order of `quantity` costs, and why.
 *
 * Pure. The explanation is built alongside the arithmetic rather than
 * reconstructed afterwards, because a reconstruction can disagree with the
 * number it claims to explain.
 */
export function computeQuantityEconomics(input: QuantityEconomicsInput): QuantityEconomicsResult {
  const { quantity, scale, mode } = input;
  const effects: string[] = [];

  if (compare(quantity, ZERO) <= 0) {
    throw new RangeError("Quantity must be greater than zero; there is no per-unit cost for an order of nothing.");
  }

  // ── Variable cost, possibly tiered ────────────────────────────────────
  const tier = tierFor(input.tiers, quantity);
  const unitRate = tier ? tier.unitRate : input.variableUnitCost;
  if (tier) {
    effects.push(
      `Unit rate ${decToString(tier.unitRate)} applies from ${decToString(tier.fromQuantity)} up (${tier.label}).`,
    );
  }
  let total = multiply(unitRate, quantity);

  // ── Pack sizing ───────────────────────────────────────────────────────
  for (const pack of input.packs) {
    const packs = packsRequired(pack, quantity, scale);
    const cost = multiply(packs, pack.packCost);
    total = add(total, cost);

    const yielded = multiply(packs, pack.unitsPerPack);
    const spare = subtract(yielded, quantity);
    if (compare(spare, ZERO) > 0) {
      // The wasted remainder is where the steps in the curve come from, so it
      // is named rather than absorbed into a total.
      effects.push(
        `${pack.label}: ${decToString(packs)} pack(s) yield ${decToString(yielded)}, leaving ${decToString(spare)} spare that this order still pays for.`,
      );
    } else {
      effects.push(`${pack.label}: ${decToString(packs)} pack(s) used exactly.`);
    }
  }

  // ── Non-recurring cost ────────────────────────────────────────────────
  for (const nr of input.nonRecurring) {
    if (nr.amortizeOverUnits === null) {
      total = add(total, nr.amount);
      effects.push(`${nr.label}: ${decToString(nr.amount)} charged wholly to this order.`);
      continue;
    }
    if (compare(nr.amortizeOverUnits, ZERO) <= 0) {
      throw new RangeError(
        `${nr.label} amortises over ${decToString(nr.amortizeOverUnits)} units, which has no answer. Use null to charge it wholly to this order.`,
      );
    }
    const perUnit = divide(nr.amount, nr.amortizeOverUnits, scale, mode);
    const share = multiply(perUnit, quantity);
    total = add(total, share);
    effects.push(
      `${nr.label}: ${decToString(nr.amount)} spread over ${decToString(nr.amortizeOverUnits)} units, so this order carries ${decToString(share)}.`,
    );
  }

  // ── Order minimum ─────────────────────────────────────────────────────
  let minimumApplied = false;
  if (input.minimumOrderCharge !== null && compare(total, input.minimumOrderCharge) < 0) {
    effects.push(
      `Raised to the minimum order charge of ${decToString(input.minimumOrderCharge)} (the work came to ${decToString(total)}).`,
    );
    total = input.minimumOrderCharge;
    minimumApplied = true;
  }

  return {
    quantity,
    totalCost: total,
    unitCost: divide(total, quantity, scale, mode),
    effects,
    minimumApplied,
  };
}

/** One row of a quantity table. */
export interface QuantityBreak {
  readonly quantity: Decimal;
  readonly totalCost: Decimal;
  readonly unitCost: Decimal;
  /** Change in unit cost from the previous row. Negative means cheaper. */
  readonly unitCostDelta: Decimal | null;
  /** Set when the unit cost moved for a structural reason, naming it. */
  readonly discontinuity: string | null;
  readonly effects: readonly string[];
}

/**
 * A price table across quantities, with every step explained.
 *
 * DOES NOT MUTATE THE BASELINE. Each row is an independent calculation from
 * the same inputs, so generating a table can never disturb the estimate a
 * customer was quoted.
 *
 * A discontinuity is recorded when a row's unit cost changes for a reason
 * other than smooth amortisation — a tier boundary, a pack boundary, a
 * minimum falling away. Those are the rows a salesperson needs to see.
 */
export function quantityTable(
  quantities: readonly Decimal[],
  base: Omit<QuantityEconomicsInput, "quantity">,
): readonly QuantityBreak[] {
  // Sorted ascending, so "the previous row" means a smaller order and the
  // deltas read the way a table is read.
  const ordered = [...quantities].sort((a, b) => compare(a, b));
  const rows: QuantityBreak[] = [];

  let previous: QuantityEconomicsResult | null = null;
  for (const quantity of ordered) {
    const result = computeQuantityEconomics({ ...base, quantity });

    let discontinuity: string | null = null;
    if (previous !== null) {
      const tierBefore = tierFor(base.tiers, previous.quantity);
      const tierNow = tierFor(base.tiers, quantity);
      if (tierBefore?.label !== tierNow?.label) {
        discontinuity = tierNow
          ? `Entered rate tier "${tierNow.label}" at ${decToString(tierNow.fromQuantity)}.`
          : "Left the tiered rates.";
      } else if (previous.minimumApplied && !result.minimumApplied) {
        discontinuity = "The order minimum stopped applying — the work now costs more than the floor.";
      } else {
        for (const pack of base.packs) {
          const before = packsRequired(pack, previous.quantity, base.scale);
          const now = packsRequired(pack, quantity, base.scale);
          if (compare(before, now) !== 0) {
            discontinuity = `${pack.label}: pack count moved from ${decToString(before)} to ${decToString(now)}.`;
            break;
          }
        }
      }
    }

    rows.push({
      quantity,
      totalCost: result.totalCost,
      unitCost: result.unitCost,
      unitCostDelta: previous === null ? null : subtract(result.unitCost, previous.unitCost),
      discontinuity,
      effects: result.effects,
    });
    previous = result;
  }

  return rows;
}

/**
 * A learning curve, applied only when a policy explicitly asks for one.
 *
 * OFF BY DEFAULT AND SEPARATE. A learning curve is a claim that people get
 * faster with repetition — often true, and a quiet 15% reduction applied to
 * every estimate is a quiet 15% reduction in every quote. The directive
 * requires it be explicitly configured, and requires the formula and rate to
 * be recorded with the result.
 *
 * Wright's model: the cumulative average time for `n` units is
 * `first × n^(log2(rate))`. Computed at the caller's precision.
 */
export function learningCurveFactor(
  units: Decimal,
  learningRate: Decimal,
  scale: number,
  mode: RoundingMode,
): { readonly factor: Decimal; readonly formula: string } {
  if (compare(learningRate, ZERO) <= 0 || compare(learningRate, ONE) > 0) {
    throw new RangeError(
      `A learning rate must be between 0 and 1 (0.85 meaning "each doubling costs 85% as much"). Received ${decToString(learningRate)}.`,
    );
  }
  // A FAST PATH, not a correctness guard.
  //
  // A mutation removing this survives the suite, and that is correct rather
  // than a gap: below one unit the doubling loop never runs and the remainder
  // comes out negative, which the `remainder > 0` check below already skips.
  // The general path produces exactly 1 on its own.
  //
  // It stays because it states the intent — "no learning below the first
  // doubling" — where a reader looks for it, rather than leaving that
  // behaviour to be inferred from the sign of an intermediate value.
  if (compare(units, ONE) <= 0) {
    return { factor: ONE, formula: "Wright cumulative average; no reduction below two units." };
  }

  // Repeated halving rather than logarithms, so the whole computation stays in
  // exact decimal. Each doubling multiplies by the learning rate; the
  // remainder is interpolated linearly, which is stated because it is an
  // approximation and approximations must be visible.
  let doublings = 0;
  let n = ONE;
  while (compare(multiply(n, fromInteger(2)), units) <= 0) {
    n = multiply(n, fromInteger(2));
    doublings += 1;
  }

  let factor = ONE;
  for (let i = 0; i < doublings; i += 1) factor = multiply(factor, learningRate);

  const remainder = divide(subtract(units, n), n, scale, mode);
  if (compare(remainder, ZERO) > 0) {
    const nextStep = multiply(factor, subtract(ONE, learningRate));
    factor = subtract(factor, multiply(nextStep, remainder));
  }

  return {
    factor,
    formula: `Wright cumulative average, rate ${decToString(learningRate)}, ${doublings} doubling(s) with linear interpolation of the remainder.`,
  };
}
