/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/actualCostMethod.ts
 * Module:   cost-iq-engine / core
 * Purpose:  What a job actually cost — including the parts nobody recorded.
 */

import { z } from "zod";

import {
  type Decimal,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  toString as decToString,
} from "../domain/decimal.js";
import { costComponentKindSchema, decimalStringSchema } from "../domain/costModel.js";
import type { CostMethod, CostMethodResult } from "./methodRegistry.js";

// ─────────────────────────────────────────────────────────────────────────────
// AN ACTUAL COST IS AN ESTIMATE WITH BETTER EVIDENCE
//
// It feels like the one number in costing that is simply true. It is not. It is
// assembled from whatever got recorded, and what gets recorded is systematically
// incomplete in the same direction every time:
//
//   - Time booked to a job stops when somebody remembers to stop it.
//   - Material issued is recorded; material scrapped and re-cut often is not.
//   - Rework is frequently booked to the original job, or to nothing.
//   - Setup gets shared across a batch and attributed to the first part.
//
// Every one of those makes the actual look LOWER than it was, and the error is
// invisible because an actual carries the authority of having happened. A
// variance computed against it then reports the estimate as pessimistic, and
// somebody trims the estimate. That is the loop this module exists to break.
//
// So this method computes the actual AND reports its completeness: which
// categories have postings, which are silent, and how much of the estimate's
// shape is missing from the actual. A silent category is not zero. It is
// unknown, and the two must not look the same.
//
// WHY IT IS A METHOD AND NOT A REPORT
//
// It goes in the registry, versioned like the others, because an actual cost is
// used the same way an estimate is — quoted from, compared against, and argued
// about eighteen months later. Anything that produces a number people rely on
// needs the same replay guarantees, and a report that lives outside the
// registry has none of them.
// ─────────────────────────────────────────────────────────────────────────────

export const actualPostingSchema = z
  .object({
    postingId: z.string().min(1),
    kind: costComponentKindSchema,
    label: z.string().min(1),
    /** What was consumed. Hours, kilograms, units — the unit says which. */
    quantity: decimalStringSchema,
    quantityUnit: z.string().min(1),
    /** What it cost per unit at the time it was consumed. */
    unitRate: decimalStringSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** When the consumption happened. Used for ordering, never for a clock. */
    postedAt: z.string().min(1),
    /**
     * Whether this posting was reconstructed rather than recorded.
     *
     * A time entry somebody wrote up on Friday for Tuesday's work is a real
     * cost and weaker evidence than a clock-in. Marked so the completeness
     * report can say how much of the "actual" was remembered.
     */
    reconstructed: z.boolean().default(false),
  })
  .strict();
export type ActualPosting = z.infer<typeof actualPostingSchema>;

export const actualCostInputSchema = z
  .object({
    subjectId: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    postings: z.array(actualPostingSchema),
    /**
     * The component kinds the ESTIMATE contained.
     *
     * Supplied so the method can name what is missing. Without it, an actual
     * with no finishing postings looks like a job that needed no finishing,
     * which is indistinguishable from a job whose finishing was never booked.
     */
    expectedKinds: z.array(costComponentKindSchema).default([]),
    scale: z.number().int().min(0).max(18),
  })
  .strict()
  .refine((i) => i.postings.every((p) => p.currency === i.currency), {
    message:
      "Every posting must be in the job's currency. Mixing them would need a conversion rate and a date, and an actual cost that quietly converted would not be reproducible.",
    path: ["postings"],
  });
export type ActualCostInput = z.infer<typeof actualCostInputSchema>;

export interface ActualCompleteness {
  /** Kinds the estimate expected that have no postings at all. */
  readonly silentKinds: readonly string[];
  /** Kinds with postings that were written up rather than recorded. */
  readonly reconstructedKinds: readonly string[];
  /** Share of the total that came from reconstructed postings. */
  readonly reconstructedShare: Decimal;
  /**
   * Whether this actual is complete enough to compute a variance against.
   *
   * False when a category the estimate contained is silent. A variance against
   * a partial actual reports the estimate as pessimistic and invites somebody
   * to trim it.
   */
  readonly safeForVariance: boolean;
  readonly note: string;
}

/**
 * The actual cost method.
 *
 * Version 1.0.0. Sums postings at the rate recorded against each one — NOT at
 * today's rate, which is the difference between what a job cost and what it
 * would cost to repeat.
 */
export const actualCostMethod: CostMethod<ActualCostInput> = {
  id: "actual-cost",
  version: "1.0.0",
  summary:
    "Sums recorded postings at the rate each was booked at, and reports what the actual is missing. A silent category is unknown, not zero.",
  inputSchema: actualCostInputSchema,

  compute(input): CostMethodResult {
    const diagnostics: string[] = [];
    const components = input.postings.map((posting) => {
      const amount = multiply(fromString(posting.quantity), fromString(posting.unitRate));
      return {
        componentId: posting.postingId,
        kind: posting.kind,
        label: posting.label,
        amount: decToString(divide(amount, fromString("1"), input.scale, "HALF_EVEN")),
        currency: posting.currency,
        included: true,
        notes: posting.reconstructed
          ? ["Reconstructed from memory rather than recorded at the time."]
          : [],
        basisId: `posting:${posting.postingId}`,
        quantity: posting.quantity,
        quantityUnit: posting.quantityUnit,
        parentId: null,
      };
    });

    if (input.postings.length === 0) {
      // Not an error, and emphatically not a cost of zero. A job with no
      // postings is a job nobody booked anything to.
      diagnostics.push(
        "There are no postings, so this job has no actual cost — which is different from having cost nothing. Whatever was spent on it was booked somewhere else, or not at all.",
      );
    }

    const reconstructed = input.postings.filter((p) => p.reconstructed);
    if (reconstructed.length > 0) {
      diagnostics.push(
        `${reconstructed.length} of ${input.postings.length} postings were reconstructed rather than recorded at the time. They are real costs and weaker evidence, and they tend to be rounder numbers than the truth.`,
      );
    }

    const postedKinds = new Set(input.postings.map((p) => p.kind));
    const silent = input.expectedKinds.filter((k) => !postedKinds.has(k));
    if (silent.length > 0) {
      diagnostics.push(
        `The estimate contained ${silent.join(", ")} and the actual has no postings for ${silent.length === 1 ? "it" : "them"}. That is unknown, not zero — and a variance computed against this actual would report the estimate as pessimistic by exactly the amount nobody booked.`,
      );
    }

    return {
      ok: true,
      output: {
        components: components as never,
        assumptions: [],
        diagnostics,
      },
    };
  },
};

/**
 * How complete an actual is, as data a caller can branch on.
 *
 * Separate from the method's diagnostics because a host needs to make a
 * decision on this — whether to show a variance at all — and parsing prose to
 * make a decision is how prose stops being read.
 */
export function assessCompleteness(
  input: ActualCostInput,
  scale: number,
): ActualCompleteness {
  const postedKinds = new Set(input.postings.map((p) => p.kind));
  const silentKinds = input.expectedKinds.filter((k) => !postedKinds.has(k));

  const total = input.postings.reduce<Decimal>(
    (acc, p) => add(acc, multiply(fromString(p.quantity), fromString(p.unitRate))),
    ZERO,
  );
  const reconstructedTotal = input.postings
    .filter((p) => p.reconstructed)
    .reduce<Decimal>((acc, p) => add(acc, multiply(fromString(p.quantity), fromString(p.unitRate))), ZERO);

  const reconstructedShare =
    compare(total, ZERO) === 0 ? ZERO : divide(reconstructedTotal, total, scale, "HALF_EVEN");

  const reconstructedKinds = [
    ...new Set(input.postings.filter((p) => p.reconstructed).map((p) => p.kind)),
  ].sort();

  const safeForVariance = silentKinds.length === 0 && input.postings.length > 0;

  const note = safeForVariance
    ? `Every category the estimate contained has postings. A variance against this actual is measuring a real difference${
        compare(reconstructedShare, ZERO) > 0
          ? `, though ${decToString(reconstructedShare)} of it rests on postings written up after the fact`
          : ""
      }.`
    : input.postings.length === 0
      ? "There are no postings at all. There is no actual cost here to compare anything against."
      : `${silentKinds.join(", ")} ${silentKinds.length === 1 ? "has" : "have"} no postings. A variance computed now would attribute the whole of ${silentKinds.length === 1 ? "that category" : "those categories"} to the estimate being wrong, when the actual simply does not contain it.`;

  return { silentKinds, reconstructedKinds, reconstructedShare, safeForVariance, note };
}
