// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type { BusinessCalendar, DueDateRule, PaymentTermsDefinition } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import {
  addDays,
  applyBusinessDayAdjustment,
  clampToMonthEnd,
  monthStartPlus,
  parts,
  type ISODate,
} from "./dates.js";
import { PAYABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// terms.* — §16.1–16.3. There is NO fallback chain: an absent basis fact is a
// refusal, not a walk down a priority list.
// ─────────────────────────────────────────────────────────────────────────────

export interface TermsFacts {
  readonly documentDate?: ISODate;
  readonly postingDate?: ISODate;
  readonly goodsReceivedDate?: ISODate;
  readonly entryDate?: ISODate;
  /** Clearance-mandate date (Italy SdI, France PDP): can differ from the printed date. */
  readonly legalEffectiveDate?: ISODate;
}

export function resolveTermsDate(
  terms: PaymentTermsDefinition,
  facts: TermsFacts,
): Result<ISODate> {
  const M = PAYABLES_METHODS.resolveTermsDate;
  const selected: { fact: string; value: ISODate | undefined } = (() => {
    switch (terms.termsDateBasis) {
      case "document-date":
        return { fact: "documentDate", value: facts.documentDate };
      case "posting-date":
        return { fact: "postingDate", value: facts.postingDate };
      case "received-date":
        return { fact: "goodsReceivedDate", value: facts.goodsReceivedDate };
      case "entry-date":
        return { fact: "entryDate", value: facts.entryDate };
      case "legal-effective":
        return { fact: "legalEffectiveDate", value: facts.legalEffectiveDate };
      case "explicit":
        return { fact: "explicitTermsDate", value: terms.explicitTermsDate };
    }
  })();
  if (selected.value === undefined) {
    return refuse(
      "missing-evidence",
      M,
      `termsDateBasis is '${terms.termsDateBasis}' and no ${selected.fact} was supplied. There is no fallback chain.`,
    );
  }
  return ok(selected.value);
}

export function deriveDueDate(
  termsDate: ISODate,
  rule: DueDateRule,
  adjustment: PaymentTermsDefinition["dueDateAdjustment"],
  calendar?: BusinessCalendar,
): Result<ISODate> {
  const M = PAYABLES_METHODS.deriveDueDate;
  let due: ISODate;
  switch (rule.kind) {
    case "days":
      due = addDays(termsDate, rule.days);
      break;
    case "day-of-month": {
      const advance = parts(termsDate).day > rule.cutoffDay ? 1 : 0;
      const { year, month } = monthStartPlus(termsDate, advance + rule.monthsAhead);
      due = clampToMonthEnd(year, month, rule.dayOfMonth);
      break;
    }
    case "fixed-date":
      due = rule.date;
      break;
  }
  if (adjustment !== "none" && calendar === undefined) {
    return refuse(
      "missing-evidence",
      M,
      `dueDateAdjustment '${adjustment}' requires a BusinessCalendar; a business-day rule with no calendar silently means nothing.`,
    );
  }
  return ok(calendar ? applyBusinessDayAdjustment(due, adjustment, calendar) : due);
}

export interface InstallmentAmount {
  readonly installmentSequence: number;
  readonly amount: ExactMoney;
  readonly rule: DueDateRule;
}

/**
 * terms.split-installments.v1 — boundary B-1: round each of installments
 * 1..n−1 at the currency scale in the terms' rounding mode; the LAST absorbs
 * the residual so the installments sum exactly to the original. Rounding
 * every installment and letting the sum drift is a defect, not a variant.
 */
export function splitInstallments(
  originalAmount: ExactMoney,
  terms: PaymentTermsDefinition,
): Result<readonly InstallmentAmount[]> {
  const M = PAYABLES_METHODS.splitInstallments;
  const installments = terms.installments;
  if (!installments || installments.length === 0) {
    return refuse("missing-evidence", M, "The terms definition declares no installments.");
  }
  const totalUnits = exactMinorUnits(originalAmount);
  const out: InstallmentAmount[] = [];
  let assigned = 0n;
  for (let i = 0; i < installments.length; i++) {
    const share = installments[i];
    if (!share) continue;
    if (i === installments.length - 1) {
      out.push({
        installmentSequence: i + 1,
        amount: exactMoneyFromMinorUnits(
          totalUnits - assigned,
          originalAmount.currency,
          originalAmount.scale,
        ),
        rule: share.rule,
      });
      break;
    }
    // share.percentage is percent units as a decimal string: exact scaled math.
    const [whole = "0", fraction = ""] = share.percentage.split(".");
    const shareScale = fraction.length;
    const shareUnits = BigInt(whole + fraction);
    // amount_i = total × share / 100, rounded once (B-1).
    const units = divideAndRound(
      totalUnits * shareUnits,
      100n * 10n ** BigInt(shareScale),
      terms.roundingMode,
    );
    assigned += units;
    out.push({
      installmentSequence: i + 1,
      amount: exactMoneyFromMinorUnits(units, originalAmount.currency, originalAmount.scale),
      rule: share.rule,
    });
  }
  return ok(out);
}
