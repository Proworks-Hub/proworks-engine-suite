// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { rToDecimalString } from "@proworks-hub/contracts";

import {
  accruedInterest,
  aggregatePolicy,
  cashEquivalentCandidacy,
  concentrationTest,
  effectiveInterestAmortization,
  ratingFloorTest,
  realizedGain,
  unrealizedGain,
  yieldConventionFamily,
  yieldToMaturity,
  type Lot,
} from "../kernel.js";

describe("§16.2 accrued interest — the convention IS the method", () => {
  it("refuses without a day count: 1.39% of the accrual rides on it", () => {
    const r = accruedInterest(100_000_000n, 5_000_000n, 90, undefined);
    expect(!r.ok && r.refusal.kind).toBe("day_count_not_declared");
  });
  it("golden: 1,000,000 at 5% for 90 days — 12,500.00 (ACT/360) vs 12,328.77 (ACT/365F)", () => {
    const a360 = accruedInterest(100_000_000n, 5_000_000n, 90, "act-360");
    const a365 = accruedInterest(100_000_000n, 5_000_000n, 90, "act-365f");
    expect(a360.ok && a365.ok).toBe(true);
    if (!a360.ok || !a365.ok) return;
    expect(rToDecimalString(a360.value.accrued, 0)).toBe("1250000"); // minor
    expect(rToDecimalString(a365.value.accrued, 0)).toBe("1232877");
  });
});

describe("§16.3 amortization to par — the residual is declared, never distributed", () => {
  it("refuses without the frozen acquisition yield", () => {
    const r = effectiveInterestAmortization(97_000_00n, 100_000_00n, undefined, 200_00n, 4);
    expect(!r.ok && r.refusal.kind).toBe("acquisition_yield_missing");
  });
  it("forces the final carrying to par and reports the assigned residual", () => {
    const r = effectiveInterestAmortization(9_700_000n, 10_000_000n, 300_000_000n, 20_000n, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const last = r.value.rows[r.value.rows.length - 1]!;
    expect(rToDecimalString(last.closing, 0)).toBe("10000000");
    // The residual is a first-class figure, not silence.
    expect(r.value.finalResidualAssigned.num !== 0n).toBe(true);
  });
});

describe("§16.6 the yield convention family — face vs price, 360 vs 365", () => {
  it("discount < money-market < bond-equivalent for a discount instrument", () => {
    // Face 1,000,000.00, price 980,000.00, 90 days.
    const r = yieldConventionFamily(100_000_000n, 98_000_000n, 90);
    expect(r.bankDiscountE8 < r.moneyMarketE8).toBe(true);
    expect(r.moneyMarketE8 < r.bondEquivalentE8).toBe(true);
    // discount: (2/100)×4 = 8.0000%; mmy: (2/98)×4 ≈ 8.1633%.
    expect(r.bankDiscountE8).toBe(8_000_000n);
    expect(r.moneyMarketE8).toBe(8_163_265n);
  });
});

describe("§16.4 YTM — indeterminate on non-convergence, assumptions recorded", () => {
  it("solves a par bond's YTM at its coupon rate", () => {
    const r = yieldToMaturity(100_000_00n, [
      { t: 1, amountMinor: 500_000n },
      { t: 2, amountMinor: 10_500_000n },
    ]);
    expect(r.state).toBe("solved");
    if (r.state !== "solved") return;
    // Par bond at 5% coupon → YTM 5%.
    expect(r.ytmE10 >= 499_999_990n && r.ytmE10 <= 500_000_010n).toBe(true);
    expect(r.assumptions).toContain("coupons-reinvested-at-ytm");
  });
  it("no bracket sign change → indeterminate, never a last iterate", () => {
    const r = yieldToMaturity(100n, [{ t: 1, amountMinor: 1n }]);
    expect(r.state).toBe("indeterminate");
  });
});

describe("§16.7 the six limit tests — indeterminate never rounds down to compliant", () => {
  it("the aggregation rule: breached > indeterminate > compliant", () => {
    const withIndeterminate = aggregatePolicy([
      { limitId: "l1", verdict: "compliant", indeterminateReason: null },
      { limitId: "l2", verdict: "indeterminate", indeterminateReason: "no rating" },
    ]);
    expect(withIndeterminate.overall).toBe("indeterminate");
    const withBreach = aggregatePolicy([
      { limitId: "l1", verdict: "indeterminate", indeterminateReason: "no rating" },
      { limitId: "l2", verdict: "breached", indeterminateReason: null },
    ]);
    expect(withBreach.overall).toBe("breached");
    const clean = aggregatePolicy([{ limitId: "l1", verdict: "compliant", indeterminateReason: null }]);
    expect(clean.overall).toBe("compliant");
  });
  it("M-POL-2 rating floor: absent, stale, and conflicting-without-tiebreak are each indeterminate", () => {
    const absent = ratingFloorTest("l2", "sp-long", 3, [], "2026-08-01", undefined);
    expect(absent.verdict).toBe("indeterminate");
    const stale = ratingFloorTest(
      "l2",
      "sp-long",
      3,
      [{ agencyScaleRef: "sp-long", notch: 2, observedAt: "2026-01-01" }],
      "2026-08-01",
      undefined,
    );
    expect(stale.verdict).toBe("indeterminate");
    const conflicting = ratingFloorTest(
      "l2",
      "sp-long",
      3,
      [
        { agencyScaleRef: "sp-long", notch: 2, observedAt: "2026-08-15" },
        { agencyScaleRef: "sp-long", notch: 5, observedAt: "2026-08-16" },
      ],
      "2026-08-01",
      undefined,
    );
    expect(conflicting.verdict).toBe("indeterminate");
    expect(conflicting.indeterminateReason).toContain("tie-break");
    const worstOf = ratingFloorTest(
      "l2",
      "sp-long",
      3,
      [
        { agencyScaleRef: "sp-long", notch: 2, observedAt: "2026-08-15" },
        { agencyScaleRef: "sp-long", notch: 5, observedAt: "2026-08-16" },
      ],
      "2026-08-01",
      "worst-of",
    );
    expect(worstOf.verdict).toBe("breached"); // worst notch 5 > floor 3
  });
  it("M-POL-4: percent-of-market-value over amortized-cost positions is indeterminate TODAY, with the policy resolution path named", () => {
    const r = concentrationTest(
      "l4",
      [{ issuerRef: "issuer-a", valueMinor: 100n, valueBasis: "amortized-cost" }],
      2_500n,
      "percent-of-market-value",
    );
    expect(r.verdict).toBe("indeterminate");
    expect(r.indeterminateReason).toContain("amortized-cost basis");
    const onCost = concentrationTest(
      "l4",
      [
        { issuerRef: "issuer-a", valueMinor: 400n, valueBasis: "amortized-cost" },
        { issuerRef: "issuer-b", valueMinor: 600n, valueBasis: "amortized-cost" },
      ],
      2_500n,
      "percent-of-amortized-cost",
    );
    expect(onCost.verdict).toBe("breached"); // 60% > 25%
  });
});

describe("§16.8 disposal — the method is required over a declared lot order", () => {
  const lots: Lot[] = [
    { lotId: "b", settlementDate: "2026-02-01", units: 100n, costMinor: 10_000n },
    { lotId: "a", settlementDate: "2026-01-01", units: 100n, costMinor: 9_000n },
  ];
  it("refuses without a disposal method", () => {
    const r = realizedGain(lots, 100n, 12_000n, 0n, undefined);
    expect(!r.ok && r.refusal.kind).toBe("disposal_method_not_declared");
  });
  it("FIFO consumes by (settlementDate, lotId), not insertion order", () => {
    const r = realizedGain(lots, 150n, 20_000n, 100n, { kind: "fifo" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 100 units of lot a (9,000) + 50 of lot b (5,000) = 14,000 basis.
    expect(r.value.costBasisMinor).toBe(14_000n);
    expect(r.value.lotsConsumed).toEqual(["a", "b"]);
    expect(r.value.realizedMinor).toBe(20_000n - 100n - 14_000n);
  });
  it("specific identification refuses when the named lots are insufficient", () => {
    const r = realizedGain(lots, 150n, 20_000n, 0n, { kind: "specific-identification", lotIds: ["a"] });
    expect(!r.ok && r.refusal.kind).toBe("specified_lots_insufficient");
  });
});

describe("§16.12 honesty gates", () => {
  it("unrealized refuses without an evidenced fair value", () => {
    const indicative = unrealizedGain(10_000n, { minor: 11_000n, basis: "indicative" });
    expect(!indicative.ok && indicative.refusal.kind).toBe("unrealized_requires_fair_value_evidence");
    const evidenced = unrealizedGain(10_000n, { minor: 11_000n, basis: "fair-value-evidenced" });
    expect(evidenced.ok).toBe(true);
    if (!evidenced.ok) return;
    expect(evidenced.value.unrealizedMinor).toBe(1_000n);
  });
  it("M-CE-1 never asserts: candidacy facts carry assertion 'none'", () => {
    const r = cashEquivalentCandidacy({ originalMaturityDays: 60, readilyConvertible: true, insignificantValueChangeRisk: null });
    expect(r.kind).toBe("cash-equivalent-candidacy-facts");
    expect(r.assertion).toBe("none");
    expect(r.insignificantValueChangeRisk).toBeNull(); // unknown stays unknown
  });
});
