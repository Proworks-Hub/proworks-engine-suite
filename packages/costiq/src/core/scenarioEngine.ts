/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/scenarioEngine.ts
 * Module:   cost-iq-engine / core
 * Purpose:  What-if, without touching what-is.
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
  toString as decToString,
} from "../domain/decimal.js";
import type { CostComponent } from "../domain/costModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// A SCENARIO IS AN OVERLAY, NEVER A MUTATION
//
// The whole value of scenarios is that they are cheap to generate. Comparing
// twelve suppliers, five volumes and three processes is sixty calculations,
// and a person will only run them if doing so is obviously safe.
//
// It is obviously safe only if a scenario CANNOT alter the baseline. So an
// overlay produces a NEW set of components and the input is never written to.
// The tests assert that by deep-comparing the baseline before and after, which
// is the kind of guarantee that has to be checked rather than intended.
//
// OVERRIDES ARE DATA
//
// Not functions. An executable override could do anything, cannot be
// serialised, cannot be sent to another instance, and cannot be replayed — and
// replay is how a scenario from six months ago is checked.
//
// SENSITIVITY IS NOT SIMULATION
//
// Ranking inputs by how much the answer moves when each is varied is
// deterministic and cheap. Monte Carlo is neither, and the directive makes it
// optional and advisory. What is here is the deterministic part: vary one
// input at a time by a stated amount, measure the effect, rank.
// ─────────────────────────────────────────────────────────────────────────────

export type OverrideTarget = "RATE" | "QUANTITY" | "COMPONENT_AMOUNT" | "YIELD";

export interface ScenarioOverride {
  readonly target: OverrideTarget;
  /** Which component or rate the override applies to. */
  readonly targetRef: string;
  readonly value: Decimal;
  readonly rationale: string;
}

export interface OverlayResult {
  readonly components: readonly CostComponent[];
  readonly total: Decimal;
  /** Overrides that matched nothing, so a typo does not silently do nothing. */
  readonly unmatched: readonly ScenarioOverride[];
  readonly applied: readonly string[];
}

/**
 * Applies overrides to a copy of the baseline components.
 *
 * Returns the unmatched overrides rather than ignoring them. A scenario whose
 * override named a component that does not exist produces a total identical to
 * the baseline, which reads as "this change makes no difference" — the most
 * misleading possible outcome.
 */
export function applyOverlay(
  baseline: readonly CostComponent[],
  overrides: readonly ScenarioOverride[],
  scale: number,
  mode: Parameters<typeof divide>[3],
): OverlayResult {
  const byId = new Map(baseline.map((c) => [c.componentId, c]));
  const matched = new Set<ScenarioOverride>();
  const applied: string[] = [];

  const components = baseline.map((component) => {
    let next = { ...component };

    for (const override of overrides) {
      const targets =
        override.target === "RATE"
          ? component.basisId === override.targetRef
          : component.componentId === override.targetRef;
      if (!targets) continue;

      matched.add(override);
      const quantity = component.quantity === undefined ? null : fromString(component.quantity);
      const amount = fromString(component.amount);

      switch (override.target) {
        case "COMPONENT_AMOUNT":
          next = { ...next, amount: decToString(override.value) };
          applied.push(`${component.label}: amount set to ${decToString(override.value)} (${override.rationale}).`);
          break;

        case "RATE": {
          // The implied rate is amount ÷ quantity. Recomputing from it keeps
          // the override meaningful without needing the original rate on the
          // component — which a rolled-up estimate may no longer carry.
          if (quantity === null || compare(quantity, ZERO) === 0) {
            // No quantity means no rate to replace. Treated as unmatched
            // rather than silently reinterpreted as an amount.
            matched.delete(override);
            break;
          }
          next = { ...next, amount: decToString(multiply(quantity, override.value)) };
          applied.push(
            `${component.label}: rate changed to ${decToString(override.value)} across ${decToString(quantity)} ${component.quantityUnit ?? "units"} (${override.rationale}).`,
          );
          break;
        }

        case "QUANTITY": {
          if (quantity === null || compare(quantity, ZERO) === 0) {
            matched.delete(override);
            break;
          }
          const impliedRate = divide(amount, quantity, scale, mode);
          next = {
            ...next,
            quantity: decToString(override.value),
            amount: decToString(multiply(override.value, impliedRate)),
          };
          applied.push(
            `${component.label}: quantity changed to ${decToString(override.value)} at the same rate (${override.rationale}).`,
          );
          break;
        }

        case "YIELD": {
          if (compare(override.value, ZERO) <= 0 || compare(override.value, ONE) > 0) {
            matched.delete(override);
            break;
          }
          // Yield divides: a worse yield means more must be made.
          next = { ...next, amount: decToString(divide(amount, override.value, scale, mode)) };
          applied.push(
            `${component.label}: yield changed to ${decToString(override.value)}, so more must be started (${override.rationale}).`,
          );
          break;
        }

        default: {
          const unreachable: never = override.target;
          throw new TypeError(`Unknown override target ${String(unreachable)}.`);
        }
      }
    }

    return next;
  });

  const total = components
    .filter((c) => c.included)
    .reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);

  return {
    components,
    total,
    unmatched: overrides.filter((o) => !matched.has(o)),
    applied,
  };
}

/** The difference between two scenarios, line by line. */
export interface BridgeLine {
  readonly componentId: string;
  readonly label: string;
  readonly from: Decimal;
  readonly to: Decimal;
  readonly delta: Decimal;
}

export interface CostBridge {
  readonly fromTotal: Decimal;
  readonly toTotal: Decimal;
  readonly delta: Decimal;
  /** Every line that moved, largest change first. */
  readonly lines: readonly BridgeLine[];
}

/**
 * A bridge from one set of components to another.
 *
 * The lines sum exactly to the delta, which is what makes a waterfall chart
 * honest — a bridge whose bars do not reach the end is a bridge that omitted
 * something.
 */
export function costBridge(
  from: readonly CostComponent[],
  to: readonly CostComponent[],
): CostBridge {
  const fromById = new Map(from.map((c) => [c.componentId, c]));
  const toById = new Map(to.map((c) => [c.componentId, c]));
  const ids = [...new Set([...fromById.keys(), ...toById.keys()])].sort();

  const lines: BridgeLine[] = [];
  for (const id of ids) {
    const a = fromById.get(id);
    const b = toById.get(id);
    const fromAmount = a && a.included ? fromString(a.amount) : ZERO;
    const toAmount = b && b.included ? fromString(b.amount) : ZERO;
    const delta = subtract(toAmount, fromAmount);
    if (compare(delta, ZERO) === 0) continue;
    lines.push({
      componentId: id,
      label: (b ?? a)!.label,
      from: fromAmount,
      to: toAmount,
      delta,
    });
  }

  const fromTotal = from.filter((c) => c.included).reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);
  const toTotal = to.filter((c) => c.included).reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);

  const magnitude = (d: Decimal) => (compare(d, ZERO) < 0 ? subtract(ZERO, d) : d);
  const sorted = [...lines].sort((a, b) => {
    const byMagnitude = compare(magnitude(b.delta), magnitude(a.delta));
    return byMagnitude !== 0 ? byMagnitude : a.componentId < b.componentId ? -1 : 1;
  });

  return { fromTotal, toTotal, delta: subtract(toTotal, fromTotal), lines: sorted };
}

// ─────────────────────────────────────────────────────────────────────────────
// SENSITIVITY
// ─────────────────────────────────────────────────────────────────────────────

export interface SensitivityInput {
  readonly componentId: string;
  readonly label: string;
  /** How much to vary it by, as a fraction. 0.1 means ±10%. */
  readonly variation: Decimal;
}

export interface SensitivityRanking {
  readonly componentId: string;
  readonly label: string;
  /** Total when the input is varied down and up. */
  readonly low: Decimal;
  readonly high: Decimal;
  /** How much the answer moves across the full swing. */
  readonly swing: Decimal;
  /** Swing as a fraction of the baseline total. */
  readonly swingFraction: Decimal;
}

/**
 * Ranks inputs by how much the total moves when each is varied alone.
 *
 * ONE AT A TIME. Varying several together measures their combination, which is
 * a different and much harder question — and the point of a sensitivity
 * ranking is to say which single input to go and nail down first.
 */
export function rankSensitivity(
  baseline: readonly CostComponent[],
  inputs: readonly SensitivityInput[],
  scale: number,
  mode: Parameters<typeof divide>[3],
): readonly SensitivityRanking[] {
  const baseTotal = baseline
    .filter((c) => c.included)
    .reduce<Decimal>((acc, c) => add(acc, fromString(c.amount)), ZERO);

  const rankings = inputs.map((input) => {
    const component = baseline.find((c) => c.componentId === input.componentId);
    if (!component) {
      return {
        componentId: input.componentId,
        label: input.label,
        low: baseTotal,
        high: baseTotal,
        swing: ZERO,
        swingFraction: ZERO,
      };
    }

    const amount = fromString(component.amount);
    const down = multiply(amount, subtract(ONE, input.variation));
    const up = multiply(amount, add(ONE, input.variation));

    const low = add(subtract(baseTotal, amount), down);
    const high = add(subtract(baseTotal, amount), up);
    const swing = subtract(high, low);

    return {
      componentId: input.componentId,
      label: input.label,
      low,
      high,
      swing,
      swingFraction:
        compare(baseTotal, ZERO) === 0 ? ZERO : divide(swing, baseTotal, scale, mode),
    };
  });

  // Largest swing first — the input worth nailing down. Ties by id so the
  // ranking is deterministic.
  return [...rankings].sort((a, b) => {
    const bySwing = compare(b.swing, a.swing);
    return bySwing !== 0 ? bySwing : a.componentId < b.componentId ? -1 : 1;
  });
}

/**
 * The value of an input at which two alternatives cost the same.
 *
 * Linear in the input, which is true for a rate or a quantity and stated
 * because it is not true for everything — a tiered rate has steps, and a
 * break-even computed across one is wrong on the far side of the step.
 */
export function breakEven(
  aFixed: Decimal,
  aPerUnit: Decimal,
  bFixed: Decimal,
  bPerUnit: Decimal,
  scale: number,
  mode: Parameters<typeof divide>[3],
): { readonly quantity: Decimal | null; readonly explanation: string } {
  const slopeDelta = subtract(aPerUnit, bPerUnit);
  if (compare(slopeDelta, ZERO) === 0) {
    return {
      quantity: null,
      explanation:
        compare(aFixed, bFixed) === 0
          ? "The two alternatives cost the same at every quantity."
          : "The two alternatives never meet: their per-unit costs are identical, so the fixed difference never closes.",
    };
  }
  const quantity = divide(subtract(bFixed, aFixed), slopeDelta, scale, mode);
  if (compare(quantity, ZERO) < 0) {
    return {
      quantity,
      explanation: `They would meet at ${decToString(quantity)} units, which is negative — meaning one alternative is cheaper at every real quantity.`,
    };
  }
  return {
    quantity,
    explanation: `The alternatives cost the same at ${decToString(quantity)} units. Below that the one with the lower fixed cost wins; above it, the one with the lower per-unit cost.`,
  };
}
