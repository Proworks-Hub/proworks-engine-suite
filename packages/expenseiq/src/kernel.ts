// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// ExpenseIQ kernel — §16. Policy is DATA over a closed rule vocabulary; the
// kernel knows threshold, effectiveFrom, jurisdiction and citation, and
// nothing else — no US-specific identifier appears here (the
// multi-jurisdiction proof, §16.9). Evaluation is TOTAL (no short-circuit),
// a rule never reads another rule's outcome, and a missing required input is
// UNDETERMINABLE — never pass — with undeterminable outranking every other
// verdict class: a claim we cannot evaluate must not be reported compliant
// OR as a violation of the person. Card matching ranks ordinally and never
// scores; a personal-charge candidate carries reply paths, not a verdict.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const EXPENSE_METHODS = {
  ruleDefinition: method("policy.rule-definition"),
  evaluate: method("policy.evaluate"),
  reimbursable: method("policy.reimbursable-amount"),
  perDiem: method("perdiem.entitlement"),
  mileage: method("mileage.entitlement"),
  cardMatch: method("cardmatch.match-lines"),
  personalCharge: method("cardmatch.personal-charge-candidate"),
  coding: method("coding.derive"),
} as const satisfies Record<string, MethodRef>;

export const EXPENSE_REFUSAL_KINDS = [
  "rule_registration_invalid",
  "no_mapping",
  "unit_system_mismatch",
] as const;
export type ExpenseRefusalKind = (typeof EXPENSE_REFUSAL_KINDS)[number];

export interface ExpenseRefusal {
  readonly kind: ExpenseRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ExpenseRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ExpenseRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.1 · the rule as data, validated at registration ─────────────────────

export type RuleSeverity = "advisory" | "reviewable" | "blocking";

export interface PolicyRuleDefinition {
  readonly ruleId: string;
  readonly semanticVersion: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly jurisdictionCurrency: string;
  readonly thresholdCurrency?: string;
  readonly aggregateWindowDays?: number;
  readonly isAggregateCeiling: boolean;
  readonly severity: RuleSeverity;
  /** The policy document the verdict will cite, by value. */
  readonly citation: { documentId: string; version: string; paragraph: string };
  /** NAMED required inputs — read by undeterminable reporting. */
  readonly requiredInputs: readonly string[];
  /** The rule body. Receives the line and its inputs — NEVER the accumulator
   * of other rules' outcomes. */
  readonly test: (inputs: ReadonlyMap<string, bigint>) => { pass: boolean; observed: string; threshold: string };
}

/** Registration-time validation: a bad rule is rejected before it can ever
 * evaluate — the pattern PayablesIQ established for day-limit sets. */
export function registerRule(rule: PolicyRuleDefinition): Result<PolicyRuleDefinition> {
  const M = EXPENSE_METHODS.ruleDefinition;
  if (rule.effectiveTo !== undefined && rule.effectiveTo < rule.effectiveFrom) {
    return refuse("rule_registration_invalid", M, `${rule.ruleId}: effectiveTo ${rule.effectiveTo} precedes effectiveFrom ${rule.effectiveFrom}.`);
  }
  if (rule.thresholdCurrency !== undefined && rule.thresholdCurrency !== rule.jurisdictionCurrency) {
    return refuse(
      "rule_registration_invalid",
      M,
      `${rule.ruleId}: threshold currency ${rule.thresholdCurrency} differs from the jurisdiction's ${rule.jurisdictionCurrency}.`,
    );
  }
  if (rule.isAggregateCeiling && rule.aggregateWindowDays === undefined) {
    return refuse("rule_registration_invalid", M, `${rule.ruleId}: an aggregate ceiling with no declared window is unevaluable.`);
  }
  return ok(rule);
}

// ── §16.2 · the evaluation kernel ───────────────────────────────────────────

export type RuleEvaluation =
  | { readonly outcome: "pass"; readonly ruleId: string; readonly observed: string; readonly threshold: string }
  | {
      readonly outcome: "fail";
      readonly ruleId: string;
      readonly observed: string;
      readonly threshold: string;
      readonly severity: RuleSeverity;
      /** Every fail carries the rule's citation by value. */
      readonly citation: PolicyRuleDefinition["citation"];
    }
  | { readonly outcome: "not-applicable"; readonly ruleId: string; readonly reason: string }
  | { readonly outcome: "undeterminable"; readonly ruleId: string; readonly missing: readonly string[] };

export type VerdictClass =
  | "in-policy"
  | "out-of-policy-advisory"
  | "out-of-policy-reviewable"
  | "out-of-policy-blocking"
  | "undeterminable";

export interface PolicyEvaluationResult {
  readonly evaluations: readonly RuleEvaluation[];
  readonly verdictClass: VerdictClass;
  readonly methodRef: MethodRef;
}

export function evaluatePolicy(
  rules: readonly PolicyRuleDefinition[],
  applicable: (rule: PolicyRuleDefinition) => boolean,
  inputs: ReadonlyMap<string, bigint>,
): PolicyEvaluationResult {
  // Deterministic order: (ruleId, semanticVersion) lexicographic — ordering
  // affects presentation only, never the verdict class.
  const ordered = [...rules].sort((a, b) =>
    a.ruleId !== b.ruleId ? (a.ruleId < b.ruleId ? -1 : 1) : a.semanticVersion < b.semanticVersion ? -1 : 1,
  );
  // TOTAL: every applicable rule is evaluated — no early return on a fail.
  const evaluations: RuleEvaluation[] = ordered.map((rule): RuleEvaluation => {
    if (!applicable(rule)) return { outcome: "not-applicable", ruleId: rule.ruleId, reason: "outside applicability" };
    // The required-input pre-check runs BEFORE the rule body, so a rule
    // author cannot accidentally treat undefined as zero.
    const missing = rule.requiredInputs.filter((name) => !inputs.has(name));
    if (missing.length > 0) return { outcome: "undeterminable", ruleId: rule.ruleId, missing };
    const r = rule.test(inputs);
    return r.pass
      ? { outcome: "pass", ruleId: rule.ruleId, observed: r.observed, threshold: r.threshold }
      : {
          outcome: "fail",
          ruleId: rule.ruleId,
          observed: r.observed,
          threshold: r.threshold,
          severity: rule.severity,
          citation: rule.citation,
        };
  });
  return { evaluations, verdictClass: composeVerdict(evaluations), methodRef: EXPENSE_METHODS.evaluate };
}

/** Verdict composition: undeterminable OUTRANKS everything, then blocking >
 * reviewable > advisory > in-policy. */
export function composeVerdict(evaluations: readonly RuleEvaluation[]): VerdictClass {
  if (evaluations.some((e) => e.outcome === "undeterminable")) return "undeterminable";
  const fails = evaluations.filter((e): e is Extract<RuleEvaluation, { outcome: "fail" }> => e.outcome === "fail");
  if (fails.some((f) => f.severity === "blocking")) return "out-of-policy-blocking";
  if (fails.some((f) => f.severity === "reviewable")) return "out-of-policy-reviewable";
  if (fails.length > 0) return "out-of-policy-advisory";
  return "in-policy";
}

// ── §16.3 · reimbursable amount: no amount over a blocking or unknown claim ─

export type ReimbursableOutcome =
  | { readonly state: "payable"; readonly amountMinor: bigint; readonly cappedByRuleId: string | null }
  | { readonly state: "provisional"; readonly amountMinor: bigint; readonly pendingReview: true }
  | { readonly state: "no-amount"; readonly reason: "blocking-verdict" | "undeterminable"; readonly missing: readonly string[] };

export function reimbursableAmount(
  claimedMinor: bigint,
  verdict: PolicyEvaluationResult,
  ceilings: readonly { ruleId: string; ceilingMinor: bigint }[],
): ReimbursableOutcome {
  if (verdict.verdictClass === "out-of-policy-blocking") {
    // The field is ABSENT, not zero: zero is an amount, and this is not one.
    return { state: "no-amount", reason: "blocking-verdict", missing: [] };
  }
  if (verdict.verdictClass === "undeterminable") {
    const missing = verdict.evaluations.flatMap((e) => (e.outcome === "undeterminable" ? e.missing : []));
    return { state: "no-amount", reason: "undeterminable", missing };
  }
  // The LOWEST applicable ceiling wins and the rule that supplied it is
  // recorded: "your dinner was capped" is only useful with "by rule X at Y".
  let amount = claimedMinor;
  let cappedBy: string | null = null;
  for (const c of ceilings) {
    if (c.ceilingMinor < amount) {
      amount = c.ceilingMinor;
      cappedBy = c.ruleId;
    }
  }
  return verdict.verdictClass === "out-of-policy-reviewable"
    ? { state: "provisional", amountMinor: amount, pendingReview: true }
    : { state: "payable", amountMinor: amount, cappedByRuleId: cappedBy };
}

// ── §16.4 · per diem: partial-day factor on M&IE only ───────────────────────

export interface PerDiemRateRef {
  readonly lodgingCeilingMinor: bigint;
  readonly mieTotalMinor: bigint;
  /** GSA-published per-meal breakdown; absent means provided-meal deductions
   * are undeterminable, never a guessed fraction. */
  readonly mieBreakdown: { breakfastMinor: bigint; lunchMinor: bigint; dinnerMinor: bigint } | null;
  /** The 0.75 first/last-day factor is DATA on the rate ref (permille), not a
   * constant in code — the same factor has a second trigger (12-24h travel). */
  readonly firstLastDayFactorPermille: bigint;
}

export type PerDiemDayResult =
  | { readonly state: "entitled"; readonly amountMinor: bigint }
  | { readonly state: "undeterminable"; readonly missing: string };

export function perDiemDayEntitlement(
  rateRef: PerDiemRateRef,
  day: {
    readonly actualLodgingMinor: bigint;
    readonly isFirstOrLast: boolean;
    readonly providedMeals: readonly ("breakfast" | "lunch" | "dinner")[];
  },
): PerDiemDayResult {
  if (day.providedMeals.length > 0 && rateRef.mieBreakdown === null) {
    return { state: "undeterminable", missing: "rate ref carries no M&IE breakdown; a guessed deduction fraction is not made" };
  }
  const lodging =
    day.actualLodgingMinor < rateRef.lodgingCeilingMinor ? day.actualLodgingMinor : rateRef.lodgingCeilingMinor;
  let mie = rateRef.mieTotalMinor;
  for (const meal of day.providedMeals) {
    const b = rateRef.mieBreakdown!;
    mie -= meal === "breakfast" ? b.breakfastMinor : meal === "lunch" ? b.lunchMinor : b.dinnerMinor;
  }
  // The partial-day factor applies to M&IE ONLY, never lodging — applying it
  // to lodging is the common and expensive error. ONE rounding, half-up.
  const factor = day.isFirstOrLast ? rateRef.firstLastDayFactorPermille : 1000n;
  const mieFactored = (mie * factor + 500n) / 1000n;
  return { state: "entitled", amountMinor: lodging + mieFactored };
}

/** The actual-expense ceiling (300% of per diem) is a RULE, not a clamp:
 * exceeding it is a blocking fail, never a silent truncation. */
export function actualExpenseCeilingCheck(
  claimedMinor: bigint,
  perDiemRateMinor: bigint,
): { pass: boolean; observed: string; threshold: string } {
  const ceiling = perDiemRateMinor * 3n;
  return { pass: claimedMinor <= ceiling, observed: claimedMinor.toString(), threshold: `300% of per-diem = ${ceiling}` };
}

// ── §16.5 · mileage: the two traps ──────────────────────────────────────────

export interface MileageRatePeriod {
  readonly fromDate: string;
  readonly toDate: string;
  /** minor units per distance unit, e.g. cents per mile. */
  readonly ratePerUnitMinor: bigint;
  readonly unitSystem: "miles" | "kilometres";
}

export type MileageResult =
  | { readonly state: "entitled"; readonly amountMinor: bigint; readonly segments: readonly { fromDate: string; ratePerUnitMinor: bigint; distance: bigint }[] }
  | { readonly state: "undeterminable"; readonly missing: string };

/** Trap 1 — mid-year rate boundaries: each dated segment prices at its own
 * rate, each rounded once. A single blended rate over a boundary-spanning
 * trip is the injected failure. */
export function mileageEntitlement(
  segments: readonly { date: string; distance: bigint; unitSystem: "miles" | "kilometres" }[],
  ratePeriods: readonly MileageRatePeriod[],
): Result<MileageResult> {
  const M = EXPENSE_METHODS.mileage;
  let total = 0n;
  const priced: { fromDate: string; ratePerUnitMinor: bigint; distance: bigint }[] = [];
  for (const segment of segments) {
    const period = ratePeriods.find((p) => segment.date >= p.fromDate && segment.date <= p.toDate);
    if (period === undefined) {
      return ok({ state: "undeterminable", missing: `no rate period covers ${segment.date}` });
    }
    if (period.unitSystem !== segment.unitSystem) {
      // A kilometre distance cannot be multiplied by a per-mile rate.
      return refuse("unit_system_mismatch", M, `Segment on ${segment.date} is in ${segment.unitSystem}; the rate is per ${period.unitSystem}.`);
    }
    total += segment.distance * period.ratePerUnitMinor;
    priced.push({ fromDate: period.fromDate, ratePerUnitMinor: period.ratePerUnitMinor, distance: segment.distance });
  }
  return ok({ state: "entitled", amountMinor: total, segments: priced });
}

/**
 * Trap 2 — tiered cumulative bands (HMRC AMAP shape): the rate for THIS claim
 * depends on miles already claimed this tax year, which arrives as an
 * explicit snapshot, never a live query. Absent snapshot → undeterminable —
 * assuming zero pays the high rate on a mile that should be low, an error
 * that only appears for the heaviest travellers.
 */
export function tieredMileageEntitlement(
  claimDistance: bigint,
  tierBoundary: bigint,
  belowRateMinor: bigint,
  aboveRateMinor: bigint,
  yearToDate: { readonly milesToDate: bigint; readonly asOf: string } | undefined,
): MileageResult {
  if (yearToDate === undefined) {
    return { state: "undeterminable", missing: "MileageYearToDateSnapshot: the tier depends on miles already claimed, and zero is not a default" };
  }
  const startAt = yearToDate.milesToDate;
  const belowRemaining = tierBoundary > startAt ? tierBoundary - startAt : 0n;
  const belowMiles = claimDistance < belowRemaining ? claimDistance : belowRemaining;
  const aboveMiles = claimDistance - belowMiles;
  return {
    state: "entitled",
    amountMinor: belowMiles * belowRateMinor + aboveMiles * aboveRateMinor,
    segments: [
      { fromDate: yearToDate.asOf, ratePerUnitMinor: belowRateMinor, distance: belowMiles },
      { fromDate: yearToDate.asOf, ratePerUnitMinor: aboveRateMinor, distance: aboveMiles },
    ],
  };
}

// ── §16.6 · card matching: ordinal ranks, never a float score ───────────────

export interface CardCandidate {
  readonly transactionRef: string;
  readonly amountExact: boolean;
  readonly amountWithinTolerance: boolean;
  readonly dateExact: boolean;
  readonly dateWithinWindow: boolean;
  readonly merchantMatch: boolean;
}

export type CardMatchOutcome =
  | { readonly outcome: "matched"; readonly transactionRef: string; readonly rank: "R1" | "R2" | "R3" }
  | { readonly outcome: "ambiguous"; readonly candidates: readonly string[]; readonly rank: string }
  | { readonly outcome: "no-match" };

export function matchCardLine(
  candidates: readonly CardCandidate[],
  tenantSingleCandidateAutoMatch: boolean,
): CardMatchOutcome {
  const r1 = candidates.filter((c) => c.amountExact && c.dateExact && c.merchantMatch);
  if (r1.length === 1) return { outcome: "matched", transactionRef: r1[0]!.transactionRef, rank: "R1" };
  if (r1.length > 1) return { outcome: "ambiguous", candidates: r1.map((c) => c.transactionRef), rank: "R1" };
  const r2 = candidates.filter((c) => c.amountExact && c.dateWithinWindow && c.merchantMatch);
  if (r2.length === 1) return { outcome: "matched", transactionRef: r2[0]!.transactionRef, rank: "R2" };
  if (r2.length > 1) return { outcome: "ambiguous", candidates: r2.map((c) => c.transactionRef), rank: "R2" };
  const r3 = candidates.filter((c) => c.amountExact && c.dateWithinWindow && !c.merchantMatch);
  if (r3.length === 1 && tenantSingleCandidateAutoMatch) {
    return { outcome: "matched", transactionRef: r3[0]!.transactionRef, rank: "R3" };
  }
  if (r3.length >= 1) return { outcome: "ambiguous", candidates: r3.map((c) => c.transactionRef), rank: "R3" };
  // R4: amount within tolerance + exact date + merchant — ambiguous ALWAYS;
  // an auto-match here is the two-lunches-same-day failure.
  const r4 = candidates.filter((c) => c.amountWithinTolerance && c.dateExact && c.merchantMatch);
  if (r4.length >= 1) return { outcome: "ambiguous", candidates: r4.map((c) => c.transactionRef), rank: "R4" };
  // Amount alone at any rank is NEVER a match.
  return { outcome: "no-match" };
}

// ── §16.7 · the personal-charge candidate: not an accusation ────────────────

/** No verdict field; not assignable to a policy verdict; carries the reply
 * paths the host UI must render — a candidate with no reply path is an
 * accusation. Its event is its own, never expense.policy.violated. */
export interface PersonalChargeCandidate {
  readonly kind: "personal-charge-candidate";
  readonly transactionRef: string;
  readonly amountMinor: bigint;
  readonly unmatchedSinceDays: number;
  readonly resolutionPaths: readonly ["claim-as-business", "acknowledge-personal", "dispute-transaction"];
  readonly eventName: "expense.card.charge.unmatched";
  readonly methodRef: MethodRef;
}

export function personalChargeCandidate(
  transactionRef: string,
  amountMinor: bigint,
  unmatchedSinceDays: number,
): PersonalChargeCandidate {
  return {
    kind: "personal-charge-candidate",
    transactionRef,
    amountMinor,
    unmatchedSinceDays,
    resolutionPaths: ["claim-as-business", "acknowledge-personal", "dispute-transaction"],
    eventName: "expense.card.charge.unmatched",
    methodRef: EXPENSE_METHODS.personalCharge,
  };
}

// ── §16.8 · coding: a table lookup with an explicit refusal ─────────────────

export function deriveCoding(
  expenseTypeRef: string,
  jurisdiction: string,
  mappingTable: ReadonlyMap<string, string>,
): Result<{ accountRef: string; derivedFrom: string }> {
  const M = EXPENSE_METHODS.coding;
  const key = `${jurisdiction}:${expenseTypeRef}`;
  const accountRef = mappingTable.get(key);
  if (accountRef === undefined) {
    // Never a default account: a suspense-account default is how miscoded
    // spend becomes invisible.
    return refuse("no_mapping", M, `No account mapping for ${key}.`);
  }
  return ok({ accountRef, derivedFrom: key });
}
