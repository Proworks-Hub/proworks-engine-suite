// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import type { ExchangeRateRef } from "@proworks-hub/contracts";

import { validateProposal, type LedgerSnapshot } from "../kernel/validation.js";
import type { PeriodState } from "../model/model.js";
import {
  auth,
  BOOK_BARE,
  BOOK_IC,
  BOOK_USD,
  CALENDAR,
  CHART,
  CURRENCY_REGISTRY,
  DIMENSIONS,
  eur,
  proposal,
  SPOT_EUR_USD,
  usd,
} from "./fixtures.js";

const OPEN: Record<string, PeriodState> = {
  "2026-6": "closed",
  "2026-7": "closed",
  "2026-8": "open",
  "2026-9": "future",
  "2026-13": "pending-close",
};

function snapshot(overrides?: Partial<LedgerSnapshot>): LedgerSnapshot {
  return {
    book: BOOK_USD,
    chartVersions: [CHART],
    calendar: CALENDAR,
    dimensionSchema: DIMENSIONS,
    periodStates: OPEN,
    currencyRegistry: CURRENCY_REGISTRY,
    fxRates: [],
    ...overrides,
  };
}

function run(p: unknown, s?: Partial<LedgerSnapshot>, recordedAt: string | undefined = "2026-08-15T10:00:00Z") {
  return validateProposal({ proposal: p, recordedAt, snapshot: snapshot(s) });
}

function expectRefusal(outcome: ReturnType<typeof validateProposal>, code: string) {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.refusal.code).toBe(code);
    // Every refusal names its rule and a remediation — a refusal that is a
    // bare string is the P5 failure.
    expect(outcome.refusal.methodRef.methodId).toMatch(/^LEDGER-/);
    expect(outcome.refusal.remediation.length).toBeGreaterThan(10);
  }
}

describe("the ladder accepts the textbook entry", () => {
  it("posts a balanced same-currency entry", () => {
    const outcome = run(proposal());
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.replay) {
      expect(outcome.entry.entryId).toMatch(/^je_/);
      expect(outcome.entry.lines).toHaveLength(2);
      expect(outcome.functionalTotals.debits.amount).toBe("100.00");
      expect(outcome.functionalTotals.credits.amount).toBe("100.00");
      expect(outcome.generatedLines).toHaveLength(0);
      // Routine postings carry NO approval field — there is nothing to read it.
      expect(outcome.entry.governanceDecisionRef).toBeUndefined();
    }
  });
});

describe("gates 1–11: structure, book, idempotency, time, period", () => {
  it("gate 1 — malformed proposal", () => {
    expectRefusal(run({ nonsense: true }), "PROPOSAL_MALFORMED");
  });
  it("gate 2 — unknown book", () => {
    expectRefusal(run(proposal({ bookId: "book-nope" })), "UNKNOWN_BOOK");
  });
  it("gate 3 — inactive book", () => {
    expectRefusal(
      run(proposal(), { book: { ...BOOK_USD, status: "suspended" } }),
      "BOOK_INACTIVE",
    );
  });
  it("gate 4 — missing idempotency key", () => {
    expectRefusal(run(proposal({ idempotencyKey: undefined })), "IDEMPOTENCY_KEY_MISSING");
  });
  it("gate 5 — replay returns the ORIGINAL entry, and a conflicting key refuses", () => {
    const p = proposal();
    const contentMatch = run(p, {
      existingForKey: { entryId: "je_original", contentHash: hashOf(p) },
    });
    expect(contentMatch.ok).toBe(true);
    if (contentMatch.ok) {
      expect(contentMatch.replay).toBe(true);
      if (contentMatch.replay) expect(contentMatch.entryId).toBe("je_original");
    }
    const different = run(proposal({ proposalId: "prop-2", lines: [
      { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("999.00") },
      { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("999.00") },
    ] }), {
      existingForKey: { entryId: "je_original", contentHash: hashOf(p) },
    });
    expectRefusal(different, "IDEMPOTENCY_KEY_CONFLICT");
  });
  it("gate 6 — recordedAt is required; LedgerIQ reads no clock", () => {
    // Called directly: a default parameter would silently supply the very
    // timestamp this gate exists to demand.
    const outcome = validateProposal({
      proposal: proposal(),
      recordedAt: undefined,
      snapshot: snapshot(),
    });
    expectRefusal(outcome, "RECORD_TIME_MISSING");
  });
  it("gate 7 — period not in the calendar", () => {
    expectRefusal(
      run(proposal({ periodRef: { fiscalYear: 2026, periodNumber: 14 } })),
      "PERIOD_NOT_FOUND",
    );
  });
  it("gate 8 — effective date outside the period", () => {
    expectRefusal(run(proposal({ effectiveDate: "2026-09-02" })), "EFFECTIVE_DATE_OUTSIDE_PERIOD");
  });
  it("gate 9 — closed, future, permanently closed, pending-close", () => {
    expectRefusal(
      run(proposal({ effectiveDate: "2026-07-10", periodRef: { fiscalYear: 2026, periodNumber: 7 } })),
      "PERIOD_CLOSED",
    );
    expectRefusal(
      run(proposal({ effectiveDate: "2026-09-10", periodRef: { fiscalYear: 2026, periodNumber: 9 } })),
      "PERIOD_FUTURE",
    );
    expectRefusal(
      run(
        proposal({ effectiveDate: "2026-07-10", periodRef: { fiscalYear: 2026, periodNumber: 7 } }),
        { periodStates: { ...OPEN, "2026-7": "permanently-closed" } },
      ),
      "PERIOD_PERMANENTLY_CLOSED",
    );
    expectRefusal(
      run(proposal({ effectiveDate: "2026-12-31", periodRef: { fiscalYear: 2026, periodNumber: 13 } })),
      "PERIOD_PENDING_CLOSE",
    );
  });
  it("gate 9 admits an ADJUSTING entry into pending-close — with the elevated decision gate 28 checks", () => {
    const p = proposal({
      entryType: "adjusting",
      effectiveDate: "2026-12-31",
      periodRef: { fiscalYear: 2026, periodNumber: 13 },
    });
    const without = run(p);
    expectRefusal(without, "NOT_AUTHORIZED");
    const withAuth = validateProposal({
      proposal: p,
      recordedAt: "2026-12-31T10:00:00Z",
      snapshot: snapshot(),
      authorization: auth("post:adjusting:book-usd:2026-13", "elevated"),
    });
    expect(withAuth.ok).toBe(true);
    if (withAuth.ok && !withAuth.replay) {
      // The decision was consulted, so it IS recorded.
      expect(withAuth.entry.governanceDecisionRef).toBe("dec-1");
    }
  });
  it("gate 10 — fewer than two lines", () => {
    expectRefusal(
      run(proposal({ lines: [{ lineNo: 1, accountCode: "5000", side: "debit", amount: usd("1.00") }] })),
      "ENTRY_TOO_FEW_LINES",
    );
  });
  it("gate 11 — line numbering not dense from 1", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("1.00") },
            { lineNo: 3, accountCode: "2000", side: "credit", amount: usd("1.00") },
          ],
        }),
      ),
      "LINE_NUMBERING_INVALID",
    );
  });
});

describe("gates 12–21: accounts, control, currency, scale, statistical, dimensions", () => {
  const twoLines = (first: Partial<{ accountCode: string; amount: { amount: string; currency: string; scale: number } }>) => [
    { lineNo: 1, accountCode: first.accountCode ?? "5000", side: "debit" as const, amount: first.amount ?? usd("1.00") },
    { lineNo: 2, accountCode: "2000", side: "credit" as const, amount: usd("1.00") },
  ];

  it("gate 12 — unknown account", () => {
    expectRefusal(run(proposal({ lines: twoLines({ accountCode: "0000" }) })), "ACCOUNT_UNKNOWN");
  });
  it("gate 13 — summary account not postable", () => {
    expectRefusal(run(proposal({ lines: twoLines({ accountCode: "6000" }) })), "ACCOUNT_NOT_POSTABLE");
  });
  it("gate 14 — account blocked at the date", () => {
    expectRefusal(run(proposal({ lines: twoLines({ accountCode: "8000" }) })), "ACCOUNT_BLOCKED_AT_DATE");
  });
  it("gate 15 — control account reserved to another source; an elevated decision passes it", () => {
    const p = proposal({ lines: twoLines({ accountCode: "1100" }) });
    expectRefusal(run(p), "ACCOUNT_CONTROL_RESERVED");
    // The reserving source itself passes without any decision.
    const owner = run(proposal({ proposedBy: "hive.receivablesiq", lines: twoLines({ accountCode: "1100" }) }));
    expect(owner.ok).toBe(true);
    // A non-owner with the right elevated decision passes.
    const bypass = validateProposal({
      proposal: p,
      recordedAt: "2026-08-15T10:00:00Z",
      snapshot: snapshot(),
      authorization: auth("post:control-account:1100", "elevated"),
    });
    expect(bypass.ok).toBe(true);
  });
  it("gate 16 — currency not permitted on the account", () => {
    const outcome = run(
      proposal({
        fxRateType: "spot-at-transaction-date",
        lines: twoLines({ accountCode: "7000", amount: eur("1.00") }),
      }),
      { fxRates: [SPOT_EUR_USD] },
    );
    expectRefusal(outcome, "CURRENCY_NOT_PERMITTED_ON_ACCOUNT");
  });
  it("gate 17 — scale must match the currency registry; unknown currency refuses", () => {
    expectRefusal(
      run(proposal({ lines: twoLines({ amount: { amount: "1.000", currency: "USD", scale: 3 } }) })),
      "SCALE_VIOLATION",
    );
    expectRefusal(
      run(proposal({ lines: twoLines({ amount: { amount: "1.00", currency: "CHF", scale: 2 } }) })),
      "SCALE_VIOLATION",
    );
  });
  it("gate 18 — statistical/monetary account alignment, both directions", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "5000", side: "debit", statisticalQuantity: { amount: "4", unit: "hours" } },
            { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1.00") },
          ],
        }),
      ),
      "STATISTICAL_ON_MONETARY_ACCOUNT",
    );
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "9000", side: "debit", amount: usd("1.00") },
            { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1.00") },
          ],
        }),
      ),
      "MONETARY_ON_STATISTICAL_ACCOUNT",
    );
  });
  it("statistical lines are excluded from the money invariant", () => {
    const outcome = run(
      proposal({
        lines: [
          { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("10.00") },
          { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("10.00") },
          { lineNo: 3, accountCode: "9000", side: "debit", statisticalQuantity: { amount: "12", unit: "headcount" } },
        ],
      }),
    );
    expect(outcome.ok).toBe(true);
  });
  it("gate 19 — required dimension missing", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("5.00") },
            { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("5.00") },
          ],
        }),
      ),
      "DIMENSION_REQUIRED_MISSING",
    );
  });
  it("gate 20 — dimension value unknown, including effective-dated expiry", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("5.00") },
            { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("5.00"), dimensions: { dept: "D9" } },
          ],
        }),
      ),
      "DIMENSION_VALUE_UNKNOWN",
    );
    // D2 expired 2026-06-30; an August entry may not use it.
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("5.00") },
            { lineNo: 2, accountCode: "4000", side: "credit", amount: usd("5.00"), dimensions: { dept: "D2" } },
          ],
        }),
      ),
      "DIMENSION_VALUE_UNKNOWN",
    );
  });
  it("gate 21 — cross-validation rule forbids the combination", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "1000", side: "debit", amount: usd("5.00") },
            {
              lineNo: 2,
              accountCode: "4000",
              side: "credit",
              amount: usd("5.00"),
              dimensions: { dept: "D1", region: "E1" },
            },
          ],
        }),
      ),
      "DIMENSION_COMBINATION_INVALID",
    );
  });
});

describe("gates 22–25: FX, residue, balance — GD-2c and the invariant", () => {
  const eurEntry = (rateType?: string) =>
    proposal({
      ...(rateType ? { fxRateType: rateType } : {}),
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: eur("1000000.00") },
        { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1085000.00") },
      ],
    });

  it("gate 22 — rate type is a required declaration with NO default", () => {
    expectRefusal(run(eurEntry(), { fxRates: [SPOT_EUR_USD] }), "FX_RATE_TYPE_UNDECLARED");
  });
  it("gate 22a — port unbound, rate unavailable, rate stale: three DIFFERENT facts", () => {
    expectRefusal(
      run(eurEntry("spot-at-transaction-date"), { fxRates: "port-unbound" }),
      "FX_PORT_UNBOUND",
    );
    expectRefusal(
      run(eurEntry("period-average"), { fxRates: [SPOT_EUR_USD] }),
      "FX_RATE_UNAVAILABLE",
    );
    const staleBook = { ...BOOK_USD, fxStalenessDays: 3 };
    const oldRate: ExchangeRateRef = { ...SPOT_EUR_USD, effectiveDate: "2026-08-01" };
    expectRefusal(
      run(eurEntry("spot-at-transaction-date"), { book: staleBook, fxRates: [oldRate] }),
      "FX_RATE_STALE",
    );
  });
  it("gate 22a — a rate dated AFTER the effective date is not usable: no look-ahead", () => {
    // Added after mutation `rate-date-ignored` SURVIVED: nothing proved that
    // a future-dated rate is refused rather than silently used.
    const future: ExchangeRateRef = { ...SPOT_EUR_USD, effectiveDate: "2026-08-20" };
    expectRefusal(
      run(eurEntry("spot-at-transaction-date"), { fxRates: [future] }),
      "FX_RATE_UNAVAILABLE",
    );
  });
  it("GD-2c — the golden conversion: EUR 1,000,000.00 at 1.0850 spot = USD 1,085,000.00", () => {
    const outcome = run(eurEntry("spot-at-transaction-date"), { fxRates: [SPOT_EUR_USD] });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.replay) {
      const converted = outcome.entry.lines[0];
      expect(converted?.functionalAmount?.amount).toBe("1085000.00");
      // The rate is captured BY VALUE with source and effective date.
      expect(converted?.rateRef?.rate).toBe("1.0850");
      expect(converted?.rateRef?.source).toBe("fixture");
      expect(outcome.entry.postingMethodRefs.map((m) => m.methodId)).toContain("LEDGER-FX-CONVERSION");
    }
  });
  it("a wrongly-quoted rate is MIXED_CURRENCY_ARITHMETIC, not a wrong sum", () => {
    const wrongQuote: ExchangeRateRef = { ...SPOT_EUR_USD, quote: "KWD" };
    expectRefusal(
      run(eurEntry("spot-at-transaction-date"), { fxRates: [wrongQuote] }),
      "MIXED_CURRENCY_ARITHMETIC",
    );
  });
  it("gate 23 — a conversion residue becomes a VISIBLE generated line on the declared account", () => {
    // 0.01 EUR at 1.0850 → 0.0109 → rounds to 0.01; three such debits vs a
    // 0.04 USD credit leaves a 1-minor-unit residue.
    const p = proposal({
      fxRateType: "spot-at-transaction-date",
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 2, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 3, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 4, accountCode: "2000", side: "credit", amount: usd("0.04") },
      ],
    });
    const outcome = run(p, { fxRates: [SPOT_EUR_USD] });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.replay) {
      expect(outcome.generatedLines).toHaveLength(1);
      const residue = outcome.generatedLines[0];
      expect(residue?.accountCode).toBe("5099");
      expect(residue?.generatedBy?.methodId).toBe("LEDGER-ROUNDING-RESIDUE");
      // And the entry balances EXACTLY after the residue line.
      expect(outcome.functionalTotals.debits.amount).toBe(outcome.functionalTotals.credits.amount);
    }
  });
  it("gate 23 — no residue account declared: refusal, not absorption", () => {
    const bare = { ...BOOK_USD };
    delete (bare as Record<string, unknown>).roundingResidueAccount;
    const p = proposal({
      fxRateType: "spot-at-transaction-date",
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 2, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 3, accountCode: "5000", side: "debit", amount: eur("0.01") },
        { lineNo: 4, accountCode: "2000", side: "credit", amount: usd("0.04") },
      ],
    });
    expectRefusal(run(p, { book: bare as typeof BOOK_USD, fxRates: [SPOT_EUR_USD] }), "ROUNDING_RESIDUE_UNASSIGNED");
  });
  it("gate 23 — a residue beyond tolerance means the conversion is wrong, not the rounding", () => {
    const p = proposal({
      fxRateType: "spot-at-transaction-date",
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: eur("100.00") },
        { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("100.00") },
      ],
    });
    expectRefusal(run(p, { fxRates: [SPOT_EUR_USD] }), "ROUNDING_RESIDUE_EXCEEDS_TOLERANCE");
  });
  it("gate 24 — the invariant is EXACT: one minor unit off refuses", () => {
    expectRefusal(
      run(
        proposal({
          lines: [
            { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("100.00") },
            { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("99.99") },
          ],
        }),
      ),
      "UNBALANCED_ENTRY",
    );
  });
  it("gate 25 — unbalanced by balancing dimension refuses by default", () => {
    const p = proposal({
      bookId: "book-bare",
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("10.00"), dimensions: { entity: "A" } },
        { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("10.00"), dimensions: { entity: "B" } },
      ],
    });
    expectRefusal(run(p, { book: BOOK_BARE }), "UNBALANCED_BY_BALANCING_DIMENSION");
  });
  it("gate 25 — a declared intercompanyRule generates VISIBLY-generated due-to/due-from lines", () => {
    const p = proposal({
      bookId: "book-ic",
      lines: [
        { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("10.00"), dimensions: { entity: "A" } },
        { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("10.00"), dimensions: { entity: "B" } },
      ],
    });
    const outcome = run(p, { book: BOOK_IC });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && !outcome.replay) {
      expect(outcome.generatedLines).toHaveLength(2);
      for (const line of outcome.generatedLines) {
        expect(line.generatedBy?.methodId).toBe("LEDGER-INTERCOMPANY-BALANCING");
      }
      // After generation, every entity value balances.
      const perEntity = new Map<string, bigint>();
      for (const line of outcome.entry.lines) {
        if (!line.functionalAmount) continue;
        const units = BigInt(line.functionalAmount.amount.replace(".", "").replace("-", ""));
        const signed = line.side === "debit" ? units : -units;
        const entity = line.dimensions.entity ?? "?";
        perEntity.set(entity, (perEntity.get(entity) ?? 0n) + signed);
      }
      for (const [, net] of perEntity) expect(net).toBe(0n);
    }
  });
});

describe("gates 26–28 and LOCK-2", () => {
  it("gate 26 — reversal target missing or already reversed", () => {
    expectRefusal(
      run(proposal({ entryType: "reversal", reversalOf: "je_ghost" })),
      "REVERSAL_TARGET_NOT_FOUND",
    );
  });
  it("gate 27 — a manual entry with no resolved principal refuses", () => {
    expectRefusal(
      run(proposal({ entrySource: "manual", principal: "steven" })),
      "IDENTITY_UNRESOLVED",
    );
    const resolved = run(proposal({ entrySource: "manual", principal: "steven" }), {
      resolvedPrincipal: "human.steven",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok && !resolved.replay) {
      expect(resolved.entry.postedByPrincipal).toBe("human.steven");
    }
  });
  it("LOCK-2 — evidence that is ENTIRELY ai-candidate refuses; mixed evidence posts", () => {
    const quality = (s: string) => ({
      coverage: "adequate",
      freshness: "adequate",
      sourceStrength: s,
      sampleSufficiency: "adequate",
      normalizationQuality: "adequate",
      assumptionLoad: "light",
      historicalReliability: "adequate",
    });
    expectRefusal(
      run(proposal({ evidence: [{ ref: "e1", quality: quality("ai-candidate") }] })),
      "AI_CANDIDATE_SOLE_BASIS",
    );
    const mixed = run(
      proposal({
        evidence: [
          { ref: "e1", quality: quality("ai-candidate") },
          { ref: "e2", quality: quality("observed-local") },
        ],
      }),
    );
    expect(mixed.ok).toBe(true);
  });
});

describe("ladder ORDER is part of the contract", () => {
  it("an unbalanced entry into a closed period reports the period, not the balance", () => {
    const outcome = run(
      proposal({
        effectiveDate: "2026-07-10",
        periodRef: { fiscalYear: 2026, periodNumber: 7 },
        lines: [
          { lineNo: 1, accountCode: "5000", side: "debit", amount: usd("100.00") },
          { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1.00") },
        ],
      }),
    );
    expectRefusal(outcome, "PERIOD_CLOSED");
  });
  it("a missing idempotency key wins over an unknown account", () => {
    const outcome = run(
      proposal({
        idempotencyKey: undefined,
        lines: [
          { lineNo: 1, accountCode: "0000", side: "debit", amount: usd("1.00") },
          { lineNo: 2, accountCode: "2000", side: "credit", amount: usd("1.00") },
        ],
      }),
    );
    expectRefusal(outcome, "IDEMPOTENCY_KEY_MISSING");
  });
});

// The kernel's own content hash, reused so gate-5 fixtures agree with it.
import { proposalContentHash } from "../kernel/validation.js";
import { postingProposalSchema } from "@proworks-hub/contracts";
function hashOf(p: unknown): string {
  return proposalContentHash(postingProposalSchema.parse(p));
}
