// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// CreditIQ kernel — §16. Exposure is a KNOWN FLOOR under a per-class
// coverage manifest (E1..E7) — there is no field called `exposure` carrying
// a partial sum (G-10). The limit-test asymmetry is the engine's second
// load-bearing rule: partial evidence can prove a breach (what we can see
// already exceeds the limit; the unseen cannot bring it back under) but can
// NEVER prove compliance — and a within-limit event does not exist,
// deliberately: there is no positive assertion to publish. A mitigant whose conditions cannot be evaluated does
// not reduce exposure: an uncertain reduction reported as certain is the
// unknown-as-zero error in the opposite direction. Adverse action is a hard
// gate: the DecisionRegime is required with no default, and no reason set
// derives from a decomposition that does not reconcile EXACTLY to the score.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const CREDIT_METHODS = {
  compose: method("credit.exposure.compose"),
  mitigate: method("credit.exposure.mitigate"),
  utilisation: method("credit.utilisation.compute"),
  limitTest: method("credit.limit.test"),
  limitDerive: method("credit.limit.derive"),
  reasons: method("credit.reasons.derive"),
  regime: method("credit.decision.regime"),
  behaviour: method("credit.behaviour.indicators"),
} as const satisfies Record<string, MethodRef>;

export const CREDIT_REFUSAL_KINDS = [
  "regime_not_declared",
  "out_of_scope_assertion_unattributed",
  "reasons_not_extractable_for_regime",
  "decomposition_does_not_reconcile",
  "limit_rule_overlap_unresolvable",
  "temporary_limit_without_reason",
  "permissible_purpose_mismatch",
] as const;
export type CreditRefusalKind = (typeof CREDIT_REFUSAL_KINDS)[number];

export interface CreditRefusal {
  readonly kind: CreditRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CreditRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: CreditRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.2 · exposure: a known floor under a coverage manifest ───────────────

export const OBLIGATION_CLASSES = ["E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
export type ObligationClass = (typeof OBLIGATION_CLASSES)[number];

export interface ClassCoverage {
  readonly class: ObligationClass;
  readonly coverage: "complete" | "partial" | "absent";
  readonly reason: string;
  readonly amountMinor: bigint; // contributed amount (0 when absent)
}

export interface ExposureResult {
  /** ALWAYS a floor, never "the exposure" — the name is the rule (G-10). */
  readonly knownFloorMinor: bigint;
  readonly state: "determinate" | "indeterminate";
  readonly coverage: readonly ClassCoverage[];
  readonly methodRef: MethodRef;
}

export function composeExposure(coverage: readonly ClassCoverage[]): ExposureResult {
  const byClass = new Map(coverage.map((c) => [c.class, c]));
  const full: ClassCoverage[] = OBLIGATION_CLASSES.map(
    (cls) => byClass.get(cls) ?? { class: cls, coverage: "absent", reason: "no source declared", amountMinor: 0n },
  );
  return {
    knownFloorMinor: full.reduce((a, c) => a + c.amountMinor, 0n),
    state: full.every((c) => c.coverage === "complete") ? "determinate" : "indeterminate",
    coverage: full,
    methodRef: CREDIT_METHODS.compose,
  };
}

// ── §16.3 · mitigants: indeterminate admissibility does not reduce ──────────

export interface Mitigant {
  readonly mitigantRef: string;
  readonly amountMinor: bigint;
  readonly inForceAtAsOf: boolean;
  readonly namesThisCustomer: boolean;
  readonly classInScope: boolean;
  readonly conditionsEvaluable: boolean;
  readonly conditionsSatisfied: boolean | null; // null when not evaluable
}

export interface MitigationResult {
  readonly exposureGrossMinor: bigint;
  readonly exposureNetMinor: bigint;
  readonly admitted: readonly string[];
  /** Reported as POTENTIAL mitigants with reasons — never as reductions. */
  readonly indeterminate: readonly { mitigantRef: string; reason: string }[];
  readonly inadmissible: readonly { mitigantRef: string; reason: string }[];
}

export function applyMitigants(grossMinor: bigint, mitigants: readonly Mitigant[]): MitigationResult {
  const admitted: string[] = [];
  const indeterminate: { mitigantRef: string; reason: string }[] = [];
  const inadmissible: { mitigantRef: string; reason: string }[] = [];
  let net = grossMinor;
  for (const m of mitigants) {
    if (!m.inForceAtAsOf || !m.namesThisCustomer || !m.classInScope) {
      inadmissible.push({ mitigantRef: m.mitigantRef, reason: "out of force, scope or party" });
      continue;
    }
    if (!m.conditionsEvaluable || m.conditionsSatisfied === null) {
      // Credit insurance is conditional by nature; an unevaluable condition
      // does not reduce. The opposite-direction twin of unknown-as-zero.
      indeterminate.push({ mitigantRef: m.mitigantRef, reason: "conditions not evaluable" });
      continue;
    }
    if (!m.conditionsSatisfied) {
      inadmissible.push({ mitigantRef: m.mitigantRef, reason: "conditions not satisfied" });
      continue;
    }
    admitted.push(m.mitigantRef);
    net -= m.amountMinor;
  }
  return { exposureGrossMinor: grossMinor, exposureNetMinor: net, admitted, indeterminate, inadmissible };
}

// ── §16.4 · the coverage-semantics limit test ───────────────────────────────

export type CreditLimitOutcome =
  | { readonly outcome: "exceeded"; readonly publishable: "credit.limit.exceeded" }
  | { readonly outcome: "within-limit"; readonly publishable: null } // no within event EXISTS
  | {
      readonly outcome: "indeterminate";
      readonly missingClasses: readonly ObligationClass[];
      readonly publishable: null;
    };

export function testCreditLimit(exposure: ExposureResult, limitMinor: bigint): CreditLimitOutcome {
  if (exposure.knownFloorMinor > limitMinor) {
    // Assertible even when partial: adding the unseen cannot bring the floor
    // back under the limit.
    return { outcome: "exceeded", publishable: "credit.limit.exceeded" };
  }
  if (exposure.state === "determinate") {
    return { outcome: "within-limit", publishable: null };
  }
  // Partial evidence can never prove compliance — the missing parts are
  // unbounded above. "I computed 60% of the exposure and it fits" reports
  // the absence of data as the absence of risk.
  return {
    outcome: "indeterminate",
    missingClasses: exposure.coverage.filter((c) => c.coverage !== "complete").map((c) => c.class),
    publishable: null,
  };
}

/** Utilisation over an indeterminate exposure is undefined, never 0. */
export type DefinedRatio =
  | { readonly defined: true; readonly numeratorMinor: bigint; readonly denominatorMinor: bigint }
  | { readonly defined: false; readonly reason: string };

export function utilisation(exposure: ExposureResult, limitMinor: bigint): DefinedRatio {
  if (exposure.state !== "determinate") return { defined: false, reason: "numerator-indeterminate" };
  if (limitMinor === 0n) return { defined: false, reason: "zero-denominator" };
  return { defined: true, numeratorMinor: exposure.knownFloorMinor, denominatorMinor: limitMinor };
}

/** A hold criterion over an indeterminate utilisation is indeterminate,
 * never not-met (§37 T-04). */
export function holdCriterionUtilisationAbove(
  ratio: DefinedRatio,
  thresholdPermille: bigint,
): "met" | "not-met" | "indeterminate" {
  if (!ratio.defined) return "indeterminate";
  return ratio.numeratorMinor * 1000n > ratio.denominatorMinor * thresholdPermille ? "met" : "not-met";
}

// ── §16.5 · limit derivation ────────────────────────────────────────────────

export interface LimitRule {
  readonly ruleId: string;
  readonly precedence: number; // declared; equal precedence on overlap is unresolvable
  readonly requiredEvidenceRefs: readonly string[];
  readonly proposedMinor: bigint;
  readonly ceilingMinor: bigint;
}

export interface ProposedCreditLimit {
  readonly amountMinor: bigint;
  readonly ruleId: string;
  readonly ceilingApplied: boolean;
  readonly expiresAt?: string;
  readonly temporaryReason?: string;
}

export function deriveLimit(
  applicableRules: readonly LimitRule[],
  availableEvidenceRefs: ReadonlySet<string>,
  temporary?: { expiresAt: string; temporaryReason?: string },
): Result<ProposedCreditLimit | { readonly noProposal: true; readonly reasons: readonly string[] }> {
  const M = CREDIT_METHODS.limitDerive;
  if (temporary !== undefined && temporary.temporaryReason === undefined) {
    return refuse("temporary_limit_without_reason", M, "expiresAt without temporaryReason is refused — the grant discipline, same reason.");
  }
  const evaluable = applicableRules.filter((r) => r.requiredEvidenceRefs.every((e) => availableEvidenceRefs.has(e)));
  if (evaluable.length === 0) {
    // A rule whose evidence is absent yields NO proposal; it does not fall back.
    return ok({ noProposal: true, reasons: applicableRules.map((r) => `${r.ruleId}: evidence absent`) });
  }
  const topPrecedence = Math.max(...evaluable.map((r) => r.precedence));
  const winners = evaluable.filter((r) => r.precedence === topPrecedence);
  if (winners.length > 1) {
    // Silent first-match is how two rules become one undocumented rule.
    return refuse("limit_rule_overlap_unresolvable", M, `Rules ${winners.map((r) => r.ruleId).join(", ")} share precedence ${topPrecedence}.`);
  }
  const rule = winners[0]!;
  const capped = rule.proposedMinor > rule.ceilingMinor;
  return ok({
    amountMinor: capped ? rule.ceilingMinor : rule.proposedMinor,
    ruleId: rule.ruleId,
    // The cap is part of the explanation and — where the request was for
    // more — part of the adverse-action reason set (a counteroffer is
    // adverse action unless accepted, §1002.2(c)).
    ceilingApplied: capped,
    ...(temporary !== undefined ? { expiresAt: temporary.expiresAt, temporaryReason: temporary.temporaryReason } : {}),
  });
}

// ── §16.6 · payment behaviour caveats as computation ────────────────────────

export interface BehaviourMeasure {
  readonly daysBeyondTermsTimes100: bigint;
  readonly disputeAdjusted: boolean;
  /** Prepaid history evidences nothing about credit risk; counting it as
   * good behaviour rewards never having been trusted. */
  readonly evidentialValue: "normal" | "none-terms-not-extended";
}

export function behaviourMeasure(
  daysBeyondTermsTimes100: bigint,
  disputeFlagBound: boolean,
  termsWereExtended: boolean,
): BehaviourMeasure {
  return {
    daysBeyondTermsTimes100,
    // With the flag unbound only the unadjusted figure exists, and it is
    // LABELLED — an unadjusted DBT overstates delinquency; the honest
    // response is a labelled figure, not a corrected guess.
    disputeAdjusted: disputeFlagBound,
    evidentialValue: termsWereExtended ? "normal" : "none-terms-not-extended",
  };
}

// ── §16.7 · adverse action: the hard gate ───────────────────────────────────

export type DecisionRegime =
  | "us-consumer-ecoa-regb"
  | "us-business-small-ecoa-regb"
  | "us-business-large-or-trade-credit"
  | "declared-out-of-scope";

export function declareRegime(
  regime: DecisionRegime | undefined,
  outOfScopeAssertion?: { assertedBy: string; writtenBasis: string },
): Result<{ regime: DecisionRegime; obligations: "reasons-owed" | "none-asserted" }> {
  const M = CREDIT_METHODS.regime;
  if (regime === undefined) {
    // No default, no inference, no "unknown" that proceeds. ECOA does not
    // stop at the consumer boundary: it reaches trade credit; what changes
    // is the form and timing of notice, not whether reasons are owed.
    return refuse("regime_not_declared", M, "DecisionRegime is a required argument on every assessment request.");
  }
  if (regime === "declared-out-of-scope") {
    if (
      outOfScopeAssertion === undefined ||
      !outOfScopeAssertion.assertedBy.startsWith("human.") ||
      outOfScopeAssertion.writtenBasis.trim() === ""
    ) {
      return refuse("out_of_scope_assertion_unattributed", M, "Out-of-scope is an assertion — recorded, attributable, by a human with a written basis — not a default.");
    }
    return ok({ regime, obligations: "none-asserted" });
  }
  return ok({ regime, obligations: "reasons-owed" });
}

export interface FactorContribution {
  readonly factorId: string;
  readonly contribution: bigint; // signed, exact
  readonly evidenceRefs: readonly string[];
  readonly plainLanguage: string;
}

export interface ScoreDecomposition {
  readonly baseline: bigint;
  readonly contributions: readonly FactorContribution[];
  readonly score: bigint;
}

export interface ScoringMethodDescriptor {
  readonly methodId: string;
  readonly reasonBasis: "deterministic-decomposition" | "none";
}

/** Method selection refuses when the regime carries obligations and the
 * method cannot decompose — expressed at selection so it cannot be bypassed
 * at rendering time. */
export function selectMethod(
  regimeObligations: "reasons-owed" | "none-asserted",
  descriptor: ScoringMethodDescriptor,
): Result<ScoringMethodDescriptor> {
  const M = CREDIT_METHODS.reasons;
  if (regimeObligations === "reasons-owed" && descriptor.reasonBasis === "none") {
    return refuse(
      "reasons_not_extractable_for_regime",
      M,
      `${descriptor.methodId} cannot produce a reconciling decomposition; it is not usable for a decision in a regime with adverse-action obligations.`,
    );
  }
  return ok(descriptor);
}

/** Reasons derive ONLY from a decomposition that reconciles exactly:
 * baseline + Σ contributions == score. Ordered by adverse magnitude; FCRA
 * caps key factors at four, with inquiries exempt from the cap. */
export function deriveReasons(
  decomposition: ScoreDecomposition,
  fcraCap: boolean,
  inquiryFactorIds: ReadonlySet<string>,
): Result<readonly FactorContribution[]> {
  const M = CREDIT_METHODS.reasons;
  const sum = decomposition.contributions.reduce((a, c) => a + c.contribution, 0n);
  if (decomposition.baseline + sum !== decomposition.score) {
    // A reason set that does not reconcile to the arithmetic that produced
    // the outcome is a post-hoc narrative, not an explanation.
    return refuse(
      "decomposition_does_not_reconcile",
      M,
      `baseline ${decomposition.baseline} + Σ ${sum} != score ${decomposition.score}.`,
    );
  }
  const adverse = decomposition.contributions
    .filter((c) => c.contribution < 0n)
    .sort((a, b) => (a.contribution !== b.contribution ? (a.contribution < b.contribution ? -1 : 1) : a.factorId < b.factorId ? -1 : 1));
  if (!fcraCap) return ok(adverse);
  const nonInquiry = adverse.filter((c) => !inquiryFactorIds.has(c.factorId)).slice(0, 4);
  const inquiries = adverse.filter((c) => inquiryFactorIds.has(c.factorId)); // exempt from the cap
  return ok([...nonInquiry, ...inquiries]);
}

// ── §16.8 · FCRA permissible purpose bound to Governance purpose ────────────

export function checkPermissiblePurpose(
  reportPurpose: string,
  assessmentGovernancePurpose: string,
): Result<{ purposeMatched: true }> {
  const M = CREDIT_METHODS.regime;
  if (reportPurpose !== assessmentGovernancePurpose) {
    // Consuming a report for a purpose other than the one it was obtained
    // for is the §1681b defect one layer along.
    return refuse("permissible_purpose_mismatch", M, `Report obtained for "${reportPurpose}"; assessment purpose is "${assessmentGovernancePurpose}".`);
  }
  return ok({ purposeMatched: true });
}
