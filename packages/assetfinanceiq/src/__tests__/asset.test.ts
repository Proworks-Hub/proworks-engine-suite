// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  capitalizationVerdict,
  chargeAt,
  decliningBalanceSchedule,
  determineMidQuarter,
  disposalOutcome,
  macrsYear1Charge,
  measureImpairment,
  openEpoch,
  reverseImpairment,
  scheduleFromCumulative,
  straightLineC,
  sumOfYearsDigitsC,
  tax481aCatchup,
  type InServiceRecord,
  type TestBasisConvention,
} from "../kernel.js";

describe("CAP-THRESHOLD-POLICY — three-valued, never silently expensing", () => {
  it("resolves on amount where it can, names judgement where it cannot", () => {
    expect(capitalizationVerdict({ amountMinor: 380000n, thresholdMinor: 100000n }).ok).toBe(true);
    const above = capitalizationVerdict({ amountMinor: 380000n, thresholdMinor: 100000n });
    expect(above.ok && above.value).toBe("capitalize");
    const below = capitalizationVerdict({ amountMinor: 80000n, thresholdMinor: 100000n });
    expect(below.ok && below.value).toBe("judgement-required"); // NOT expense
    const repair = capitalizationVerdict({
      amountMinor: 80000n,
      thresholdMinor: 100000n,
      improvementTestOutcome: "repair",
    });
    expect(repair.ok && repair.value).toBe("expense");
  });
});

describe("DEPR-SCHEDULE-ROUNDING — one boundary on the cumulative function, exact sum", () => {
  it("straight line over an awkward base sums EXACTLY with no plug line", () => {
    // 10,000.01 over 7 periods: per-period rounding would drift.
    const base = 1000001n;
    const charges = scheduleFromCumulative(straightLineC(base, 7), 7, "half-even");
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(base);
    // And every charge differs by at most one minor unit from its neighbours.
    const distinct = new Set(charges.map((c) => c.toString()));
    expect(distinct.size).toBeLessThanOrEqual(2);
  });
  it("a 480-period building schedule sums exactly — the CostIQ drift corrected", () => {
    const base = 123456789n;
    const charges = scheduleFromCumulative(straightLineC(base, 480), 480, "half-even");
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(base);
  });
  it("sum-of-years-digits: C(N) == base exactly", () => {
    const base = 1500000n;
    const charges = scheduleFromCumulative(sumOfYearsDigitsC(base, 5), 5, "half-even");
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(base);
    // Year 1 = 5/15 of base.
    expect(charges[0]).toBe(500000n);
  });
  it("declining balance switches to straight line (zero residual) at the crossover period", () => {
    const { charges, switchPeriod } = decliningBalanceSchedule({
      costMinor: 1000000n,
      residualMinor: 0n,
      lifePeriods: 5,
      factorPercent: 200,
      scale: 2,
      mode: "half-even",
    });
    // DDB charges 400k/240k/144k; in period 4 the remaining-life SL charge
    // (108k) exceeds the DB charge (86.4k) — the recorded switch point.
    expect(switchPeriod).toBe(4);
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(1000000n);
  });
  it("declining balance floors at the residual and never depreciates below it", () => {
    const { charges } = decliningBalanceSchedule({
      costMinor: 1000000n,
      residualMinor: 100000n,
      lifePeriods: 5,
      factorPercent: 200,
      scale: 2,
      mode: "half-even",
    });
    expect(charges.reduce((a, b) => a + b, 0n)).toBe(900000n); // cost − residual
    expect(charges.every((c) => c >= 0n)).toBe(true);
  });
});

describe("G-21 — the mid-quarter cliff, measured", () => {
  const population: InServiceRecord[] = [
    { recordId: "A", quarter: 1, preElectionBasisMinor: 15000000n, section179Minor: 12000000n, disposedSameYear: false, basisFrozen: true },
    { recordId: "B", quarter: 2, preElectionBasisMinor: 10000000n, section179Minor: 0n, disposedSameYear: false, basisFrozen: true },
    { recordId: "C", quarter: 3, preElectionBasisMinor: 8000000n, section179Minor: 0n, disposedSameYear: false, basisFrozen: true },
    { recordId: "D", quarter: 4, preElectionBasisMinor: 18000000n, section179Minor: 0n, disposedSameYear: false, basisFrozen: true },
  ];
  const readingA: TestBasisConvention = { section179: "does-not-reduce", bonus: "does-not-reduce", sameYearDisposals: "excluded" };
  const readingB: TestBasisConvention = { section179: "reduces", bonus: "does-not-reduce", sameYearDisposals: "excluded" };

  it("refuses without a declared test-basis convention — no default, no ??", () => {
    const outcome = determineMidQuarter(population, undefined);
    expect(!outcome.ok && outcome.refusal.kind).toBe("TEST_BASIS_CONVENTION_REQUIRED");
  });
  it("the two readings produce OPPOSITE determinations on the same population, and each names the other's ratio", () => {
    const a = determineMidQuarter(population, readingA);
    const b = determineMidQuarter(population, readingB);
    expect(a.ok && a.value.outcome).toBe("half-year"); // 35.29%
    expect(a.ok && a.value.q4RatioBasisPoints).toBe(3529);
    expect(a.ok && a.value.alternativeQ4RatioBasisPoints).toBe(4615);
    expect(b.ok && b.value.outcome).toBe("mid-quarter-required"); // 46.15%
    expect(b.ok && b.value.q4RatioBasisPoints).toBe(4615);
  });
  it("first-year deductions: $78,000 vs $56,500 — the 27.56% cliff", () => {
    const a = determineMidQuarter(population, readingA);
    const b = determineMidQuarter(population, readingB);
    if (!a.ok || !b.ok) throw new Error("fixture");
    const postElection = [
      { basis: 3000000n, quarter: 1 as const },
      { basis: 10000000n, quarter: 2 as const },
      { basis: 8000000n, quarter: 3 as const },
      { basis: 18000000n, quarter: 4 as const },
    ];
    const total = (det: typeof a.value) =>
      postElection.reduce((acc, r) => {
        const charge = macrsYear1Charge(r.basis, r.quarter, det, "half-even");
        if (!charge.ok) throw new Error("charge");
        return acc + charge.value;
      }, 0n);
    expect(total(a.value)).toBe(7800000n); // $78,000 half-year
    expect(total(b.value)).toBe(5650000n); // $56,500 mid-quarter
  });
  it("the statutory boundary is MORE THAN 40%: exactly 40.00% is half-year, 40.01% is mid-quarter", () => {
    // Added after mutation `midq-threshold-moved` survived: nothing pinned
    // the cliff's exact edge.
    const record = (id: string, quarter: 1 | 4, basis: bigint): InServiceRecord => ({
      recordId: id, quarter, preElectionBasisMinor: basis, section179Minor: 0n,
      disposedSameYear: false, basisFrozen: true,
    });
    const convention: TestBasisConvention = { section179: "does-not-reduce", bonus: "does-not-reduce", sameYearDisposals: "excluded" };
    const atBoundary = determineMidQuarter([record("a", 1, 6000n), record("d", 4, 4000n)], convention);
    expect(atBoundary.ok && atBoundary.value.outcome).toBe("half-year");
    const justOver = determineMidQuarter([record("a", 1, 5999n), record("d", 4, 4001n)], convention);
    expect(justOver.ok && justOver.value.outcome).toBe("mid-quarter-required");
  });
  it("an incomplete population is INDETERMINATE and MACRS refuses — never defaults to half-year", () => {
    const incomplete = [...population.slice(0, 3), { ...population[3]!, basisFrozen: false }];
    const outcome = determineMidQuarter(incomplete, readingA);
    expect(outcome.ok && outcome.value.outcome).toBe("indeterminate");
    if (!outcome.ok) return;
    const charge = macrsYear1Charge(1000000n, 1, outcome.value, "half-even");
    expect(!charge.ok && charge.refusal.kind).toBe("MIDQ_INDETERMINATE");
  });
});

describe("epochs — history never recomputes; §481(a) is framework- and classification-bound", () => {
  it("opens epochs prospectively, refuses overlap and unauthorized revisions; reads govern by epoch", () => {
    const initial = openEpoch([], {
      effectiveFromPeriod: 1,
      charges: [100n, 100n, 100n],
      reason: "initial",
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const unauthorized = openEpoch(initial.value, {
      effectiveFromPeriod: 4,
      charges: [50n, 50n],
      reason: "life-revision",
    });
    expect(!unauthorized.ok && unauthorized.refusal.kind).toBe("AUTHORIZATION_REQUIRED");
    const overlapping = openEpoch(initial.value, {
      effectiveFromPeriod: 2,
      charges: [50n],
      reason: "life-revision",
      authorizationRef: "gov-1",
    });
    expect(!overlapping.ok && overlapping.refusal.kind).toBe("EPOCH_HISTORY_IMMUTABLE");
    const revised = openEpoch(initial.value, {
      effectiveFromPeriod: 4,
      charges: [50n, 50n],
      reason: "life-revision",
      authorizationRef: "gov-1",
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    // Reading 2021 reads the epoch that governed 2021, whatever happened since.
    expect(chargeAt(revised.value, 2)).toBe(100n);
    expect(chargeAt(revised.value, 5)).toBe(50n);
  });
  it("§481(a): tax book + method revision only; book frameworks and life revisions refuse", () => {
    const bookFramework = tax481aCatchup({
      framework: "ifrs",
      changeClassification: "method-revision",
      takenToDateMinor: 500n,
      wouldHaveTakenMinor: 700n,
    });
    expect(!bookFramework.ok && bookFramework.refusal.kind).toBe("CATCHUP_NOT_PERMITTED");
    const lifeRevision = tax481aCatchup({
      framework: "us-tax",
      changeClassification: "life-revision",
      takenToDateMinor: 500n,
      wouldHaveTakenMinor: 700n,
    });
    expect(!lifeRevision.ok && lifeRevision.refusal.kind).toBe("CATCHUP_NOT_PERMITTED");
    const valid = tax481aCatchup({
      framework: "us-tax",
      changeClassification: "method-revision",
      takenToDateMinor: 500n,
      wouldHaveTakenMinor: 700n,
    });
    expect(valid.ok && valid.value.catchUpMinor).toBe(200n);
  });
});

describe("impairment — supplied recoverable amounts, framework-bound reversal", () => {
  it("refuses to impair to an invented number", () => {
    const outcome = measureImpairment({ carryingMinor: 1000n });
    expect(!outcome.ok && outcome.refusal.kind).toBe("RECOVERABLE_AMOUNT_UNAVAILABLE");
    const measured = measureImpairment({
      carryingMinor: 1000n,
      fairValueLessCostsMinor: 700n,
      valueInUseMinor: 800n,
    });
    expect(measured.ok && measured.value.lossMinor).toBe(200n); // higher of the two
  });
  it("US GAAP refuses reversal as a FRAMEWORK rule; IFRS caps at the counterfactual", () => {
    const usGaap = reverseImpairment({
      framework: "us-gaap",
      currentCarryingMinor: 800n,
      proposedCarryingMinor: 950n,
      counterfactualCarryingMinor: 900n,
    });
    expect(!usGaap.ok && usGaap.refusal.kind).toBe("IMPAIRMENT_REVERSAL_PROHIBITED_BY_FRAMEWORK");
    const ifrs = reverseImpairment({
      framework: "ifrs",
      currentCarryingMinor: 800n,
      proposedCarryingMinor: 950n,
      counterfactualCarryingMinor: 900n,
    });
    expect(ifrs.ok && ifrs.value.newCarryingMinor).toBe(900n); // capped at the counterfactual
  });
  it("disposal gain/loss is proceeds minus carrying, per book", () => {
    expect(disposalOutcome({ proceedsMinor: 1200n, carryingAtDisposalMinor: 1000n }).gainLossMinor).toBe(200n);
    expect(disposalOutcome({ proceedsMinor: 800n, carryingAtDisposalMinor: 1000n }).gainLossMinor).toBe(-200n);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/assetfinanceiq/src");
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("guards", () => {
  it("platform imports only; no clock; no float depreciation; no ledger writer; no ?? default on the convention", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/.test(f.text), f.path).toBe(false);
      expect(/Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/postEntry|writeJournal|appendJournal|postToLedger/.test(f.text), f.path).toBe(false);
      expect(/testBasisConvention\s*\?\?|convention\s*\?\?/.test(f.text), f.path).toBe(false);
    }
  });
});
