/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/varianceEngine.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Why the actual differs from the estimate, attributed to causes
 *           somebody can act on.
 */

import {
  type Decimal,
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
import type { CostComponentKind } from "../domain/costModel.js";
import type { VarianceCause } from "../domain/costEstimate.js";

// ─────────────────────────────────────────────────────────────────────────────
// "£300 OVER" IS A FACT NOBODY CAN ACT ON
//
// The useful statement is "£280 of it is material price, £20 is usage, and the
// labour was exactly right". One points at a supplier conversation; the other
// points at nothing.
//
// So variance is ATTRIBUTED, and the attribution is arithmetic rather than
// opinion. For any component with a rate and a quantity:
//
//   total    = (Qa × Ra) − (Qe × Re)
//   rate     = Qa × (Ra − Re)        the price moved
//   quantity = Re × (Qa − Qe)        more or less was used
//
// Those two sum exactly to the total. That identity is the whole reason to
// split this way rather than any of the other plausible splits — it means the
// parts always reconcile with the whole, which is what stops an attribution
// being a story told over a number.
//
// THE JOINT VARIANCE PROBLEM
//
// There is a third term. Using MORE material at a HIGHER price produces
// (Qa−Qe)×(Ra−Re), which belongs to neither cause alone. Conventions differ:
// some systems bury it in price, some split it, some report it separately.
//
// This engine puts it in RATE by evaluating the rate variance at the ACTUAL
// quantity — the standard practice, and stated here rather than left for
// somebody to reverse-engineer from the numbers.
//
// AGAINST WHICH ESTIMATE
//
// Always the pinned VERSION the actual was measured against. Comparing to
// "the current estimate" measures drift in the estimate as well as in
// reality, and reports the sum of the two as though it were performance.
// ─────────────────────────────────────────────────────────────────────────────

/** One side of a comparison: what was expected, or what happened. */
export interface VarianceSide {
  readonly componentId: string;
  readonly kind: CostComponentKind;
  readonly label: string;
  readonly amount: Decimal;
  /** Present when the component was priced by rate × quantity. */
  readonly quantity?: Decimal;
  readonly rate?: Decimal;
  readonly quantityUnit?: string;
}

export interface VarianceLine {
  readonly componentId: string;
  readonly kind: CostComponentKind;
  readonly label: string;
  readonly cause: VarianceCause;
  /** Positive means it cost MORE than estimated. */
  readonly amount: Decimal;
  readonly explanation: string;
}

export interface VarianceResult {
  readonly total: Decimal;
  readonly lines: readonly VarianceLine[];
  /**
   * The gap between the total and the sum of the attributed lines.
   *
   * Zero is the invariant. Reported rather than asserted so a caller can see a
   * fault instead of trusting one is impossible.
   */
  readonly unattributed: Decimal;
}

export interface VarianceInput {
  readonly estimated: readonly VarianceSide[];
  readonly actual: readonly VarianceSide[];
  readonly scale: number;
  readonly mode: Parameters<typeof divide>[3];
}

/**
 * Attributes the difference between an estimate and an actual.
 *
 * Deterministic and order-independent: components are matched by id and the
 * output is sorted, so two runs over the same data produce identical lines.
 */
export function computeVariance(input: VarianceInput): VarianceResult {
  const estimatedById = new Map(input.estimated.map((c) => [c.componentId, c]));
  const actualById = new Map(input.actual.map((c) => [c.componentId, c]));
  const allIds = [...new Set([...estimatedById.keys(), ...actualById.keys()])].sort();

  const lines: VarianceLine[] = [];

  for (const id of allIds) {
    const est = estimatedById.get(id);
    const act = actualById.get(id);

    // ── Present on one side only ──────────────────────────────────────────
    if (est === undefined && act !== undefined) {
      lines.push({
        componentId: id,
        kind: act.kind,
        label: act.label,
        cause: "COVERAGE",
        amount: act.amount,
        explanation: `${act.label} was incurred but not estimated — the estimate did not know about this cost at all.`,
      });
      continue;
    }
    if (est !== undefined && act === undefined) {
      lines.push({
        componentId: id,
        kind: est.kind,
        label: est.label,
        cause: "COVERAGE",
        amount: subtract(ZERO, est.amount),
        explanation: `${est.label} was estimated but never incurred.`,
      });
      continue;
    }
    if (est === undefined || act === undefined) continue;

    const delta = subtract(act.amount, est.amount);
    if (compare(delta, ZERO) === 0) continue;

    // ── Both sides priced by rate × quantity: split the difference ────────
    if (est.rate !== undefined && est.quantity !== undefined && act.rate !== undefined && act.quantity !== undefined) {
      // Rate variance evaluated at the ACTUAL quantity, which places the joint
      // term with price. Stated in the header; the alternative conventions are
      // equally defensible and this one is standard.
      const rateVariance = multiply(act.quantity, subtract(act.rate, est.rate));
      const quantityVariance = multiply(est.rate, subtract(act.quantity, est.quantity));

      if (compare(rateVariance, ZERO) !== 0) {
        lines.push({
          componentId: id,
          kind: act.kind,
          label: act.label,
          cause: "RATE",
          amount: rateVariance,
          explanation: `${act.label} was priced at ${decToString(act.rate)} rather than the estimated ${decToString(est.rate)}, across ${decToString(act.quantity)} ${act.quantityUnit ?? "units"}.`,
        });
      }
      if (compare(quantityVariance, ZERO) !== 0) {
        lines.push({
          componentId: id,
          kind: act.kind,
          label: act.label,
          cause: "QUANTITY",
          amount: quantityVariance,
          explanation: `${decToString(act.quantity)} ${act.quantityUnit ?? "units"} were used rather than the estimated ${decToString(est.quantity)}, at the estimated rate of ${decToString(est.rate)}.`,
        });
      }
      continue;
    }

    // ── Only an amount on one or both sides ──────────────────────────────
    //
    // UNEXPLAINED, and named as such. The alternative is to guess a cause,
    // and a guessed attribution is worse than an admitted gap: it looks like
    // an answer and sends somebody to the wrong conversation.
    lines.push({
      componentId: id,
      kind: act.kind,
      label: act.label,
      cause: "UNEXPLAINED",
      amount: delta,
      explanation: `${act.label} differs by ${decToString(delta)}, but was not recorded with a rate and a quantity on both sides, so the difference cannot be split between price and usage.`,
    });
  }

  const estTotal = input.estimated.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const actTotal = input.actual.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const total = subtract(actTotal, estTotal);
  const attributed = lines.reduce<Decimal>((acc, l) => add(acc, l.amount), ZERO);

  // Sorted by magnitude, largest first: the biggest cause is what somebody
  // wants to see, and ties broken by id so the order is deterministic.
  const sorted = [...lines].sort((a, b) => {
    const byMagnitude = compare(magnitude(b.amount), magnitude(a.amount));
    if (byMagnitude !== 0) return byMagnitude;
    return a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0;
  });

  return { total, lines: sorted, unattributed: subtract(total, attributed) };
}

const magnitude = (d: Decimal): Decimal => (compare(d, ZERO) < 0 ? subtract(ZERO, d) : d);

/** Variance grouped by cause, for a summary that fits on a screen. */
export function summariseByCause(result: VarianceResult): ReadonlyMap<VarianceCause, Decimal> {
  const out = new Map<VarianceCause, Decimal>();
  for (const line of result.lines) {
    out.set(line.cause, add(out.get(line.cause) ?? ZERO, line.amount));
  }
  return out;
}

/** Variance grouped by component kind. */
export function summariseByKind(result: VarianceResult): ReadonlyMap<CostComponentKind, Decimal> {
  const out = new Map<CostComponentKind, Decimal>();
  for (const line of result.lines) {
    out.set(line.kind, add(out.get(line.kind) ?? ZERO, line.amount));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// BIAS: THE PATTERN ACROSS MANY VARIANCES
//
// One job over by 8% is noise. Forty jobs of the same family averaging 8% over
// is a rate that is wrong, and it is worth far more than any single variance —
// it is the engine noticing its own inputs are stale.
//
// CostIQ RAISES this and never acts on it. Changing an authoritative rate is a
// governed act, and an engine that quietly corrected its own inputs would make
// every historical estimate unreproducible.
// ─────────────────────────────────────────────────────────────────────────────

export interface BiasObservation {
  readonly estimated: Decimal;
  readonly actual: Decimal;
}

export interface BiasFinding {
  readonly sampleSize: number;
  /** Mean signed error as a fraction: 0.08 means 8% over on average. */
  readonly meanBias: Decimal;
  /** How many of the observations lean the same way as the mean. */
  readonly consistentCount: number;
  /** Whether this looks like bias rather than scatter. */
  readonly isPersistent: boolean;
  readonly explanation: string;
}

/**
 * Whether a family of estimates is consistently wrong in one direction.
 *
 * Requires BOTH a meaningful average error and consistency of direction. A
 * mean of 8% made of +100% and −84% is not bias, it is two different problems
 * — and treating it as bias would "correct" a rate that is right on average
 * and wrong in every individual case.
 */
export function detectBias(
  observations: readonly BiasObservation[],
  options: {
    readonly minimumSample: number;
    readonly thresholdFraction: Decimal;
    readonly scale: number;
    readonly mode: Parameters<typeof divide>[3];
  },
): BiasFinding {
  const n = observations.length;
  if (n < options.minimumSample) {
    return {
      sampleSize: n,
      meanBias: ZERO,
      consistentCount: 0,
      isPersistent: false,
      explanation: `${n} observation(s) is below the minimum of ${options.minimumSample}. Too few to distinguish bias from scatter.`,
    };
  }

  let sum = ZERO;
  let sameDirection = 0;
  const errors: Decimal[] = [];
  for (const o of observations) {
    if (compare(o.estimated, ZERO) === 0) {
      // A zero estimate has no meaningful percentage error; including it would
      // divide by zero or silently drop the observation.
      continue;
    }
    const error = divide(subtract(o.actual, o.estimated), o.estimated, options.scale, options.mode);
    errors.push(error);
    sum = add(sum, error);
  }

  if (errors.length === 0) {
    return {
      sampleSize: n,
      meanBias: ZERO,
      consistentCount: 0,
      isPersistent: false,
      explanation: "Every observation had a zero estimate, so no percentage error could be computed.",
    };
  }

  const mean = divide(sum, fromInteger(errors.length), options.scale, options.mode);
  const meanIsOver = compare(mean, ZERO) > 0;
  for (const e of errors) {
    if (compare(e, ZERO) > 0 === meanIsOver && compare(e, ZERO) !== 0) sameDirection += 1;
  }

  // Two-thirds leaning the same way. A majority alone is too weak — an even
  // split with one outlier would qualify.
  const consistent = sameDirection * 3 >= errors.length * 2;
  const material = compare(magnitude(mean), options.thresholdFraction) >= 0;

  return {
    sampleSize: errors.length,
    meanBias: mean,
    consistentCount: sameDirection,
    isPersistent: consistent && material,
    explanation:
      consistent && material
        ? `${errors.length} observations average ${decToString(multiply(mean, fromInteger(100)))}% ${meanIsOver ? "over" : "under"}, with ${sameDirection} leaning the same way. That is a rate worth reviewing, not a run of bad luck.`
        : !material
          ? `Mean error of ${decToString(multiply(mean, fromInteger(100)))}% is within the threshold; nothing to report.`
          : `Mean error is ${decToString(multiply(mean, fromInteger(100)))}% but only ${sameDirection} of ${errors.length} lean that way. That is scatter, not bias — correcting a rate on this evidence would make it wrong in every individual case.`,
  };
}
