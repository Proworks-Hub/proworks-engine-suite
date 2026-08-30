// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  subtractExactMoney,
  type ExactMoney,
  type MethodRef,
  type Percentage,
} from "@proworks-hub/contracts";

import type { DiscountTier, PaymentTermsDefinition } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { addDays, daysBetween, type ISODate } from "./dates.js";
import { PAYABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// discount.* — §16.4, specified exactly.
//
// The yield has THREE named methods because the industry disagrees: on
// 2/10 net 30 they answer 36.7347%, 37.2449% and 44.5853% — a 7.85-point
// spread, wider than most costs of capital. `yieldMethod` is therefore a
// REQUIRED argument with no default (K-1, SR-06): a default would encode a
// finance policy in a library, and the ten K-cases are Steven's to rule
// together, not this engine's to erode one convenience at a time.
// ─────────────────────────────────────────────────────────────────────────────

export type YieldMethod = "simple-360" | "simple-365" | "compounded-act365f";

export const YIELD_METHOD_REFS: Record<YieldMethod, MethodRef> = {
  "simple-360": PAYABLES_METHODS.yieldSimple360,
  "simple-365": PAYABLES_METHODS.yieldSimple365,
  "compounded-act365f": PAYABLES_METHODS.yieldCompoundedAct365f,
};

/** discount.base.v1 — gross vs net-of-tax. Refusal, not fallback, when net has no determination. */
export function discountBase(
  originalAmount: ExactMoney,
  terms: Pick<PaymentTermsDefinition, "discountBase">,
  taxAmount: ExactMoney | undefined,
): Result<ExactMoney> {
  if (terms.discountBase === "gross-including-tax") return ok(originalAmount);
  if (taxAmount === undefined) {
    return refuse(
      "missing-evidence",
      PAYABLES_METHODS.discountBase,
      "discountBase is 'net-of-tax' and no TaxDetermination was supplied. This is not a fallback to gross.",
    );
  }
  return ok(subtractExactMoney(originalAmount, taxAmount));
}

/**
 * discount.amount.v1 — boundary B-2: round ONCE, at the currency scale, in
 * the terms' rounding mode. `tier.percentage` is percent units as an exact
 * decimal string; the arithmetic is scaled-integer, never float.
 */
export function discountAmount(
  base: ExactMoney,
  tier: DiscountTier,
  terms: Pick<PaymentTermsDefinition, "roundingMode">,
): { discountAmount: ExactMoney; payableIfDiscounted: ExactMoney } {
  const [whole = "0", fraction = ""] = tier.percentage.split(".");
  const pctUnits = BigInt(whole + fraction);
  const pctScale = BigInt(fraction.length);
  const units = divideAndRound(
    exactMinorUnits(base) * pctUnits,
    100n * 10n ** pctScale,
    terms.roundingMode,
  );
  const amount = exactMoneyFromMinorUnits(units, base.currency, base.scale);
  return { discountAmount: amount, payableIfDiscounted: subtractExactMoney(base, amount) };
}

/**
 * The annualised yield — boundary B-3: the Percentage is rounded to 4 decimal
 * places, half-even, ONCE, at the return. The rate itself is never rounded.
 *
 * The exponentiation in compounded-act365f is irrational, so the intermediate
 * computation uses double precision; the result is a 4-dp advisory Percentage
 * (never Money), and 4 dp is far inside double precision for d < 1.
 */
export function annualizedYield(
  discountPercentage: string,
  discountDays: number,
  netDays: number,
  yieldMethod: YieldMethod,
): Result<Percentage & { methodRef: MethodRef }> {
  const t = netDays - discountDays;
  if (t <= 0) {
    return refuse(
      "invariant-violated",
      YIELD_METHOD_REFS[yieldMethod],
      `netDays (${netDays}) must exceed discountDays (${discountDays}); t = ${t} annualises nothing.`,
    );
  }
  const d = Number(discountPercentage) / 100;
  if (!(d > 0 && d < 1)) {
    return refuse(
      "invariant-violated",
      YIELD_METHOD_REFS[yieldMethod],
      `A discount rate of ${discountPercentage}% is outside (0, 100).`,
    );
  }
  let yearly: number;
  switch (yieldMethod) {
    case "simple-360":
      yearly = (d / (1 - d)) * (360 / t);
      break;
    case "simple-365":
      yearly = (d / (1 - d)) * (365 / t);
      break;
    case "compounded-act365f":
      yearly = Math.pow(1 / (1 - d), 365 / t) - 1;
      break;
  }
  // B-3: round the percent value to 4 dp half-even, once. Scaled-integer
  // rounding so the boundary is the same divideAndRound as everywhere else.
  const scaled = divideAndRound(BigInt(Math.round(yearly * 1e12)), 10n ** 6n, "half-even");
  const percent = (Number(scaled) / 1e4).toFixed(4);
  return ok({ percent, methodRef: YIELD_METHOD_REFS[yieldMethod] });
}

/**
 * discount.capture-verdict.v1 — zero lead time is NOT assumed. A verdict
 * computed without lead time would tell an AP clerk a discount is available
 * on a day it cannot physically be settled.
 */
export function captureVerdict(
  asOf: ISODate,
  discountDate: ISODate,
  paymentLeadDays: number | undefined,
): Result<"capturable" | "lapsed"> {
  if (paymentLeadDays === undefined) {
    return refuse(
      "missing-method-argument",
      PAYABLES_METHODS.captureVerdict,
      "paymentLeadDays is required: a verdict without lead time names a day the payment cannot physically settle.",
    );
  }
  return ok(daysBetween(addDays(asOf, paymentLeadDays), discountDate) >= 0 ? "capturable" : "lapsed");
}
