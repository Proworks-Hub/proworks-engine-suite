// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  addExactMoney,
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  type ExactMoney,
} from "@proworks-hub/contracts";

import type { Account, Book, ChartOfAccountsVersion, JournalEntry, PeriodRef } from "../model/model.js";

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER-TRIAL-BALANCE/1.0.0 — the fold.
//
// THE JOURNAL LINE IS THE ONLY SOURCE OF TRUTH FOR MONEY (§14.6 rule 1).
// Balances are a fold over lines; a materialized balance is a cache with a
// stated invalidation rule, never a second source of truth. Because every
// entry sums to zero and every account starts at zero, the trial balance
// footing is a mathematical guarantee, not a report you hope reconciles.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  readonly accountCode: string;
  readonly accountClass: Account["accountClass"];
  readonly debitTotal: ExactMoney;
  readonly creditTotal: ExactMoney;
  /** Net on the account's natural presentation: positive net debit or credit. */
  readonly net: ExactMoney;
  readonly netSide: "debit" | "credit";
}

export interface TrialBalance {
  readonly bookId: string;
  readonly periodRef: PeriodRef;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebits: ExactMoney;
  readonly totalCredits: ExactMoney;
  /** COMPUTED from the rows, never a constant. If it could not be true, the query refuses. */
  readonly foots: boolean;
}

/** Compares (fiscalYear, periodNumber) — calendar order. */
export function comparePeriodRefs(a: PeriodRef, b: PeriodRef): number {
  return a.fiscalYear - b.fiscalYear || a.periodNumber - b.periodNumber;
}

/**
 * Folds functional-currency net movement per account, over entries up to and
 * including `asOfPeriod`. Statistical lines never enter the money fold.
 * Order-independent: addition commutes, and property test P-14 proves the
 * implementation kept it that way.
 */
export function foldAccountUnits(
  entries: readonly JournalEntry[],
  asOfPeriod: PeriodRef,
): Map<string, bigint> {
  const perAccount = new Map<string, bigint>();
  for (const entry of entries) {
    if (comparePeriodRefs(entry.periodRef, asOfPeriod) > 0) continue;
    for (const line of entry.lines) {
      if (!line.functionalAmount) continue;
      const units = exactMinorUnits(line.functionalAmount);
      const delta = line.side === "debit" ? units : -units;
      perAccount.set(line.accountCode, (perAccount.get(line.accountCode) ?? 0n) + delta);
    }
  }
  return perAccount;
}

export function accountBalance(
  entries: readonly JournalEntry[],
  book: Book,
  accountCode: string,
  asOfPeriod: PeriodRef,
): { balance: ExactMoney; side: "debit" | "credit" } {
  const net = foldAccountUnits(entries, asOfPeriod).get(accountCode) ?? 0n;
  const { code, scale } = book.functionalCurrency;
  return {
    balance: exactMoneyFromMinorUnits(net < 0n ? -net : net, code, scale),
    side: net < 0n ? "credit" : "debit",
  };
}

export function produceTrialBalance(
  entries: readonly JournalEntry[],
  book: Book,
  chart: ChartOfAccountsVersion,
  periodRef: PeriodRef,
): TrialBalance {
  const { code, scale } = book.functionalCurrency;
  const zero = exactMoneyFromMinorUnits(0n, code, scale);
  const accountByCode = new Map(chart.accounts.map((a) => [a.accountCode, a] as const));

  const debitTotals = new Map<string, bigint>();
  const creditTotals = new Map<string, bigint>();
  for (const entry of entries) {
    if (comparePeriodRefs(entry.periodRef, periodRef) > 0) continue;
    for (const line of entry.lines) {
      if (!line.functionalAmount) continue;
      const units = exactMinorUnits(line.functionalAmount);
      const target = line.side === "debit" ? debitTotals : creditTotals;
      target.set(line.accountCode, (target.get(line.accountCode) ?? 0n) + units);
    }
  }

  const codes = [...new Set([...debitTotals.keys(), ...creditTotals.keys()])].sort();
  const rows: TrialBalanceRow[] = codes.map((accountCode) => {
    const debit = debitTotals.get(accountCode) ?? 0n;
    const credit = creditTotals.get(accountCode) ?? 0n;
    const net = debit - credit;
    const account = accountByCode.get(accountCode);
    return {
      accountCode,
      accountClass: account ? account.accountClass : "asset",
      debitTotal: exactMoneyFromMinorUnits(debit, code, scale),
      creditTotal: exactMoneyFromMinorUnits(credit, code, scale),
      net: exactMoneyFromMinorUnits(net < 0n ? -net : net, code, scale),
      netSide: net < 0n ? "credit" : "debit",
    };
  });

  let totalDebits = zero;
  let totalCredits = zero;
  for (const row of rows) {
    totalDebits = addExactMoney(totalDebits, row.debitTotal);
    totalCredits = addExactMoney(totalCredits, row.creditTotal);
  }

  return {
    bookId: book.bookId,
    periodRef,
    rows,
    totalDebits,
    totalCredits,
    foots: exactMinorUnits(totalDebits) === exactMinorUnits(totalCredits),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER-OPENING-BALANCE/1.0.0 — year-end roll-forward (§16.8).
//
// The roll-forward is ITSELF journal entries — never a magic balance carried
// outside the journal — so replay from genesis reproduces it and an auditor
// can see it. Balance-sheet classes roll forward; income-statement classes
// close to retained earnings.
// ─────────────────────────────────────────────────────────────────────────────

export interface RollForwardLines {
  /** Lines for the `closing` entry in the final period: P&L accounts zeroed to retained earnings. */
  readonly closingLines: readonly { accountCode: string; side: "debit" | "credit"; amount: ExactMoney }[];
  /** Lines for the `opening` entry in the new year's first period: balance-sheet accounts restated. */
  readonly openingLines: readonly { accountCode: string; side: "debit" | "credit"; amount: ExactMoney }[];
}

export function computeRollForward(
  entries: readonly JournalEntry[],
  book: Book,
  chart: ChartOfAccountsVersion,
  finalPeriodOfYear: PeriodRef,
): RollForwardLines {
  if (!book.retainedEarningsAccount) {
    throw new Error(
      "The book declares no retainedEarningsAccount; the year cannot close. Declare one — nothing defaults.",
    );
  }
  const { code, scale } = book.functionalCurrency;
  const accountByCode = new Map(chart.accounts.map((a) => [a.accountCode, a] as const));
  const perAccount = foldAccountUnits(entries, finalPeriodOfYear);

  const closingLines: { accountCode: string; side: "debit" | "credit"; amount: ExactMoney }[] = [];
  const openingLines: { accountCode: string; side: "debit" | "credit"; amount: ExactMoney }[] = [];
  let retainedNet = 0n;

  for (const [accountCode, net] of [...perAccount.entries()].sort()) {
    if (net === 0n) continue;
    const account = accountByCode.get(accountCode);
    if (!account || account.accountClass === "statistical") continue;
    const abs = net < 0n ? -net : net;
    const amount = exactMoneyFromMinorUnits(abs, code, scale);
    if (account.accountClass === "income" || account.accountClass === "expense") {
      // Zero the P&L account: post the opposite of its net.
      closingLines.push({ accountCode, side: net > 0n ? "credit" : "debit", amount });
      retainedNet += net;
    } else {
      // Restate the balance-sheet account in the new year at its net.
      openingLines.push({ accountCode, side: net > 0n ? "debit" : "credit", amount });
    }
  }

  if (retainedNet !== 0n) {
    const abs = retainedNet < 0n ? -retainedNet : retainedNet;
    // The counter-side of zeroing the P&L: income (credit-natured, net < 0)
    // closes as a credit to retained earnings.
    closingLines.push({
      accountCode: book.retainedEarningsAccount,
      side: retainedNet > 0n ? "debit" : "credit",
      amount: exactMoneyFromMinorUnits(abs, code, scale),
    });
    // And retained earnings opens the new year including the result.
    const existingRe = perAccount.get(book.retainedEarningsAccount) ?? 0n;
    const opening = existingRe + retainedNet;
    if (opening !== 0n) {
      const openingAbs = opening < 0n ? -opening : opening;
      // Replace any raw retained-earnings opening line with the combined one.
      const index = openingLines.findIndex((l) => l.accountCode === book.retainedEarningsAccount);
      if (index >= 0) openingLines.splice(index, 1);
      openingLines.push({
        accountCode: book.retainedEarningsAccount,
        side: opening > 0n ? "debit" : "credit",
        amount: exactMoneyFromMinorUnits(openingAbs, code, scale),
      });
    }
  }

  return { closingLines, openingLines };
}

// ─────────────────────────────────────────────────────────────────────────────
// LEDGER-EXPORT-PROJECTION/1.0.0 — the canonical statutory projection (§21.4).
// LedgerIQ owns HAVING every field a statutory export needs; hosts render the
// national formats (FEC, SAF-T) from these rows.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportRow {
  readonly journalCode: string;
  readonly entryId: string;
  readonly journalSequence: number;
  readonly effectiveDate: string;
  readonly accountCode: string;
  readonly accountLabel: string;
  readonly auxiliaryRef: string | undefined;
  readonly pieceRef: string;
  readonly description: string | undefined;
  readonly debit: ExactMoney | undefined;
  readonly credit: ExactMoney | undefined;
  readonly matchingRef: string | undefined;
  readonly validDate: string;
  readonly transactionAmount: ExactMoney | undefined;
  readonly transactionCurrency: string | undefined;
  readonly entityRef: string;
  readonly periodRef: PeriodRef;
  readonly postedBy: string;
  readonly entryType: string;
  readonly dimensions: Readonly<Record<string, string>>;
}

/** Chronological, journal by journal — the FEC ordering requirement. */
export function exportProjection(
  entries: readonly JournalEntry[],
  book: Book,
  chart: ChartOfAccountsVersion,
): ExportRow[] {
  const accountByCode = new Map(chart.accounts.map((a) => [a.accountCode, a] as const));
  const ordered = [...entries].sort(
    (a, b) =>
      (a.journalCode < b.journalCode ? -1 : a.journalCode > b.journalCode ? 1 : 0) ||
      a.journalSequence - b.journalSequence,
  );
  const rows: ExportRow[] = [];
  for (const entry of ordered) {
    for (const line of entry.lines) {
      const account = accountByCode.get(line.accountCode);
      rows.push({
        journalCode: entry.journalCode,
        entryId: entry.entryId,
        journalSequence: entry.journalSequence,
        effectiveDate: entry.effectiveDate,
        accountCode: line.accountCode,
        accountLabel: account?.labels[0]?.text ?? line.accountCode,
        auxiliaryRef: line.openItemRef,
        pieceRef: entry.proposalId,
        description: line.lineMemo?.text,
        debit: line.side === "debit" ? line.functionalAmount : undefined,
        credit: line.side === "credit" ? line.functionalAmount : undefined,
        // Matching/lettering is a SUB-LEDGER concept: carried opaquely,
        // populated by the sub-ledger engine's data at the host (§21.4, KL-4).
        matchingRef: line.openItemRef,
        validDate: entry.recordedAt,
        transactionAmount: line.transactionAmount,
        transactionCurrency: line.transactionAmount?.currency,
        entityRef: book.entityRef,
        periodRef: entry.periodRef,
        postedBy: entry.postedByPrincipal,
        entryType: entry.entryType,
        dimensions: line.dimensions,
      });
    }
  }
  return rows;
}
