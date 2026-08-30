// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type { AgingPolicy, CashReceipt, OpenItem } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { RECEIVABLES_METHODS, validateAgingPolicy } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// M-8 · aging.policy.v1 with the reconciling identity R-1, and
// M-11 · the DSO/ADD/CEI family — every variant carries its exact input set,
// because the same label computed on different inputs is the single most
// common source of disagreement about "our DSO".
// ─────────────────────────────────────────────────────────────────────────────

function daysBetweenIso(a: string, b: string): number {
  const [ay = 0, am = 1, ad = 1] = a.split("-").map(Number);
  const [by = 0, bm = 1, bd = 1] = b.split("-").map(Number);
  // UTC dates are exact multiples of a day; the division is exact.
  return (Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000;
}

export interface AgingSnapshot {
  readonly asOf: string;
  readonly policyRef: { methodId: string; semanticVersion: string };
  readonly currency: string;
  readonly buckets: readonly { name: string; total: ExactMoney; openItemIds: readonly string[] }[];
  readonly unknownBucket: ExactMoney;
  readonly credits: ExactMoney;
  readonly onAccount: ExactMoney;
  readonly unapplied: ExactMoney;
  readonly unidentifiedCash: ExactMoney;
  readonly subLedgerTotal: ExactMoney;
  readonly resultFingerprint: string;
}

/** Single-currency aging. Cross-currency aging is per-currency snapshots, never a blended sum. */
export function ageReceivables(
  items: readonly OpenItem[],
  receipts: readonly CashReceipt[],
  policy: AgingPolicy,
  asOf: string,
  currency: string,
  scale: number,
): Result<AgingSnapshot> {
  const M = RECEIVABLES_METHODS.agingPolicy;
  const rejection = validateAgingPolicy(policy);
  if (rejection) {
    return refuse("policy-invalid", M, `${rejection.rule}: ${rejection.detail} (refused on load, not repaired)`);
  }

  const inCurrency = items.filter(
    (i) => i.openAmount.currency === currency && exactMinorUnits(i.openAmount) !== 0n,
  );
  const bucketTotals = new Map<string, { units: bigint; ids: string[] }>();
  let unknown = 0n;
  let credits = 0n;

  for (const item of inCurrency) {
    const units = exactMinorUnits(item.openAmount);
    if (item.sign === "credit" || units < 0n) {
      // separate-credits-line: credits are reported on their own line, never
      // netted invisibly into a bucket.
      credits += units < 0n ? -units : units;
      continue;
    }
    const basisDate = policy.basis === "dueDate" ? item.dueDate : item.documentDate;
    if (basisDate === undefined) {
      unknown += units;
      continue;
    }
    const age = daysBetweenIso(basisDate, asOf) - policy.graceDays;
    const effective = age < 0 ? 0 : age;
    const bucket = policy.buckets.find((b) => b.fromDays <= effective && effective < b.toDays);
    if (!bucket) {
      return refuse("policy-invalid", M, `No bucket covers ${effective} days — the policy escaped validation.`);
    }
    const cell = bucketTotals.get(bucket.name) ?? { units: 0n, ids: [] };
    cell.units += units;
    cell.ids.push(item.openItemId);
    bucketTotals.set(bucket.name, cell);
  }

  let onAccount = 0n;
  let unapplied = 0n;
  let unidentified = 0n;
  for (const receipt of receipts) {
    if (receipt.amount.currency !== currency) continue;
    const units = exactMinorUnits(receipt.unappliedAmount);
    if (units === 0n) continue;
    if (receipt.state === "unidentified") unidentified += units;
    else if (receipt.state === "on-account") onAccount += units;
    else unapplied += units;
  }

  const bucketList = policy.buckets.map((b) => {
    const cell = bucketTotals.get(b.name) ?? { units: 0n, ids: [] };
    return {
      name: b.name,
      total: exactMoneyFromMinorUnits(cell.units, currency, scale),
      openItemIds: cell.ids.sort(),
    };
  });

  // R-1, asserted on every snapshot: Σ buckets + unknown + credits(−) −
  // onAccount − unapplied − unidentified == sub-ledger total under the same
  // policy. Our sub-ledger total = Σ signed open items − unapplied cash.
  // With a single fold the identity is algebraic — it fires only when an item
  // is silently dropped or double-assigned by a future edit. A TRIPWIRE:
  // mutation `R1-assertion-dropped` survives as an equivalent mutant today,
  // recorded here honestly rather than strengthened into a false test.
  const bucketSum = bucketList.reduce((acc, b) => acc + exactMinorUnits(b.total), 0n);
  const itemsTotal = inCurrency.reduce((acc, i) => {
    const units = exactMinorUnits(i.openAmount);
    return acc + (i.sign === "credit" ? -(units < 0n ? -units : units) : units);
  }, 0n);
  const subLedger = itemsTotal - onAccount - unapplied - unidentified;
  const identityLeft = bucketSum + unknown - credits - onAccount - unapplied - unidentified;
  if (identityLeft !== subLedger) {
    return refuse(
      "aging-identity-violation",
      M,
      `R-1 failed: buckets+unknown−credits−cash = ${identityLeft} but sub-ledger = ${subLedger} minor units. The snapshot is refused, not emitted.`,
    );
  }

  const fingerprint = [
    asOf,
    policy.methodRef.methodId,
    policy.methodRef.semanticVersion,
    currency,
    ...bucketList.map((b) => `${b.name}:${b.total.amount}`),
    `unknown:${unknown}`,
    `credits:${credits}`,
  ].join("|");

  return ok({
    asOf,
    policyRef: { methodId: policy.methodRef.methodId, semanticVersion: policy.methodRef.semanticVersion },
    currency,
    buckets: bucketList,
    unknownBucket: exactMoneyFromMinorUnits(unknown, currency, scale),
    credits: exactMoneyFromMinorUnits(credits, currency, scale),
    onAccount: exactMoneyFromMinorUnits(onAccount, currency, scale),
    unapplied: exactMoneyFromMinorUnits(unapplied, currency, scale),
    unidentifiedCash: exactMoneyFromMinorUnits(unidentified, currency, scale),
    subLedgerTotal: exactMoneyFromMinorUnits(subLedger, currency, scale),
    resultFingerprint: fingerprint,
  });
}

// ── M-11: DSO family. Credit sales are REQUIRED arguments; a gap in a
// countback series REFUSES — a gap silently treated as zero produces a
// flatteringly low DSO.

export interface DsoResult {
  /** Days, 2dp as an exact decimal string. */
  readonly days: string;
  readonly variant: string;
  readonly inputs: Record<string, string>;
}

const twoDp = (numerator: bigint, denominator: bigint): string => {
  const scaled = divideAndRound(numerator * 100n, denominator, "half-even");
  const negative = scaled < 0n;
  const abs = (negative ? -scaled : scaled).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
};

export function dsoSimple(
  arBalance: ExactMoney | undefined,
  creditSales: ExactMoney | undefined,
  periodDays: number,
): Result<DsoResult> {
  const M = RECEIVABLES_METHODS.dsoSimple;
  if (!arBalance || !creditSales) {
    return refuse("policy-missing", M, "AR balance and credit sales are REQUIRED arguments; absent is a refusal, not zero.");
  }
  const sales = exactMinorUnits(creditSales);
  if (sales === 0n) return refuse("policy-invalid", M, "Credit sales of zero cannot denominate a DSO.");
  return ok({
    days: twoDp(exactMinorUnits(arBalance) * BigInt(periodDays), sales),
    variant: "dso.simple",
    inputs: { arBalance: arBalance.amount, creditSales: creditSales.amount, periodDays: String(periodDays) },
  });
}

export function dsoCountback(
  arBalance: ExactMoney | undefined,
  periodSeries: readonly { period: string; creditSales: ExactMoney; days: number }[] | undefined,
): Result<DsoResult> {
  const M = RECEIVABLES_METHODS.dsoCountback;
  if (!arBalance || !periodSeries || periodSeries.length === 0) {
    return refuse("policy-missing", M, "The countback needs the AR balance and a period series of credit sales.");
  }
  for (const p of periodSeries) {
    if (exactMinorUnits(p.creditSales) < 0n || p.days <= 0) {
      return refuse("policy-invalid", M, `Period ${p.period} is malformed.`);
    }
  }
  let remaining = exactMinorUnits(arBalance);
  let accumulatedDaysTimes100 = 0n;
  for (const p of periodSeries) {
    // Most recent first; a GAP in the series refuses upstream (caller supplies
    // contiguous periods; an explicit zero month is legal, a missing one is not).
    const sales = exactMinorUnits(p.creditSales);
    if (remaining <= 0n) break;
    if (sales >= remaining) {
      // Final partial period, pro-rated.
      accumulatedDaysTimes100 += divideAndRound(remaining * BigInt(p.days) * 100n, sales, "half-even");
      remaining = 0n;
    } else {
      accumulatedDaysTimes100 += BigInt(p.days) * 100n;
      remaining -= sales;
    }
  }
  if (remaining > 0n) {
    return refuse(
      "policy-invalid",
      M,
      "The AR balance outlasts the supplied period series; supply more history rather than a flattering number.",
    );
  }
  const abs = accumulatedDaysTimes100.toString().padStart(3, "0");
  return ok({
    days: `${abs.slice(0, -2)}.${abs.slice(-2)}`,
    variant: "dso.countback",
    inputs: { arBalance: arBalance.amount, periods: String(periodSeries.length) },
  });
}

export function cei(
  beginningAr: ExactMoney,
  creditSales: ExactMoney,
  endingAr: ExactMoney,
): Result<DsoResult> {
  const M = RECEIVABLES_METHODS.cei;
  const denominator = exactMinorUnits(beginningAr) + exactMinorUnits(creditSales);
  if (denominator === 0n) return refuse("policy-invalid", M, "CEI's denominator is zero.");
  const numerator = denominator - exactMinorUnits(endingAr);
  return ok({
    days: twoDp(numerator * 100n, denominator),
    variant: "cei",
    inputs: { beginningAr: beginningAr.amount, creditSales: creditSales.amount, endingAr: endingAr.amount },
  });
}
