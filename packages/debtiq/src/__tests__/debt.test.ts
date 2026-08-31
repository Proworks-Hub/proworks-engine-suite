// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { rAdd, rEquals, rToDecimalString, rational, type Rational } from "@proworks-hub/contracts";

import {
  amortizedCostSchedule,
  applyPrepayment,
  dayCountFraction,
  dayCountFractionIcma,
  evaluateCovenant,
  fixedAccrual,
  levelPaymentSchedule,
  maturityLadder,
  solveEir,
  tenPercentTestIfrs,
  type CalDate,
  type CovenantDefinition,
} from "../kernel.js";

const d = (y: number, m: number, day: number): CalDate => ({ y, m, d: day });

describe("§16.1 day-count conventions", () => {
  it("ACT/360 and ACT/365F: 90 actual days", () => {
    const a360 = dayCountFraction("act-360", d(2026, 1, 1), d(2026, 4, 1));
    const a365 = dayCountFraction("act-365f", d(2026, 1, 1), d(2026, 4, 1));
    expect(a360.ok && rEquals(a360.value, rational(90n, 360n))).toBe(true);
    expect(a365.ok && rEquals(a365.value, rational(90n, 365n))).toBe(true);
  });
  it("ACT/ACT-ISDA splits at the year boundary with per-year denominators", () => {
    // 2027-12-01 → 2028-02-01: 31 days in 2027 (365) + 31 days in 2028 (366, leap).
    const r = dayCountFraction("act-act-isda", d(2027, 12, 1), d(2028, 2, 1));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rEquals(r.value, rAdd(rational(31n, 365n), rational(31n, 366n)))).toBe(true);
  });
  it("30E/360-ISDA: the ordered EOM-February rules give 30/360 for Feb 28 → Mar 31 (eom)", () => {
    const r = dayCountFraction("30e-360-isda", d(2026, 2, 28), d(2026, 3, 31), { eomInstrument: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Rule 2 fires FIRST (D1=30), so rule 3 can then set D2=30: (30·1+0)/360.
    // Rule 3 before rule 2 would leave D2=31 and answer 31/360 — order matters.
    expect(rEquals(r.value, rational(30n, 360n))).toBe(true);
  });
  it("30/360-US adjusts D2 to 30 only when D1 was adjusted", () => {
    const r = dayCountFraction("30-360-us", d(2026, 1, 31), d(2026, 3, 31));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(rEquals(r.value, rational(60n, 360n))).toBe(true);
  });
  it("P-2 additivity: f(d1,d2) = f(d1,dm) + f(dm,d2) exactly", () => {
    const triples: [CalDate, CalDate, CalDate][] = [
      [d(2026, 1, 15), d(2026, 6, 10), d(2027, 3, 20)],
      [d(2027, 11, 1), d(2028, 1, 1), d(2028, 3, 1)], // across a leap boundary
    ];
    for (const convention of ["act-360", "act-365f", "act-act-isda"] as const) {
      for (const [a, m, b] of triples) {
        const whole = dayCountFraction(convention, a, b);
        const left = dayCountFraction(convention, a, m);
        const right = dayCountFraction(convention, m, b);
        expect(whole.ok && left.ok && right.ok).toBe(true);
        if (!whole.ok || !left.ok || !right.ok) continue;
        expect(rEquals(whole.value, rAdd(left.value, right.value)), `${convention}`).toBe(true);
      }
    }
  });
  it("ACT/ACT-ICMA refuses without the coupon schedule — not a substitute for ISDA", () => {
    const r = dayCountFractionIcma(d(2026, 1, 1), d(2026, 4, 1), undefined);
    expect(!r.ok && r.refusal.kind).toBe("act-act-icma-requires-coupon-schedule");
    const withSchedule = dayCountFractionIcma(d(2026, 1, 1), d(2026, 4, 1), {
      frequency: 2,
      nextCouponDate: d(2026, 7, 1),
    });
    expect(withSchedule.ok).toBe(true);
    if (!withSchedule.ok) return;
    expect(rEquals(withSchedule.value, rational(90n, 2n * 181n))).toBe(true);
  });
});

describe("§16.2/§16.3 GOLD-EIR-01 — the EIR and the unrounded-carry schedule", () => {
  // Face 10,000,000; 5y bullet; 6.00% annual; issuance costs 250,000; net 9,750,000.
  const flows = [
    { t: 0, amountMinor: -975_000_000n },
    { t: 1, amountMinor: 60_000_000n },
    { t: 2, amountMinor: 60_000_000n },
    { t: 3, amountMinor: 60_000_000n },
    { t: 4, amountMinor: 60_000_000n },
    { t: 5, amountMinor: 1_060_000_000n },
  ];
  it("solves 6.60326388% by deterministic bisection", () => {
    const r = solveEir(flows);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rateE10).toBe(660_326_388n);
  });
  it("the schedule carries unrounded and lands within half a cent of zero at maturity", () => {
    const schedule = amortizedCostSchedule(975_000_000n, 660_326_388n, [
      60_000_000n,
      60_000_000n,
      60_000_000n,
      60_000_000n,
      1_060_000_000n,
    ]);
    // Interest period 1 displays 643,818.23 (minor: 64,381,823 at 2dp of major).
    expect(rToDecimalString(schedule[0]!.interest, 0)).toBe("64381823");
    expect(rToDecimalString(schedule[1]!.closingCarrying, 0)).toBe("984052989");
    const terminal = schedule[4]!.closingCarrying;
    // |terminal| < 0.5 minor — displays as 0.00: the residual is a plug to
    // report, never a balance to sit.
    const absNum = terminal.num < 0n ? -terminal.num : terminal.num;
    expect(absNum * 2n < terminal.den).toBe(true);
  });
  it("a vector with no sign change refuses — no best-effort EIR exists", () => {
    const r = solveEir([
      { t: 0, amountMinor: 100n },
      { t: 1, amountMinor: 100n },
    ]);
    expect(!r.ok && r.refusal.kind).toBe("eir-no-sign-change");
  });
});

describe("§16.4 fixed accrual — period additivity through the day count", () => {
  it("splitting a period at any interior date sums to the whole-period accrual exactly", () => {
    const whole = dayCountFraction("act-360", d(2026, 1, 1), d(2026, 7, 1));
    const a = dayCountFraction("act-360", d(2026, 1, 1), d(2026, 3, 15));
    const b = dayCountFraction("act-360", d(2026, 3, 15), d(2026, 7, 1));
    if (!whole.ok || !a.ok || !b.ok) return;
    const accrue = (f: Rational) => fixedAccrual(1_000_000_00n, 500_000_000n, f); // 5%
    expect(rEquals(accrue(whole.value), rAdd(accrue(a.value), accrue(b.value)))).toBe(true);
  });
});

describe("§16.9 GOLD-AMORT-01 — the level payment and the final-payment plug", () => {
  // P = 5,000,000.00; i = 5.25%/12 = 7/1600; n = 60.
  it("computes payment 94,929.92 and absorbs the −0.08 residual into the final payment", () => {
    const r = levelPaymentSchedule(500_000_000n, 7n, 1600n, 60, "final-payment-absorbs");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.paymentMinor).toBe(9_492_992n);
    expect(r.value.residualAbsorbedMinor).toBe(-8n);
    expect(r.value.finalPaymentMinor).toBe(9_492_984n); // 0.08 less
    expect(r.value.rows[59]!.closingMinor).toBe(0n);
  });
  it("plugPolicy refuse returns the residual unallocated", () => {
    const r = levelPaymentSchedule(500_000_000n, 7n, 1600n, 60, "refuse");
    expect(!r.ok && r.refusal.kind).toBe("amortization-residual-unallocated");
  });
  it("no plug policy declared refuses — the agreement's payment table decides", () => {
    const r = levelPaymentSchedule(500_000_000n, 7n, 1600n, 60, undefined);
    expect(!r.ok && r.refusal.kind).toBe("plug-policy-not-declared");
  });
});

describe("§16.10 GOLD-MOD-01 — the 10% test with lender-only fees", () => {
  // End of period 2: carrying 9,840,529.89 at original EIR 6.60326388%.
  // Amended: coupon 4.25%, six-year bullet.
  const carrying = 984_052_989n;
  const newFlows = [
    { t: 1, amountMinor: 42_500_000n },
    { t: 2, amountMinor: 42_500_000n },
    { t: 3, amountMinor: 42_500_000n },
    { t: 4, amountMinor: 42_500_000n },
    { t: 5, amountMinor: 42_500_000n },
    { t: 6, amountMinor: 1_042_500_000n },
  ];
  it("base case: −9.9191% — MODIFICATION, inside 10% by eight-hundredths of a point", () => {
    const r = tenPercentTestIfrs(carrying, newFlows, 660_326_388n, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.differenceBps).toBe(991n);
    expect(r.value.conclusion).toBe("modification");
  });
  it("a 150,000 arrangement fee paid to the LENDER enters the test: −8.3948%, still modification", () => {
    const r = tenPercentTestIfrs(carrying, newFlows, 660_326_388n, [{ amountMinor: 15_000_000n, payee: "lender" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.differenceBps).toBe(839n);
    expect(r.value.lenderFeesIncludedMinor).toBe(15_000_000n);
  });
  it("G-11: third-party legal costs CANNOT enter the test — the flip to extinguishment is structurally unreachable", () => {
    // Wrongly including 200,000 of third-party costs would push −11.95% and
    // flip the conclusion. The payee field makes that mistake impossible: the
    // fee is recorded as excluded and the answer does not move.
    const r = tenPercentTestIfrs(carrying, newFlows, 660_326_388n, [{ amountMinor: 20_000_000n, payee: "third-party" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.differenceBps).toBe(991n);
    expect(r.value.conclusion).toBe("modification");
    expect(r.value.thirdPartyFeesExcludedMinor).toBe(20_000_000n);
  });
});

describe("§16.6 covenants — no built-in ratios, Div never yields a number over zero", () => {
  const leverage: CovenantDefinition = {
    agreementRef: "credit-agreement-2026",
    kind: "attested",
    expression: {
      node: "div",
      numerator: { node: "term", name: "ConsolidatedTotalDebt" },
      denominator: {
        node: "add",
        left: { node: "term", name: "ConsolidatedEBITDA" },
        right: { node: "addback", term: "PermittedAddBacks", cap: rational(50n, 1n), permitted: true },
      },
    },
    comparator: "<=",
    threshold: rational(35n, 10n), // 3.5x
    declaredTerms: ["ConsolidatedTotalDebt", "ConsolidatedEBITDA", "PermittedAddBacks"],
  };
  const bind = (entries: [string, Rational][]) => new Map(entries);
  it("a template cannot be tested against (G-10)", () => {
    const r = evaluateCovenant({ ...leverage, kind: "template" }, bind([]));
    expect(!r.ok && r.refusal.kind).toBe("covenant-template-not-testable");
  });
  it("evaluates an attested definition with a capped add-back", () => {
    const r = evaluateCovenant(
      leverage,
      bind([
        ["ConsolidatedTotalDebt", rational(700n, 1n)],
        ["ConsolidatedEBITDA", rational(180n, 1n)],
        ["PermittedAddBacks", rational(90n, 1n)], // capped to 50
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 700 / (180 + 50) = 3.043… ≤ 3.5 → pass.
    expect(r.value.outcome).toBe("pass");
  });
  it("a zero denominator is UNTESTABLE — never 0, never Infinity", () => {
    const r = evaluateCovenant(
      leverage,
      bind([
        ["ConsolidatedTotalDebt", rational(700n, 1n)],
        ["ConsolidatedEBITDA", rational(-50n, 1n)],
        ["PermittedAddBacks", rational(50n, 1n)],
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe("untestable");
    if (r.value.outcome === "untestable") expect(r.value.reason).toBe("zero-denominator");
  });
  it("an unbound term is untestable with the term named — a covenant never passes on a defaulted input", () => {
    const r = evaluateCovenant(leverage, bind([["ConsolidatedTotalDebt", rational(700n, 1n)]]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe("untestable");
  });
  it("an expression referencing an undeclared term fails validation before any test", () => {
    const bad: CovenantDefinition = { ...leverage, declaredTerms: ["ConsolidatedTotalDebt"] };
    const r = evaluateCovenant(bad, bind([]));
    expect(!r.ok && r.refusal.kind).toBe("covenant-term-unbound");
  });
});

describe("§16.11/§16.12 prepayment order and ladder buckets — required", () => {
  const schedule = [
    { period: 1, amountMinor: 100n },
    { period: 2, amountMinor: 100n },
    { period: 3, amountMinor: 100n },
  ];
  it("an undeclared application order refuses", () => {
    const r = applyPrepayment(schedule, 150n, undefined);
    expect(!r.ok && r.refusal.kind).toBe("prepayment-application-order-not-declared");
  });
  it("to-earliest and to-latest apply from opposite ends", () => {
    const earliest = applyPrepayment(schedule, 150n, "to-earliest-scheduled");
    const latest = applyPrepayment(schedule, 150n, "to-latest-scheduled");
    if (!earliest.ok || !latest.ok) return;
    expect(earliest.value.map((r) => r.amountMinor)).toEqual([0n, 50n, 100n]);
    expect(latest.value.map((r) => r.amountMinor)).toEqual([100n, 50n, 0n]);
  });
  it("undeclared ladder buckets refuse — 0-1y/1-3y is a convention, not a standard", () => {
    const r = maturityLadder([{ instrumentRef: "i1", maturityDate: "2027-01-01", principalMinor: 100n }], undefined);
    expect(!r.ok && r.refusal.kind).toBe("ladder-buckets-not-declared");
  });
});
