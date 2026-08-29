// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { RepairCandidate } from "../repair/candidate.js";
import type { ChangeSet } from "../repair/workspace.js";
import type { ValidationVerdict } from "./validators.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repair fitness scoring (directive §20) and selection (§21).
//
// §20: "Do not use one opaque AI score. Use explicit dimensions... Store each
// dimension separately. An aggregate score may be computed, but individual
// dimensions must remain inspectable. A repair that fixes the bug but fails
// constitutional integrity must be rejected regardless of aggregate score."
//
// THE AGGREGATE IS ADVISORY AND SAYS SO
//
// Every dimension is stored. The aggregate exists because ranking needs a
// number, and it is explicitly NOT the thing that decides admissibility —
// `admissible` is a separate boolean computed from the veto dimensions, and
// selection filters on it before it ever looks at a score.
//
// This matters because the failure mode is specific and seductive: a candidate
// that fixes the bug perfectly, regresses nothing, and quietly widens an
// authority grant will out-score an honest candidate on every numeric
// dimension. Any weighting small enough to be outvoted is a weighting that
// permits the thing it was meant to forbid.
//
// NULL IS A SCORE
//
// A dimension nothing measured is `null`, never 0 and never 1. Zero reads as
// "measured and terrible" and one reads as "measured and perfect"; both are
// lies about a measurement that did not happen, and both propagate into the
// aggregate as if they were facts.
// ─────────────────────────────────────────────────────────────────────────────

export type DimensionScore = number | null;

export interface RepairFitness {
  /** Did the original failure stop happening? */
  readonly faultFixed: DimensionScore;
  /** Did anything else break? Higher is fewer regressions. */
  readonly regressions: DimensionScore;
  /** VETO. Constitutional integrity. */
  readonly constitutionalIntegrity: DimensionScore;
  /** VETO. */
  readonly security: DimensionScore;
  /** VETO. */
  readonly tenantIsolation: DimensionScore;
  /** VETO. */
  readonly contractCompatibility: DimensionScore;
  /** VETO. */
  readonly portability: DimensionScore;
  readonly reversibility: DimensionScore;
  readonly blastRadius: DimensionScore;
  readonly performance: DimensionScore;
  readonly complexity: DimensionScore;
  readonly maintainability: DimensionScore;
  readonly confidence: DimensionScore;
}

/**
 * The dimensions where a failure cannot be outweighed.
 *
 * §20's sentence, as a list. Named here rather than inline so that adding a
 * dimension forces a decision about whether it is a veto.
 */
export const VETO_DIMENSIONS: readonly (keyof RepairFitness)[] = Object.freeze([
  "constitutionalIntegrity",
  "security",
  "tenantIsolation",
  "contractCompatibility",
  "portability",
]);

export interface ScoredRepair {
  readonly repairCandidateId: string;
  readonly fitness: RepairFitness;
  /**
   * Whether this candidate may be selected AT ALL.
   *
   * Computed from the veto dimensions alone. Separate from the aggregate on
   * purpose — selection filters on this before it looks at any number.
   */
  readonly admissible: boolean;
  readonly inadmissibleBecause: readonly string[];
  /**
   * ADVISORY. For ranking admissible candidates against each other.
   *
   * Never for deciding whether a candidate may be used. Dimensions that were
   * not measured are excluded from the mean rather than counted as anything.
   */
  readonly advisoryAggregate: DimensionScore;
  /** Which dimensions nothing measured. */
  readonly unmeasured: readonly (keyof RepairFitness)[];
}

/** How reversible a repair is, as a score. The corpus's three values. */
function reversibilityScore(candidate: RepairCandidate): DimensionScore {
  switch (candidate.reversibility) {
    case "REVERSIBLE":
      return 1;
    case "CONTAIN_FIRST":
      // Not "half reversible". It means containment comes first, which is a
      // heavier operational commitment than a plain revert.
      return 0.5;
    case "NOT_APPLICABLE":
      return null;
  }
}

/**
 * Blast radius as a score.
 *
 * Returns null. The corpus's sixteen blast-radius values are heterogeneous —
 * WORK_ORDER, FINANCIAL, ARCHITECTURE, HIVE — and there is no honest ordering
 * between a financial blast radius and an architectural one. Scoring them would
 * mean inventing a ranking and then letting it move a decision.
 *
 * The value is still STORED on the candidate and shown to a human. What it is
 * not is a number in an average.
 */
function blastRadiusScore(): DimensionScore {
  return null;
}

function complexityScore(changeSet: ChangeSet): DimensionScore {
  // Smaller is better, saturating. A 1-line change scores near 1; a 500-line
  // change scores near 0. Crude and deliberately so — this is a tiebreaker
  // between admissible candidates, not a judgement about quality.
  const churn = changeSet.linesAdded + changeSet.linesRemoved;
  if (churn === 0) return null;
  return 1 / (1 + churn / 50);
}

export interface ScoreInput {
  candidate: RepairCandidate;
  changeSet: ChangeSet;
  verdict: ValidationVerdict;
  /** Diagnostic confidence in the root cause this candidate addresses. */
  diagnosticConfidence?: "suspected" | "probable" | "confirmed";
  /** Host-measured, when measured at all. */
  performance?: number;
  maintainability?: number;
}

const CONFIDENCE_SCORE: Readonly<Record<string, number>> = Object.freeze({
  suspected: 0.3,
  probable: 0.65,
  confirmed: 1,
});

export function scoreRepair(input: ScoreInput): ScoredRepair {
  const byName = new Map(input.verdict.results.map((r) => [r.validatorName, r]));

  /** A validator's outcome as a dimension score. NOT_RUN becomes null. */
  const fromValidator = (name: string): DimensionScore => {
    const result = byName.get(name);
    if (!result || result.outcome === "NOT_RUN") return null;
    return result.outcome === "PASSED" ? 1 : 0;
  };

  const replay = byName.get("scenario-replay");
  const regression = byName.get("regression");

  const fitness: RepairFitness = {
    faultFixed: !replay || replay.outcome === "NOT_RUN" ? null : replay.outcome === "PASSED" ? 1 : 0,
    regressions:
      !regression || regression.outcome === "NOT_RUN" ? null : regression.outcome === "PASSED" ? 1 : 0,
    // The forbidden-shortcut validator IS the constitutional integrity check.
    constitutionalIntegrity: fromValidator("forbidden-shortcut"),
    security: fromValidator("sentinel"),
    // Sentinel covers tenant weakening; there is no separate check yet, so this
    // reads from the same result rather than inventing an independent number.
    tenantIsolation: fromValidator("sentinel"),
    contractCompatibility: fromValidator("contract-compatibility"),
    portability: fromValidator("portability"),
    reversibility: reversibilityScore(input.candidate),
    blastRadius: blastRadiusScore(),
    performance: input.performance ?? null,
    complexity: complexityScore(input.changeSet),
    maintainability: input.maintainability ?? null,
    confidence:
      input.diagnosticConfidence === undefined ? null : CONFIDENCE_SCORE[input.diagnosticConfidence]!,
  };

  // ── Admissibility ─────────────────────────────────────────────────────────
  //
  // A veto dimension that FAILED blocks. A veto dimension that was never
  // measured also blocks — "we did not check whether this widens authority" is
  // not a reason to proceed, and treating unmeasured as acceptable is how the
  // unchecked path becomes the default path.
  const inadmissibleBecause: string[] = [];

  for (const dimension of VETO_DIMENSIONS) {
    const value = fitness[dimension];
    if (value === null) {
      inadmissibleBecause.push(
        `${dimension} was not measured. An unmeasured constitutional dimension is not a passing one.`,
      );
    } else if (value < 1) {
      inadmissibleBecause.push(`${dimension} failed.`);
    }
  }

  if (!input.verdict.valid) {
    inadmissibleBecause.push(`Validation rejected this candidate: ${input.verdict.reason}`);
  }

  const measured = (Object.entries(fitness) as [keyof RepairFitness, DimensionScore][]).filter(
    ([, v]) => v !== null,
  );
  const unmeasured = (Object.entries(fitness) as [keyof RepairFitness, DimensionScore][])
    .filter(([, v]) => v === null)
    .map(([k]) => k);

  return {
    repairCandidateId: input.candidate.repairCandidateId,
    fitness,
    admissible: inadmissibleBecause.length === 0,
    inadmissibleBecause,
    advisoryAggregate:
      measured.length === 0
        ? null
        : measured.reduce((sum, [, v]) => sum + (v as number), 0) / measured.length,
    unmeasured,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection (directive §21).
//
// "V1 selection logic should prefer: valid, constitutional, secure, low blast
// radius, reversible, contract-compatible, simpler, lower-risk repairs. Do not
// optimize solely for test_pass_rate."
//
// The first six of those are admissibility, not preference — a candidate that
// is not constitutional is not a worse choice, it is not a choice. So they are
// filtered, and the ordering below only ever runs over what survived.
// ─────────────────────────────────────────────────────────────────────────────

export type Selection =
  | { readonly selected: ScoredRepair; readonly rejected: readonly { id: string; because: string }[] }
  | { readonly selected: null; readonly reason: string; readonly rejected: readonly { id: string; because: string }[] };

const RISK_ORDER: Readonly<Record<RepairCandidate["risk"], number>> = Object.freeze({
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  SEVERE: 3,
});

export function selectRepair(
  scored: readonly { score: ScoredRepair; candidate: RepairCandidate }[],
): Selection {
  const rejected: { id: string; because: string }[] = [];

  const admissible = scored.filter((s) => {
    if (s.score.admissible) return true;
    rejected.push({
      id: s.score.repairCandidateId,
      because: s.score.inadmissibleBecause.join(" "),
    });
    return false;
  });

  if (admissible.length === 0) {
    return {
      selected: null,
      reason:
        "No admissible candidate. Every proposal either failed a constitutional dimension or left one unmeasured. " +
        "Producing no repair is a valid outcome; producing an inadmissible one is not.",
      rejected,
    };
  }

  // Ordering, in the directive's stated priority. Reversibility and risk come
  // before anything resembling a test pass rate, and `faultFixed` is
  // deliberately LAST among the numeric comparisons — §21's "do not optimize
  // solely for test_pass_rate", taken literally.
  const ranked = [...admissible].sort((a, b) => {
    const reversible = (s: ScoredRepair) => s.fitness.reversibility ?? 0;
    if (reversible(b.score) !== reversible(a.score)) return reversible(b.score) - reversible(a.score);

    const risk = RISK_ORDER[a.candidate.risk] - RISK_ORDER[b.candidate.risk];
    if (risk !== 0) return risk;

    const complexity = (s: ScoredRepair) => s.fitness.complexity ?? 0;
    if (complexity(b.score) !== complexity(a.score)) return complexity(b.score) - complexity(a.score);

    const fixed = (s: ScoredRepair) => s.fitness.faultFixed ?? 0;
    return fixed(b.score) - fixed(a.score);
  });

  const winner = ranked[0]!;
  for (const loser of ranked.slice(1)) {
    rejected.push({
      id: loser.score.repairCandidateId,
      because: `Admissible, but ${winner.score.repairCandidateId} is preferred: more reversible, lower risk, or simpler.`,
    });
  }

  return { selected: winner.score, rejected };
}
