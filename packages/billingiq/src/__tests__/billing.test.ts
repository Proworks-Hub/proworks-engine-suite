// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  attestGapless,
  documentTotals,
  emptySeries,
  ingestUsageEvent,
  issueNumber,
  lateUsageDisposition,
  lineNetAmount,
  prorate,
  ratePackage,
  rateTiered,
  selectCorrection,
  taxGate,
  validateSchemeConstruction,
  type ProrationRequest,
  type Tier,
} from "../kernel.js";

describe("M-1/M-2 line and document arithmetic", () => {
  it("line net: (price ÷ base qty) × qty + charges − allowances, rounded once", () => {
    // per-10 price of 100.00 minor units × 25 units = 250.00
    const r = lineNetAmount(10_000n, 10n, 25n, 500n, 300n);
    expect(r.ok && r.value).toBe(25_000n + 500n - 300n);
  });
  it("a zero base quantity is a typed refusal, not a zero", () => {
    const r = lineNetAmount(10_000n, 0n, 25n, 0n, 0n);
    expect(!r.ok && r.refusal.kind).toBe("invalid-price-base-quantity");
  });
  it("totals that do not reconcile REFUSE — no figure is adjusted to balance a document", () => {
    const base = {
      lineNetMinor: [10_000n, 5_000n],
      documentAllowancesMinor: 1_000n,
      documentChargesMinor: 0n,
      taxTotalMinor: 2_800n,
      prepaidMinor: 0n,
      roundingAmountMinor: 0n,
      statedTaxExclusiveMinor: 14_000n,
      statedAmountDueMinor: 16_800n,
    };
    expect(documentTotals(base).ok).toBe(true);
    const off = documentTotals({ ...base, statedAmountDueMinor: 16_801n });
    expect(!off.ok && off.refusal.kind).toBe("totals-do-not-reconcile");
  });
});

describe("M-4 GP-1 — six conventions, one event, the spread is the reason there is no default", () => {
  const base: ProrationRequest = {
    convention: undefined,
    priceBasis: "current-price",
    totalSecondsInPeriod: 2_419_200n,
    remainingSeconds: 1_144_800n,
    totalDaysInPeriod: 28n,
    remainingDaysExclusive: 13n,
    remainingDays30360: 16n,
    oldPeriodAmountMinor: 10_000n, // 100.00
    newPeriodAmountMinor: 25_000n, // 250.00
  };
  const net = (convention: ProrationRequest["convention"]): bigint => {
    const r = prorate({ ...base, convention });
    if (!r.ok) throw new Error(r.refusal.detail);
    return r.value.netChargeMinor;
  };
  it("an absent convention or price basis refuses", () => {
    expect(!prorate(base).ok).toBe(true);
    const noBasis = prorate({ ...base, convention: "actual-seconds", priceBasis: undefined });
    expect(!noBasis.ok && noBasis.refusal.kind).toBe("proration-convention-required");
  });
  it("T-GOLD-GP1: the golden table, exactly", () => {
    expect(net("actual-seconds")).toBe(7_098n); // −47.32 + 118.30
    expect(net("calendar-day-exclusive")).toBe(6_964n); // −46.43 + 116.07
    expect(net("calendar-day-inclusive")).toBe(7_500n); // −50.00 + 125.00
    expect(net("thirty-three-sixty")).toBe(8_000n); // −53.33 + 133.33
    expect(net("credit-and-rebill")).toBe(15_000n); // −100.00 + 250.00
    expect(net("none")).toBe(0n);
  });
  it("credit and debit lines are rounded per line (RB-2), half-even", () => {
    const r = prorate({ ...base, convention: "actual-seconds" });
    if (!r.ok) return;
    expect(r.value.creditLineMinor).toBe(-4_732n);
    expect(r.value.debitLineMinor).toBe(11_830n);
  });
});

describe("M-6/M-7 tiered and package rating", () => {
  const tier1: Tier[] = [
    { upTo: 5n, unitAmountMinor: 700n, flatAmountMinor: 0n },
    { upTo: 10n, unitAmountMinor: 650n, flatAmountMinor: 0n },
    { upTo: null, unitAmountMinor: 600n, flatAmountMinor: 0n },
  ];
  it("tier mode absent refuses — 68% apart on one table", () => {
    const r = rateTiered(6n, tier1, undefined, "bill-nothing");
    expect(!r.ok && r.refusal.kind).toBe("tier-mode-required");
  });
  it("T-GOLD-TIER1: volume vs graduated across the published quantities", () => {
    const cases: [bigint, bigint, bigint][] = [
      [1n, 700n, 700n],
      [5n, 3_500n, 3_500n],
      [6n, 3_900n, 4_150n],
      [20n, 12_000n, 12_750n],
      [25n, 15_000n, 15_750n],
    ];
    for (const [quantity, volume, graduated] of cases) {
      const v = rateTiered(quantity, tier1, "volume", undefined);
      const g = rateTiered(quantity, tier1, "graduated", undefined);
      expect(v.ok && v.value, `volume@${quantity}`).toBe(volume);
      expect(g.ok && g.value, `graduated@${quantity}`).toBe(graduated);
    }
  });
  it("T-GOLD-TIER2 with flats at quantity 12: 66.00 vs 111.00", () => {
    const tiers: Tier[] = [
      { upTo: 5n, unitAmountMinor: 500n, flatAmountMinor: 1_000n },
      { upTo: 10n, unitAmountMinor: 400n, flatAmountMinor: 2_000n },
      { upTo: 15n, unitAmountMinor: 300n, flatAmountMinor: 3_000n },
      { upTo: 20n, unitAmountMinor: 200n, flatAmountMinor: 4_000n },
      { upTo: null, unitAmountMinor: 100n, flatAmountMinor: 5_000n },
    ];
    const v = rateTiered(12n, tiers, "volume", "bill-first-tier-flat");
    const g = rateTiered(12n, tiers, "graduated", "bill-first-tier-flat");
    expect(v.ok && v.value).toBe(6_600n);
    expect(g.ok && g.value).toBe(11_100n);
  });
  it("a flat first tier at zero quantity requires the declared behaviour", () => {
    const tiers: Tier[] = [{ upTo: null, unitAmountMinor: 100n, flatAmountMinor: 1_000n }];
    const r = rateTiered(0n, tiers, "volume", undefined);
    expect(!r.ok && r.refusal.kind).toBe("zero-quantity-behaviour-required");
    const flat = rateTiered(0n, tiers, "volume", "bill-first-tier-flat");
    expect(flat.ok && flat.value).toBe(1_000n);
    const nothing = rateTiered(0n, tiers, "volume", "bill-nothing");
    expect(nothing.ok && nothing.value).toBe(0n);
  });
  it("package pricing: a started block is a charged block", () => {
    const r = ratePackage(21n, 10n, 500n);
    expect(r.ok && r.value).toBe(1_500n); // 3 blocks
    const zero = ratePackage(21n, 0n, 500n);
    expect(!zero.ok && zero.refusal.kind).toBe("invalid-block-size");
  });
});

describe("M-8/M-10 usage — bounded windows and LOCK-3 late handling", () => {
  const config = { dedupWindowDays: 34, maxBackdatingDays: 35, maxFutureSkewMinutes: 5 };
  const meters = new Set(["api-calls"]);
  it("required windows: an unbounded or silent window is refused", () => {
    const r = ingestUsageEvent({ ...config, dedupWindowDays: undefined }, { sourceEventId: "e1", meterRef: "api-calls", ageDays: 0, futureMinutes: 0 }, meters, new Set());
    expect(!r.ok && r.refusal.kind).toBe("usage-window-config-required");
  });
  it("duplicate is suppressed and counted, never silently dropped; unknown meter never rated", () => {
    const dup = ingestUsageEvent(config, { sourceEventId: "e1", meterRef: "api-calls", ageDays: 1, futureMinutes: 0 }, meters, new Set(["e1"]));
    expect(dup.ok && dup.value.outcome).toBe("duplicate-suppressed");
    const unknown = ingestUsageEvent(config, { sourceEventId: "e2", meterRef: "mystery", ageDays: 0, futureMinutes: 0 }, meters, new Set());
    expect(unknown.ok && unknown.value.outcome).toBe("rejected-unknown-meter");
    const old = ingestUsageEvent(config, { sourceEventId: "e3", meterRef: "api-calls", ageDays: 36, futureMinutes: 0 }, meters, new Set());
    expect(old.ok && old.value.outcome).toBe("rejected-out-of-window");
  });
  it("late after cutoff on an unissued draft is DEFERRED — the cutoff is the rule, not the issuance", () => {
    expect(lateUsageDisposition(false, "draft", "2026-02", 100n, 1_000n).action).toBe("late-deferred");
  });
  it("late after issuance becomes a catch-up line on the NEXT open period; material amounts get review", () => {
    const small = lateUsageDisposition(false, "issued", "2026-02", 100n, 1_000n);
    expect(small.action).toBe("catch-up-line-next-open-period");
    if (small.action === "catch-up-line-next-open-period") expect(small.reviewRequired).toBe(false);
    const large = lateUsageDisposition(false, "issued", "2026-02", 5_000n, 1_000n);
    if (large.action === "catch-up-line-next-open-period") expect(large.reviewRequired).toBe(true);
  });
});

describe("M-12 gapless numbering — every value accounted for", () => {
  it("a failed commit BURNS the value with a record; the next issuance takes the next value", () => {
    let series = emptySeries();
    const first = issueNumber(series, true, "doc-1");
    if (!first.ok) return;
    series = first.value.series;
    expect(first.value.issuedValue).toBe(1n);
    const failed = issueNumber(series, false, "doc-2");
    if (!failed.ok) return;
    series = failed.value.series;
    expect(failed.value.issuedValue).toBeNull();
    const third = issueNumber(series, true, "doc-3");
    if (!third.ok) return;
    series = third.value.series;
    expect(third.value.issuedValue).toBe(3n); // never the burned 2
    const attestation = attestGapless(series);
    expect(attestation.gapless).toBe(true); // 2 is occupied by the void record
    expect(series.positions[1]!.state).toBe("void-in-sequence");
  });
  it("an unbound sequence port refuses — never a synthesized number", () => {
    const r = issueNumber(undefined, true, "doc-1");
    expect(!r.ok && r.refusal.kind).toBe("number-sequence-unbound");
  });
  it("T-SEQ-06: allocate-on-draft is rejected at construction when gapless", () => {
    const r = validateSchemeConstruction(true, "allocate-on-draft");
    expect(!r.ok && r.refusal.kind).toBe("gapless-forbids-draft-allocation");
    expect(validateSchemeConstruction(false, "allocate-on-draft").ok).toBe(true);
  });
});

describe("M-14 corrections — instruments, not edits", () => {
  it("a void the engine cannot establish is refused, and the credit note is offered", () => {
    const r = selectCorrection("void", false, false, undefined);
    expect(!r.ok && r.refusal.kind).toBe("void-not-establishable-use-credit-note");
    const seen = selectCorrection("void", true, true, undefined);
    expect(seen.ok).toBe(false);
    const clean = selectCorrection("void", true, false, undefined);
    expect(clean.ok).toBe(true);
    if (clean.ok && clean.value.instrument === "void") expect(clean.value.originalNumberRetained).toBe(true);
  });
  it("a credit note requires the caller's disposition — BillingIQ holds no payment state to infer from", () => {
    const r = selectCorrection("credit-note", true, false, undefined);
    expect(!r.ok && r.refusal.kind).toBe("credit-disposition-required");
    const refund = selectCorrection("credit-note", true, false, "refund-requested");
    expect(refund.ok).toBe(true);
    if (refund.ok && refund.value.instrument === "credit-note") {
      expect(refund.value.refundExecution).toBe("PaymentsIQ-request-only"); // never an execution
      expect(refund.value.ownNumberSeries).toBe("credit-note-series");
    }
  });
});

describe("M-16 the tax gate — never softened", () => {
  it("each of the three conditions refuses independently", () => {
    const absent = taxGate(undefined);
    expect(!absent.ok && absent.refusal.kind).toBe("tax-determination-unresolved");
    const pending = taxGate({ state: "pending", rateVersion: "v3", category: "S" });
    expect(!pending.ok && pending.refusal.kind).toBe("tax-determination-not-final");
    const unversioned = taxGate({ state: "determined", rateVersion: undefined, category: "S" });
    expect(!unversioned.ok && unversioned.refusal.kind).toBe("tax-determination-unversioned");
  });
  it("a DETERMINED zero-tax category clears — E/O/Z are answers, not absences", () => {
    const r = taxGate({ state: "determined", rateVersion: "v3", category: "E" });
    expect(r.ok && r.value.category).toBe("E");
  });
});
