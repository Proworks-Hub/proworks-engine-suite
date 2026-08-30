// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

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
import type { AppendResult, LedgerStore } from "../ports/ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// The reference in-memory LedgerStore — for tests and for hosts that have not
// yet bound a durable store. Honours the §21.2 durability contract to the
// extent memory can: atomic append, optimistic version check, read-your-writes
// replay lookup, gapless sequences. What memory cannot honour — durability
// across a restart — it does not pretend to.
// ─────────────────────────────────────────────────────────────────────────────

export interface InMemoryLedgerFixtures {
  readonly books: readonly Book[];
  readonly chartVersions: Readonly<Record<string, readonly ChartOfAccountsVersion[]>>;
  readonly calendars: readonly AccountingCalendar[];
  readonly dimensionSchemas?: readonly DimensionSchema[];
  /** Initial period states, keyed `${bookId}:${fiscalYear}-${periodNumber}`. */
  readonly periodStates?: Readonly<Record<string, PeriodState>>;
}

export function createInMemoryLedgerStore(fixtures: InMemoryLedgerFixtures): LedgerStore & {
  /** Test-only visibility: every appended entry, in append order. */
  appendedEntries(): readonly JournalEntry[];
} {
  const books = new Map(fixtures.books.map((b) => [b.bookId, b] as const));
  const calendars = new Map(fixtures.calendars.map((c) => [c.calendarRef, c] as const));
  const dimensionSchemas = new Map(
    (fixtures.dimensionSchemas ?? []).map((d) => [d.schemaRef, d] as const),
  );
  const entries: JournalEntry[] = [];
  const byIdempotencyKey = new Map<string, JournalEntry>();
  const byEntryId = new Map<string, JournalEntry>();
  const bookVersions = new Map<string, number>();
  const periodStates = new Map<string, PeriodState>(
    Object.entries(fixtures.periodStates ?? {}),
  );
  const periodHistory = new Map<string, PeriodStateTransition[]>();
  const sequences = new Map<string, number>();

  const stateKey = (bookId: string, p: PeriodRef) => `${bookId}:${p.fiscalYear}-${p.periodNumber}`;

  return {
    getBook: async (bookId) => books.get(bookId),
    getChartVersions: async (chartRef) => fixtures.chartVersions[chartRef] ?? [],
    getCalendar: async (calendarRef) => calendars.get(calendarRef),
    getDimensionSchema: async (schemaRef) => dimensionSchemas.get(schemaRef),
    getBookVersion: async (bookId) => bookVersions.get(bookId) ?? 0,

    findEntryByIdempotencyKey: async (bookId, key) => byIdempotencyKey.get(`${bookId}:${key}`),
    findEntryById: async (bookId, entryId) => {
      const found = byEntryId.get(entryId);
      return found && found.bookId === bookId ? found : undefined;
    },

    appendEntry: async (entry, expectedBookVersion): Promise<AppendResult> => {
      const current = bookVersions.get(entry.bookId) ?? 0;
      if (current !== expectedBookVersion) return { outcome: "conflict" };
      // Atomic in memory: everything below is synchronous — including the
      // sequence, consumed inside the same atom so it stays gapless.
      const seqKey = `${entry.bookId}:${entry.journalCode}:${entry.periodRef.fiscalYear}`;
      const journalSequence = (sequences.get(seqKey) ?? 0) + 1;
      sequences.set(seqKey, journalSequence);
      const complete: JournalEntry = { ...entry, journalSequence };
      entries.push(complete);
      byIdempotencyKey.set(`${entry.bookId}:${entry.idempotencyKey}`, complete);
      byEntryId.set(entry.entryId, complete);
      bookVersions.set(entry.bookId, current + 1);
      return { outcome: "appended", bookVersion: current + 1, journalSequence };
    },

    markReversed: async (bookId, targetEntryId, reversedBy) => {
      const target = byEntryId.get(targetEntryId);
      if (target && target.bookId === bookId) {
        // The one mutation: sets a previously-absent field, once. The entry's
        // lines and amounts never change.
        const updated: JournalEntry = { ...target, reversedBy };
        byEntryId.set(targetEntryId, updated);
        byIdempotencyKey.set(`${bookId}:${target.idempotencyKey}`, updated);
        const index = entries.findIndex((e) => e.entryId === targetEntryId);
        if (index >= 0) entries[index] = updated;
      }
    },

    readEntries: async (bookId) => entries.filter((e) => e.bookId === bookId),

    getPeriodState: async (bookId, periodRef) => periodStates.get(stateKey(bookId, periodRef)),
    getAllPeriodStates: async (bookId) => {
      const result: Record<string, PeriodState> = {};
      for (const [key, state] of periodStates) {
        if (key.startsWith(`${bookId}:`)) result[key.slice(bookId.length + 1)] = state;
      }
      return result;
    },

    appendPeriodStateTransition: async (bookId, periodRef, transition, expectedState) => {
      const key = stateKey(bookId, periodRef);
      const current = periodStates.get(key) ?? "future";
      if (current !== expectedState) return "conflict";
      periodStates.set(key, transition.to);
      const history = periodHistory.get(key) ?? [];
      history.push(transition);
      periodHistory.set(key, history);
      return "applied";
    },

    getPeriodStateHistory: async (bookId, periodRef) =>
      periodHistory.get(stateKey(bookId, periodRef)) ?? [],

    nextJournalSequence: async (bookId, journalCode, fiscalYear) => {
      const key = `${bookId}:${journalCode}:${fiscalYear}`;
      const next = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, next);
      return next;
    },

    appendedEntries: () => entries,
  };
}
