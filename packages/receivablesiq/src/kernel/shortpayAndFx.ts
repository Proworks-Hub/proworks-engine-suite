// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
  type ExchangeRateRef,
  type RoundingMode,
} from "@proworks-hub/contracts";

import type { DiscountTerm, TolerancePolicy } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { RECEIVABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-2 discount · M-5 short-pay classification · M-6 residual-vs-partial ·
// M-7 cross-currency settlement.
// ─────────────────────────────────────────────────────────────────────────────

/** M-2: earned when valueDate ≤ discount due date; unearned ONLY under an explicit policy allowance. */
export function evaluateDiscount(
  term: DiscountTerm,
  itemDocumentDate: string,
  valueDate: string,
  base: ExactMoney,
  policy: TolerancePolicy,
  roundingMode: RoundingMode,
): Result<{ kind: "earned" | "unearned"; amount: ExactMoney }> {
  const M = RECEIVABLES_METHODS.discount;
  const [whole = "0", fraction = ""] = term.percentage.split(".");
  const units = divideAndRound(
    exactMinorUnits(base) * BigInt(whole + fraction),
    100n * 10n ** BigInt(fraction.length),
    roundingMode, // boundary R1 — the one rounding in the discount path
  );
  const amount = exactMoneyFromMinorUnits(units, base.currency, base.scale);
  if (units > exactMinorUnits(base)) {
    return refuse("policy-invalid", M, "The computed discount exceeds the open amount.");
  }
  // Discount due date = documentDate + term.days, compared as ISO strings via
  // day arithmetic below (dates are YYYY-MM-DD, so day-difference works).
  const due = addDaysIso(itemDocumentDate, term.days);
  if (valueDate <= due) return ok({ kind: "earned", amount });
  if (!policy.allowUnearnedDiscount) {
    return refuse(
      "policy-invalid",
      M,
      `The discount window closed ${due}; unearned discounts are not allowed by this policy.`,
    );
  }
  // Recorded as UNEARNED so the two are never confused downstream.
  return ok({ kind: "unearned", amount });
}

function addDaysIso(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const time = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const next = new Date(time);
  return next.toISOString().slice(0, 10);
}

/** M-5: classify a residual after application. `refer` is a REAL outcome, not a failure. */
export type ShortPayDisposition =
  | "tolerance-writeoff"
  | "discount-earned"
  | "chargeback"
  | "deduction-open"
  | "refer";

export function classifyShortPay(
  residual: ExactMoney,
  policy: TolerancePolicy,
  reasonCode: string | undefined,
  reasonCodeMap: Readonly<Record<string, "chargeback" | "deduction-open">>,
): Result<{ disposition: ShortPayDisposition; authorizationRef?: string }> {
  const M = RECEIVABLES_METHODS.shortpayClassification;
  const residualUnits = exactMinorUnits(residual);
  if (residualUnits < 0n) {
    return refuse("policy-invalid", M, "A negative residual is an over-application, not a short pay.");
  }
  // Tolerance: the SMALLER of absolute and percentage. Percentage needs the
  // base; here the residual itself is compared against the absolute bound —
  // the caller pre-computes the percentage bound and passes the smaller as
  // `absoluteMinor` when both are set.
  if (residualUnits <= BigInt(policy.absoluteMinor)) {
    // Requires the STANDING tolerance authorization on file, not a per-item approval.
    return ok({ disposition: "tolerance-writeoff", authorizationRef: policy.toleranceAuthorizationRef });
  }
  if (reasonCode !== undefined) {
    const mapped = reasonCodeMap[reasonCode];
    if (mapped !== undefined) return ok({ disposition: mapped });
    // Unknown reason codes are NEVER coerced to a default bucket.
    return ok({ disposition: "refer" });
  }
  return ok({ disposition: "refer" });
}

/**
 * M-6: the SAP partial/residual distinction, explicit because it changes
 * aging materially. Partial keeps the original item open at the reduced
 * amount, aging from its ORIGINAL due date. Residual clears the parent and
 * creates a child whose due-date basis is a versioned, recorded choice.
 */
export function residualStrategyChildBasis(
  strategy: "partial" | "residual",
  policyBasis: "inherit-parent" | "reset-to-application-date",
  parentDueDate: string | undefined,
  applicationDate: string,
): { createsChild: boolean; childDueDate?: string } {
  if (strategy === "partial") return { createsChild: false };
  const childDueDate = policyBasis === "inherit-parent" ? parentDueDate : applicationDate;
  return childDueDate !== undefined ? { createsChild: true, childDueDate } : { createsChild: true };
}

/**
 * M-7: cross-currency settlement. The rate arrives BY VALUE with source and
 * effective date; unbound or missing ⇒ refuse — NEVER substitute the booking
 * rate. openAmount is reduced exactly in transaction currency (R-D: never
 * rounded); the realized gain/loss rounds ONCE at R3, and a one-minor-unit
 * residual is recorded explicitly, never absorbed silently.
 */
export function realizedFxGainLoss(
  appliedInTransaction: ExactMoney,
  originalRate: ExchangeRateRef,
  settleRate: ExchangeRateRef | undefined,
  functionalCurrency: string,
  functionalScale: number,
  fxRounding: RoundingMode,
): Result<{ gainLoss: ExactMoney; fxRoundingResidualMinor: bigint }> {
  const M = RECEIVABLES_METHODS.applicationFx;
  if (!settleRate) {
    return refuse(
      "rate-port-unbound",
      M,
      "No settlement rate is available for the effective date. The booking rate is never substituted.",
    );
  }
  const toUnits = (rate: string) => {
    const [whole = "0", fraction = ""] = rate.split(".");
    return { units: BigInt(whole + fraction), scale: BigInt(fraction.length) };
  };
  const r0 = toUnits(originalRate.rate);
  const rs = toUnits(settleRate.rate);
  const applied = exactMinorUnits(appliedInTransaction);
  const scaleAdjust = 10n ** BigInt(functionalScale - appliedInTransaction.scale > 0 ? functionalScale - appliedInTransaction.scale : 0);
  // Full-precision functional values as rationals over a common denominator.
  const fOriginalNum = applied * r0.units * 10n ** rs.scale * scaleAdjust;
  const fSettledNum = applied * rs.units * 10n ** r0.scale * scaleAdjust;
  const denominator = 10n ** (r0.scale + rs.scale);
  const fOriginalRounded = divideAndRound(fOriginalNum, denominator, fxRounding);
  const fSettledRounded = divideAndRound(fSettledNum, denominator, fxRounding);
  const gainLossRounded = divideAndRound(fSettledNum - fOriginalNum, denominator, fxRounding); // R3, once
  const residual = fSettledRounded - fOriginalRounded - gainLossRounded;
  return ok({
    gainLoss: exactMoneyFromMinorUnits(gainLossRounded, functionalCurrency, functionalScale),
    fxRoundingResidualMinor: residual,
  });
}
