// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createLedgerRuntime } from "../runtime/ledgerRuntime.js";
import type { LedgerStore } from "../ports/ports.js";
import { auth, CURRENCY_REGISTRY, makeStore, proposal, usd } from "./fixtures.js";

const RECORDED = "2026-08-15T10:00:00Z";

function runtime(store = makeStore()) {
  return {
    runtime: createLedgerRuntime({ store, currencyRegistry: CURRENCY_REGISTRY }),
    store,
  };
}

describe("posting through the store — gates 29–30", () => {
  it("posts, assigns a gapless sequence, and a same-key retry replays the ORIGINAL", async () => {
    const { runtime: lr } = runtime();
    const first = await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    expect(first.posted).toBe(true);
    if (!first.posted) return;
    expect(first.journalSequence).toBe(1);
    expect(first.replay).toBe(false);

    const retry = await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    expect(retry.posted).toBe(true);
    if (!retry.posted) return;
    expect(retry.replay).toBe(true);
    expect(retry.entryId).toBe(first.entryId);
    expect(retry.journalSequence).toBe(first.journalSequence);
    // Nothing posted twice.
    const balance = await lr.readAccountBalance({
      bookId: "book-usd",
      accountCode: "5000",
      asOfPeriodRef: { fiscalYear: 2026, periodNumber: 8 },
    });
    expect(balance.ok && balance.balance.amount).toBe("100.00");
  });

  it("64 concurrent posts: no double post, no lost write, gapless sequences", async () => {
    const { runtime: lr, store } = runtime();
    const posts = Array.from({ length: 64 }, (_, i) =>
      lr.post({
        proposal: proposal({ proposalId: `p-${i}`, idempotencyKey: `key-${i}` }),
        recordedAt: RECORDED,
      }),
    );
    const outcomes = await Promise.all(posts);
    const posted = outcomes.filter((o) => o.posted);
    expect(posted).toHaveLength(64);
    const sequences = (posted as { journalSequence: number }[])
      .map((o) => o.journalSequence)
      .sort((a, b) => a - b);
    // Gapless and unique: exactly 1..64.
    expect(sequences).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(store.appendedEntries()).toHaveLength(64);
  });

  it("surfaces STORE_UNAVAILABLE when the store throws, and health reports unknown", async () => {
    const broken = new Proxy(makeStore(), {
      get(target, prop) {
        if (prop === "getBook") return async () => Promise.reject(new Error("connection refused"));
        return Reflect.get(target, prop);
      },
    }) as unknown as LedgerStore & { appendedEntries(): unknown[] };
    const lr = createLedgerRuntime({ store: broken, currencyRegistry: CURRENCY_REGISTRY });
    const outcome = await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    expect(!outcome.posted && outcome.refusal.code).toBe("STORE_UNAVAILABLE");
    const health = await lr.health();
    expect(health.healthy).toBe(null);
  });
});

describe("the dry run writes NOTHING", () => {
  it("validates, projects lines, and the store call log stays empty", async () => {
    const { runtime: lr, store } = runtime();
    const outcome = await lr.validate({ proposal: proposal(), recordedAt: RECORDED });
    expect(outcome.wouldPost).toBe(true);
    if (outcome.wouldPost) {
      expect(outcome.projectedLines).toHaveLength(2);
    }
    expect(store.appendedEntries()).toHaveLength(0);
    // And a dry run of a bad proposal refuses with the same taxonomy.
    const bad = await lr.validate({
      proposal: proposal({
        lines: [
          { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("2.00") },
          { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1.00") },
        ],
      }),
      recordedAt: RECORDED,
    });
    expect(!bad.wouldPost && bad.refusal.code).toBe("UNBALANCED_ENTRY");
  });
});

describe("reversal — J-5: a correction is a new entry", () => {
  it("reverses switch-side, marks the target, and refuses a second reversal", async () => {
    const { runtime: lr } = runtime();
    const posted = await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    if (!posted.posted) throw new Error("fixture post failed");

    const reversed = await lr.reverse({
      bookId: "book-usd",
      entryId: posted.entryId,
      recordedAt: RECORDED,
      reason: "duplicate liability",
      requestedBy: "hive.payablesiq",
    });
    expect(reversed.posted).toBe(true);
    if (!reversed.posted) return;
    expect(reversed.entryId).not.toBe(posted.entryId);

    // The account nets to zero after the reversal.
    const balance = await lr.readAccountBalance({
      bookId: "book-usd",
      accountCode: "5000",
      asOfPeriodRef: { fiscalYear: 2026, periodNumber: 8 },
    });
    expect(balance.ok && balance.balance.amount).toBe("0.00");

    // At most once.
    const again = await lr.reverse({
      bookId: "book-usd",
      entryId: posted.entryId,
      recordedAt: RECORDED,
      reason: "again",
      requestedBy: "hive.payablesiq",
    });
    expect(!again.posted && again.refusal.code).toBe("REVERSAL_TARGET_ALREADY_REVERSED");
  });

  it("names REVERSAL_PERIOD_CLOSED when the reversal period does not admit it", async () => {
    const { runtime: lr } = runtime();
    const posted = await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    if (!posted.posted) throw new Error("fixture post failed");
    const intoClosed = await lr.reverse({
      bookId: "book-usd",
      entryId: posted.entryId,
      reversalPeriodRef: { fiscalYear: 2026, periodNumber: 7 },
      recordedAt: RECORDED,
      reason: "should not land",
      requestedBy: "hive.payablesiq",
    });
    expect(!intoClosed.posted && intoClosed.refusal.code).toBe("REVERSAL_PERIOD_CLOSED");
  });
});

describe("period transitions — J-4, J-5, and the authorization floors", () => {
  it("closes only with a purpose-bound elevated decision; earlier periods close first", async () => {
    const { runtime: lr } = runtime();

    // No decision at all: "we could not ask" is its own condition.
    const unasked = await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
    });
    expect(!unasked.ok && unasked.refusal.code).toBe("GOVERNANCE_UNAVAILABLE");

    // A decision bound to the WRONG purpose refuses.
    const wrongPurpose = await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
      authorization: auth("close_ledger_period:book-usd:2026-9", "elevated"),
    });
    expect(!wrongPurpose.ok && wrongPurpose.refusal.code).toBe("NOT_AUTHORIZED");

    // The right decision closes it.
    const closed = await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
      authorization: auth("close_ledger_period:book-usd:2026-8", "elevated"),
    });
    expect(closed.ok && closed.state).toBe("closed");

    // And later postings into it refuse — including from the closer itself.
    const late = await lr.post({ proposal: proposal({ idempotencyKey: "late" }), recordedAt: RECORDED });
    expect(!late.posted && late.refusal.code).toBe("PERIOD_CLOSED");
  });

  it("refuses to close while an earlier period is open", async () => {
    const { runtime: lr } = runtime(
      makeStore({
        periodStates: {
          "book-usd:2026-7": "open",
          "book-usd:2026-8": "open",
        },
      }),
    );
    const outcome = await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
      authorization: auth("close_ledger_period:book-usd:2026-8", "elevated"),
    });
    expect(!outcome.ok && outcome.refusal.code).toBe("EARLIER_PERIOD_OPEN");
  });

  it("reopen needs a HIGH decision, distinct floor from close; the seal is terminal", async () => {
    const { runtime: lr } = runtime();
    await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
      authorization: auth("close_ledger_period:book-usd:2026-8", "elevated"),
    });

    // An elevated decision does NOT reach the reopen floor.
    const tooLow = await lr.reopenPeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "controller",
      reason: "statutory correction",
      authorization: auth("reopen_ledger_period:book-usd:2026-8", "elevated"),
    });
    expect(!tooLow.ok && tooLow.refusal.code).toBe("NOT_AUTHORIZED");

    const reopened = await lr.reopenPeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "controller",
      reason: "statutory correction",
      authorization: auth("reopen_ledger_period:book-usd:2026-8", "high"),
    });
    expect(reopened.ok && reopened.state).toBe("open");

    // Sealed is terminal: no exit, stated, enforced.
    const { runtime: lr2 } = runtime(
      makeStore({ periodStates: { "book-usd:2026-8": "permanently-closed" } }),
    );
    const sealed = await lr2.reopenPeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "controller",
      reason: "try",
      authorization: auth("reopen_ledger_period:book-usd:2026-8", "critical"),
    });
    expect(!sealed.ok && sealed.refusal.code).toBe("PERIOD_PERMANENTLY_CLOSED");
  });

  it("an expired decision refuses — authority does not outlive its issue", async () => {
    const { runtime: lr } = runtime();
    const outcome = await lr.closePeriod({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
      recordedAt: RECORDED,
      actor: "closeiq",
      authorization: auth("close_ledger_period:book-usd:2026-8", "elevated", {
        expiresAt: "2026-08-01T00:00:00Z",
      }),
    });
    expect(!outcome.ok && outcome.refusal.code).toBe("NOT_AUTHORIZED");
  });
});

describe("queries", () => {
  it("the trial balance foots — computed, not constant", async () => {
    const { runtime: lr } = runtime();
    await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    await lr.post({
      proposal: proposal({
        proposalId: "p2",
        idempotencyKey: "key-2",
        lines: [
          { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("50.00") },
          { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("50.00"), dimensions: { dept: "D1" } },
        ],
      }),
      recordedAt: RECORDED,
    });
    const tb = await lr.produceTrialBalance({
      bookId: "book-usd",
      periodRef: { fiscalYear: 2026, periodNumber: 8 },
    });
    expect(tb.ok).toBe(true);
    if (tb.ok) {
      expect(tb.trialBalance.foots).toBe(true);
      expect(tb.trialBalance.totalDebits.amount).toBe("150.00");
      expect(tb.trialBalance.totalCredits.amount).toBe("150.00");
    }
  });

  it("cross-book derivation is a typed NO", () => {
    const { runtime: lr } = runtime();
    const outcome = lr.deriveParallelBookEntry();
    expect(outcome.refusal.code).toBe("CROSS_BOOK_DERIVATION_NOT_OWNED");
  });

  it("reads the chart as of a date", async () => {
    const { runtime: lr } = runtime();
    const chart = await lr.readChartOfAccounts({ bookId: "book-usd", asOfDate: "2026-08-15" });
    expect(chart.ok).toBe(true);
    const before = await lr.readChartOfAccounts({ bookId: "book-usd", asOfDate: "2025-01-01" });
    expect(before.ok).toBe(false);
  });

  it("exports the canonical projection in journal/sequence order", async () => {
    const { runtime: lr } = runtime();
    await lr.post({ proposal: proposal(), recordedAt: RECORDED });
    const rows = await lr.exportRows({ bookId: "book-usd" });
    expect(rows.ok).toBe(true);
    if (rows.ok) {
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0]?.validDate).toBe(RECORDED);
      expect(rows.rows[0]?.journalSequence).toBe(1);
      // Debit and credit are separate columns (FEC shape).
      const debitRow = rows.rows.find((r) => r.debit !== undefined);
      const creditRow = rows.rows.find((r) => r.credit !== undefined);
      expect(debitRow?.debit?.amount).toBe("100.00");
      expect(creditRow?.credit?.amount).toBe("100.00");
    }
  });
});
