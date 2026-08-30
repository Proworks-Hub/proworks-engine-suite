// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  postingProposalSchema,
  type ExactMoney,
  type FxRateType,
  type MethodRef,
} from "@proworks-hub/contracts";

import { refusal, type LedgerRefusal } from "../contractsLocal/refusals.js";
import {
  accountBalance,
  exportProjection,
  produceTrialBalance,
  type ExportRow,
  type TrialBalance,
} from "../kernel/balance.js";
import { LEDGER_METHODS } from "../kernel/methods.js";
import { findTransition, meetsRiskFloor } from "../kernel/period.js";
import {
  authorizationSatisfies,
  validateProposal,
  type LedgerSnapshot,
  type SuppliedAuthorization,
} from "../kernel/validation.js";
import type {
  ChartOfAccountsVersion,
  JournalEntry,
  JournalLine,
  PeriodRef,
  PeriodState,
} from "../model/model.js";
import type { FxRateSource, LedgerStore, PrincipalResolver } from "../ports/ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// The impure shell — thin by design. It loads a snapshot, runs the pure
// kernel, and performs gates 29–30 (the only I/O): the optimistic append and
// store availability. All time arrives as explicit arguments; this file reads
// no clock.
//
// Not yet wired (recorded honestly, hiveMap gap + DEC-025 debt): event
// publication (`ledger.entry.posted` …) through platform-events, and the
// auditiq immutability chain. Posting is authoritative in the STORE — an
// event is evidence, and its absence never rolls back a durable posting.
// ─────────────────────────────────────────────────────────────────────────────

const V = LEDGER_METHODS.proposalValidation;

/** Sums a posted entry's functional lines by side — read by the replay response. */
function functionalTotalsOf(
  entry: JournalEntry,
  functional: { code: string; scale: number },
): { debits: ExactMoney; credits: ExactMoney } {
  let debits = 0n;
  let credits = 0n;
  for (const line of entry.lines) {
    if (!line.functionalAmount) continue;
    const units = exactMinorUnits(line.functionalAmount);
    if (line.side === "debit") debits += units;
    else credits += units;
  }
  return {
    debits: exactMoneyFromMinorUnits(debits, functional.code, functional.scale),
    credits: exactMoneyFromMinorUnits(credits, functional.code, functional.scale),
  };
}

export interface LedgerRuntimeOptions {
  readonly store: LedgerStore;
  /** Unbound today in every installation. The engine refuses, never assumes 1.0. */
  readonly fxRateSource?: FxRateSource;
  readonly principalResolver?: PrincipalResolver;
  /** ISO-4217 → scale. Configuration, never hard-coded, never defaulted. */
  readonly currencyRegistry: Readonly<Record<string, number>>;
  /** Optimistic-append retries before surfacing CONCURRENT_MODIFICATION. */
  readonly maxAppendRetries?: number;
}

export type PostOutcome =
  | {
      readonly posted: true;
      readonly entryId: string;
      readonly journalSequence: number;
      readonly functionalTotals: { readonly debits: ExactMoney; readonly credits: ExactMoney };
      readonly postingMethodRefs: readonly MethodRef[];
      readonly replay: boolean;
    }
  | { readonly posted: false; readonly refusal: LedgerRefusal };

export type DryRunOutcome =
  | {
      readonly wouldPost: true;
      readonly projectedLines: readonly JournalLine[];
      readonly projectedResidue: readonly JournalLine[];
      readonly methodRefs: readonly MethodRef[];
    }
  | { readonly wouldPost: false; readonly refusal: LedgerRefusal };

export type PeriodOutcome =
  | { readonly ok: true; readonly state: PeriodState }
  | { readonly ok: false; readonly refusal: LedgerRefusal };

export interface LedgerRuntime {
  post(input: {
    proposal: unknown;
    recordedAt: string;
    authorization?: SuppliedAuthorization;
  }): Promise<PostOutcome>;
  /** Gates 1–28 with projected lines and NO write. */
  validate(input: {
    proposal: unknown;
    recordedAt: string;
    authorization?: SuppliedAuthorization;
  }): Promise<DryRunOutcome>;
  reverse(input: {
    bookId: string;
    entryId: string;
    reversalPeriodRef?: PeriodRef;
    recordedAt: string;
    reason: string;
    requestedBy: string;
  }): Promise<PostOutcome>;
  closePeriod(input: {
    bookId: string;
    periodRef: PeriodRef;
    recordedAt: string;
    actor: string;
    authorization?: SuppliedAuthorization;
  }): Promise<PeriodOutcome>;
  reopenPeriod(input: {
    bookId: string;
    periodRef: PeriodRef;
    recordedAt: string;
    actor: string;
    reason: string;
    authorization?: SuppliedAuthorization;
  }): Promise<PeriodOutcome>;
  readAccountBalance(input: {
    bookId: string;
    accountCode: string;
    asOfPeriodRef: PeriodRef;
  }): Promise<
    | { readonly ok: true; readonly balance: ExactMoney; readonly side: "debit" | "credit" }
    | { readonly ok: false; readonly refusal: LedgerRefusal }
  >;
  produceTrialBalance(input: {
    bookId: string;
    periodRef: PeriodRef;
  }): Promise<{ readonly ok: true; readonly trialBalance: TrialBalance } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
  readChartOfAccounts(input: {
    bookId: string;
    asOfDate: string;
  }): Promise<
    | { readonly ok: true; readonly chart: ChartOfAccountsVersion }
    | { readonly ok: false; readonly refusal: LedgerRefusal }
  >;
  exportRows(input: {
    bookId: string;
  }): Promise<{ readonly ok: true; readonly rows: readonly ExportRow[] } | { readonly ok: false; readonly refusal: LedgerRefusal }>;
  /**
   * The typed answer to "derive my US GAAP entry from my IFRS entry": no.
   * Deriving one book's amounts from another's requires knowing the
   * accounting difference, which is the originating engine's domain (§16.9).
   */
  deriveParallelBookEntry(): { readonly ok: false; readonly refusal: LedgerRefusal };
  /** healthy | degraded (FX port unbound) | unknown (store unreachable). Unknown ≠ healthy. */
  health(): Promise<{ readonly healthy: boolean | null; readonly detail: string }>;
}

export function createLedgerRuntime(options: LedgerRuntimeOptions): LedgerRuntime {
  const { store } = options;
  const maxRetries = options.maxAppendRetries ?? 3;
  /** Books×periods with a post mid-append — read by closePeriod's PROPOSAL_IN_FLIGHT. */
  const inFlight = new Set<string>();
  /**
   * Per-book write serialization. The optimistic version check (§21.2 rule 2)
   * still runs — an EXTERNAL writer to the same store is caught — but posts
   * through THIS runtime queue per book instead of burning retries against
   * each other. Sixty-four concurrent writers post sixty-four entries with
   * gapless sequences (IT-11), which retries alone cannot guarantee.
   */
  const bookQueues = new Map<string, Promise<unknown>>();
  function serialized<T>(bookId: string | undefined, work: () => Promise<T>): Promise<T> {
    if (!bookId) return work();
    const tail = bookQueues.get(bookId) ?? Promise.resolve();
    const next = tail.then(work, work);
    bookQueues.set(bookId, next.catch(() => undefined));
    return next;
  }

  const stateKey = (p: PeriodRef) => `${p.fiscalYear}-${p.periodNumber}`;

  const storeUnavailable = (cause: unknown): LedgerRefusal =>
    refusal(
      "STORE_UNAVAILABLE",
      V,
      `The ledger store did not answer: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was posted; retry when the store is reachable.`,
    );

  async function loadSnapshot(
    proposal: unknown,
    forReversalTarget?: string,
  ): Promise<{ snapshot: LedgerSnapshot; bookVersion: number } | { error: LedgerRefusal }> {
    // A pre-parse peek at bookId/periodRef; the kernel re-parses authoritatively.
    const peek = postingProposalSchema.safeParse(proposal);
    const bookId = peek.success ? peek.data.bookId : undefined;
    try {
      const book = bookId ? await store.getBook(bookId) : undefined;
      const chartVersions = book ? await store.getChartVersions(book.chartRef) : [];
      const calendar = book ? await store.getCalendar(book.calendarRef) : undefined;
      const dimensionSchema =
        book && book.dimensionSchemaRef
          ? await store.getDimensionSchema(book.dimensionSchemaRef)
          : undefined;
      const periodStates = book ? await store.getAllPeriodStates(book.bookId) : {};
      const bookVersion = book ? await store.getBookVersion(book.bookId) : 0;

      const existing =
        book && peek.success && peek.data.idempotencyKey
          ? await store.findEntryByIdempotencyKey(book.bookId, peek.data.idempotencyKey)
          : undefined;

      const reversalId = forReversalTarget ?? (peek.success ? peek.data.reversalOf : undefined);
      const reversalTarget =
        book && reversalId ? await store.findEntryById(book.bookId, reversalId) : undefined;

      // Prefetch FX rates for the pure ladder. Distinct facts stay distinct:
      // no port bound vs. a bound port with no rate.
      let fxRates: LedgerSnapshot["fxRates"] = "port-unbound";
      if (options.fxRateSource && book && peek.success) {
        const foreign = [
          ...new Set(
            peek.data.lines
              .map((l) => l.amount?.currency)
              .filter(
                (c): c is string => c !== undefined && c !== book.functionalCurrency.code,
              ),
          ),
        ];
        const rateType: FxRateType | undefined = book.fxRateType ?? peek.data.fxRateType;
        fxRates =
          foreign.length === 0 || rateType === undefined
            ? []
            : await options.fxRateSource.ratesFor(
                foreign,
                book.functionalCurrency.code,
                peek.data.effectiveDate,
                rateType,
              );
      }

      // Resolve the human principal for manual entries, when a resolver is bound.
      let resolvedPrincipal: string | undefined;
      if (
        peek.success &&
        (peek.data.entrySource ?? "automated") === "manual" &&
        peek.data.principal &&
        options.principalResolver
      ) {
        resolvedPrincipal = await options.principalResolver.resolveHuman(peek.data.principal);
      }

      return {
        bookVersion,
        snapshot: {
          book,
          chartVersions,
          calendar,
          dimensionSchema,
          periodStates,
          currencyRegistry: options.currencyRegistry,
          ...(existing
            ? { existingForKey: { entryId: existing.entryId, contentHash: existing.contentHash } }
            : {}),
          ...(reversalTarget ? { reversalTarget } : {}),
          fxRates,
          ...(resolvedPrincipal !== undefined ? { resolvedPrincipal } : {}),
        },
      };
    } catch (cause) {
      return { error: storeUnavailable(cause) };
    }
  }

  async function postValidated(input: {
    proposal: unknown;
    recordedAt: string;
    authorization?: SuppliedAuthorization;
    forReversalTarget?: string;
  }): Promise<PostOutcome> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const loaded = await loadSnapshot(input.proposal, input.forReversalTarget);
      if ("error" in loaded) return { posted: false, refusal: loaded.error };

      const outcome = validateProposal({
        proposal: input.proposal,
        recordedAt: input.recordedAt,
        snapshot: loaded.snapshot,
        ...(input.authorization ? { authorization: input.authorization } : {}),
      });
      if (!outcome.ok) return { posted: false, refusal: outcome.refusal };
      if (outcome.replay) {
        // The retry found its original: return the ORIGINAL posting's facts.
        // The caller must treat replay as success — nothing posted twice.
        const book = loaded.snapshot.book as NonNullable<LedgerSnapshot["book"]>;
        let original: JournalEntry | undefined;
        try {
          original = await store.findEntryById(book.bookId, outcome.entryId);
        } catch (cause) {
          return { posted: false, refusal: storeUnavailable(cause) };
        }
        if (!original) {
          return { posted: false, refusal: storeUnavailable("replay target vanished mid-read") };
        }
        return {
          posted: true,
          entryId: original.entryId,
          journalSequence: original.journalSequence,
          functionalTotals: functionalTotalsOf(original, {
            code: book.functionalCurrency.code,
            scale: book.functionalCurrency.scale,
          }),
          postingMethodRefs: original.postingMethodRefs,
          replay: true,
        };
      }

      const flightKey = `${outcome.entry.bookId}:${stateKey(outcome.entry.periodRef)}`;
      inFlight.add(flightKey);
      try {
        const appended = await store.appendEntry(outcome.entry, loaded.bookVersion);
        if (appended.outcome === "conflict") {
          if (attempt < maxRetries) continue; // reload and revalidate — replay may now exist
          return {
            posted: false,
            refusal: refusal(
              "CONCURRENT_MODIFICATION",
              V,
              "The book changed underneath this posting on every attempt. Retry; the idempotency key makes the retry safe.",
            ),
          };
        }
        if (input.forReversalTarget) {
          await store.markReversed(
            outcome.entry.bookId,
            input.forReversalTarget,
            outcome.entry.entryId,
          );
        }
        return {
          posted: true,
          entryId: outcome.entry.entryId,
          journalSequence: appended.journalSequence,
          functionalTotals: outcome.functionalTotals,
          postingMethodRefs: outcome.entry.postingMethodRefs,
          replay: false,
        };
      } catch (cause) {
        return { posted: false, refusal: storeUnavailable(cause) };
      } finally {
        inFlight.delete(flightKey);
      }
    }
    // Unreachable: the loop always returns. Stated for the type system.
    return {
      posted: false,
      refusal: refusal("CONCURRENT_MODIFICATION", V, "Retry."),
    };
  }

  return {
    post: (input) => {
      const peek = postingProposalSchema.safeParse(input.proposal);
      return serialized(peek.success ? peek.data.bookId : undefined, () => postValidated(input));
    },

    async validate(input) {
      const loaded = await loadSnapshot(input.proposal);
      if ("error" in loaded) return { wouldPost: false, refusal: loaded.error };
      const outcome = validateProposal({
        proposal: input.proposal,
        recordedAt: input.recordedAt,
        snapshot: loaded.snapshot,
        ...(input.authorization ? { authorization: input.authorization } : {}),
      });
      if (!outcome.ok) return { wouldPost: false, refusal: outcome.refusal };
      if (outcome.replay) {
        // A dry run of an already-posted key "would post" as a replay.
        return { wouldPost: true, projectedLines: [], projectedResidue: [], methodRefs: [] };
      }
      return {
        wouldPost: true,
        projectedLines: outcome.entry.lines,
        projectedResidue: outcome.generatedLines,
        methodRefs: outcome.entry.postingMethodRefs,
      };
    },

    async reverse(input) {
      let target: JournalEntry | undefined;
      try {
        target = await store.findEntryById(input.bookId, input.entryId);
      } catch (cause) {
        return { posted: false, refusal: storeUnavailable(cause) };
      }
      if (!target) {
        return {
          posted: false,
          refusal: refusal(
            "REVERSAL_TARGET_NOT_FOUND",
            LEDGER_METHODS.reversal,
            "Name a posted entry of this book.",
            input.entryId,
          ),
        };
      }
      if (target.reversedBy !== undefined) {
        // Checked BEFORE building the proposal: a second reversal attempt
        // must hear "already reversed", not replay the first one.
        return {
          posted: false,
          refusal: refusal(
            "REVERSAL_TARGET_ALREADY_REVERSED",
            LEDGER_METHODS.reversal,
            `Already reversed by ${target.reversedBy}. An entry is reversed at most once; reverse the reversal to reinstate.`,
            input.entryId,
          ),
        };
      }
      let book;
      try {
        book = await store.getBook(input.bookId);
      } catch (cause) {
        return { posted: false, refusal: storeUnavailable(cause) };
      }
      if (!book) {
        return {
          posted: false,
          refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
        };
      }

      // Reversal dating: an explicit reversal period dates the reversal at
      // that period's start (LEDGER-REVERSAL's `specified-period` dating);
      // absent, the reversal lands in the original period on the original date.
      let reversalEffectiveDate = target.effectiveDate;
      if (input.reversalPeriodRef) {
        let calendar;
        try {
          calendar = await store.getCalendar(book.calendarRef);
        } catch (cause) {
          return { posted: false, refusal: storeUnavailable(cause) };
        }
        const period = calendar?.periods.find(
          (p) =>
            p.periodRef.fiscalYear === input.reversalPeriodRef?.fiscalYear &&
            p.periodRef.periodNumber === input.reversalPeriodRef?.periodNumber,
        );
        if (!period) {
          return {
            posted: false,
            refusal: refusal(
              "PERIOD_NOT_FOUND",
              LEDGER_METHODS.reversal,
              "The reversal period is not in the book's calendar.",
            ),
          };
        }
        reversalEffectiveDate = period.startDate;
      }

      // LEDGER-REVERSAL/1.0.0: construct the reversing proposal per the
      // book's declared method. switch-side flips debit/credit; change-sign
      // keeps the side with a negated amount (exports badly to FEC, which is
      // why switch-side is the common declaration).
      const negate = (m: ExactMoney): ExactMoney => ({
        ...m,
        amount: m.amount.startsWith("-") ? m.amount.slice(1) : `-${m.amount}`,
      });
      const lines = target.lines
        .filter((l) => l.generatedBy === undefined)
        .map((l, index) => ({
          lineNo: index + 1,
          accountCode: l.accountCode,
          side:
            book.reversalMethod === "switch-side"
              ? l.side === "debit"
                ? ("credit" as const)
                : ("debit" as const)
              : l.side,
          ...(l.transactionAmount
            ? {
                amount:
                  book.reversalMethod === "change-sign"
                    ? negate(l.transactionAmount)
                    : l.transactionAmount,
              }
            : {}),
          ...(l.statisticalQuantity ? { statisticalQuantity: l.statisticalQuantity } : {}),
          dimensions: l.dimensions,
          ...(l.openItemRef ? { openItemRef: l.openItemRef } : {}),
        }));

      const proposal = {
        proposalId: `reversal:${target.entryId}`,
        proposedBy: input.requestedBy,
        bookId: input.bookId,
        journalCode: target.journalCode,
        entryType: "reversal",
        lines,
        effectiveDate: reversalEffectiveDate,
        periodRef: input.reversalPeriodRef ?? target.periodRef,
        methodRef: LEDGER_METHODS.reversal,
        evidence: [],
        trace: target.trace,
        idempotencyKey: `reversal:${target.entryId}`,
        reversalOf: target.entryId,
      };

      const outcome = await serialized(input.bookId, () =>
        postValidated({
          proposal,
          recordedAt: input.recordedAt,
          forReversalTarget: target.entryId,
        }),
      );
      if (!outcome.posted) {
        // A reversal aimed at a closed period is its own condition, named so
        // the operator hears "the reversal cannot land there", not "period".
        const periodCodes = [
          "PERIOD_CLOSED",
          "PERIOD_PERMANENTLY_CLOSED",
          "PERIOD_PENDING_CLOSE",
          "PERIOD_FUTURE",
          "EFFECTIVE_DATE_OUTSIDE_PERIOD",
        ];
        if (periodCodes.includes(outcome.refusal.code)) {
          return {
            posted: false,
            refusal: refusal(
              "REVERSAL_PERIOD_CLOSED",
              LEDGER_METHODS.reversal,
              "The reversal period does not admit it. Reverse into an open period via reversalPeriodRef.",
              outcome.refusal.offending,
            ),
          };
        }
      }
      return outcome;
    },

    async closePeriod(input) {
      return transitionPeriod({
        ...input,
        to: "closed",
        purpose: `close_ledger_period:${input.bookId}:${stateKey(input.periodRef)}`,
      });
    },

    async reopenPeriod(input) {
      return transitionPeriod({
        ...input,
        to: "open",
        purpose: `reopen_ledger_period:${input.bookId}:${stateKey(input.periodRef)}`,
      });
    },

    async readAccountBalance(input) {
      try {
        const book = await store.getBook(input.bookId);
        if (!book) {
          return {
            ok: false,
            refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
          };
        }
        // An adjustment-only book's balance folds base + delta (§16.9).
        let entries = [...(await store.readEntries(input.bookId))];
        if (book.bookRole === "adjustment-only" && book.baseBookRef) {
          entries = [...(await store.readEntries(book.baseBookRef)), ...entries];
        }
        const { balance, side } = accountBalance(entries, book, input.accountCode, input.asOfPeriodRef);
        return { ok: true, balance, side };
      } catch (cause) {
        return { ok: false, refusal: storeUnavailable(cause) };
      }
    },

    async produceTrialBalance(input) {
      try {
        const book = await store.getBook(input.bookId);
        if (!book) {
          return {
            ok: false,
            refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
          };
        }
        const chart = (await store.getChartVersions(book.chartRef))[0];
        if (!chart) {
          return {
            ok: false,
            refusal: refusal("ACCOUNT_UNKNOWN", V, "The book's chart has no versions.", book.chartRef),
          };
        }
        let entries = [...(await store.readEntries(input.bookId))];
        if (book.bookRole === "adjustment-only" && book.baseBookRef) {
          entries = [...(await store.readEntries(book.baseBookRef)), ...entries];
        }
        const tb = produceTrialBalance(entries, book, chart, input.periodRef);
        if (!tb.foots) {
          // Not a result — an incident. Every entry sums to zero, so a trial
          // balance that does not foot means the store was altered outside
          // the engine.
          return {
            ok: false,
            refusal: refusal(
              "TRIAL_BALANCE_DOES_NOT_FOOT",
              LEDGER_METHODS.trialBalance,
              "The fold does not foot, which cannot happen through the posting path. Verify the store's integrity via the audit chain.",
            ),
          };
        }
        return { ok: true, trialBalance: tb };
      } catch (cause) {
        return { ok: false, refusal: storeUnavailable(cause) };
      }
    },

    async readChartOfAccounts(input) {
      try {
        const book = await store.getBook(input.bookId);
        if (!book) {
          return {
            ok: false,
            refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
          };
        }
        const versions = await store.getChartVersions(book.chartRef);
        const chart = versions.find(
          (v) =>
            v.effectiveFrom <= input.asOfDate &&
            (v.effectiveTo === undefined || input.asOfDate <= v.effectiveTo),
        );
        if (!chart) {
          return {
            ok: false,
            refusal: refusal(
              "ACCOUNT_UNKNOWN",
              V,
              `No chart version is effective at ${input.asOfDate}.`,
              book.chartRef,
            ),
          };
        }
        return { ok: true, chart };
      } catch (cause) {
        return { ok: false, refusal: storeUnavailable(cause) };
      }
    },

    async exportRows(input) {
      try {
        const book = await store.getBook(input.bookId);
        if (!book) {
          return {
            ok: false,
            refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
          };
        }
        const chart = (await store.getChartVersions(book.chartRef))[0];
        if (!chart) {
          return {
            ok: false,
            refusal: refusal("ACCOUNT_UNKNOWN", V, "The book's chart has no versions.", book.chartRef),
          };
        }
        const entries = await store.readEntries(input.bookId);
        return { ok: true, rows: exportProjection(entries, book, chart) };
      } catch (cause) {
        return { ok: false, refusal: storeUnavailable(cause) };
      }
    },

    deriveParallelBookEntry() {
      return {
        ok: false,
        refusal: refusal(
          "CROSS_BOOK_DERIVATION_NOT_OWNED",
          LEDGER_METHODS.parallelBookProjection,
          "Deriving one book's amounts from another's requires knowing the accounting difference, which is the originating engine's domain. Produce one proposal per book.",
        ),
      };
    },

    async health() {
      try {
        // Any successful store round-trip proves reachability.
        await store.getBook("__health__");
      } catch {
        return { healthy: null, detail: "The store did not answer. Unknown is not the same as healthy." };
      }
      if (!options.fxRateSource) {
        return {
          healthy: true,
          detail:
            "degraded: no FxRateSource is bound — foreign-currency proposals refuse; same-currency postings continue.",
        };
      }
      return { healthy: true, detail: "Posting path available." };
    },
  };

  async function transitionPeriod(input: {
    bookId: string;
    periodRef: PeriodRef;
    to: PeriodState;
    recordedAt: string;
    actor: string;
    reason?: string;
    authorization?: SuppliedAuthorization;
    purpose: string;
  }): Promise<PeriodOutcome> {
    const M = LEDGER_METHODS.periodState;
    try {
      const book = await store.getBook(input.bookId);
      if (!book) {
        return {
          ok: false,
          refusal: refusal("UNKNOWN_BOOK", V, "Name a book this installation holds.", input.bookId),
        };
      }
      const calendar = await store.getCalendar(book.calendarRef);
      const period = calendar?.periods.find(
        (p) =>
          p.periodRef.fiscalYear === input.periodRef.fiscalYear &&
          p.periodRef.periodNumber === input.periodRef.periodNumber,
      );
      if (!calendar || !period) {
        return {
          ok: false,
          refusal: refusal(
            "PERIOD_NOT_FOUND",
            M,
            "Target a period the book's calendar defines.",
            stateKey(input.periodRef),
          ),
        };
      }
      const current = (await store.getPeriodState(input.bookId, input.periodRef)) ?? "future";
      if (current === "permanently-closed") {
        return {
          ok: false,
          refusal: refusal(
            "PERIOD_PERMANENTLY_CLOSED",
            M,
            "The seal is terminal by design. There is no exit, and that is stated, not implied.",
            stateKey(input.periodRef),
          ),
        };
      }
      const rule = findTransition(current, input.to);
      if (!rule) {
        return {
          ok: false,
          refusal: refusal(
            input.to === "closed" ? "PERIOD_CLOSED" : "PERIOD_NOT_FOUND",
            M,
            `No legal transition ${current} → ${input.to}. The §13.5 table enumerates every exit.`,
            stateKey(input.periodRef),
          ),
        };
      }

      // Closing requires every earlier period closed first, and no in-flight
      // proposal for the period.
      if (input.to === "closed") {
        for (const p of calendar.periods) {
          const cmp =
            p.periodRef.fiscalYear - input.periodRef.fiscalYear ||
            p.periodRef.periodNumber - input.periodRef.periodNumber;
          if (cmp >= 0) continue;
          const earlier =
            (await store.getPeriodState(input.bookId, p.periodRef)) ?? "future";
          if (earlier === "open" || earlier === "pending-close") {
            return {
              ok: false,
              refusal: refusal(
                "EARLIER_PERIOD_OPEN",
                M,
                `Close ${p.periodRef.fiscalYear}-${p.periodRef.periodNumber} first; periods close in order.`,
                stateKey(p.periodRef),
              ),
            };
          }
        }
        if (inFlight.has(`${input.bookId}:${stateKey(input.periodRef)}`)) {
          return {
            ok: false,
            refusal: refusal(
              "PROPOSAL_IN_FLIGHT",
              M,
              "A proposal for this period is mid-append. Let it land or refuse, then close.",
              stateKey(input.periodRef),
            ),
          };
        }
      }

      // "You may not" and "we could not ask" need different operator responses.
      if (!input.authorization) {
        return {
          ok: false,
          refusal: refusal(
            "GOVERNANCE_UNAVAILABLE",
            M,
            `No governance decision accompanied the request. Obtain one for purpose "${input.purpose}" at risk class ${rule.authorizationFloor} or above.`,
          ),
        };
      }
      const auth = authorizationSatisfies(
        input.authorization,
        input.purpose,
        rule.authorizationFloor,
        input.recordedAt,
      );
      if (!auth.ok) {
        return { ok: false, refusal: refusal("NOT_AUTHORIZED", M, auth.why) };
      }
      if (!meetsRiskFloor(input.authorization.envelope.riskClass, rule.authorizationFloor)) {
        return {
          ok: false,
          refusal: refusal("NOT_AUTHORIZED", M, `This transition's floor is ${rule.authorizationFloor}.`),
        };
      }

      const applied = await store.appendPeriodStateTransition(
        input.bookId,
        input.periodRef,
        {
          from: current,
          to: input.to,
          at: input.recordedAt,
          governanceDecisionRef: input.authorization.decision.decisionId ?? "decision:unreferenced",
          actor: input.actor,
          ...(input.reason ? { reason: input.reason } : {}),
        },
        current,
      );
      if (applied === "conflict") {
        return {
          ok: false,
          refusal: refusal(
            "CONCURRENT_MODIFICATION",
            M,
            "The period's state changed underneath this transition. Re-read and decide again.",
          ),
        };
      }
      return { ok: true, state: input.to };
    } catch (cause) {
      return { ok: false, refusal: storeUnavailable(cause) };
    }
  }
}
