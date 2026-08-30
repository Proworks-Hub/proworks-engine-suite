// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateDiscount,
  allocateRelativeSsp,
  allocateVariableToObligation,
  applyConstraint,
  classifySatisfaction,
  costToCostProgress,
  estimateVariable,
  identifyContract,
  observableSsp,
  recognizeOverTime,
  residualSsp,
  royaltyException,
  type ConstraintFactors,
} from "../kernel.js";

const met = (evidenceRef = "ev"): { met: true; evidenceRef: string } => ({ met: true, evidenceRef });
const notMet = (evidenceRef = "ev"): { met: false; evidenceRef: string } => ({ met: false, evidenceRef });

describe("M-1 — five criteria, none defaulting to met", () => {
  const all = {
    approvalAndCommitment: met(),
    identifiableRights: met(),
    identifiablePaymentTerms: met(),
    commercialSubstance: met(),
    collectibilityProbable: met(),
  };
  it("a missing finding refuses naming it; failed collectibility is not-a-contract", () => {
    const { collectibilityProbable: _c, ...missing } = all;
    const outcome = identifyContract(missing);
    expect(!outcome.ok && outcome.refusal.detail).toContain("collectibilityProbable");
    const failed = identifyContract({ ...all, collectibilityProbable: notMet() });
    expect(failed.ok && failed.value.state).toBe("not-a-contract");
    const contract = identifyContract(all);
    expect(contract.ok && contract.value.state).toBe("contract");
  });
});

describe("M-4/M-5/M-6 — variable consideration and THE constraint", () => {
  const outcomes = [
    { amountMinor: 100_000n, probabilityBps: 6000 },
    { amountMinor: 0n, probabilityBps: 4000 },
  ];
  it("the estimation method is the ENTITY'S selection; a distribution must sum to one", () => {
    const unselected = estimateVariable({ method: undefined, outcomes });
    expect(!unselected.ok && unselected.refusal.kind).toBe("estimation-method-unselected");
    const expected = estimateVariable({ method: "expected-value", outcomes });
    expect(expected.ok && expected.value.rawEstimateMinor).toBe(60_000n);
    const mostLikely = estimateVariable({ method: "most-likely-amount", outcomes });
    expect(mostLikely.ok && mostLikely.value.rawEstimateMinor).toBe(100_000n);
    const bad = estimateVariable({
      method: "expected-value",
      outcomes: [{ amountMinor: 1n, probabilityBps: 9000 }],
    });
    expect(bad.ok).toBe(false);
  });
  it("ANY absent factor finding refuses — absence is never 'no risk'", () => {
    const partial: ConstraintFactors = {
      outsideInfluence: met(),
      longResolutionPeriod: met(),
      limitedExperience: notMet(),
      concessionPractice: notMet(),
      // broadRange absent
    };
    const outcome = applyConstraint(100_000n, partial, [10000, 8000, 5000, 2500, 1000, 0]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("constraint-evidence-insufficient");
    expect(!outcome.ok && outcome.refusal.detail).toContain("broadRange");
  });
  it("the policy scales inclusion by risk-factor count, never above the raw estimate", () => {
    const factors: ConstraintFactors = {
      outsideInfluence: met(),
      longResolutionPeriod: met(),
      limitedExperience: notMet(),
      concessionPractice: notMet(),
      broadRange: notMet(),
    };
    const outcome = applyConstraint(100_000n, factors, [10000, 8000, 5000, 2500, 1000, 0]);
    expect(outcome.ok && outcome.value.riskFactorsMet).toBe(2);
    expect(outcome.ok && outcome.value.constrainedMinor).toBe(50_000n);
  });
  it("the royalty exception is IP-licence-gated", () => {
    expect(royaltyException(undefined).ok).toBe(false);
    expect(royaltyException(notMet()).ok).toBe(false);
    expect(royaltyException(met()).ok).toBe(true);
  });
});

describe("M-7/M-10 — SSP: the corridor refuses, the residual is gated", () => {
  const policy = { minimumObservations: 5, toleranceBps: 1000, requiredCoverageBps: 8000 };
  it("insufficient coverage refuses — never a wider band", () => {
    const scattered = observableSsp([100n, 200n, 300n, 400n, 500n], policy);
    expect(!scattered.ok && scattered.refusal.kind).toBe("ssp-corridor-coverage-insufficient");
    const tight = observableSsp([98n, 99n, 100n, 101n, 102n], policy);
    expect(tight.ok && tight.value.sspMinor).toBe(100n);
  });
  it("the residual needs its narrow-condition finding, and an implausible result refuses", () => {
    const ungated = residualSsp({
      transactionPriceMinor: 1000n,
      observableOtherSspsMinor: [600n],
    });
    expect(!ungated.ok && ungated.refusal.kind).toBe("residual-conditions-unmet");
    const gated = residualSsp({
      transactionPriceMinor: 1000n,
      observableOtherSspsMinor: [600n],
      highlyVariableFinding: met(),
    });
    expect(gated.ok && gated.value.sspMinor).toBe(400n);
    const negative = residualSsp({
      transactionPriceMinor: 1000n,
      observableOtherSspsMinor: [600n, 500n],
      highlyVariableFinding: met(),
    });
    expect(!negative.ok && negative.refusal.kind).toBe("residual-result-implausible");
  });
});

describe("M-11 — relative-SSP allocation: exact, order-independent, monotone", () => {
  const obligations = [
    { obligationId: "licence", sspMinor: 70_000n, ordinal: 1 },
    { obligationId: "support", sspMinor: 20_000n, ordinal: 2 },
    { obligationId: "training", sspMinor: 10_000n, ordinal: 3 },
  ];
  it("P-2 exactness: Σ allocated == T for an awkward price", () => {
    const outcome = allocateRelativeSsp(99_999n, obligations);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.allocations.reduce((a, r) => a + r.allocatedMinor, 0n)).toBe(99_999n);
  });
  it("P-3 order independence: shuffling produces identical allocations", () => {
    const forward = allocateRelativeSsp(99_999n, obligations);
    const reversed = allocateRelativeSsp(99_999n, [...obligations].reverse());
    expect(forward.ok && reversed.ok).toBe(true);
    if (!forward.ok || !reversed.ok) return;
    const sort = (r: typeof forward.value.allocations) =>
      [...r].sort((a, b) => a.obligationId.localeCompare(b.obligationId));
    expect(sort(forward.value.allocations)).toEqual(sort(reversed.value.allocations));
  });
  it("P-4 monotonicity: a larger SSP never receives less", () => {
    const outcome = allocateRelativeSsp(99_999n, obligations);
    if (!outcome.ok) return;
    const byId = new Map(outcome.value.allocations.map((a) => [a.obligationId, a.allocatedMinor]));
    expect(byId.get("licence")! > byId.get("support")!).toBe(true);
    expect(byId.get("support")! > byId.get("training")!).toBe(true);
  });
  it("preconditions refuse: zero SSP sum", () => {
    const outcome = allocateRelativeSsp(100n, [{ obligationId: "x", sspMinor: 0n, ordinal: 1 }]);
    expect(!outcome.ok && outcome.refusal.kind).toBe("ssp-sum-zero");
  });
});

describe("M-12/M-13 — fallbacks are RECORDED, never silent", () => {
  it("discount: all three conditions or proportionate-with-record", () => {
    const specific = allocateDiscount({
      regularStandaloneSales: met(),
      regularBundleSales: met(),
      substantiallySameDiscount: met(),
    });
    expect(specific.target).toBe("specific-obligations");
    const fallback = allocateDiscount({ regularStandaloneSales: met() });
    expect(fallback.target).toBe("proportionate");
    expect(fallback.fallbackRecorded).toContain("regularBundleSales");
  });
  it("variable allocation: both 32-40 criteria or into-the-price, recorded as materially different", () => {
    const specific = allocateVariableToObligation({
      relatesSpecifically: met(),
      consistentWithObjective: met(),
    });
    expect(specific.path).toBe("specific-allocation");
    const fallback = allocateVariableToObligation({ relatesSpecifically: met() });
    expect(fallback.path).toBe("into-transaction-price");
    expect(fallback.recorded).toContain("materially different");
  });
});

describe("M-14 — no default to ratable", () => {
  it("criterion (c) needs BOTH halves; nothing evidenced REFUSES", () => {
    const halfC = classifySatisfaction({ noAlternativeUse: met() });
    expect(!halfC.ok && halfC.refusal.kind).toBe("over-time-criterion-unevidenced");
    const fullC = classifySatisfaction({
      noAlternativeUse: met(),
      enforceableRightToPayment: met(),
    });
    expect(fullC.ok && fullC.value.pattern).toBe("over-time");
    const pointInTime = classifySatisfaction({ controlTransferEvidenced: met() });
    expect(pointInTime.ok && pointInTime.value.pattern).toBe("point-in-time");
    const nothing = classifySatisfaction({});
    expect(!nothing.ok && nothing.refusal.kind).toBe("over-time-criterion-unevidenced");
  });
});

describe("M-15/M-17 — cost-to-cost with uninstalled materials at zero margin", () => {
  it("excludes uninstalled and wasted costs from the measure; recognises uninstalled at cost", () => {
    const progress = costToCostProgress({
      costIncurredMinor: 500_000n,
      uninstalledMaterialsMinor: 100_000n,
      wastedCostsMinor: 50_000n,
      totalEstimatedCostMinor: 1_100_000n,
    });
    expect(progress.ok).toBe(true);
    if (!progress.ok) return;
    // (500k−100k−50k) / (1,100k−100k) = 35%
    expect(progress.value.progressBps).toBe(3500);
    const recognized = recognizeOverTime({
      allocatedMinor: 2_000_000n,
      progressBps: progress.value.progressBps,
      previouslyRecognizedMinor: 500_000n,
      uninstalledAtCostMinor: progress.value.uninstalledAtCostMinor,
    });
    // 2,000,000 × 35% + 100,000 at cost = 800,000; catch-up = 300,000.
    expect(recognized.cumulativeMinor).toBe(800_000n);
    expect(recognized.catchUpMinor).toBe(300_000n);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/revenuerecognitioniq/src");
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
  it("platform imports only; no clock; no floats; no billing or cash vocabulary in the model", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/issueInvoice|applyCash|postEntry|writeJournal/.test(f.text), f.path).toBe(false);
    }
  });
});
