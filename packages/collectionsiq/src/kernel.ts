// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// CollectionsIQ kernel — §16. An amount under an open, unanswered dispute is
// SUPPRESSED from dunning — scoped to the disputed portion only; the rest of
// the invoice stays collectable. A missing priority factor is never imputed
// zero: the score is partial with the factors named, or refused past the
// policy's tolerance. The dunning evaluator checks every exit condition at
// every step (the direct answer to the declared-and-never-read
// terminationConditions defect). Contact caps count outcome-unknown AGAINST
// the cap — the conservative direction protects the contacted party, not the
// collector's headroom (H-6). Quiet hours run on the CONTACTED PARTY's local
// clock; unknown timezone refuses for every time-bound channel. Action-
// outcome association carries causalClaim "none" as a literal, with the
// confounders enumerated — naming them is the method's actual product.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const COLLECTIONS_METHODS = {
  priority: method("collectionsiq.priority"),
  promiseOutcome: method("collectionsiq.promise.outcome"),
  dunning: method("collectionsiq.dunning.evaluate"),
  escalation: method("collectionsiq.escalation"),
  frequency: method("collectionsiq.contact.frequency"),
  quietHours: method("collectionsiq.contact.quiethours"),
  writeOff: method("collectionsiq.writeoff.candidate"),
  association: method("collectionsiq.effectiveness.association"),
} as const satisfies Record<string, MethodRef>;

export const COLLECTIONS_REFUSAL_KINDS = [
  "too_many_missing_factors",
  "escalation_requires_governance",
  "experiment_design_not_predating_actions",
] as const;
export type CollectionsRefusalKind = (typeof COLLECTIONS_REFUSAL_KINDS)[number];

export interface CollectionsRefusal {
  readonly kind: CollectionsRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CollectionsRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: CollectionsRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── M-1 · worklist priority: partial over imputed-zero, dispute suppression ─

export interface PrioritySubject {
  readonly subjectRef: string;
  readonly amountAtRiskMinor: bigint;
  readonly disputedPortionMinor: bigint;
  readonly factors: ReadonlyMap<string, bigint>; // normalised factor values by id
}

export interface PriorityRow {
  readonly subjectRef: string;
  readonly score: bigint;
  readonly scoreBasis: "complete" | "partial";
  readonly missingFactors: readonly string[];
  /** Dunning-suppressed portion — priority on this part reflects RESOLVING
   * the case, not chasing the money. */
  readonly suppressedFromDunningMinor: bigint;
  readonly collectableMinor: bigint;
  /** A rank is not an authority; nothing downstream may treat it as one. */
  readonly authority: "none";
}

export function prioritize(
  subject: PrioritySubject,
  policyFactorWeights: ReadonlyMap<string, bigint>,
  maxMissingFactors: number,
): Result<PriorityRow> {
  const M = COLLECTIONS_METHODS.priority;
  const missing: string[] = [];
  let score = 0n;
  for (const [factorId, weight] of policyFactorWeights) {
    const value = subject.factors.get(factorId);
    if (value === undefined) {
      // NOT imputed zero: the score goes partial with the factor named.
      missing.push(factorId);
      continue;
    }
    score += weight * value;
  }
  if (missing.length > maxMissingFactors) {
    return refuse("too_many_missing_factors", M, `${missing.length} of ${policyFactorWeights.size} factors missing (${missing.join(", ")}); policy tolerates ${maxMissingFactors}.`);
  }
  return ok({
    subjectRef: subject.subjectRef,
    score,
    scoreBasis: missing.length === 0 ? "complete" : "partial",
    missingFactors: missing,
    suppressedFromDunningMinor: subject.disputedPortionMinor,
    collectableMinor: subject.amountAtRiskMinor - subject.disputedPortionMinor,
    authority: "none",
  });
}

// ── M-3 · promise outcome and the honest keep-rate ──────────────────────────

export type PromiseOutcome = "kept" | "kept-late" | "partial" | "broken" | "void";
export type VoidReason = "superseded" | "subject-credited" | "scope-invalidated";

export function promiseOutcome(
  promisedMinor: bigint,
  promisedDate: string,
  graceDays: number,
  qualifyingPayments: readonly { amountMinor: bigint; date: string }[],
  asOf: string,
  voidReason?: VoidReason,
): { outcome: PromiseOutcome | "still-open"; voidReason?: VoidReason } {
  if (voidReason !== undefined) return { outcome: "void", voidReason };
  const graceEnd = addDays(promisedDate, graceDays);
  const paidByDate = qualifyingPayments.filter((p) => p.date <= promisedDate).reduce((a, p) => a + p.amountMinor, 0n);
  const paidByGrace = qualifyingPayments.filter((p) => p.date <= graceEnd).reduce((a, p) => a + p.amountMinor, 0n);
  if (paidByDate >= promisedMinor) return { outcome: "kept" };
  if (paidByGrace >= promisedMinor) return { outcome: "kept-late" };
  if (asOf <= graceEnd) return { outcome: "still-open" };
  return { outcome: paidByGrace > 0n ? "partial" : "broken" };
}

function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Never a bare percentage: folding partial/void/superseded into either side
 * is exactly how a keep-rate gets flattered, and every fold is defensible —
 * so the composition is stated and the reader chooses. */
export interface PromiseKeepRate {
  readonly kept: number;
  readonly keptLate: number;
  readonly partial: number;
  readonly broken: number;
  readonly void: number;
  readonly stillOpen: number;
  readonly barePercentage: null; // deliberately not computable from this type
}

export function keepRateComposition(outcomes: readonly (PromiseOutcome | "still-open")[]): PromiseKeepRate {
  const count = (o: PromiseOutcome | "still-open"): number => outcomes.filter((x) => x === o).length;
  return {
    kept: count("kept"),
    keptLate: count("kept-late"),
    partial: count("partial"),
    broken: count("broken"),
    void: count("void"),
    stillOpen: count("still-open"),
    barePercentage: null,
  };
}

// ── M-4 · dunning: every exit condition, every step ─────────────────────────

export interface DunningStep {
  readonly stepId: string;
  readonly offsetDays: number;
  readonly channelClass: string;
}

export interface DunningFacts {
  readonly settled: boolean; // E-1
  readonly openDisputeCoversAmount: boolean; // E-2 (scoped per M-1)
  readonly openPromiseCoversAmount: boolean; // E-3
  readonly permissionState: "permitted" | "cap-exhausted" | "quiet-hours" | "consent-withdrawn" | "cease"; // E-4
}

export type SequenceEvaluation =
  | { readonly state: "steps-due"; readonly dueSteps: readonly string[] }
  | { readonly state: "suspended-by-exit-condition"; readonly condition: "settled" | "disputed" | "promised" | "permission"; readonly dueSteps: readonly [] }
  | { readonly state: "halted-by-permission"; readonly terminal: true; readonly dueSteps: readonly [] }
  | { readonly state: "exhausted"; readonly humanReviewRequired: true; readonly dueSteps: readonly [] };

export function evaluateDunning(
  steps: readonly DunningStep[],
  stepsAlreadyFired: number,
  maxSteps: number,
  facts: DunningFacts,
  daysSinceAnchor: number,
): SequenceEvaluation {
  // The exit conditions are evaluated at EVERY step — a met condition yields
  // zero steps. This is the direct answer to the terminationConditions
  // defect: an exit condition with no reader is the defect this engine
  // exists to not repeat.
  if (facts.permissionState === "cease") return { state: "halted-by-permission", terminal: true, dueSteps: [] };
  if (facts.settled) return { state: "suspended-by-exit-condition", condition: "settled", dueSteps: [] };
  if (facts.openDisputeCoversAmount) return { state: "suspended-by-exit-condition", condition: "disputed", dueSteps: [] };
  if (facts.openPromiseCoversAmount) return { state: "suspended-by-exit-condition", condition: "promised", dueSteps: [] };
  if (facts.permissionState !== "permitted") return { state: "suspended-by-exit-condition", condition: "permission", dueSteps: [] };
  if (stepsAlreadyFired >= maxSteps) {
    // Exhausted is NOT terminal-and-forgotten: it lands on a human worklist.
    return { state: "exhausted", humanReviewRequired: true, dueSteps: [] };
  }
  const dueSteps = steps
    .slice(stepsAlreadyFired)
    .filter((s) => s.offsetDays <= daysSinceAnchor)
    .slice(0, maxSteps - stepsAlreadyFired)
    .map((s) => s.stepId);
  return { state: "steps-due", dueSteps };
}

// ── M-5 · escalation: external consequence requires Governance ──────────────

export interface EscalationRung {
  readonly rungId: string;
  readonly requiresGovernance: boolean;
  readonly requiresHumanPrincipal: boolean;
}

export function moveRung(
  rung: EscalationRung,
  governanceGranted: boolean | undefined,
  principal: string | undefined,
): Result<{ rungId: string; recordedAs: "journal-entry"; principal: string }> {
  const M = COLLECTIONS_METHODS.escalation;
  // Unconfigured Governance denies — the ladder fails CLOSED.
  if (rung.requiresGovernance && governanceGranted !== true) {
    return refuse("escalation_requires_governance", M, `Rung ${rung.rungId} has external consequence; the engine requests, a Governance decision permits. Unconfigured Governance denies.`);
  }
  if (rung.requiresHumanPrincipal && (principal === undefined || !principal.startsWith("human."))) {
    return refuse("escalation_requires_governance", M, `Rung ${rung.rungId} requires a human principal; a model output never moves a rung.`);
  }
  return ok({ rungId: rung.rungId, recordedAs: "journal-entry", principal: principal ?? "system.scheduler" });
}

// ── M-6 · contact frequency: unknown counts against the cap ─────────────────

export interface ContactRecord {
  readonly atDate: string;
  readonly channelClass: string;
  readonly direction: "outbound" | "inbound";
  readonly connectionOutcome: "connected-conversation" | "no-connect" | "outcome-unknown";
  readonly priorConsentWithinWindow: boolean;
}

export interface FrequencyVerdict {
  readonly countedAttempts: number;
  readonly capReached: boolean;
  /** Started by a CONVERSATION (either direction) — that is what the rule is
   * about. */
  readonly inPostConversationWindow: boolean;
}

export function evaluateFrequency(
  records: readonly ContactRecord[],
  proposedDate: string,
  windowDays: number,
  maxContactsInWindow: number,
  postConversationQuietDays: number,
): FrequencyVerdict {
  const windowStart = addDays(proposedDate, -windowDays);
  const counted = records.filter((r) => {
    if (r.direction === "inbound") return false; // inbound never counts against an outbound cap
    if (r.atDate <= windowStart || r.atDate > proposedDate) return false;
    if (r.connectionOutcome === "no-connect") return false; // excluded only on EVIDENCE
    if (r.priorConsentWithinWindow) return false;
    // outcome-unknown COUNTS: if the delivery outcome never arrived, the
    // engine does not get to assume the call did not connect (H-6).
    return true;
  }).length;
  const lastConversation = records
    .filter((r) => r.connectionOutcome === "connected-conversation")
    .map((r) => r.atDate)
    .sort()
    .pop();
  const inPostConversationWindow =
    lastConversation !== undefined && proposedDate <= addDays(lastConversation, postConversationQuietDays);
  return { countedAttempts: counted, capReached: counted >= maxContactsInWindow, inPostConversationWindow };
}

// ── M-7 · quiet hours: the contacted party's clock or nothing ───────────────

export type QuietHoursVerdict = "permitted" | "refused-quiet-hours" | "refused-unknown-locale";

export function evaluateQuietHours(
  obligorLocalHour: number | undefined,
  channelIsTimeBound: boolean,
  windowStartHour = 8,
  windowEndHour = 21,
): QuietHoursVerdict {
  if (!channelIsTimeBound) return "permitted";
  if (obligorLocalHour === undefined) {
    // Never the tenant's zone, never UTC, never "probably the billing
    // address country". The operational cost is real and the correct
    // response is to bind the locale port, not relax the rule.
    return "refused-unknown-locale";
  }
  return obligorLocalHour >= windowStartHour && obligorLocalHour < windowEndHour ? "permitted" : "refused-quiet-hours";
}

// ── M-8 · write-off candidacy: stated conditions, not a judgement ───────────

export interface WriteOffCandidate {
  readonly subjectRef: string;
  readonly basis: readonly string[];
  readonly authorizationRequired: true;
  /** NOT "this money will not be recovered" — LOCK-2 forbids that claim. */
  readonly collectabilityJudgement: "none";
}

export function writeOffCandidacy(
  subjectRef: string,
  conditions: { ageDays: number; ageThresholdDays: number; sequenceExhausted: boolean; uncontactable: boolean; amountMinor: bigint; pursuitCostThresholdMinor: bigint },
): WriteOffCandidate | null {
  const basis: string[] = [];
  if (conditions.ageDays > conditions.ageThresholdDays) basis.push(`age ${conditions.ageDays}d > ${conditions.ageThresholdDays}d`);
  if (conditions.sequenceExhausted) basis.push("dunning sequence exhausted");
  if (conditions.uncontactable) basis.push("uncontactable: cease with no alternative permitted channel");
  if (conditions.amountMinor < conditions.pursuitCostThresholdMinor) basis.push("amount below pursuit-cost threshold");
  if (basis.length === 0) return null;
  return { subjectRef, basis, authorizationRequired: true, collectabilityJudgement: "none" };
}

// ── M-9 · association: defined by what it refuses to claim ──────────────────

export const ASSOCIATION_CONFOUNDERS = [
  "base-rate: most invoices are paid without any collection action",
  "selection: collectors work the accounts they believe will respond",
  "correlated-severity: actions concentrate on large and old items",
  "multi-touch: no observational rule divides credit among several actions",
  "payer-cycle: the actual scheduler is the payer's AP run date, unobserved",
] as const;

export type AssociationResult =
  | {
      readonly causalClaim: "none";
      readonly paymentsInWindowMinor: bigint;
      readonly observationWindowDays: number;
      readonly confounders: typeof ASSOCIATION_CONFOUNDERS;
    }
  | {
      readonly causalClaim: "randomized-within-tenant";
      readonly betweenArmDifferenceMinor: bigint;
      readonly designRef: string;
    };

export function associateActionOutcome(
  paymentsInWindowMinor: bigint,
  observationWindowDays: number,
  experiment?: { readonly designRef: string; readonly designRecordedAt: string; readonly firstActionAt: string; readonly betweenArmDifferenceMinor: bigint },
): Result<AssociationResult> {
  const M = COLLECTIONS_METHODS.association;
  if (experiment !== undefined) {
    if (experiment.designRecordedAt >= experiment.firstActionAt) {
      // The design cannot be created retrospectively.
      return refuse("experiment_design_not_predating_actions", M, "A causal claim requires an assignment record predating the actions it evaluates.");
    }
    return ok({
      causalClaim: "randomized-within-tenant",
      betweenArmDifferenceMinor: experiment.betweenArmDifferenceMinor,
      designRef: experiment.designRef,
    });
  }
  // The refused claim, concretely: no "collections drove $X in cash". The
  // confounders are the method's actual product.
  return ok({
    causalClaim: "none",
    paymentsInWindowMinor,
    observationWindowDays,
    confounders: ASSOCIATION_CONFOUNDERS,
  });
}
