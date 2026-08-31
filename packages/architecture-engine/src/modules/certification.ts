// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { ConformanceFinding } from "@proworks-hub/hive-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// CertificationIQ and BenchmarkIQ.
//
// Together because they answer the same question in two registers: is this
// claim backed by evidence, or is it merely asserted?
//
// NEITHER AUTHORIZES ANYTHING. CertificationIQ reports a status; whether that
// status is sufficient to deploy is Governance's decision and a human's. A
// certification engine that could block a release would hold a power nobody
// granted it, and the pressure to make it say PASS would arrive the first time
// a release was urgent.
// ─────────────────────────────────────────────────────────────────────────────

export const certificationStatusSchema = z.enum([
  /** Every required rule passed and every required evidence kind is present. */
  "CERTIFIED",
  /** Nothing failed, but required evidence is missing. NOT a pass. */
  "INCOMPLETE",
  /** At least one required rule failed. */
  "NOT_CERTIFIED",
  /** The profile could not be evaluated at all. */
  "UNKNOWN",
]);
export type CertificationStatus = z.infer<typeof certificationStatusSchema>;

/** A versioned bundle of what a maturity claim requires. */
export interface CertificationProfile {
  readonly profileId: string;
  readonly version: string;
  readonly requiredRuleIds: readonly string[];
  /** Kinds of evidence that must be present, by prefix: `test:`, `adr:`, `bench:`. */
  readonly requiredEvidenceKinds: readonly string[];
}

export interface CertificationResult {
  readonly profileId: string;
  readonly subjectId: string;
  readonly status: CertificationStatus;
  readonly failedRuleIds: readonly string[];
  readonly missingRuleIds: readonly string[];
  readonly missingEvidenceKinds: readonly string[];
  /** Never "approved". This engine does not approve. */
  readonly note: string;
}

/**
 * Evaluates a subject against a certification profile.
 *
 * `INCOMPLETE` is the value that earns this module its place. A profile
 * requiring ten rules where nine passed and one was never evaluated is not a
 * pass — treating an unevaluated rule as satisfied is how certification stops
 * meaning anything, and it fails silently and in the flattering direction.
 *
 * A rule that was evaluated as NOT_APPLICABLE with a stated reason does count
 * as addressed, because somebody decided. UNKNOWN does not.
 */
export function certify(
  profile: CertificationProfile,
  subjectId: string,
  findings: readonly ConformanceFinding[],
  evidenceRefs: readonly string[],
): CertificationResult {
  const mine = findings.filter((f) => f.subjectId === subjectId);
  const byRule = new Map(mine.map((f) => [f.ruleId, f]));

  const failedRuleIds: string[] = [];
  const missingRuleIds: string[] = [];
  for (const ruleId of profile.requiredRuleIds) {
    const finding = byRule.get(ruleId);
    if (!finding || finding.status === "UNKNOWN") {
      missingRuleIds.push(ruleId);
      continue;
    }
    if (finding.status === "FAIL") failedRuleIds.push(ruleId);
  }

  const missingEvidenceKinds = profile.requiredEvidenceKinds.filter(
    (kind) => !evidenceRefs.some((ref) => ref.startsWith(kind)),
  );

  const status: CertificationStatus =
    failedRuleIds.length > 0
      ? "NOT_CERTIFIED"
      : missingRuleIds.length > 0 || missingEvidenceKinds.length > 0
        ? "INCOMPLETE"
        : "CERTIFIED";

  return {
    profileId: profile.profileId,
    subjectId,
    status,
    failedRuleIds: failedRuleIds.sort(),
    missingRuleIds: missingRuleIds.sort(),
    missingEvidenceKinds: missingEvidenceKinds.sort(),
    note: "A certification status is evidence, not permission. Governance decides whether it is sufficient.",
  };
}

// ── BenchmarkIQ ──────────────────────────────────────────────────────────────

/** What a benchmark run has to record to be worth citing. */
export interface BenchmarkProfile {
  readonly profileId: string;
  readonly domain: string;
  readonly workload: string;
  readonly dataset: string;
  readonly environment: string;
  readonly metric: string;
  readonly unit: string;
  /** Percentiles observed. A mean alone hides the tail that users feel. */
  readonly percentiles: Readonly<Record<string, number>>;
  readonly runs: number;
  /** What this run does NOT establish. Required, and non-empty. */
  readonly limitations: readonly string[];
}

export interface ComparativeClaim {
  readonly claim: string;
  readonly comparedTo: string;
  /** A citation for the other system's number, under §27's legal/ethical rule. */
  readonly publicSourceRef?: string;
}

export const claimVerdictSchema = z.enum([
  "SUPPORTED",
  /** The evidence does not reach the claim. The claim is not published. */
  "UNSUPPORTED",
]);
export type ClaimVerdict = z.infer<typeof claimVerdictSchema>;

export interface ClaimAssessment {
  readonly verdict: ClaimVerdict;
  readonly reasons: readonly string[];
}

/**
 * Whether a comparative performance claim may be made.
 *
 * Manifesto §26/§27: never claim "better than X" without reproducible
 * evidence. This refuses by default and states why, because the failure mode
 * is not somebody lying — it is somebody with a real measurement drawing a
 * conclusion one step wider than it supports, in a document nobody re-derives.
 *
 * Three independent reasons to refuse, all reported rather than
 * short-circuited, so a caller fixing one is told about the others.
 */
export function assessComparativeClaim(
  profile: BenchmarkProfile,
  claim: ComparativeClaim,
): ClaimAssessment {
  const reasons: string[] = [];

  if (profile.runs < 2) {
    reasons.push(
      `a single run is not reproducible evidence (runs=${profile.runs}); repeat it before comparing`,
    );
  }
  if (!claim.publicSourceRef) {
    reasons.push(
      `no public source is cited for ${claim.comparedTo}; a comparison against an unmeasured system is a claim about a guess`,
    );
  }
  if (profile.limitations.length === 0) {
    reasons.push(
      "no limitations recorded; a benchmark that claims to have none has not been examined closely enough",
    );
  }

  return {
    verdict: reasons.length === 0 ? "SUPPORTED" : "UNSUPPORTED",
    reasons,
  };
}

/**
 * Renders a benchmark result WITHOUT a comparative claim.
 *
 * Always available, because measuring your own system is always legitimate.
 * It is the comparison that needs the other party's number, and that is the
 * part `assessComparativeClaim` gates.
 */
export function describeBenchmark(profile: BenchmarkProfile): string {
  const ps = Object.entries(profile.percentiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}${profile.unit}`)
    .join(" ");
  return `${profile.profileId}: ${profile.metric} over ${profile.workload} on ${profile.dataset} (${profile.environment}, ${profile.runs} runs) — ${ps}. Limitations: ${profile.limitations.join("; ") || "none recorded"}.`;
}
