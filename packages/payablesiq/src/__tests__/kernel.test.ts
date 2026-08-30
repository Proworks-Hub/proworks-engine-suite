// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { agePayables, computeVendorBalance, mergeVendorBalances } from "../kernel/aging.js";
import { annualizedYield, captureVerdict, discountAmount, discountBase } from "../kernel/discount.js";
import { addDays, applyBusinessDayAdjustment, daysBetween, dayOfWeek } from "../kernel/dates.js";
import { validateAgingScheme, validateTermsDefinition, PAYABLES_METHODS } from "../kernel/methods.js";
import { deriveDueDate, resolveTermsDate, splitInstallments } from "../kernel/terms.js";
import {
  applySettlement,
  OBLIGATION_TRANSITIONS,
  reconcileOpenAmount,
  TERMINAL_OBLIGATION_STATUSES,
} from "../kernel/settlement.js";
import {
  obligationFingerprint,
  obligationStatusSchema,
  type AgingScheme,
  type PayableObligation,
  type PaymentTermsDefinition,
  type SettlementApplication,
} from "../model.js";

const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });
const jpy = (amount: string) => ({ amount, currency: "JPY", scale: 0 });

const TERMS: PaymentTermsDefinition = {
  methodRef: { methodId: "terms.2-10-net-30", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  termsDateBasis: "document-date",
  rule: { kind: "days", days: 30 },
  discountSchedule: [{ days: 10, percentage: "2" }],
  discountBase: "gross-including-tax",
  dueDateAdjustment: "none",
  roundingMode: "half-even",
};

const quality = {
  coverage: "adequate",
  freshness: "adequate",
  sourceStrength: "observed-local",
  sampleSufficiency: "adequate",
  normalizationQuality: "adequate",
  assumptionLoad: "light",
  historicalReliability: "unknown",
} as const;

function obligation(overrides?: Partial<PayableObligation>): PayableObligation {
  return {
    obligationId: "ob-1",
    ownership: "tenant-private",
    ownerRef: "org-1",
    version: 1,
    vendorRef: "vendor-A",
    vendorIdentityResolution: "unresolved",
    originKind: "invoice-asserted",
    sourceDocumentKey: "inv-100",
    originalAmount: usd("1000.00"),
    currency: "USD",
    installmentSequence: 1,
    termsResolution: "derived",
    termsDate: "2026-08-01",
    dueDate: "2026-08-31",
    discountSchedule: [{ days: 10, percentage: "2" }],
    status: "open",
    openAmount: usd("1000.00"),
    applications: [],
    fundingRoute: "direct",
    assumedMoneyScale: 2,
    ledgerAcknowledgement: "unknown",
    evidence: quality,
    freshness: "current",
    trace: { correlationId: "c-1" },
    ...overrides,
  };
}

describe("dates — the February cases and business-day adjustment", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap
  });
  it("daysBetween: due today is 0 and NOT past due", () => {
    expect(daysBetween("2026-08-15", "2026-08-15")).toBe(0);
    expect(daysBetween("2026-08-15", "2026-08-16")).toBe(1);
  });
  it("day-of-month rule: day 31 clamps to February's end, leap and non-leap (GC-08/GC-09)", () => {
    const rule = { kind: "day-of-month", cutoffDay: 31, monthsAhead: 1, dayOfMonth: 31 } as const;
    const nonLeap = deriveDueDate("2026-01-15", rule, "none");
    expect(nonLeap.ok && nonLeap.value).toBe("2026-02-28");
    const leap = deriveDueDate("2024-01-15", rule, "none");
    expect(leap.ok && leap.value).toBe("2024-02-29");
  });
  it("cutoff day advances the schedule a month", () => {
    const rule = { kind: "day-of-month", cutoffDay: 15, monthsAhead: 0, dayOfMonth: 10 } as const;
    const before = deriveDueDate("2026-08-15", rule, "none");
    expect(before.ok && before.value).toBe("2026-08-10");
    const after = deriveDueDate("2026-08-16", rule, "none");
    expect(after.ok && after.value).toBe("2026-09-10");
  });
  it("business-day adjustment requires a calendar; without one only 'none' is legal", () => {
    const refused = deriveDueDate("2026-08-01", { kind: "days", days: 0 }, "following");
    expect(refused.ok).toBe(false);
    // 2026-08-15 is a Saturday.
    expect(dayOfWeek("2026-08-15")).toBe(6);
    const calendar = { calendarRef: "us", weekendDays: [0, 6], holidays: ["2026-08-17"] };
    expect(applyBusinessDayAdjustment("2026-08-15", "following", calendar)).toBe("2026-08-18");
    expect(applyBusinessDayAdjustment("2026-08-15", "preceding", calendar)).toBe("2026-08-14");
    // modified-following falls back when following would cross the month.
    const monthEnd = { calendarRef: "us", weekendDays: [0, 6], holidays: [] };
    expect(dayOfWeek("2026-10-31")).toBe(6);
    expect(applyBusinessDayAdjustment("2026-10-31", "modified-following", monthEnd)).toBe("2026-10-30");
  });
});

describe("terms — no fallback chain, exact installment splitting", () => {
  it("refuses an absent basis fact rather than walking a priority list", () => {
    const outcome = resolveTermsDate(
      { ...TERMS, termsDateBasis: "received-date" },
      { documentDate: "2026-08-01" },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.detail).toContain("goodsReceivedDate");
  });
  it("legal-effective basis exists for clearance mandates", () => {
    const outcome = resolveTermsDate(
      { ...TERMS, termsDateBasis: "legal-effective" },
      { documentDate: "2026-08-01", legalEffectiveDate: "2026-08-03" },
    );
    expect(outcome.ok && outcome.value).toBe("2026-08-03");
  });
  it("splits installments with the residual to the LAST (B-1) so the sum is exact", () => {
    const terms: PaymentTermsDefinition = {
      ...TERMS,
      installments: [
        { percentage: "33.33", rule: { kind: "days", days: 30 } },
        { percentage: "33.33", rule: { kind: "days", days: 60 } },
        { percentage: "33.34", rule: { kind: "days", days: 90 } },
      ],
    };
    const split = splitInstallments(usd("100.00"), terms);
    expect(split.ok).toBe(true);
    if (split.ok) {
      expect(split.value.map((i) => i.amount.amount)).toEqual(["33.33", "33.33", "33.34"]);
      // And an awkward amount still sums exactly: 100.01 → 33.33 + 33.33 + 33.35.
      const awkward = splitInstallments(usd("100.01"), terms);
      expect(awkward.ok && awkward.value.map((i) => i.amount.amount)).toEqual([
        "33.33",
        "33.33",
        "33.35",
      ]);
    }
  });
  it("rejects installment shares that do not sum to exactly 100% — at registration (I-1)", () => {
    const bad: PaymentTermsDefinition = {
      ...TERMS,
      installments: [
        { percentage: "50", rule: { kind: "days", days: 30 } },
        { percentage: "49.99", rule: { kind: "days", days: 60 } },
      ],
    };
    expect(validateTermsDefinition(bad)?.rule).toBe("I-1");
  });
  it("rejects a non-monotonic discount schedule at registration (I-2)", () => {
    const bad: PaymentTermsDefinition = {
      ...TERMS,
      discountSchedule: [
        { days: 10, percentage: "2" },
        { days: 20, percentage: "3" },
      ],
    };
    expect(validateTermsDefinition(bad)?.rule).toBe("I-2");
  });
});

describe("discount — GC-31..GC-45: the exact mathematics of 2/10 net 30", () => {
  it("computes the three yields to four decimal places — the 7.85-point spread", () => {
    const s360 = annualizedYield("2", 10, 30, "simple-360");
    const s365 = annualizedYield("2", 10, 30, "simple-365");
    const comp = annualizedYield("2", 10, 30, "compounded-act365f");
    expect(s360.ok && s360.value.percent).toBe("36.7347");
    expect(s365.ok && s365.value.percent).toBe("37.2449");
    expect(comp.ok && comp.value.percent).toBe("44.5853");
  });
  it("computes the discount amount at the currency scale, rounding once (B-2)", () => {
    const { discountAmount: amount, payableIfDiscounted } = discountAmount(
      usd("1000.00"),
      { days: 10, percentage: "2" },
      { roundingMode: "half-even" },
    );
    expect(amount.amount).toBe("20.00");
    expect(payableIfDiscounted.amount).toBe("980.00");
    // A JPY discount computes at scale 0, not a hardcoded 2.
    const jpyResult = discountAmount(jpy("10000"), { days: 10, percentage: "2" }, { roundingMode: "half-even" });
    expect(jpyResult.discountAmount.amount).toBe("200");
  });
  it("net-of-tax with no determination refuses — not a fallback to gross (GC-40)", () => {
    const outcome = discountBase(usd("1000.00"), { discountBase: "net-of-tax" }, undefined);
    expect(outcome.ok).toBe(false);
    const withTax = discountBase(usd("1000.00"), { discountBase: "net-of-tax" }, usd("100.00"));
    expect(withTax.ok && withTax.value.amount).toBe("900.00");
  });
  it("the capture verdict requires paymentLeadDays — zero lead time is not assumed (GC-34-adjacent)", () => {
    const missing = captureVerdict("2026-08-05", "2026-08-11", undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.refusal.kind).toBe("missing-method-argument");
    const capturable = captureVerdict("2026-08-05", "2026-08-11", 5);
    expect(capturable.ok && capturable.value).toBe("capturable");
    // The BOUNDARY day: payment lands exactly on the discount date, and that
    // still captures. (Mutation `capture-strict-boundary` survived until this.)
    const boundary = captureVerdict("2026-08-05", "2026-08-11", 6);
    expect(boundary.ok && boundary.value).toBe("capturable");
    const lapsed = captureVerdict("2026-08-05", "2026-08-11", 7);
    expect(lapsed.ok && lapsed.value).toBe("lapsed");
  });
});

const SCHEME: AgingScheme = {
  methodRef: { methodId: "scheme.standard", semanticVersion: "1.0.0", effectiveFrom: "2026-01-01" },
  basis: "due-date",
  buckets: [
    { name: "0-30", lowerDays: 0, upperDays: 31 },
    { name: "31-60", lowerDays: 31, upperDays: 61 },
    { name: "61+", lowerDays: 61, upperDays: Number.MAX_SAFE_INTEGER },
  ],
  futureBucket: "not-yet-due",
  termsUnknownBucket: "terms-unknown",
};

describe("aging — open amount, terms-unknown, per-currency; scheme validated at registration", () => {
  it("rejects a scheme with a gap AT REGISTRATION", () => {
    const gappy: AgingScheme = {
      ...SCHEME,
      buckets: [
        { name: "0-30", lowerDays: 0, upperDays: 31 },
        { name: "35+", lowerDays: 35, upperDays: Number.MAX_SAFE_INTEGER },
      ],
    };
    expect(validateAgingScheme(gappy)?.rule).toBe("scheme-coverage");
    expect(validateAgingScheme(SCHEME)).toBeUndefined();
  });
  it("buckets the OPEN amount by days past due; unknown terms land in terms-unknown, never current", () => {
    const outcome = agePayables({
      obligations: [
        obligation({ obligationId: "a", dueDate: "2026-08-01", openAmount: usd("100.00") }),
        obligation({ obligationId: "b", dueDate: "2026-06-15", openAmount: usd("50.00") }),
        obligation({
          obligationId: "c",
          termsResolution: "unresolved",
          dueDate: undefined,
          termsDate: undefined,
          openAmount: usd("25.00"),
        }),
        obligation({ obligationId: "d", dueDate: "2026-09-15", openAmount: usd("10.00") }),
        obligation({ obligationId: "jp", currency: "JPY", originalAmount: jpy("5000"), openAmount: jpy("5000"), dueDate: "2026-08-01" }),
      ],
      scheme: SCHEME,
      asOf: "2026-08-20",
      method: "open-amount-original-basis",
      agingRunId: "run-1",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byName = new Map(outcome.value.buckets.map((b) => [`${b.name}:${b.currency}`, b]));
    expect(byName.get("0-30:USD")?.total.amount).toBe("100.00"); // 19 days
    expect(byName.get("61+:USD")?.total.amount).toBe("50.00"); // 66 days
    expect(byName.get("terms-unknown:USD")?.total.amount).toBe("25.00");
    expect(byName.get("not-yet-due:USD")?.total.amount).toBe("10.00");
    // JPY partitions separately at scale 0 — never summed into USD.
    expect(byName.get("0-30:JPY")?.total.amount).toBe("5000");
  });
});

describe("vendor balance — a partition, never a sum; merge needs the resolver", () => {
  it("partitions per currency with credit and debit reported separately", () => {
    const outcome = computeVendorBalance(
      [
        obligation({ obligationId: "a", openAmount: usd("100.00") }),
        obligation({ obligationId: "b", originKind: "credit-memo", openAmount: usd("-30.00") }),
        obligation({ obligationId: "jp", currency: "JPY", originalAmount: jpy("5000"), openAmount: jpy("5000") }),
      ],
      "vendor-A",
      "2026-08-20",
      false,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.vendorIdentityResolution).toBe("unresolved");
    const usdRow = outcome.value.perCurrency.find((r) => r.currency === "USD");
    expect(usdRow?.credit.amount).toBe("100.00");
    expect(usdRow?.debit.amount).toBe("30.00"); // separate, never netted
    expect(outcome.value.perCurrency.find((r) => r.currency === "JPY")?.credit.amount).toBe("5000");
  });
  it("refuses to merge vendorRefs without the resolver's assertion", () => {
    expect(mergeVendorBalances(undefined).ok).toBe(false);
    expect(mergeVendorBalances(false).ok).toBe(false);
    expect(mergeVendorBalances(true).ok).toBe(true);
  });
});

describe("settlement — the authoritative derivation and its invariants", () => {
  const app = (overrides?: Partial<SettlementApplication>): SettlementApplication => ({
    applicationId: "app-1",
    obligationId: "ob-1",
    appliedAmount: usd("400.00"),
    applicationDate: "2026-08-10",
    kind: "settlement",
    sourceRef: "pay-1",
    idempotencyKey: "k-1",
    ...overrides,
  });

  it("applies, versions, and derives the open amount — never edits", () => {
    const outcome = applySettlement(obligation(), [], app());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.next.version).toBe(2);
    expect(outcome.value.next.supersedes).toBe("ob-1@v1");
    expect(outcome.value.next.openAmount.amount).toBe("600.00");
    expect(outcome.value.next.status).toBe("partially-settled");
    // Full settlement closes it.
    const closing = applySettlement(outcome.value.next, [app()], app({ applicationId: "app-2", idempotencyKey: "k-2", appliedAmount: usd("600.00") }));
    expect(closing.ok && closing.value.next.status).toBe("settled");
  });
  it("replays the same idempotency key and refuses a conflicting reuse", () => {
    const first = applySettlement(obligation(), [], app());
    if (!first.ok) throw new Error("fixture");
    const replay = applySettlement(first.value.next, [app()], app());
    expect(replay.ok && replay.value.replayed).toBe(true);
    const conflict = applySettlement(first.value.next, [app()], app({ appliedAmount: usd("1.00") }));
    expect(conflict.ok).toBe(false);
  });
  it("refuses an over-application naming the exact excess", () => {
    const outcome = applySettlement(obligation(), [], app({ appliedAmount: usd("1012.00") }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.detail).toContain("12.00 USD");
  });
  it("refuses a write-off with no authorization reference", () => {
    const outcome = applySettlement(obligation(), [], app({ kind: "write-off" }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.kind).toBe("not-authorized");
    const authorized = applySettlement(
      obligation(),
      [],
      app({ kind: "write-off", appliedAmount: usd("1000.00"), authorizationRef: "gov-1" }),
    );
    expect(authorized.ok && authorized.value.next.status).toBe("written-off");
  });
  it("refuses cross-currency application", () => {
    const outcome = applySettlement(
      obligation(),
      [],
      app({ appliedAmount: { amount: "400.00", currency: "EUR", scale: 2 } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.kind).toBe("currency-mismatch");
  });
  it("reconcileOpenAmount names BOTH figures on a mismatch and never silently corrects", () => {
    const drifted = obligation({ openAmount: usd("999.00") });
    const outcome = reconcileOpenAmount(drifted, []);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.detail).toContain("999.00");
      expect(outcome.refusal.detail).toContain("1000.00");
    }
    expect(reconcileOpenAmount(obligation(), []).ok).toBe(true);
  });
});

describe("the fingerprint distinguishes installments", () => {
  it("gives installment 1 and installment 2 of one document distinct identities", () => {
    // Mutation `fingerprint-ignores-installment` survived until this test:
    // two installments of one invoice MUST NOT deduplicate into one liability.
    const base = obligation();
    const fp1 = obligationFingerprint({ ...base, installmentSequence: 1 });
    const fp2 = obligationFingerprint({ ...base, installmentSequence: 2 });
    expect(fp1).not.toBe(fp2);
  });
});

describe("the obligation state machine — every state exits or is declared terminal (T-SM-04)", () => {
  it("walks the transition table, not the prose", () => {
    for (const status of obligationStatusSchema.options) {
      const hasExit = OBLIGATION_TRANSITIONS.some((t) => t.from === status);
      const terminal = TERMINAL_OBLIGATION_STATUSES.includes(status);
      expect(hasExit || terminal, status).toBe(true);
      expect(hasExit && terminal, status).toBe(false);
    }
    // Every hold/release/write-off transition requires authorization.
    for (const t of OBLIGATION_TRANSITIONS) {
      if (t.to === "held" || t.from === "held" || t.to === "written-off") {
        expect(t.requiresAuthorization, `${t.from}->${t.to}`).toBe(true);
      }
    }
  });
  it("does NOT contain disputed-hold — a state with no producer is the shipped defect shape", () => {
    expect(obligationStatusSchema.options).not.toContain("disputed-hold");
    expect(PAYABLES_METHODS.registry.methodId).toBe("methods.registry");
  });
});
