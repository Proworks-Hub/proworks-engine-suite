// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

import type { AgingScheme, PaymentTermsDefinition } from "../model.js";

// ─────────────────────────────────────────────────────────────────────────────
// The method registry — §16.11. Registration validates the structural rules,
// so a bad definition cannot produce a bad number in production: invalid
// definitions are rejected AT REGISTRATION, not at use. `effectiveFrom`
// resolution is by the obligation's terms date, never by wall clock.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const PAYABLES_METHODS = {
  resolveTermsDate: method("terms.resolve-terms-date"),
  deriveDueDate: method("terms.derive-due-date"),
  splitInstallments: method("terms.split-installments"),
  discountBase: method("discount.base"),
  discountAmount: method("discount.amount"),
  yieldSimple360: method("discount.yield.simple-360"),
  yieldSimple365: method("discount.yield.simple-365"),
  yieldCompoundedAct365f: method("discount.yield.compounded-act365f"),
  captureVerdict: method("discount.capture-verdict"),
  agingOpenAmountOriginalBasis: method("aging.open-amount-original-basis"),
  agingResidualRebase: method("aging.residual-rebase"),
  vendorBalance: method("balance.vendor-balance"),
  fxRevalueOpenItem: method("fx.revalue-open-item"),
  rankObligations: method("priority.rank-obligations"),
  escheatDormancyCandidate: method("escheat.dormancy-candidate"),
  latePaymentExposure: method("interest.late-payment-exposure"),
  recordObligation: method("obligation.record"),
  applySettlement: method("settlement.apply"),
  proposePostings: method("proposal.construct"),
  registry: method("methods.registry"),
} as const satisfies Record<string, MethodRef>;

export interface RegistrationRejection {
  readonly rule: string;
  readonly detail: string;
}

/**
 * I-2 and the discount-date invariant: tiers ordered by ascending days with
 * STRICTLY descending percentages. I-1: installment shares sum to exactly
 * 100%. Day limits (not modelled as variants here) reduce to: an explicit
 * terms date is required exactly when the basis says so.
 */
export function validateTermsDefinition(
  terms: PaymentTermsDefinition,
): RegistrationRejection | undefined {
  if (terms.termsDateBasis === "explicit" && terms.explicitTermsDate === undefined) {
    return { rule: "explicit-basis", detail: "termsDateBasis 'explicit' requires explicitTermsDate." };
  }
  if (terms.termsDateBasis !== "explicit" && terms.explicitTermsDate !== undefined) {
    return { rule: "explicit-basis", detail: "explicitTermsDate is only legal with basis 'explicit'." };
  }
  const tiers = terms.discountSchedule;
  for (let i = 1; i < tiers.length; i++) {
    const prev = tiers[i - 1];
    const curr = tiers[i];
    if (!prev || !curr) continue;
    if (curr.days <= prev.days) {
      return { rule: "I-2", detail: `Tier days must strictly ascend: ${prev.days} then ${curr.days}.` };
    }
    if (Number(curr.percentage) >= Number(prev.percentage)) {
      return {
        rule: "I-2",
        detail: `Tier percentages must strictly descend: ${prev.percentage}% then ${curr.percentage}%.`,
      };
    }
  }
  if (terms.installments) {
    if (terms.installments.length === 0) {
      return { rule: "I-1", detail: "An installment plan with zero installments is not a plan." };
    }
    // Exact sum in hundredths of a percent — no floats.
    let totalHundredths = 0n;
    for (const share of terms.installments) {
      const [whole = "0", fraction = ""] = share.percentage.split(".");
      totalHundredths += BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
    }
    if (totalHundredths !== 10000n) {
      return {
        rule: "I-1",
        detail: `Installment shares must sum to exactly 100%; they sum to ${Number(totalHundredths) / 100}%.`,
      };
    }
  }
  return undefined;
}

/**
 * Bucket structure: contiguous, non-overlapping half-open [lower, upper)
 * covering (−∞, +∞) via the future bucket below 0 and an open-ended top. A
 * scheme with a gap means some obligation silently vanishes from a total —
 * rejected here, never discovered at use.
 */
export function validateAgingScheme(scheme: AgingScheme): RegistrationRejection | undefined {
  const buckets = scheme.buckets;
  if (buckets.length === 0) {
    return { rule: "scheme-buckets", detail: "A scheme needs at least one bucket." };
  }
  const first = buckets[0];
  if (first && first.lowerDays !== 0) {
    return {
      rule: "scheme-coverage",
      detail: `The first bucket starts at ${first.lowerDays}; days 0..${first.lowerDays} would vanish. Buckets start at 0 (the future bucket holds negatives).`,
    };
  }
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i];
    if (!bucket) continue;
    if (bucket.upperDays <= bucket.lowerDays) {
      return { rule: "scheme-buckets", detail: `Bucket "${bucket.name}" is empty or inverted.` };
    }
    const next = buckets[i + 1];
    if (next && next.lowerDays !== bucket.upperDays) {
      return {
        rule: "scheme-coverage",
        detail: `Gap or overlap between "${bucket.name}" [..${bucket.upperDays}) and "${next.name}" [${next.lowerDays}..).`,
      };
    }
  }
  const last = buckets[buckets.length - 1];
  if (last && last.upperDays !== Number.MAX_SAFE_INTEGER) {
    return {
      rule: "scheme-coverage",
      detail: `The last bucket "${last.name}" ends at ${last.upperDays}; older obligations would vanish. End the last bucket at Number.MAX_SAFE_INTEGER.`,
    };
  }
  return undefined;
}
