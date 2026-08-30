/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/costModelHealth.ts
 * Module:   cost-iq-engine / core
 * Purpose:  Whether the cost model deserves to be believed.
 */

import {
  type Decimal,
  type RoundingMode,
  ZERO,
  add,
  compare,
  divide,
  fromString,
  multiply,
  subtract,
  toString as decToString,
} from "../domain/decimal.js";
import { type Provenance, SOURCE_STRENGTH, ageInDays } from "../domain/provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// A COST MODEL DECAYS SILENTLY
//
// Nothing breaks when a rate goes stale. The estimate still computes, still
// looks precise, still prints to six decimal places. It is simply wrong, and
// there is no error to notice.
//
// That is the failure mode this module exists for. It does not check whether
// the arithmetic is right — the tests do that — it checks whether the INPUTS
// still deserve to be believed, and reports it as a standing signal rather
// than something a person has to remember to go and look for.
//
// FINDINGS ARE DETERMINISTIC AND ORDERED
//
// Every finding comes from a rule with a threshold the caller supplies. No AI,
// no heuristics that drift between versions. Given the same model and the same
// policy, the same findings come out in the same order — so "the health report
// changed" always means the model changed, never that the report is noisy.
//
// HEALTH IS NOT A SINGLE NUMBER
//
// There is a score, because people want one and dashboards need one. It is
// reported next to the findings that produced it and never on its own: a score
// of 72 tells nobody what to fix, and a model with one catastrophic gap and
// ninety healthy rates can score well while being unusable for the one estimate
// that matters.
// ─────────────────────────────────────────────────────────────────────────────

export const HEALTH_SEVERITY = ["INFO", "WARNING", "SERIOUS", "CRITICAL"] as const;
export type HealthSeverity = (typeof HEALTH_SEVERITY)[number];

const SEVERITY_RANK: Record<HealthSeverity, number> = {
  CRITICAL: 0,
  SERIOUS: 1,
  WARNING: 2,
  INFO: 3,
};

export interface HealthFinding {
  readonly code: string;
  readonly severity: HealthSeverity;
  /** What is wrong, in words a person who did not build this can act on. */
  readonly message: string;
  /** Which basis, component or estimate it is about. */
  readonly subjectRef: string;
  /** What to do about it. */
  readonly remedy: string;
}

export interface HealthPolicy {
  /** Beyond this age a rate is called out. */
  readonly staleAfterDays: number;
  /** Beyond this, it is serious. */
  readonly veryStaleAfterDays: number;
  /** Below this source strength, evidence is called weak. */
  readonly minimumSourceStrength: number;
  /** A model with more than this fraction of its value unpriced is not usable. */
  readonly maximumUnpricedFraction: Decimal;
  /** Coverage below this is called out even when the source is strong. */
  readonly minimumCoverageFraction: Decimal;
  readonly scale: number;
  readonly mode: RoundingMode;
}

export interface ModelComponentHealth {
  readonly ref: string;
  readonly label: string;
  /** Null for an unpriced component — the case that matters most. */
  readonly provenance: Provenance | null;
  /** How much of the component's value this evidence actually covers. */
  readonly coverageFraction: Decimal;
  /** Share of total model cost, used to weight the score. */
  readonly valueShareFraction: Decimal;
}

export interface ModelHealthReport {
  readonly findings: readonly HealthFinding[];
  /** 0–100. Reported next to the findings, never alone. */
  readonly score: Decimal;
  readonly worstSeverity: HealthSeverity | null;
  /** False when the model should not be used for a decision without work first. */
  readonly usable: boolean;
  readonly summary: string;
  readonly assessedAt: string;
}

/**
 * Assesses one model's inputs.
 *
 * `now` is an argument, never `Date.now()`. A health report that depends on the
 * wall clock cannot be replayed, and a report nobody can replay cannot be used
 * to show that a decision was reasonable at the time it was made.
 */
export function assessModelHealth(
  components: readonly ModelComponentHealth[],
  policy: HealthPolicy,
  now: Date,
): ModelHealthReport {
  if (components.length === 0) {
    return {
      findings: [
        {
          code: "MODEL_EMPTY",
          severity: "CRITICAL",
          message: "This cost model has no components. It cannot be wrong, because it does not say anything.",
          subjectRef: "(model)",
          remedy: "Add the components that make up the cost before using this model for anything.",
        },
      ],
      score: ZERO,
      worstSeverity: "CRITICAL",
      usable: false,
      summary: "Empty model.",
      assessedAt: now.toISOString(),
    };
  }

  const findings: HealthFinding[] = [];

  // Penalty accumulates WEIGHTED BY VALUE SHARE, so a stale rate covering 60%
  // of the cost hurts far more than a stale rate on a rounding-error component.
  // A flat count would let a model full of trivial healthy rates hide a bad
  // large one — which is the shape most real cost models have.
  let penalty = ZERO;
  let unpricedShare = ZERO;

  for (const component of components) {
    if (component.provenance === null) {
      unpricedShare = add(unpricedShare, component.valueShareFraction);
      findings.push({
        code: "UNPRICED_COMPONENT",
        severity: "SERIOUS",
        message: `"${component.label}" has no cost evidence at all. It carries ${asPercentText(component.valueShareFraction, policy)} of the model's value and sits at whatever default the method applied.`,
        subjectRef: component.ref,
        remedy: "Price it, or mark it explicitly excluded so the total stops implying it was counted.",
      });
      penalty = add(penalty, multiply(component.valueShareFraction, fromString("100")));
      continue;
    }

    const age = ageInDays(component.provenance, now);
    const strength = SOURCE_STRENGTH[component.provenance.sourceKind];

    if (age > policy.veryStaleAfterDays) {
      findings.push({
        code: "EVIDENCE_VERY_STALE",
        severity: "SERIOUS",
        message: `"${component.label}" rests on evidence ${age} days old, past the ${policy.veryStaleAfterDays}-day limit. Anything that has moved since — wages, materials, energy — has moved without this model noticing.`,
        subjectRef: component.ref,
        remedy: "Re-verify the rate against a current source, or freeze it deliberately with a stated reason.",
      });
      penalty = add(penalty, multiply(component.valueShareFraction, fromString("60")));
    } else if (age > policy.staleAfterDays) {
      findings.push({
        code: "EVIDENCE_AGING",
        severity: "WARNING",
        message: `"${component.label}" rests on evidence ${age} days old, past the ${policy.staleAfterDays}-day refresh point. Still usable; worth checking before it is quoted.`,
        subjectRef: component.ref,
        remedy: "Schedule a refresh. This is not urgent yet, which is exactly why it gets forgotten.",
      });
      penalty = add(penalty, multiply(component.valueShareFraction, fromString("20")));
    }

    if (strength < policy.minimumSourceStrength) {
      findings.push({
        code: "WEAK_SOURCE",
        severity: "WARNING",
        message: `"${component.label}" is priced from ${component.provenance.sourceKind}, weaker than this model's policy accepts. It is a placeholder being treated as a fact.`,
        subjectRef: component.ref,
        remedy: "Replace it with a quote, an invoice or a contracted rate.",
      });
      penalty = add(penalty, multiply(component.valueShareFraction, fromString("25")));
    }

    if (compare(component.coverageFraction, policy.minimumCoverageFraction) < 0) {
      findings.push({
        code: "THIN_COVERAGE",
        severity: "WARNING",
        message: `Evidence for "${component.label}" covers only ${asPercentText(component.coverageFraction, policy)} of its value. The rest is extrapolation, however good the source of the covered part is.`,
        subjectRef: component.ref,
        remedy: "Extend the evidence, or narrow the component so the evidence covers what it claims to.",
      });
      penalty = add(penalty, multiply(component.valueShareFraction, fromString("30")));
    }
  }

  if (compare(unpricedShare, policy.maximumUnpricedFraction) > 0) {
    findings.push({
      code: "TOO_MUCH_UNPRICED",
      severity: "CRITICAL",
      message: `${asPercentText(unpricedShare, policy)} of this model's value is unpriced, past the ${asPercentText(policy.maximumUnpricedFraction, policy)} limit. The total is not an estimate; it is a partial sum being presented as one.`,
      subjectRef: "(model)",
      remedy: "Price the missing components before this model is used for a quote or a decision.",
    });
  }

  const rawScore = subtract(fromString("100"), penalty);
  const score = compare(rawScore, ZERO) < 0 ? ZERO : divide(rawScore, fromString("1"), policy.scale, policy.mode);

  // Ordered by severity, then code, then subject. Deterministic so two runs of
  // the same model produce identical reports — a report that reorders itself
  // trains people to ignore its diffs.
  const ordered = [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byCode = a.code.localeCompare(b.code);
    return byCode !== 0 ? byCode : a.subjectRef.localeCompare(b.subjectRef);
  });

  const worstSeverity = ordered.length === 0 ? null : ordered[0]!.severity;

  return {
    findings: ordered,
    score,
    worstSeverity,
    usable: worstSeverity !== "CRITICAL",
    summary:
      ordered.length === 0
        ? "No findings. Every component has evidence that is current, strong enough, and covers what it claims."
        : `${ordered.length} finding${ordered.length === 1 ? "" : "s"}, worst ${worstSeverity}. Score ${decToString(score)} of 100 — read the findings, not the score.`,
    assessedAt: now.toISOString(),
  };
}

/**
 * Compares two health reports.
 *
 * Answers "is this getting better or worse", which is what actually drives
 * behaviour. A model that is bad and improving needs different attention from
 * one that is bad and rotting.
 */
export function healthTrend(
  earlier: ModelHealthReport,
  later: ModelHealthReport,
): {
  readonly direction: "IMPROVING" | "DEGRADING" | "UNCHANGED";
  readonly scoreDelta: Decimal;
  readonly resolved: readonly HealthFinding[];
  readonly introduced: readonly HealthFinding[];
  readonly note: string;
} {
  const delta = subtract(later.score, earlier.score);
  const cmp = compare(delta, ZERO);

  const resolved = earlier.findings.filter(
    (e) => !later.findings.some((l) => l.code === e.code && l.subjectRef === e.subjectRef),
  );
  const introduced = later.findings.filter(
    (l) => !earlier.findings.some((e) => e.code === l.code && e.subjectRef === l.subjectRef),
  );

  const direction = cmp > 0 ? "IMPROVING" : cmp < 0 ? "DEGRADING" : "UNCHANGED";

  // Churn is reported separately because a flat score genuinely can hide it:
  // two findings fixed and two of equal weight introduced nets to zero, and
  // reporting only "unchanged" would hide real movement in both directions.
  const churn =
    resolved.length > 0 || introduced.length > 0
      ? ` ${resolved.length} finding${resolved.length === 1 ? "" : "s"} resolved, ${introduced.length} new.`
      : " No findings changed.";

  return {
    direction,
    scoreDelta: delta,
    resolved,
    introduced,
    note: `Health is ${direction.toLowerCase()} (${decToString(delta)} points).${churn}`,
  };
}

function asPercentText(fraction: Decimal, policy: HealthPolicy): string {
  return `${decToString(divide(multiply(fraction, fromString("100")), fromString("1"), Math.min(policy.scale, 2), policy.mode))}%`;
}
