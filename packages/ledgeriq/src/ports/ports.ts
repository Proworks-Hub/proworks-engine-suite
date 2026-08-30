// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ExchangeRateRef, FxRateType } from "@proworks-hub/contracts";

import type {
  AccountingCalendar,
  Book,
  ChartOfAccountsVersion,
  DimensionSchema,
  JournalEntry,
  PeriodRef,
  PeriodState,
  PeriodStateTransition,
} from "../model/model.js";

// ─────────────────────────────────────────────────────────────────────────────
// Ports — interfaces only, implementations belong to hosts (§21).
//
// THERE IS NO `updateEntry`. THERE IS NO `deleteEntry`. The interface does not
// have them. Immutability is a type-system property, not a policy someone
// remembers — the same choice auditiq already made.
//
// Durability contract the host must provide (§21.2) — stated here because an
// implicit assumption is discovered in production:
//   1. `appendEntry` is atomic across all lines: every line durable or none.
//   2. `appendEntry` is linearizable per bookId and honours
//      `expectedBookVersion`, returning "conflict" the engine surfaces as
//      CONCURRENT_MODIFICATION. Optimistic — reads must not block.
//   3. `findEntryByIdempotencyKey` is read-your-writes consistent with
//      `appendEntry`, or replay detection races and double-posts under retry.
//   4. `nextJournalSequence` is GAPLESS and monotonic per journal per fiscal
//      year — not merely unique. Statutory examiners read sequences; a gap is
//      a question.
//   5. Failure is reported, never swallowed: a store error surfaces as
//      STORE_UNAVAILABLE and health reports `unknown`, not `healthy`.
// ─────────────────────────────────────────────────────────────────────────────

export type AppendResult =
  | {
      readonly outcome: "appended";
      readonly bookVersion: number;
      /**
       * Assigned INSIDE the atomic append, not by a separate call — a
       * reserved-then-conflicted sequence would be a gap, and obligation 4
       * says gapless. This is why `appendEntry` takes the entry without its
       * sequence and returns the one it consumed.
       */
      readonly journalSequence: number;
    }
  | { readonly outcome: "conflict" };

export interface LedgerStore {
  getBook(bookId: string): Promise<Book | undefined>;
  getChartVersions(chartRef: string): Promise<readonly ChartOfAccountsVersion[]>;
  getCalendar(calendarRef: string): Promise<AccountingCalendar | undefined>;
  getDimensionSchema(schemaRef: string): Promise<DimensionSchema | undefined>;
  /** The book's optimistic version, for expectedBookVersion. */
  getBookVersion(bookId: string): Promise<number>;
  findEntryByIdempotencyKey(
    bookId: string,
    idempotencyKey: string,
  ): Promise<JournalEntry | undefined>;
  findEntryById(bookId: string, entryId: string): Promise<JournalEntry | undefined>;
  /** Atomic across lines; linearizable per book; assigns the gapless journalSequence within the same atom. */
  appendEntry(
    entry: Omit<JournalEntry, "journalSequence">,
    expectedBookVersion: number,
  ): Promise<AppendResult>;
  /** Marks the target of a reversal as reversed. The ONLY mutation, and it sets a previously-absent field once. */
  markReversed(bookId: string, targetEntryId: string, reversedBy: string): Promise<void>;
  readEntries(bookId: string): Promise<readonly JournalEntry[]>;
  getPeriodState(bookId: string, periodRef: PeriodRef): Promise<PeriodState | undefined>;
  getAllPeriodStates(bookId: string): Promise<Readonly<Record<string, PeriodState>>>;
  /** Compare-and-set: fails when the current state is not `expectedState`. */
  appendPeriodStateTransition(
    bookId: string,
    periodRef: PeriodRef,
    transition: PeriodStateTransition,
    expectedState: PeriodState,
  ): Promise<"applied" | "conflict">;
  getPeriodStateHistory(bookId: string, periodRef: PeriodRef): Promise<readonly PeriodStateTransition[]>;
  /** GAPLESS, monotonic per (bookId, journalCode, fiscalYear). */
  nextJournalSequence(bookId: string, journalCode: string, fiscalYear: number): Promise<number>;
}

/**
 * FX rates arrive through a port, by value, with source and effective date
 * (LOCK-4: connectivity is IntegrationIQ's; LedgerIQ holds no credential).
 * Unbound today in every installation — and the engine refuses rather than
 * assuming a rate of 1.0.
 */
export interface FxRateSource {
  /** Every rate with base in `bases`, quoted in `quote`, usable at `effectiveDate` for `rateType`. */
  ratesFor(
    bases: readonly string[],
    quote: string,
    effectiveDate: string,
    rateType: FxRateType,
  ): Promise<readonly ExchangeRateRef[]>;
}

/**
 * Resolves a human principal for manual entries (AS 2401). Unbound today:
 * manual entries are refused rather than recorded anonymously (§32.2).
 */
export interface PrincipalResolver {
  resolveHuman(principal: string): Promise<string | undefined>;
}
