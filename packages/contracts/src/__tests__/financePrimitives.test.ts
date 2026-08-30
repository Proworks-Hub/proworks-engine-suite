// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  addExactMoney,
  compareExactMoney,
  compareSourceStrength,
  CurrencyMismatchError,
  divideAndRound,
  exactMinorUnits,
  exactMoneyFromDecimalString,
  exactMoneyFromMinorUnits,
  exactMoneySchema,
  exchangeRateRefSchema,
  isSoleBasisAiCandidate,
  isZeroExactMoney,
  multiplyExactMoneyByRate,
  negateExactMoney,
  postingProposalSchema,
  subtractExactMoney,
  sumExactMoney,
  type EvidenceRef,
} from "../index.js";

const usd = (amount: string) => exactMoneySchema.parse({ amount, currency: "USD", scale: 2 });

describe("ExactMoney — the exact-decimal primitive", () => {
  it("refuses a JSON number in an amount position, rather than coercing it", () => {
    // The wire is exactly where exact decimal is lost. A number is a double.
    expect(exactMoneySchema.safeParse({ amount: 10.5, currency: "USD", scale: 2 }).success).toBe(
      false,
    );
  });

  it("has no default currency", () => {
    expect(exactMoneySchema.safeParse({ amount: "1.00", scale: 2 }).success).toBe(false);
  });

  it("enforces the canonical form: exactly `scale` fraction digits", () => {
    expect(exactMoneySchema.safeParse({ amount: "1.5", currency: "USD", scale: 2 }).success).toBe(
      false,
    );
    expect(exactMoneySchema.safeParse({ amount: "1.50", currency: "USD", scale: 2 }).success).toBe(
      true,
    );
    // A JPY book: zero minor units, and "100.00" is NOT a valid JPY amount.
    expect(exactMoneySchema.safeParse({ amount: "100", currency: "JPY", scale: 0 }).success).toBe(
      true,
    );
    expect(
      exactMoneySchema.safeParse({ amount: "100.00", currency: "JPY", scale: 0 }).success,
    ).toBe(false);
    // A KWD book: three minor units.
    expect(
      exactMoneySchema.safeParse({ amount: "1.250", currency: "KWD", scale: 3 }).success,
    ).toBe(true);
  });

  it("round-trips minor units exactly, including negatives and sub-1 amounts", () => {
    expect(exactMinorUnits(usd("1234.56"))).toBe(123456n);
    expect(exactMinorUnits(usd("-0.07"))).toBe(-7n);
    expect(exactMoneyFromMinorUnits(-7n, "USD", 2).amount).toBe("-0.07");
    expect(exactMoneyFromMinorUnits(0n, "JPY", 0).amount).toBe("0");
  });

  it("adds and subtracts without drift where floats would drift", () => {
    // 0.1 + 0.2 — the canonical float failure.
    expect(addExactMoney(usd("0.10"), usd("0.20")).amount).toBe("0.30");
    expect(subtractExactMoney(usd("0.30"), usd("0.10")).amount).toBe("0.20");
  });

  it("refuses cross-currency arithmetic loudly", () => {
    const eur = exactMoneySchema.parse({ amount: "1.00", currency: "EUR", scale: 2 });
    expect(() => addExactMoney(usd("1.00"), eur)).toThrow(CurrencyMismatchError);
    expect(() => compareExactMoney(usd("1.00"), eur)).toThrow(CurrencyMismatchError);
    expect(() => sumExactMoney([usd("1.00"), eur], "USD", 2)).toThrow(CurrencyMismatchError);
  });

  it("refuses cross-scale arithmetic even within one currency", () => {
    const wrongScale = exactMoneySchema.parse({ amount: "1.000", currency: "USD", scale: 3 });
    expect(() => addExactMoney(usd("1.00"), wrongScale)).toThrow(CurrencyMismatchError);
  });

  it("sums an empty list only with an explicit denomination", () => {
    expect(sumExactMoney([], "USD", 2).amount).toBe("0.00");
  });

  it("negates and detects zero", () => {
    expect(negateExactMoney(usd("5.25")).amount).toBe("-5.25");
    expect(isZeroExactMoney(usd("0.00"))).toBe(true);
    expect(isZeroExactMoney(usd("-0.01"))).toBe(false);
  });
});

describe("rounding — a decision, taken once, in a named mode", () => {
  it("implements all seven modes on the half boundary", () => {
    // 25 / 10 = 2.5 exactly — the discriminating case.
    expect(divideAndRound(25n, 10n, "half-up")).toBe(3n);
    expect(divideAndRound(25n, 10n, "half-down")).toBe(2n);
    expect(divideAndRound(25n, 10n, "half-even")).toBe(2n);
    expect(divideAndRound(35n, 10n, "half-even")).toBe(4n);
    expect(divideAndRound(21n, 10n, "up")).toBe(3n);
    expect(divideAndRound(29n, 10n, "down")).toBe(2n);
    expect(divideAndRound(21n, 10n, "ceiling")).toBe(3n);
    expect(divideAndRound(29n, 10n, "floor")).toBe(2n);
  });

  it("mirrors correctly for negatives — ceiling and floor are directional, halves are symmetric", () => {
    expect(divideAndRound(-25n, 10n, "half-up")).toBe(-3n);
    expect(divideAndRound(-25n, 10n, "half-even")).toBe(-2n);
    expect(divideAndRound(-21n, 10n, "ceiling")).toBe(-2n);
    expect(divideAndRound(-21n, 10n, "floor")).toBe(-3n);
  });

  it("requires a rounding mode only when precision would actually be lost", () => {
    expect(exactMoneyFromDecimalString("1.5", "USD", 2).amount).toBe("1.50");
    expect(() => exactMoneyFromDecimalString("1.005", "USD", 2)).toThrow(/Rounding is a decision/);
    expect(exactMoneyFromDecimalString("1.005", "USD", 2, "half-even").amount).toBe("1.00");
    expect(exactMoneyFromDecimalString("1.005", "USD", 2, "half-up").amount).toBe("1.01");
  });

  it("converts EUR→USD at the golden GD-2c rates exactly, rounding once", () => {
    const eur = exactMoneySchema.parse({ amount: "1000000.00", currency: "EUR", scale: 2 });
    // The three rate-type conventions from LedgerIQ §16.4 — fixture rates.
    expect(multiplyExactMoneyByRate(eur, "1.0850", "USD", 2, "half-even").amount).toBe(
      "1085000.00",
    );
    expect(multiplyExactMoneyByRate(eur, "1.0725", "USD", 2, "half-even").amount).toBe(
      "1072500.00",
    );
    expect(multiplyExactMoneyByRate(eur, "1.0610", "USD", 2, "half-even").amount).toBe(
      "1061000.00",
    );
  });

  it("converts into a zero-scale currency without inventing precision", () => {
    // 10.00 × 163.25 = 1632.5 — exactly on the half, so the mode decides:
    // half-even lands on the even neighbour, half-up moves away from zero.
    const eur = exactMoneySchema.parse({ amount: "10.00", currency: "EUR", scale: 2 });
    expect(multiplyExactMoneyByRate(eur, "163.25", "JPY", 0, "half-even").amount).toBe("1632");
    expect(multiplyExactMoneyByRate(eur, "163.25", "JPY", 0, "half-up").amount).toBe("1633");
  });

  it("refuses a negative rate", () => {
    expect(() => multiplyExactMoneyByRate(usd("1.00"), "-1.1", "EUR", 2, "half-up")).toThrow(
      /negative/,
    );
  });
});

describe("ExchangeRateRef", () => {
  it("carries provenance and refuses a self-rate", () => {
    const ok = exchangeRateRefSchema.safeParse({
      base: "EUR",
      quote: "USD",
      rate: "1.0850",
      source: "fixture",
      effectiveDate: "2026-08-30",
      rateType: "spot-at-transaction-date",
    });
    expect(ok.success).toBe(true);
    const self = exchangeRateRefSchema.safeParse({
      base: "USD",
      quote: "USD",
      rate: "1",
      source: "fixture",
      effectiveDate: "2026-08-30",
      rateType: "period-fixed",
    });
    expect(self.success).toBe(false);
  });
});

describe("EvidenceQuality and LOCK-2", () => {
  const quality = (sourceStrength: EvidenceRef["quality"]["sourceStrength"]) => ({
    coverage: "adequate" as const,
    freshness: "adequate" as const,
    sourceStrength,
    sampleSufficiency: "adequate" as const,
    normalizationQuality: "adequate" as const,
    assumptionLoad: "light" as const,
    historicalReliability: "adequate" as const,
  });

  it("orders source strength strongest-first", () => {
    expect(compareSourceStrength("authoritative-local", "ai-candidate")).toBeLessThan(0);
    expect(compareSourceStrength("ai-candidate", "simulated")).toBeGreaterThan(0);
    expect(compareSourceStrength("derived", "derived")).toBe(0);
  });

  it("detects an evidence set whose sole basis is ai-candidate", () => {
    const ai: EvidenceRef = { ref: "e1", quality: quality("ai-candidate") };
    const observed: EvidenceRef = { ref: "e2", quality: quality("observed-local") };
    expect(isSoleBasisAiCandidate([ai])).toBe(true);
    expect(isSoleBasisAiCandidate([ai, observed])).toBe(false);
    // Empty is a DIFFERENT condition from AI-only, and must not read as it.
    expect(isSoleBasisAiCandidate([])).toBe(false);
  });
});

describe("PostingProposal", () => {
  const line = (lineNo: number, side: "debit" | "credit", amount: string) => ({
    lineNo,
    accountCode: "1000",
    side,
    amount: { amount, currency: "USD", scale: 2 },
    dimensions: {},
  });

  const proposal = {
    proposalId: "prop-1",
    proposedBy: "hive.payablesiq",
    bookId: "book-1",
    lines: [line(1, "debit", "100.00"), line(2, "credit", "100.00")],
    effectiveDate: "2026-08-15",
    periodRef: { fiscalYear: 2026, periodNumber: 8 },
    methodRef: { methodId: "AP-LIABILITY-RECOGNITION", semanticVersion: "1.0.0" },
    evidence: [],
    trace: { correlationId: "corr-1" },
    idempotencyKey: "ap:inv-100:1.0.0",
  };

  it("parses the canonical shape", () => {
    expect(postingProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("permits a missing idempotencyKey at the schema so the ladder can refuse it precisely", () => {
    const { idempotencyKey: _dropped, ...withoutKey } = proposal;
    expect(postingProposalSchema.safeParse(withoutKey).success).toBe(true);
  });

  it("refuses a line that is both monetary and statistical, or neither", () => {
    const both = {
      ...proposal,
      lines: [
        {
          ...line(1, "debit", "1.00"),
          statisticalQuantity: { amount: "4", unit: "hours" },
        },
        line(2, "credit", "1.00"),
      ],
    };
    expect(postingProposalSchema.safeParse(both).success).toBe(false);
    const neither = {
      ...proposal,
      lines: [
        { lineNo: 1, accountCode: "1000", side: "debit", dimensions: {} },
        line(2, "credit", "1.00"),
      ],
    };
    expect(postingProposalSchema.safeParse(neither).success).toBe(false);
  });

  it("rejects an unknown field at the current version — it is a typo", () => {
    expect(postingProposalSchema.safeParse({ ...proposal, forceFlag: true }).success).toBe(false);
  });
});
