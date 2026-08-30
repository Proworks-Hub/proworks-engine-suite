/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/consequence/costConsequence.ts
 * Module:   cost-iq-engine / consequence
 * Purpose:  Answering another engine's economic question without answering it.
 */

import {
  type Decimal,
  type RoundingMode,
  ZERO,
  compare,
  divide,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// ANOTHER ENGINE ASKS "WHICH IS CHEAPER". IT MUST NOT HEAR "DO THAT ONE".
//
// This is the shape of every cross-engine economic question: a scheduler wants
// to know the cost of two sequences, procurement wants two suppliers compared,
// a designer wants two materials priced. CostIQ can answer all of them, and
// answering them is exactly where the charter gets crossed — because the
// cheaper option is so nearly the recommendation that the gap closes by itself
// in whatever code consumes the reply.
//
// So the reply is deliberately shaped to be hard to misuse:
//
//   - It is called cost EVIDENCE, in the type name and in the text.
//   - It carries the unresolved assumptions, so a consumer that wants to act
//     automatically has to first decide to ignore a list of caveats.
//   - It reports how CLOSE the answer is. Most cross-engine questions come back
//     within a few percent, which is inside the error bar of the models, and a
//     consumer treating that as a ranking is acting on noise.
//   - `isAuthorization()` returns false, so the claim is testable rather than
//     stated.
//
// WHY NOT JUST REUSE rankAlternatives
//
// `rankAlternatives` answers a question a person asked, inside CostIQ, where
// the surrounding text and the caveats are read. This one crosses an engine
// boundary and arrives as a data structure in code nobody reads twice. The
// difference is not the arithmetic — it is that this one has to survive being
// consumed by a machine.
// ─────────────────────────────────────────────────────────────────────────────

export interface CostedOption {
  readonly optionId: string;
  readonly label: string;
  readonly totalCost: Decimal;
  readonly currency: string;
  /**
   * What had to be assumed to cost it.
   *
   * Travels with the answer rather than being dropped at the boundary. An
   * assumption nobody can see is an assumption nobody checks.
   */
  readonly assumptions: readonly string[];
  /**
   * How good the evidence behind this figure is, 0–100.
   *
   * Carried because comparing a well-evidenced option with a guessed one and
   * reporting only the difference is how a guess wins an argument.
   */
  readonly evidenceScore: number;
}

export interface CostEvidenceReply {
  readonly questionId: string;
  /** Who asked, so a refusal or a caveat can be routed back. */
  readonly askedBy: string;
  readonly options: readonly CostedOption[];
  /** Ordered cheapest first. An ordering, NOT a recommendation. */
  readonly byCost: readonly CostedOption[];
  /** Gap between cheapest and next, as a fraction of the cheapest. Null if only one. */
  readonly marginFraction: Decimal | null;
  /** True when the gap is inside the stated materiality — the common case. */
  readonly tooCloseToDistinguish: boolean;
  /** True when the cheapest option also has the weakest evidence. */
  readonly cheapestIsLeastEvidenced: boolean;
  readonly unresolvedAssumptions: readonly string[];
  readonly evidenceSummary: string;
  /** What the asking engine still has to decide. Never empty. */
  readonly stillToDecide: readonly string[];
}

/**
 * Costs a set of options and returns evidence about them.
 *
 * Refuses a single option: "which is cheaper" needs something to compare
 * against, and returning a one-item ranking would let a consumer read
 * "cheapest option: X" from a set of one.
 */
export function answerCostQuestion(input: {
  readonly questionId: string;
  readonly askedBy: string;
  readonly options: readonly CostedOption[];
  /** Below this fraction the difference is not distinguishable. */
  readonly materialityFraction: Decimal;
  readonly scale: number;
  readonly mode: RoundingMode;
}): CostEvidenceReply {
  if (input.options.length < 2) {
    throw new RangeError(
      `A cost comparison needs at least two options; "${input.questionId}" supplied ${input.options.length}. Returning a ranking of one would let the caller read "the cheapest option is X" from a set that contained no alternative.`,
    );
  }

  const currencies = new Set(input.options.map((o) => o.currency));
  if (currencies.size > 1) {
    // The same refusal the money rules make, at the boundary where it is most
    // likely to be papered over with a conversion nobody records.
    throw new RangeError(
      `The options are priced in ${[...currencies].sort().join(", ")}. Comparing them needs a conversion rate and a date, both of which are evidence in their own right — CostIQ refuses to invent either, so convert deliberately before asking.`,
    );
  }

  const byCost = [...input.options].sort((a, b) => {
    const byAmount = compare(a.totalCost, b.totalCost);
    // Deterministic ties, so two identical questions get identical answers.
    return byAmount !== 0 ? byAmount : a.optionId.localeCompare(b.optionId);
  });

  const cheapest = byCost[0]!;
  const runnerUp = byCost[1]!;
  const gap = subtract(runnerUp.totalCost, cheapest.totalCost);
  const marginFraction =
    compare(cheapest.totalCost, ZERO) === 0
      ? ZERO
      : divide(gap, cheapest.totalCost, input.scale, input.mode);

  const tooCloseToDistinguish = compare(marginFraction, input.materialityFraction) < 0;
  const weakest = input.options.reduce((worst, o) => (o.evidenceScore < worst.evidenceScore ? o : worst));
  const cheapestIsLeastEvidenced =
    cheapest.optionId === weakest.optionId && weakest.evidenceScore < 100;

  const unresolvedAssumptions = [
    ...new Set(input.options.flatMap((o) => o.assumptions.map((a) => `${o.label}: ${a}`))),
  ];

  const stillToDecide = [
    "Whether cost is the deciding factor here at all. It usually is not the only one.",
    `Whether the assumptions listed hold for this case — CostIQ took them as given and did not test any of them.`,
  ];
  if (tooCloseToDistinguish) {
    stillToDecide.push(
      `Whether a ${decToString(marginFraction)} difference is real. It is inside the ${decToString(input.materialityFraction)} materiality this question was asked with, which means the ordering could reverse on an input being slightly wrong.`,
    );
  }
  if (cheapestIsLeastEvidenced) {
    stillToDecide.push(
      `Whether "${cheapest.label}" is genuinely cheapest or merely least known. It has both the lowest cost and the weakest evidence, which is the pattern an underestimate makes.`,
    );
  }

  const evidenceSummary = tooCloseToDistinguish
    ? `"${cheapest.label}" costs ${decToString(cheapest.totalCost)} ${cheapest.currency} and "${runnerUp.label}" costs ${decToString(runnerUp.totalCost)} — a difference of ${decToString(marginFraction)}, which this question's own materiality threshold says is too small to distinguish. This is cost evidence and it does not separate the options.`
    : `"${cheapest.label}" is the lowest-cost option at ${decToString(cheapest.totalCost)} ${cheapest.currency}, ${decToString(gap)} below "${runnerUp.label}". This is cost evidence, not an authorization and not a decision.`;

  return {
    questionId: input.questionId,
    askedBy: input.askedBy,
    options: input.options,
    byCost,
    marginFraction,
    tooCloseToDistinguish,
    cheapestIsLeastEvidenced,
    unresolvedAssumptions,
    evidenceSummary,
    stillToDecide,
  };
}

/**
 * Whether a cost evidence reply authorizes anything.
 *
 * Always false. A function so a consuming engine can assert it in its own
 * tests — the boundary holds on both sides or it does not hold.
 */
export function isAuthorization(): false {
  return false;
}

/**
 * What a consumer of this reply may and may not conclude.
 *
 * The same shape as the event consequence contracts, for the same reason: the
 * prohibition is the half that gets forgotten, and forgetting it is silent.
 */
export const COST_EVIDENCE_CONTRACT = Object.freeze({
  asserts: "These options were costed on the evidence available, under the assumptions listed.",
  entitles: [
    "Showing the figures and the gap between them to a person.",
    "Using cost as one input to a decision the asking engine owns.",
    "Discarding an option on cost grounds when the gap is outside materiality AND the evidence supports it.",
  ],
  doesNotEntitle: [
    "Treating the cheapest option as the chosen one. CostIQ costed them; it did not weigh them against anything else that matters.",
    "Acting automatically on a difference inside the materiality threshold. That is acting on noise.",
    "Dropping the assumptions when passing the answer on. They are what the numbers depend on.",
    "Inferring that a cheaper option is better. It is cheaper.",
  ],
});
