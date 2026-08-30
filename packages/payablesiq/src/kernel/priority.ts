// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { exactMinorUnits, type Percentage } from "@proworks-hub/contracts";

import type { PayableObligation } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { addDays, daysBetween, type ISODate } from "./dates.js";
import { annualizedYield, captureVerdict, type YieldMethod } from "./discount.js";
import { PAYABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// priority.rank-obligations.v1 — §16.8. Deterministic, explainable, a TOTAL
// order (obligationId is the final tie-break, so sort instability cannot
// reorder). The result is a RECOMMEND-rung candidate set with reason codes —
// it is not a payment run; PaymentsIQ composes runs.
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentCandidate {
  readonly obligationId: string;
  readonly reasonCodes: readonly string[];
  readonly discountDate?: ISODate;
  readonly dueDate?: ISODate;
}

export interface ExcludedObligation {
  readonly obligationId: string;
  readonly reason: string;
}

export interface PaymentCandidateSet {
  readonly asOf: ISODate;
  readonly candidates: readonly PaymentCandidate[];
  readonly excluded: readonly ExcludedObligation[];
}

export interface PriorityInputs {
  readonly obligations: readonly PayableObligation[];
  readonly asOf: ISODate;
  readonly paymentLeadDays?: number;
  readonly costOfCapital?: Percentage;
  readonly yieldMethod?: YieldMethod;
  /** Net days per obligation's terms, for yield computation; keyed by obligationId. */
  readonly netDaysByObligation?: Readonly<Record<string, number>>;
}

export function prioritizeObligations(inputs: PriorityInputs): Result<PaymentCandidateSet> {
  const M = PAYABLES_METHODS.rankObligations;
  const excluded: ExcludedObligation[] = [];
  const discountTier: (PaymentCandidate & { discountAmountUnits: bigint })[] = [];
  const dueTier: (PaymentCandidate & { openUnits: bigint })[] = [];

  for (const o of inputs.obligations) {
    if (o.status === "held" || o.status === "written-off" || o.status === "settled" || o.status === "reversed") {
      excluded.push({ obligationId: o.obligationId, reason: `status:${o.status}` });
      continue;
    }
    if (o.fundingRoute === "supplier-finance") {
      // Already funded by a third party; paying it again is the defect.
      excluded.push({ obligationId: o.obligationId, reason: "funding:supplier-finance" });
      continue;
    }
    if (o.termsResolution === "unresolved" || o.termsResolution === "candidate-pending") {
      // Guessing a due date to rank an item is exactly the defect this
      // engine refuses.
      excluded.push({ obligationId: o.obligationId, reason: "terms-unresolved" });
      continue;
    }
    if (o.dueDate === undefined || o.termsDate === undefined) {
      excluded.push({ obligationId: o.obligationId, reason: "terms-unresolved" });
      continue;
    }

    // Discount tier: capturable AND yield beats the supplied cost of capital.
    let placedInDiscountTier = false;
    if (
      o.discountSchedule.length > 0 &&
      inputs.costOfCapital !== undefined &&
      inputs.yieldMethod !== undefined &&
      inputs.paymentLeadDays !== undefined
    ) {
      const tier = o.discountSchedule[0];
      if (tier) {
        const discountDate = addDays(o.termsDate, tier.days);
        const verdict = captureVerdict(inputs.asOf, discountDate, inputs.paymentLeadDays);
        const netDays =
          inputs.netDaysByObligation?.[o.obligationId] ?? daysBetween(o.termsDate, o.dueDate);
        if (verdict.ok && verdict.value === "capturable") {
          const yieldResult = annualizedYield(
            tier.percentage,
            tier.days,
            netDays,
            inputs.yieldMethod,
          );
          if (yieldResult.ok && Number(yieldResult.value.percent) > Number(inputs.costOfCapital.percent)) {
            discountTier.push({
              obligationId: o.obligationId,
              reasonCodes: ["discount-capturable", `yield:${yieldResult.value.percent}%`],
              discountDate,
              dueDate: o.dueDate,
              discountAmountUnits: exactMinorUnits(o.openAmount),
            });
            placedInDiscountTier = true;
          }
        }
      }
    }
    if (!placedInDiscountTier) {
      dueTier.push({
        obligationId: o.obligationId,
        reasonCodes: ["due-date-order"],
        dueDate: o.dueDate,
        openUnits: exactMinorUnits(o.openAmount),
      });
    }
  }

  if (
    (inputs.costOfCapital !== undefined || inputs.paymentLeadDays !== undefined) &&
    inputs.yieldMethod === undefined
  ) {
    return refuse(
      "missing-method-argument",
      M,
      "yieldMethod is required when discount economics participate: simple-360, simple-365 and compounded-act365f differ by 7.85 percentage points on 2/10 net 30.",
    );
  }

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  discountTier.sort(
    (a, b) =>
      cmp(a.discountDate ?? "", b.discountDate ?? "") ||
      (b.discountAmountUnits > a.discountAmountUnits ? 1 : b.discountAmountUnits < a.discountAmountUnits ? -1 : 0) ||
      cmp(a.obligationId, b.obligationId),
  );
  dueTier.sort(
    (a, b) =>
      cmp(a.dueDate ?? "", b.dueDate ?? "") ||
      (b.openUnits > a.openUnits ? 1 : b.openUnits < a.openUnits ? -1 : 0) ||
      cmp(a.obligationId, b.obligationId),
  );

  return ok({
    asOf: inputs.asOf,
    candidates: [
      ...discountTier.map(({ discountAmountUnits: _d, ...c }) => c),
      ...dueTier.map(({ openUnits: _o, ...c }) => c),
    ],
    excluded,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// escheat.dormancy-candidate.v1 and interest.late-payment-exposure.v1 —
// §16.9/§16.10. Both compute from SUPPLIED policy. PayablesIQ does not know
// the law, does not select a jurisdiction, holds no rate table.
// ─────────────────────────────────────────────────────────────────────────────

export interface DormancyPolicy {
  readonly dormancyYears: number;
  readonly dueDiligenceWindowDays: number;
  /** Minor units below which the policy ignores the item. */
  readonly thresholdAmountMinor: bigint;
}

export function dormancyCandidate(
  obligation: PayableObligation,
  policy: DormancyPolicy | undefined,
  asOf: ISODate,
): Result<{ candidate: boolean; reason: string }> {
  const M = PAYABLES_METHODS.escheatDormancyCandidate;
  if (!policy) {
    return refuse("missing-method-argument", M, "A dormancy policy must be supplied; PayablesIQ does not know the law.");
  }
  if (obligation.dueDate === undefined) {
    return refuse("terms-unresolved", M, `${obligation.obligationId} has no due date to measure dormancy from.`);
  }
  const dormantDays = daysBetween(obligation.dueDate, asOf);
  const threshold = policy.dormancyYears * 365;
  const over = exactMinorUnits(obligation.openAmount) >= policy.thresholdAmountMinor;
  const candidate = dormantDays >= threshold && over;
  return ok({
    candidate,
    reason: candidate
      ? `dormant ${dormantDays} days ≥ ${threshold} under the supplied policy`
      : `dormant ${dormantDays} days < ${threshold}, or below threshold`,
  });
}

export interface StatutoryInterestPolicy {
  /** Annual statutory rate, percent units, exact decimal string. */
  readonly annualRatePercent: string;
  readonly dayCountBasis: "act/365f" | "act/360";
  /** Fixed recovery amount in minor units of the obligation currency. */
  readonly fixedRecoveryMinor: bigint;
}

export function latePaymentExposure(
  obligation: PayableObligation,
  policy: StatutoryInterestPolicy | undefined,
  asOf: ISODate,
): Result<{ interestMinor: bigint; fixedRecoveryMinor: bigint; daysLate: number }> {
  const M = PAYABLES_METHODS.latePaymentExposure;
  if (!policy) {
    return refuse("missing-method-argument", M, "A statutory rate must be supplied; PayablesIQ holds no rate table.");
  }
  if (obligation.dueDate === undefined) {
    return refuse("terms-unresolved", M, `${obligation.obligationId} has no due date.`);
  }
  const daysLate = Math.max(0, daysBetween(obligation.dueDate, asOf));
  const basis = policy.dayCountBasis === "act/360" ? 360n : 365n;
  const [whole = "0", fraction = ""] = policy.annualRatePercent.split(".");
  const rateUnits = BigInt(whole + fraction);
  const rateScale = 10n ** BigInt(fraction.length);
  // interest = open × rate% × days / basis — floor'd to minor units (exposure, not a bill).
  const interestMinor =
    (exactMinorUnits(obligation.openAmount) * rateUnits * BigInt(daysLate)) /
    (100n * rateScale * basis);
  return ok({
    interestMinor,
    fixedRecoveryMinor: daysLate > 0 ? policy.fixedRecoveryMinor : 0n,
    daysLate,
  });
}
