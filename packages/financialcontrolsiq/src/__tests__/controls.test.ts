// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  computeControlCoverage,
  computeDeficiencyCandidate,
  computeRulePrecision,
  deriveSampleSize,
  detectExceptions,
  evaluateDesignEffectiveness,
  evaluateExceptionBudget,
  evaluateOperatingEffectiveness,
  evaluateSegregationOfDuties,
  loadThreshold,
} from "../kernel.js";

describe("M-1/M-2 design and operating effectiveness are separate findings", () => {
  it("design: a control whose response does not address a claimed assertion is deficient", () => {
    const r = evaluateDesignEffectiveness({
      controlId: "c1",
      riskStatement: "unauthorized journal entries post to closed periods",
      claimedAssertions: ["completeness", "authorization"],
      addressedAssertions: ["authorization"],
    });
    expect(r.verdict).toBe("deficient");
    if (r.verdict === "deficient") expect(r.unmetAssertions).toEqual(["completeness"]);
  });
  it("design without a risk statement is indeterminate — effectiveness is relative to a stated risk", () => {
    const r = evaluateDesignEffectiveness({ controlId: "c1", riskStatement: " ", claimedAssertions: [], addressedAssertions: [] });
    expect(r.verdict).toBe("indeterminate");
  });
  it("operating: an unattested population can NEVER test effective — 100% of unattested < 25 of attested", () => {
    const r = evaluateOperatingEffectiveness({
      populationCompleteness: "unattested",
      testedCount: 10_000,
      deviationCount: 0,
      tolerableRatePermille: 50n,
      itgcRelianceClaimed: false,
      itgcTestResultRef: null,
    });
    expect(r.verdict).toBe("indeterminate");
    if (r.verdict === "indeterminate") expect(r.reason).toBe("population-unattested");
  });
  it("unsubstantiated ITGC reliance and zero evidence are each indeterminate; a real deviation rate decides", () => {
    const base = {
      populationCompleteness: "attested" as const,
      testedCount: 40,
      deviationCount: 3,
      tolerableRatePermille: 50n,
      itgcRelianceClaimed: false,
      itgcTestResultRef: null,
    };
    expect(evaluateOperatingEffectiveness({ ...base, itgcRelianceClaimed: true }).verdict).toBe("indeterminate");
    expect(evaluateOperatingEffectiveness({ ...base, testedCount: 0, deviationCount: 0 }).verdict).toBe("indeterminate");
    const deficient = evaluateOperatingEffectiveness(base); // 75‰ > 50‰
    expect(deficient.verdict).toBe("deficient");
    const effective = evaluateOperatingEffectiveness({ ...base, deviationCount: 1 }); // 25‰ ≤ 50‰
    expect(effective.verdict).toBe("effective");
  });
});

describe("M-4 sampling — required drivers, no defaults", () => {
  it("expected >= tolerable refuses: no sample size supports the conclusion", () => {
    const r = deriveSampleSize(50n, 50n, 950, 10_000);
    expect(!r.ok && r.refusal.kind).toBe("sample_expected_exceeds_tolerable");
  });
  it("a population smaller than the derived size tests 100%", () => {
    const r = deriveSampleSize(50n, 10n, 950, 30);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.approach).toBe("test-100-percent");
    expect(r.value.sampleSize).toBe(30);
  });
  it("higher confidence derives a larger sample", () => {
    const at95 = deriveSampleSize(50n, 10n, 950, 100_000);
    const at99 = deriveSampleSize(50n, 10n, 990, 100_000);
    if (!at95.ok || !at99.ok) return;
    expect(at99.value.sampleSize).toBeGreaterThan(at95.value.sampleSize);
  });
});

describe("M-6 segregation of duties — clean is unconstructable", () => {
  const conflictPairs: (readonly [string, string])[] = [["create-vendor", "release-payment"]];
  it("an unbound identity port is indeterminate", () => {
    const r = evaluateSegregationOfDuties(conflictPairs, undefined, true);
    expect(r.verdict === "indeterminate" && r.reason).toBe("identity-port-unbound");
  });
  it("an incomplete duty mapping is indeterminate", () => {
    const r = evaluateSegregationOfDuties(conflictPairs, new Map(), false);
    expect(r.verdict === "indeterminate" && r.reason).toBe("duty-mapping-incomplete");
  });
  it("a conflict names the principal and both duties", () => {
    const r = evaluateSegregationOfDuties(conflictPairs, new Map([["user-7", ["create-vendor", "release-payment"]]]), true);
    expect(r.verdict).toBe("conflicts-found");
    if (r.verdict !== "conflicts-found") return;
    expect(r.conflicts[0]!.principalRef).toBe("user-7");
  });
  it("the strongest positive verdict is scoped: no-conflicts-in-evaluated-scope, never clean", () => {
    const r = evaluateSegregationOfDuties(conflictPairs, new Map([["user-8", ["create-vendor"]]]), true);
    expect(r.verdict).toBe("no-conflicts-in-evaluated-scope");
  });
});

describe("§16.6 thresholds — evidenced or unloadable", () => {
  it("a threshold with no basis refuses: there is no basis 'guessed'", () => {
    const r = loadThreshold("rule-1", 100_000n, undefined, "2026-08-30");
    expect(!r.ok && r.refusal.kind).toBe("threshold_basis_missing");
  });
  it("a provisional threshold past expiry FAILS TO LOAD, naming the owner", () => {
    const r = loadThreshold("rule-1", 100_000n, { kind: "provisional", expiresAt: "2026-06-01", ownerRef: "human.steven", rationale: "initial rollout" }, "2026-08-30");
    expect(!r.ok && r.refusal.kind).toBe("rule-unloadable: threshold-expired");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("human.steven");
  });
  it("an unexpired provisional and an evidenced basis both load", () => {
    expect(loadThreshold("rule-1", 100_000n, { kind: "provisional", expiresAt: "2027-01-01", ownerRef: "human.steven", rationale: "rollout" }, "2026-08-30").ok).toBe(true);
    expect(loadThreshold("rule-2", 50_000n, { kind: "statutory", citation: "reg-x" }, "2026-08-30").ok).toBe(true);
  });
});

describe("M-5 exception detection — missing facts refuse, never empty", () => {
  it("a rule referencing a fact the population lacks refuses naming the fact", () => {
    const r = detectExceptions(["approvalTimestamp", "paymentTimestamp"], new Set(["approvalTimestamp"]), () => []);
    expect(!r.ok && r.refusal.kind).toBe("rule_references_missing_fact");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("paymentTimestamp");
  });
  it("with facts present the rule runs", () => {
    const r = detectExceptions(["a"], new Set(["a"]), () => ["exc-1"]);
    expect(r.ok && r.value).toEqual(["exc-1"]);
  });
});

describe("M-8/M-9/M-10 — candidates, precision, coverage", () => {
  it("a deficiency candidate has NO severity and records untested compensating controls as nothing", () => {
    const c = computeDeficiencyCandidate(
      "c1",
      75n,
      50n,
      2_000_000n,
      [{ controlId: "comp-1", tested: false, effective: null }],
      [{ indicator: "restatement-of-prior-financials", assertedBy: "human.auditor" }],
    );
    expect("severity" in c).toBe(false);
    expect(c.compensatingControls[0]!.state).toBe("compensating-untested");
    expect(c.materialWeaknessIndicators[0]!.assertedBy).toBe("human.auditor");
  });
  it("M-9: below the adjudication minimum the interval is ABSENT — never 0, never 1", () => {
    const thin = computeRulePrecision(2, 1, 40, 10);
    expect(thin.precisionIntervalPermille).toBeNull();
    const enough = computeRulePrecision(30, 10, 5, 10);
    expect(enough.precisionIntervalPermille).not.toBeNull();
    expect(enough.precisionIntervalPermille!.lo).toBeGreaterThan(0);
    expect(enough.precisionIntervalPermille!.hi).toBeLessThanOrEqual(1000);
  });
  it("M-10: three counts, never a percentage; undesignated never folded", () => {
    const coverage = computeControlCoverage([
      { controlId: "a", designation: "key", tested: true },
      { controlId: "b", designation: "key", tested: false },
      { controlId: "c", designation: null, tested: true }, // undesignated stays undesignated
    ]);
    expect(coverage).toEqual({ tested: 1, untested: 1, undesignated: 1 });
  });
});

describe("§16.9 exception budgets — flagged, never suppressed, never disabled", () => {
  it("an exceeded budget emits the event, keeps every exception, and never disables the rule", () => {
    const r = evaluateExceptionBudget(5, 10_000, 200, 2); // budget 50, actual 200 > 100
    expect(r.budgetExceeded).toBe(true);
    expect(r.eventEmitted).toBe("control.rule.over_budget");
    expect(r.exceptionsEmitted).toBe(200); // none suppressed
    expect(r.ruleDisabled).toBe(false);
  });
  it("within budget: no event, still every exception", () => {
    const r = evaluateExceptionBudget(5, 10_000, 40, 2);
    expect(r.budgetExceeded).toBe(false);
    expect(r.exceptionsEmitted).toBe(40);
  });
});
