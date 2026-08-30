/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/costDriverAnalyzer.ts
 * Module:   cost-iq-engine / core
 * Purpose:  What the cost is made of — which is not what to go and fix.
 */

import {
  type Decimal,
  type RoundingMode,
  ZERO,
  add,
  compare,
  divide,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";
import type { SensitivityRanking } from "./scenarioEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONTRIBUTION AND SENSITIVITY ARE DIFFERENT QUESTIONS
//
// `rankSensitivity` already answers "which input moves the answer most if it
// turns out to be wrong". This module answers the other one: "what is the money
// actually going on".
//
// They are routinely confused, and the confusion is expensive in both
// directions:
//
//   - The largest component is not always worth attacking. Raw steel might be
//     55% of a fire pit and quoted from a contract that will not move.
//   - The most sensitive input is not always where the money is. A rate you are
//     unsure about might swing the total 8% and still only be 4% of it.
//
// So both rankings are produced, and — the part that is actually useful — the
// places where they DISAGREE are named. A component that is large and certain
// needs a negotiation. One that is small and uncertain needs a measurement.
// Only the ones that are both large and uncertain deserve to be at the top of
// somebody's week.
//
// PARETO, WITH THE HONEST CAVEAT
//
// The concentration figure says how few components carry most of the cost. It
// is genuinely useful for deciding where to look, and it says nothing about
// whether any of it can be changed — so the note says that rather than letting
// "80% is in three components" imply that three components are the answer.
// ─────────────────────────────────────────────────────────────────────────────

export interface DriverInput {
  readonly componentId: string;
  readonly label: string;
  readonly amount: Decimal;
  /** Excluded components are reported separately, never silently dropped. */
  readonly included: boolean;
}

export interface DriverContribution {
  readonly componentId: string;
  readonly label: string;
  readonly amount: Decimal;
  /** Share of the included total. */
  readonly share: Decimal;
  /** Running share once this component and everything above it is counted. */
  readonly cumulativeShare: Decimal;
  readonly rank: number;
}

export interface DriverAnalysis {
  readonly total: Decimal;
  readonly contributions: readonly DriverContribution[];
  /** How many components carry the concentration threshold's worth of cost. */
  readonly componentsCarryingMost: number;
  /**
   * True when it takes more than half the components to reach the threshold.
   *
   * A separate field rather than something to infer from the note, because a
   * spread cost and a concentrated one call for different work and a caller
   * should be able to branch on it.
   */
  readonly isSpread: boolean;
  readonly concentrationNote: string;
  /** Components excluded from the total, named so their absence is visible. */
  readonly excluded: readonly { readonly componentId: string; readonly label: string; readonly amount: Decimal }[];
  readonly warnings: readonly string[];
}

/**
 * Ranks components by what they contribute to the total.
 *
 * `concentrationThreshold` is a fraction — 0.8 asks the Pareto question. It is
 * a parameter rather than a constant because 80/20 is a rule of thumb somebody
 * noticed about land ownership in 1896, not a property of cost models.
 */
export function analyzeDrivers(
  components: readonly DriverInput[],
  concentrationThreshold: Decimal,
  scale: number,
  mode: RoundingMode,
): DriverAnalysis {
  const warnings: string[] = [];
  const included = components.filter((c) => c.included);
  const excluded = components
    .filter((c) => !c.included)
    .map((c) => ({ componentId: c.componentId, label: c.label, amount: c.amount }));

  if (excluded.length > 0) {
    warnings.push(
      `${excluded.length} component${excluded.length === 1 ? " is" : "s are"} excluded from the total and therefore from every share below. Their money is real; it is simply not in this number.`,
    );
  }

  const total = included.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);

  if (included.length === 0 || compare(total, ZERO) === 0) {
    return {
      total,
      contributions: [],
      componentsCarryingMost: 0,
      isSpread: false,
      concentrationNote:
        "There is no cost to analyse. A total of zero has no drivers, and reporting shares of it would be dividing by nothing.",
      excluded,
      warnings,
    };
  }

  if (included.some((c) => compare(c.amount, ZERO) < 0)) {
    // A credit inside a cost breakdown makes shares exceed 100% and cumulative
    // shares non-monotonic. Reported rather than corrected — the negative may
    // be perfectly deliberate.
    warnings.push(
      "At least one component is negative. Shares are still computed, but they no longer read as parts of a whole: a credit makes the positive components sum to more than the total, and the cumulative column can move backwards.",
    );
  }

  const sorted = [...included].sort((a, b) => {
    const byAmount = compare(b.amount, a.amount);
    // Ties broken by id so two runs of the same model rank identically. A
    // report that reorders itself teaches people to ignore its diffs.
    return byAmount !== 0 ? byAmount : a.componentId.localeCompare(b.componentId);
  });

  let running = ZERO;
  const contributions = sorted.map((component, index) => {
    running = add(running, component.amount);
    return {
      componentId: component.componentId,
      label: component.label,
      amount: component.amount,
      share: divide(component.amount, total, scale, mode),
      cumulativeShare: divide(running, total, scale, mode),
      rank: index + 1,
    };
  });

  const reachedThreshold = contributions.findIndex(
    (c) => compare(c.cumulativeShare, concentrationThreshold) >= 0,
  );
  const componentsCarryingMost = reachedThreshold === -1 ? contributions.length : reachedThreshold + 1;

  // Whether the cost is concentrated is a comparison between HOW MANY
  // components carry the threshold and how many there are — not whether the
  // threshold was reached at all.
  //
  // The first version keyed the finding off `reachedThreshold === -1`, which
  // was nearly unreachable: with any threshold at or below 1, the full set
  // always reaches it, so a genuinely flat cost still reported as though it
  // were concentrated. It said "4 of 4 components carry 80% of the cost",
  // which is true, useless, and reads as a finding.
  const spread = componentsCarryingMost * 2 > contributions.length;

  const concentrationNote =
    reachedThreshold === -1
      ? `Nothing reaches ${decToString(concentrationThreshold)} of the total, even counting every component. That happens when a threshold above 1 was asked for, or when a credit pulls the running total back down — either way the question needs restating before the answer means anything.`
      : spread
        ? `It takes ${componentsCarryingMost} of ${contributions.length} components to reach ${decToString(concentrationThreshold)} of the cost. This cost is SPREAD rather than concentrated, which is harder to attack — there is no small set to go after, and a reduction promise here needs to name many changes rather than one.`
        : `${componentsCarryingMost} of ${contributions.length} components carry ${decToString(concentrationThreshold)} of the cost. That says where to look. It says nothing about whether any of it can be changed.`;

  return {
    total,
    contributions,
    componentsCarryingMost,
    isSpread: reachedThreshold !== -1 && spread,
    concentrationNote,
    excluded,
    warnings,
  };
}

export interface DriverDisagreement {
  readonly componentId: string;
  readonly label: string;
  readonly contributionRank: number;
  readonly sensitivityRank: number;
  readonly kind:
    /** Large and certain. The saving is here, and it needs a negotiation. */
    | "BIG_BUT_STABLE"
    /** Small and uncertain. Worth measuring, not worth a project. */
    | "SMALL_BUT_VOLATILE"
    /** Large and uncertain. Both rankings agree, and this is the one to do first. */
    | "BIG_AND_VOLATILE";
  readonly note: string;
}

/**
 * Where the two rankings disagree, which is the actionable part.
 *
 * `disagreementRanks` is how far apart two positions must be before it is worth
 * mentioning — a component ranked 3rd and 4th has not really disagreed with
 * itself, and reporting it as a finding is noise.
 */
export function compareDriverRankings(
  contributions: readonly DriverContribution[],
  sensitivity: readonly SensitivityRanking[],
  disagreementRanks: number,
  /** Above this contribution rank AND sensitivity rank, a component is "big and volatile". */
  topN: number,
): readonly DriverDisagreement[] {
  const sensitivityRankById = new Map<string, number>();
  [...sensitivity]
    .sort((a, b) => {
      const bySwing = compare(b.swing, a.swing);
      return bySwing !== 0 ? bySwing : a.componentId.localeCompare(b.componentId);
    })
    .forEach((s, index) => sensitivityRankById.set(s.componentId, index + 1));

  const findings: DriverDisagreement[] = [];

  for (const contribution of contributions) {
    const sensitivityRank = sensitivityRankById.get(contribution.componentId);
    // A component with no sensitivity input was not asked about. Silence is not
    // a finding, and inventing a rank for it would be inventing evidence.
    if (sensitivityRank === undefined) continue;

    const gap = contribution.rank - sensitivityRank;

    if (contribution.rank <= topN && sensitivityRank <= topN) {
      findings.push({
        componentId: contribution.componentId,
        label: contribution.label,
        contributionRank: contribution.rank,
        sensitivityRank,
        kind: "BIG_AND_VOLATILE",
        note: `"${contribution.label}" is both one of the largest components and one of the most uncertain. Both rankings agree, which makes it the first thing to nail down.`,
      });
      continue;
    }

    if (Math.abs(gap) < disagreementRanks) continue;

    if (gap < 0) {
      findings.push({
        componentId: contribution.componentId,
        label: contribution.label,
        contributionRank: contribution.rank,
        sensitivityRank,
        kind: "BIG_BUT_STABLE",
        note: `"${contribution.label}" is ${contribution.rank}${ordinal(contribution.rank)} by size but only ${sensitivityRank}${ordinal(sensitivityRank)} by uncertainty. The money is here and the number is trusted — this is a negotiation, not a measurement.`,
      });
    } else {
      findings.push({
        componentId: contribution.componentId,
        label: contribution.label,
        contributionRank: contribution.rank,
        sensitivityRank,
        kind: "SMALL_BUT_VOLATILE",
        note: `"${contribution.label}" is ${sensitivityRank}${ordinal(sensitivityRank)} by uncertainty but only ${contribution.rank}${ordinal(contribution.rank)} by size. Worth measuring so the estimate stops moving; not worth a cost-reduction project.`,
      });
    }
  }

  return findings;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (n % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

/**
 * How much of the total sits on evidence weaker than a threshold.
 *
 * The question "how much of this number do we actually know" — answered as an
 * amount rather than a count, because ten weakly-evidenced fasteners and one
 * weakly-evidenced casting are not the same problem.
 */
export function costOnWeakEvidence(
  components: readonly { readonly amount: Decimal; readonly included: boolean; readonly sourceStrength: number }[],
  minimumStrength: number,
  scale: number,
  mode: RoundingMode,
): { readonly amount: Decimal; readonly fraction: Decimal; readonly note: string } {
  const included = components.filter((c) => c.included);
  const total = included.reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);
  const weak = included
    .filter((c) => c.sourceStrength < minimumStrength)
    .reduce<Decimal>((acc, c) => add(acc, c.amount), ZERO);

  if (compare(total, ZERO) === 0) {
    return {
      amount: ZERO,
      fraction: ZERO,
      note: "There is no cost, so none of it rests on weak evidence. That is arithmetic, not reassurance.",
    };
  }

  const fraction = divide(weak, total, scale, mode);
  return {
    amount: weak,
    fraction,
    note: `${decToString(weak)} of ${decToString(total)} — ${decToString(fraction)} of the total — rests on evidence weaker than the policy accepts. The remaining ${decToString(subtract(total, weak))} is as good as its sources, which is a separate question from whether the arithmetic is right.`,
  };
}
