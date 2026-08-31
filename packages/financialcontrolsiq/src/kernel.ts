// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// FinancialControlsIQ kernel — §16. Design and operating effectiveness are
// SEPARATE methods on purpose: a well-designed control operated badly and a
// badly-designed control operated perfectly are different findings with
// different remediations. 100% population coverage is NOT stronger assurance
// than a sample if the population is unattested — coverage and precision
// are different axes, and the type system says so. SoD "clean" is
// unconstructable: the strongest verdict is no-conflicts-in-evaluated-scope.
// A threshold may not be a literal in a rule: its basis is a closed union
// with no "guessed", and a provisional threshold past expiry FAILS TO LOAD.
// A deficiency candidate carries no severity — severity is a human
// judgement over visible inputs. A noisy rule is flagged and never
// disabled: turning off a control is a control-relevant event requiring
// authorization, and an engine that can switch off its own controls has
// done, in miniature, the thing sentinel-neutralization prevents.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const CONTROLS_METHODS = {
  design: method("evaluateDesignEffectiveness"),
  operating: method("evaluateOperatingEffectiveness"),
  sample: method("deriveSampleSize"),
  sod: method("evaluateSegregationOfDuties"),
  deficiency: method("computeDeficiencyCandidate"),
  precision: method("computeRulePrecision"),
  coverage: method("computeControlCoverage"),
  threshold: method("threshold.load"),
  budget: method("exceptionBudget.evaluate"),
} as const satisfies Record<string, MethodRef>;

export const CONTROLS_REFUSAL_KINDS = [
  "sample_expected_exceeds_tolerable",
  "rule-unloadable: threshold-expired",
  "threshold_basis_missing",
  "rule_references_missing_fact",
] as const;
export type ControlsRefusalKind = (typeof CONTROLS_REFUSAL_KINDS)[number];

export interface ControlsRefusal {
  readonly kind: ControlsRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ControlsRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ControlsRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── M-1 · design effectiveness: does the response address the risk? ─────────

export interface ControlDefinition {
  readonly controlId: string;
  readonly riskStatement: string;
  readonly claimedAssertions: readonly string[];
  readonly addressedAssertions: readonly string[];
}

export type DesignVerdict =
  | { readonly verdict: "effective" }
  | { readonly verdict: "deficient"; readonly unmetAssertions: readonly string[] }
  | { readonly verdict: "indeterminate"; readonly reason: string };

export function evaluateDesignEffectiveness(definition: ControlDefinition): DesignVerdict {
  if (definition.riskStatement.trim() === "") {
    return { verdict: "indeterminate", reason: "no risk statement: design effectiveness is relative to a stated risk" };
  }
  const unmet = definition.claimedAssertions.filter((a) => !definition.addressedAssertions.includes(a));
  return unmet.length > 0 ? { verdict: "deficient", unmetAssertions: unmet } : { verdict: "effective" };
}

// ── M-2 · operating effectiveness: separate, and gated on the population ────

export interface OperatingTestInputs {
  readonly populationCompleteness: "attested" | "unattested";
  readonly testedCount: number;
  readonly deviationCount: number;
  readonly tolerableRatePermille: bigint;
  readonly itgcRelianceClaimed: boolean;
  readonly itgcTestResultRef: string | null;
}

export type OperatingVerdict =
  | { readonly verdict: "effective" }
  | { readonly verdict: "deficient"; readonly deviationRatePermille: bigint }
  | { readonly verdict: "indeterminate"; readonly reason: string };

export function evaluateOperatingEffectiveness(inputs: OperatingTestInputs): OperatingVerdict {
  if (inputs.populationCompleteness === "unattested") {
    // A continuous-population test over an unattested population CANNOT
    // return effective: a sample of 25 from an attested population is worth
    // more than 100% of an unattested one.
    return { verdict: "indeterminate", reason: "population-unattested" };
  }
  if (inputs.itgcRelianceClaimed && inputs.itgcTestResultRef === null) {
    return { verdict: "indeterminate", reason: "itgc-reliance-unsubstantiated" };
  }
  if (inputs.testedCount === 0) {
    return { verdict: "indeterminate", reason: "zero-evidence" };
  }
  const rate = (BigInt(inputs.deviationCount) * 1000n) / BigInt(inputs.testedCount);
  return rate > inputs.tolerableRatePermille ? { verdict: "deficient", deviationRatePermille: rate } : { verdict: "effective" };
}

// ── M-4 · sample size: required drivers, no defaults ────────────────────────

export interface SampleBasis {
  readonly sampleSize: number;
  readonly approach: "statistical" | "test-100-percent";
  readonly drivers: { tolerablePermille: bigint; expectedPermille: bigint; confidencePermille: number };
}

const CONFIDENCE_FACTORS: Readonly<Record<number, bigint>> = { 900: 2_303n, 950: 2_996n, 990: 4_605n };

export function deriveSampleSize(
  tolerablePermille: bigint,
  expectedPermille: bigint,
  confidencePermille: 900 | 950 | 990,
  populationSize: number,
): Result<SampleBasis> {
  const M = CONTROLS_METHODS.sample;
  if (expectedPermille >= tolerablePermille) {
    // No sample size can support the conclusion.
    return refuse("sample_expected_exceeds_tolerable", M, `Expected deviation ${expectedPermille}‰ >= tolerable ${tolerablePermille}‰: testing cannot conclude effectiveness.`);
  }
  const factor = CONFIDENCE_FACTORS[confidencePermille]!;
  const size = Number((factor + (tolerablePermille - expectedPermille) - 1n) / (tolerablePermille - expectedPermille));
  if (populationSize <= size) {
    return ok({ sampleSize: populationSize, approach: "test-100-percent", drivers: { tolerablePermille, expectedPermille, confidencePermille } });
  }
  return ok({ sampleSize: size, approach: "statistical", drivers: { tolerablePermille, expectedPermille, confidencePermille } });
}

// ── M-6 · segregation of duties: clean is unconstructable ───────────────────

export type SodEvaluation =
  | { readonly verdict: "conflicts-found"; readonly conflicts: readonly { principalRef: string; conflictingDuties: readonly [string, string] }[] }
  | {
      /** The STRONGEST positive verdict: scoped to what was evaluated.
       * A "clean" that asserts the absence of unevaluated conflicts does not
       * exist as a constructor. */
      readonly verdict: "no-conflicts-in-evaluated-scope";
      readonly evaluatedPrincipalCount: number;
    }
  | { readonly verdict: "indeterminate"; readonly reason: "identity-port-unbound" | "duty-mapping-incomplete" };

export function evaluateSegregationOfDuties(
  conflictPairs: readonly (readonly [string, string])[],
  assignments: ReadonlyMap<string, readonly string[]> | undefined,
  dutyMappingComplete: boolean,
): SodEvaluation {
  if (assignments === undefined) return { verdict: "indeterminate", reason: "identity-port-unbound" };
  if (!dutyMappingComplete) return { verdict: "indeterminate", reason: "duty-mapping-incomplete" };
  const conflicts: { principalRef: string; conflictingDuties: readonly [string, string] }[] = [];
  for (const [principalRef, duties] of assignments) {
    for (const [a, b] of conflictPairs) {
      if (duties.includes(a) && duties.includes(b)) conflicts.push({ principalRef, conflictingDuties: [a, b] });
    }
  }
  return conflicts.length > 0
    ? { verdict: "conflicts-found", conflicts }
    : { verdict: "no-conflicts-in-evaluated-scope", evaluatedPrincipalCount: assignments.size };
}

// ── §16.6 · thresholds: evidenced or unloadable ─────────────────────────────

export type ThresholdBasis =
  | { readonly kind: "policy-document"; readonly documentRef: string; readonly approvedBy: string }
  | { readonly kind: "statutory"; readonly citation: string }
  | { readonly kind: "calibrated"; readonly calibrationRunRef: string; readonly adjudicatedCount: number }
  | { readonly kind: "provisional"; readonly expiresAt: string; readonly ownerRef: string; readonly rationale: string };

export function loadThreshold(
  ruleId: string,
  valueMinor: bigint,
  basis: ThresholdBasis | undefined,
  asOf: string,
): Result<{ ruleId: string; valueMinor: bigint; basis: ThresholdBasis }> {
  const M = CONTROLS_METHODS.threshold;
  if (basis === undefined) {
    // There is no basis "guessed" and no unlabelled threshold — almost every
    // unusable CCM rule is unusable because somebody picked a number.
    return refuse("threshold_basis_missing", M, `${ruleId}: a threshold may not be a literal in a rule; its basis is required.`);
  }
  if (basis.kind === "provisional" && basis.expiresAt < asOf) {
    // The exit condition AWAITING_HUMAN_AUTHORIZATION was missing, applied
    // where it is actually needed: the rule version will not construct.
    return refuse("rule-unloadable: threshold-expired", M, `${ruleId}: provisional threshold expired ${basis.expiresAt}; owner ${basis.ownerRef}.`);
  }
  return ok({ ruleId, valueMinor, basis });
}

// ── M-5 · exception detection: missing facts refuse, never empty ────────────

export function detectExceptions(
  ruleRequiredFacts: readonly string[],
  populationFacts: ReadonlySet<string>,
  test: () => readonly string[],
): Result<readonly string[]> {
  const M = CONTROLS_METHODS.operating;
  const missing = ruleRequiredFacts.filter((f) => !populationFacts.has(f));
  if (missing.length > 0) {
    // NEVER an empty result: an empty result reads as "no exceptions", which
    // is a conclusion the data cannot support.
    return refuse("rule_references_missing_fact", M, `Population lacks facts the rule reads: ${missing.join(", ")}.`);
  }
  return ok(test());
}

// ── M-8 · deficiency candidate: all inputs visible, NO severity ─────────────

export interface DeficiencyCandidate {
  readonly controlId: string;
  readonly deviationRatePermille: bigint;
  readonly tolerableRatePermille: bigint;
  readonly exposureMagnitudeMinor: bigint;
  /** An untested compensating control contributes nothing — recorded as
   * compensating-untested, never as mitigation. */
  readonly compensatingControls: readonly { controlId: string; state: "tested-effective" | "tested-deficient" | "compensating-untested" }[];
  /** The four AS 2201 .69 indicators, as recorded flags with a named source
   * — asserted by someone, never inferred. */
  readonly materialWeaknessIndicators: readonly { indicator: string; assertedBy: string }[];
  // deliberately NO severity field — a human judges over visible inputs
}

export function computeDeficiencyCandidate(
  controlId: string,
  deviationRatePermille: bigint,
  tolerableRatePermille: bigint,
  exposureMagnitudeMinor: bigint,
  compensating: readonly { controlId: string; tested: boolean; effective: boolean | null }[],
  indicators: readonly { indicator: string; assertedBy: string }[],
): DeficiencyCandidate {
  return {
    controlId,
    deviationRatePermille,
    tolerableRatePermille,
    exposureMagnitudeMinor,
    compensatingControls: compensating.map((c) => ({
      controlId: c.controlId,
      state: !c.tested ? "compensating-untested" : c.effective === true ? "tested-effective" : "tested-deficient",
    })),
    materialWeaknessIndicators: indicators,
  };
}

// ── M-9 / M-10 · precision intervals and coverage counts ────────────────────

export interface RulePrecision {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly unadjudicated: number;
  /** ABSENT below the minimum adjudicated count — never 0 and never 1. */
  readonly precisionIntervalPermille: { lo: number; hi: number } | null;
}

export function computeRulePrecision(
  truePositives: number,
  falsePositives: number,
  unadjudicated: number,
  minimumAdjudicated: number,
): RulePrecision {
  const adjudicated = truePositives + falsePositives;
  if (adjudicated < minimumAdjudicated) {
    return { truePositives, falsePositives, unadjudicated, precisionIntervalPermille: null };
  }
  const point = Math.floor((truePositives * 1000) / adjudicated);
  const halfWidth = Math.floor(1000 / Math.sqrt(adjudicated));
  return {
    truePositives,
    falsePositives,
    unadjudicated,
    precisionIntervalPermille: { lo: Math.max(0, point - halfWidth), hi: Math.min(1000, point + halfWidth) },
  };
}

/** Three counts, never a single percentage; undesignated never folded. */
export interface ControlCoverage {
  readonly tested: number;
  readonly untested: number;
  readonly undesignated: number;
}

export function computeControlCoverage(
  controls: readonly { controlId: string; designation: "key" | "non-key" | null; tested: boolean }[],
): ControlCoverage {
  let tested = 0;
  let untested = 0;
  let undesignated = 0;
  for (const c of controls) {
    if (c.designation === null) undesignated += 1;
    else if (c.tested) tested += 1;
    else untested += 1;
  }
  return { tested, untested, undesignated };
}

// ── §16.9 · exception budgets: flagged, never suppressed, never disabled ────

export interface BudgetEvaluation {
  readonly budgetPerThousand: number;
  readonly actualCount: number;
  readonly budgetExceeded: boolean;
  /** ALL exceptions are still emitted; none is suppressed. */
  readonly exceptionsEmitted: number;
  readonly eventEmitted: "control.rule.over_budget" | null;
  /** The engine NEVER disables the rule: turning off a control is a
   * control-relevant event requiring authorization — retiring a rule is an
   * APPROVE-rung act with a named human. */
  readonly ruleDisabled: false;
}

export function evaluateExceptionBudget(
  budgetPerThousand: number,
  populationSize: number,
  actualExceptionCount: number,
  exceedFactor: number,
): BudgetEvaluation {
  const budgetCount = Math.ceil((budgetPerThousand * populationSize) / 1000);
  const exceeded = actualExceptionCount > budgetCount * exceedFactor;
  return {
    budgetPerThousand,
    actualCount: actualExceptionCount,
    budgetExceeded: exceeded,
    exceptionsEmitted: actualExceptionCount,
    eventEmitted: exceeded ? "control.rule.over_budget" : null,
    ruleDisabled: false,
  };
}
