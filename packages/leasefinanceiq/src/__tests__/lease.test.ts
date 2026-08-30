// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSchedule,
  classifyAsc842Lessee,
  periodicRateUnits,
  presentValueMinor,
  selectDiscountRate,
  type ClassificationEvidence,
  type ThresholdPolicy,
} from "../kernel.js";

const POLICY: ThresholdPolicy = { majorPartBps: 7500, substantiallyAllBps: 9000 };

describe("classification — the determinacy asymmetry", () => {
  const allNotMet: ClassificationEvidence = {
    ownershipTransfers: false,
    purchaseOptionExists: false,
    termMonths: 24,
    remainingEconomicLifeMonths: 120,
    pvOfPaymentsMinor: 100_000n,
    fairValueMinor: 1_000_000n,
    noAlternativeUse: false,
  };
  it("any MET criterion suffices for finance, even with indeterminates outstanding", () => {
    const outcome = classifyAsc842Lessee(
      { ...allNotMet, ownershipTransfers: true, termMonths: undefined },
      POLICY,
    );
    expect(outcome.ok && outcome.value.classification).toBe("finance");
  });
  it("ALL not-met is operating", () => {
    const outcome = classifyAsc842Lessee(allNotMet, POLICY);
    expect(outcome.ok && outcome.value.classification).toBe("operating");
  });
  it("indeterminate criteria REFUSE, naming each — never defaulted toward operating", () => {
    const outcome = classifyAsc842Lessee(
      { ...allNotMet, termMonths: undefined, noAlternativeUse: undefined },
      POLICY,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.kind).toBe("ClassificationEvidenceInsufficient");
      expect(outcome.refusal.detail).toContain("C3");
      expect(outcome.refusal.detail).toContain("C5");
    }
  });
  it("an option with no assessment is INDETERMINATE, not not-met", () => {
    const outcome = classifyAsc842Lessee(
      { ...allNotMet, purchaseOptionExists: true, purchaseOptionReasonablyCertain: undefined },
      POLICY,
    );
    expect(outcome.ok).toBe(false);
  });
  it("the thresholds are POLICY: the same facts classify differently under a different policy", () => {
    const evidence: ClassificationEvidence = { ...allNotMet, termMonths: 84 }; // 70% of life
    const at75 = classifyAsc842Lessee(evidence, POLICY);
    expect(at75.ok && at75.value.classification).toBe("operating");
    const at65 = classifyAsc842Lessee(evidence, { ...POLICY, majorPartBps: 6500 });
    expect(at65.ok && at65.value.classification).toBe("finance");
  });
});

describe("discount-rate selection — required elections, typed refusals", () => {
  const base = {
    standard: "asc842" as const,
    implicitRateReadilyDeterminable: false,
    assetClass: "property",
    leaseTermMonths: 120,
  };
  it("implicit beats everything when readily determinable; IBR needs a term match", () => {
    const implicit = selectDiscountRate({
      ...base,
      implicitRateReadilyDeterminable: true,
      implicitRatePercent: "6.5",
    });
    expect(implicit.ok && implicit.value.rateType).toBe("implicit");
    const mismatch = selectDiscountRate({
      ...base,
      ibr: { ratePercent: "7", termMatchMonths: 60 },
    });
    expect(!mismatch.ok && mismatch.refusal.kind).toBe("RateTermMismatch");
    const matched = selectDiscountRate({
      ...base,
      ibr: { ratePercent: "7", termMatchMonths: 120 },
    });
    expect(matched.ok && matched.value.rateType).toBe("ibr");
  });
  it("the risk-free election is BY CLASS and is ASC 842 only — IFRS 16 refuses", () => {
    const elected = selectDiscountRate({
      ...base,
      riskFreeElectedClasses: ["property"],
      riskFreeRatePercent: "4.25",
    });
    expect(elected.ok && elected.value.rateType).toBe("risk-free");
    const notElected = selectDiscountRate({
      ...base,
      riskFreeElectedClasses: ["vehicles"],
      riskFreeRatePercent: "4.25",
      ibr: { ratePercent: "7", termMatchMonths: 120 },
    });
    expect(notElected.ok && notElected.value.rateType).toBe("ibr");
    const ifrs = selectDiscountRate({
      ...base,
      standard: "ifrs16",
      riskFreeElectedClasses: ["property"],
      riskFreeRatePercent: "4.25",
    });
    expect(!ifrs.ok && ifrs.refusal.kind).toBe("RiskFreeElectionUnavailable");
  });
  it("nothing available refuses — in preference to any rate the engine could have chosen", () => {
    const outcome = selectDiscountRate(base);
    expect(!outcome.ok && outcome.refusal.kind).toBe("DiscountRateUnavailable");
  });
});

describe("G-23 — the goldens, exactly", () => {
  it("LFIQ-K-1: IBR vs risk-free moves the liability by 114,941.15 — 13.35%", () => {
    const ibrRate = periodicRateUnits("7", "nominal-div-12");
    const rfRate = periodicRateUnits("4.25", "nominal-div-12");
    if (!ibrRate.ok || !rfRate.ok) throw new Error("rate");
    const ibr = presentValueMinor(1_000_000n, 120, ibrRate.value, "arrears");
    const rf = presentValueMinor(1_000_000n, 120, rfRate.value, "arrears");
    expect(ibr).toBe(86_126_354n); // 861,263.54
    expect(rf).toBe(97_620_469n); // 976,204.69
    expect(rf - ibr).toBe(11_494_115n); // 114,941.15
  });
  it("LFIQ-K-2: the compounding convention moves the liability by 8,276.73 — and it is REQUIRED", () => {
    const missing = periodicRateUnits("7", undefined);
    expect(!missing.ok && missing.refusal.kind).toBe("CompoundingConventionRequired");
    const nominal = periodicRateUnits("7", "nominal-div-12");
    const effective = periodicRateUnits("7", "effective-annual");
    if (!nominal.ok || !effective.ok) throw new Error("rate");
    expect(effective.value).toBe(5654145387n); // (1.07)^(1/12) − 1 at 12dp
    const pvNominal = presentValueMinor(1_000_000n, 120, nominal.value, "arrears");
    const pvEffective = presentValueMinor(1_000_000n, 120, effective.value, "arrears");
    expect(pvEffective).toBe(86_954_027n); // 869,540.27
    expect(pvEffective - pvNominal).toBe(827_673n); // 8,276.73
  });
});

describe("the schedule — terminal invariants hold EXACTLY (P-01..P-04)", () => {
  function goldenSchedule(model: "finance" | "operating") {
    const rate = periodicRateUnits("7", "nominal-div-12");
    if (!rate.ok) throw new Error("rate");
    const opening = presentValueMinor(1_000_000n, 120, rate.value, "arrears");
    return buildSchedule({
      model,
      openingLiabilityMinor: opening,
      openingRouMinor: opening,
      paymentMinor: 1_000_000n,
      periods: 120,
      rateUnits: rate.value,
      timing: "arrears",
    });
  }

  it("operating: liability and ROU both close at exactly zero over 120 periods", () => {
    const schedule = goldenSchedule("operating");
    const last = schedule.periods[schedule.periods.length - 1]!;
    expect(last.liabilityCloseMinor).toBe(0n); // P-01
    expect(last.rouCloseMinor).toBe(0n); // P-02
    // P-03: Σ single lease cost == Σ payments, exactly.
    const totalCost = schedule.periods.reduce((a, p) => a + (p.singleLeaseCostMinor ?? 0n), 0n);
    expect(totalCost).toBe(120_000_000n);
    // The single lease cost is 10,000.00 per period under EITHER election —
    // which is why expense-only validation can never catch a wrong election.
    expect(schedule.periods[0]?.singleLeaseCostMinor).toBe(1_000_000n);
    // P-04: Σ interest + Σ rouAmortization == Σ single lease cost.
    const totalAmortization = schedule.periods.reduce((a, p) => a + p.rouAmortizationMinor, 0n);
    expect(schedule.totalInterestMinor + totalAmortization).toBe(totalCost);
  });
  it("finance: R6 final-period-absorbs makes Σ amortization == opening ROU exactly", () => {
    const schedule = goldenSchedule("finance");
    const last = schedule.periods[schedule.periods.length - 1]!;
    expect(last.liabilityCloseMinor).toBe(0n);
    expect(last.rouCloseMinor).toBe(0n);
    const totalAmortization = schedule.periods.reduce((a, p) => a + p.rouAmortizationMinor, 0n);
    expect(totalAmortization).toBe(86_126_354n);
  });
  it("R7 with an awkward total (IDC not divisible by n): cumulative-target sums exactly", () => {
    // Added after mutation R7-independent-rounding survived: payment × n is
    // always divisible by n, so the awkward total needs IDC in it.
    const rate = periodicRateUnits("7", "nominal-div-12");
    if (!rate.ok) throw new Error("rate");
    const opening = presentValueMinor(1_000_000n, 120, rate.value, "arrears");
    const idc = 10_001n; // 100.01 — not divisible by 120
    const schedule = buildSchedule({
      model: "operating",
      openingLiabilityMinor: opening,
      openingRouMinor: opening + idc,
      paymentMinor: 1_000_000n,
      periods: 120,
      rateUnits: rate.value,
      timing: "arrears",
      initialDirectCostsMinor: idc,
    });
    const totalCost = schedule.periods.reduce((a, p) => a + (p.singleLeaseCostMinor ?? 0n), 0n);
    expect(totalCost).toBe(120_000_000n + idc); // exact, no drift
    expect(schedule.periods[schedule.periods.length - 1]!.rouCloseMinor).toBe(0n);
  });
  it("the operating plug (R8) is never rounded: cost − interest exactly, every period", () => {
    const schedule = goldenSchedule("operating");
    for (const p of schedule.periods) {
      expect(p.rouAmortizationMinor).toBe((p.singleLeaseCostMinor ?? 0n) - p.interestMinor);
    }
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/leasefinanceiq/src");
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
  it("platform imports only; no clock; no float rates; no hardcoded 75/90; no depreciate", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.pow|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/majorPartBps\s*=\s*7500|substantiallyAllBps\s*=\s*9000/.test(f.text), f.path).toBe(false);
      expect(/depreciat/i.test(f.text.replace(/never depreciated|not depreciated|owned-asset depreciation is AssetFinanceIQ's|AMORTIZED, not depreciated/g, "")), f.path).toBe(false);
    }
  });
});
