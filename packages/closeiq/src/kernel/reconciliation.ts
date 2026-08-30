// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
  type GovernanceDecision,
} from "@proworks-hub/contracts";

import { isPermitted } from "@proworks-hub/contracts";

import type {
  AccountReconciliation,
  BalanceObservation,
  CertificationCandidate,
  CertificationRecord,
  CloseProfile,
  CutOffFinding,
  CutOffRule,
  ReconcilingItem,
  ReconciliationState,
} from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { CLOSE_METHODS } from "./evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-3 · reconciliation difference — reconciliation, substantiation and
// certification are THREE different facts, never conflated.
// M-4 · auto-certification rules — every rule produces a CANDIDATE, never a
// certification; conservatism is the only safe direction.
// M-6 · cut-off determination — the grace window is READ and recorded.
// ─────────────────────────────────────────────────────────────────────────────

function fingerprint(observations: readonly BalanceObservation[]): string {
  return observations
    .map((o) => `${o.source}:${o.balance.amount}:${o.balance.currency}:${o.asOf}`)
    .sort()
    .join("|");
}

export function computeReconciliation(
  reconciliationId: string,
  closePeriodId: string,
  accountRef: string,
  observations: readonly BalanceObservation[],
  reconcilingItems: readonly ReconcilingItem[],
  asOf: string,
  currencyRegistry: Readonly<Record<string, number>>,
): Result<AccountReconciliation> {
  const M = CLOSE_METHODS.reconciliationDifference;

  // Fewer than two observations: `difference` ABSENT — not zero — and the
  // honesty state. A close engine that reports a zero difference because it
  // could not see the bank has told a lie that looks exactly like good news.
  if (observations.length < 2) {
    return ok({
      reconciliationId,
      closePeriodId,
      accountRef,
      observations,
      reconcilingItems,
      state: "unsubstantiated-unknown",
      balanceFingerprint: fingerprint(observations),
      asOf,
    });
  }

  const currency = observations[0]?.balance.currency as string;
  for (const observation of observations) {
    if (observation.balance.currency !== currency) {
      return refuse(
        "unknown-currency-scale",
        M,
        `Observations mix ${currency} and ${observation.balance.currency}; a reconciliation is one currency or a refusal.`,
      );
    }
  }
  const declaredScale = currencyRegistry[currency];
  if (declaredScale === undefined) {
    // Scale is NEVER inferred from the currency by CloseIQ — inferring would
    // fork the money type by another route. Refuse and name the currency.
    return refuse("unknown-currency-scale", M, `Currency ${currency} is not in the registry; the scale cannot be assumed.`);
  }

  const ledger = observations.find((o) => o.source === "ledger");
  const comparison = observations.find((o) => o.source !== "ledger");
  if (!ledger || !comparison) {
    return ok({
      reconciliationId,
      closePeriodId,
      accountRef,
      observations,
      reconcilingItems,
      state: "unsubstantiated-unknown",
      balanceFingerprint: fingerprint(observations),
      asOf,
    });
  }

  const itemsTotal = reconcilingItems.reduce((acc, item) => acc + exactMinorUnits(item.amount), 0n);
  const differenceUnits =
    exactMinorUnits(ledger.balance) - (exactMinorUnits(comparison.balance) + itemsTotal);
  const abs = differenceUnits < 0n ? -differenceUnits : differenceUnits;

  // A residual within one minor unit is arithmetic noise, not a reconciling
  // difference (TD-9: the primitive cannot currently tell them apart).
  const state: ReconciliationState =
    differenceUnits === 0n
      ? reconcilingItems.length > 0
        ? "explained-difference"
        : "balanced"
      : abs <= 1n
        ? "rounding-indeterminate"
        : "unexplained-difference";

  return ok({
    reconciliationId,
    closePeriodId,
    accountRef,
    observations,
    reconcilingItems,
    difference: exactMoneyFromMinorUnits(differenceUnits, currency, declaredScale),
    state,
    balanceFingerprint: fingerprint(observations),
    asOf,
  });
}

/** M-4: candidates, never certifications. Conservative: refuse-to-certify is always legal; the reverse never is. */
export function proposeCertification(
  reconciliation: AccountReconciliation,
  profile: CloseProfile,
  ruleId: "zero-balance" | "no-activity" | "within-threshold" | "aged-item-free",
  materialityThresholdMinor: bigint | undefined,
  priorCertifiedFingerprint: string | undefined,
): Result<CertificationCandidate> {
  const ruleRefs = {
    "zero-balance": CLOSE_METHODS.autoCertZeroBalance,
    "no-activity": CLOSE_METHODS.autoCertNoActivity,
    "within-threshold": CLOSE_METHODS.autoCertWithinThreshold,
    "aged-item-free": CLOSE_METHODS.autoCertAgedItemFree,
  } as const;
  const M = ruleRefs[ruleId];

  // `unknown` tier blocks auto-certification ENTIRELY: an unrated account
  // defaulted to low risk is how a material account stops being reconciled.
  if (profile.riskTier === "unknown") {
    return refuse("tier-unknown", M, `Account ${profile.accountRef} has no policy risk tier; unknown blocks auto-certification.`);
  }
  if (!profile.autoCertifiable) {
    return refuse("not-permitted", M, `Account ${profile.accountRef}'s profile does not permit auto-certification.`);
  }

  const balanced =
    reconciliation.state === "balanced" || reconciliation.state === "explained-difference";
  switch (ruleId) {
    case "zero-balance": {
      const allZero = reconciliation.observations.every((o) => exactMinorUnits(o.balance) === 0n);
      if (!allZero || reconciliation.reconcilingItems.length > 0) {
        return refuse("not-balanced", M, "zero-balance certifies only when every observation is exactly zero with no reconciling items.");
      }
      break;
    }
    case "no-activity": {
      if (!balanced) return refuse("not-balanced", M, `State is ${reconciliation.state}.`);
      if (priorCertifiedFingerprint === undefined || priorCertifiedFingerprint !== reconciliation.balanceFingerprint) {
        return refuse("not-balanced", M, "no-activity requires the balance unchanged from the prior certified period.");
      }
      break;
    }
    case "within-threshold": {
      // An unbound materiality policy does NOT fall back to a default
      // threshold. No threshold means no auto-certification.
      if (materialityThresholdMinor === undefined) {
        return refuse("materiality-unbound", M, "within-threshold is inoperable without a materiality policy. No threshold, no auto-certification.");
      }
      if (reconciliation.difference === undefined) {
        return refuse("not-balanced", M, "The difference is undeterminable; a threshold cannot be applied to an unknown.");
      }
      const units = exactMinorUnits(reconciliation.difference as ExactMoney);
      const abs = units < 0n ? -units : units;
      if (abs > materialityThresholdMinor) {
        return refuse("not-balanced", M, `The residual ${abs} minor units exceeds the threshold ${materialityThresholdMinor}.`);
      }
      break;
    }
    case "aged-item-free": {
      if (!balanced) return refuse("not-balanced", M, `State is ${reconciliation.state}.`);
      const limit = profile.agedItemLimitDays;
      if (limit === undefined) {
        return refuse("not-permitted", M, "The profile declares no reconciling-item age limit; aged-item-free cannot run.");
      }
      const daysBetween = (a: string, b: string) => {
        const [ay = 0, am = 1, ad = 1] = a.split("-").map(Number);
        const [by = 0, bm = 1, bd = 1] = b.split("-").map(Number);
        return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
      };
      const aged = reconciliation.reconcilingItems.find(
        (item) => daysBetween(item.identifiedOn, reconciliation.asOf) > limit,
      );
      if (aged) {
        return refuse("not-balanced", M, `Reconciling item ${aged.itemId} is older than the ${limit}-day profile limit.`);
      }
      break;
    }
  }

  return ok({
    candidateId: `cand:${reconciliation.reconciliationId}:${ruleId}`,
    reconciliationId: reconciliation.reconciliationId,
    ruleRef: { methodId: M.methodId, semanticVersion: M.semanticVersion },
    balanceFingerprint: reconciliation.balanceFingerprint,
  });
}

/** A candidate becomes a record only under a governance grant naming the rule AND its version. */
export function certify(
  candidate: CertificationCandidate,
  reconciliation: AccountReconciliation,
  governance: GovernanceDecision | undefined,
  grantedRule: { methodId: string; semanticVersion: string } | undefined,
  certifiedBy: string,
  at: string,
): Result<CertificationRecord> {
  const M = CLOSE_METHODS.autoCertWithinThreshold;
  if (candidate.balanceFingerprint !== reconciliation.balanceFingerprint) {
    return refuse("candidate-stale", M, "The balance changed after the candidate was produced; a new candidate is required.");
  }
  if (!governance || !isPermitted(governance)) {
    return refuse("not-permitted", M, "A candidate becomes a certification only under a permitted governance decision.");
  }
  if (
    !grantedRule ||
    grantedRule.methodId !== candidate.ruleRef.methodId ||
    grantedRule.semanticVersion !== candidate.ruleRef.semanticVersion
  ) {
    return refuse(
      "not-permitted",
      M,
      `The grant names ${grantedRule ? `${grantedRule.methodId}@${grantedRule.semanticVersion}` : "no rule"}; the candidate was produced by ${candidate.ruleRef.methodId}@${candidate.ruleRef.semanticVersion}. A grant binds to a rule AND its version.`,
    );
  }
  return ok({
    certificationId: `cert:${candidate.candidateId}`,
    certifiedBy,
    governanceRef: governance.decisionId ?? "decision:unreferenced",
    ruleRef: candidate.ruleRef,
    balanceFingerprint: candidate.balanceFingerprint,
    certifiedAt: at,
  });
}

/** M-6: the grace window is READ here and recorded on the finding as applied. */
export function determineCutOff(
  rule: CutOffRule,
  subject: {
    readonly subjectRef: string;
    readonly governingDate: string;
    readonly recordedInPeriod: boolean;
    readonly amount: ExactMoney;
  },
  periodStart: string,
  periodEnd: string,
): CutOffFinding | undefined {
  const addDays = (date: string, days: number): string => {
    const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
    return next.toISOString().slice(0, 10);
  };
  const upperBound = addDays(rule.cutOffDate, rule.graceWindowDays);
  const insideWindow = subject.governingDate >= periodStart && subject.governingDate <= upperBound;
  const misplaced = subject.recordedInPeriod !== insideWindow;
  if (!misplaced) return undefined;
  return {
    findingId: `cut:${rule.ruleId}:${subject.subjectRef}`,
    ruleId: rule.ruleId,
    subjectRef: subject.subjectRef,
    governingDate: subject.governingDate,
    recordedPeriodEnd: periodEnd,
    amount: subject.amount,
    graceWindowDaysApplied: rule.graceWindowDays,
  };
}
