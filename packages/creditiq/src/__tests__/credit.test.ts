// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  applyMitigants,
  behaviourMeasure,
  checkPermissiblePurpose,
  composeExposure,
  declareRegime,
  deriveLimit,
  deriveReasons,
  holdCriterionUtilisationAbove,
  selectMethod,
  testCreditLimit,
  utilisation,
  type ClassCoverage,
  type LimitRule,
} from "../kernel.js";

const cover = (cls: ClassCoverage["class"], coverage: ClassCoverage["coverage"], amountMinor: bigint): ClassCoverage => ({
  class: cls,
  coverage,
  reason: coverage === "complete" ? "bound" : "port unbound",
  amountMinor,
});

describe("§16.2 exposure — a known floor, never 'the exposure'", () => {
  it("undeclared classes default to absent; state is indeterminate unless every class is complete", () => {
    const partial = composeExposure([cover("E1", "complete", 50_000n)]);
    expect(partial.knownFloorMinor).toBe(50_000n);
    expect(partial.state).toBe("indeterminate");
    expect(partial.coverage).toHaveLength(7); // E1..E7 all tracked
    const complete = composeExposure(
      (["E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const).map((c) => cover(c, "complete", 1_000n)),
    );
    expect(complete.state).toBe("determinate");
    expect(complete.knownFloorMinor).toBe(7_000n);
  });
});

describe("§16.3 mitigants — indeterminate conditions do not reduce", () => {
  it("an unevaluable mitigant is reported as potential, never subtracted", () => {
    const r = applyMitigants(100_000n, [
      { mitigantRef: "insurance-1", amountMinor: 40_000n, inForceAtAsOf: true, namesThisCustomer: true, classInScope: true, conditionsEvaluable: false, conditionsSatisfied: null },
      { mitigantRef: "deposit-1", amountMinor: 10_000n, inForceAtAsOf: true, namesThisCustomer: true, classInScope: true, conditionsEvaluable: true, conditionsSatisfied: true },
      { mitigantRef: "lapsed-1", amountMinor: 5_000n, inForceAtAsOf: false, namesThisCustomer: true, classInScope: true, conditionsEvaluable: true, conditionsSatisfied: true },
    ]);
    expect(r.exposureNetMinor).toBe(90_000n); // only the deposit reduces
    expect(r.admitted).toEqual(["deposit-1"]);
    expect(r.indeterminate[0]!.mitigantRef).toBe("insurance-1");
    expect(r.inadmissible[0]!.mitigantRef).toBe("lapsed-1");
  });
});

describe("§16.4 the limit-test asymmetry — the engine's load-bearing rule", () => {
  const partialOver = composeExposure([cover("E1", "complete", 120_000n)]);
  const partialUnder = composeExposure([cover("E1", "complete", 40_000n)]);
  const completeUnder = composeExposure(
    (["E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const).map((c) => cover(c, "complete", 10_000n)),
  );
  it("a breach IS assertible on partial evidence — the unseen cannot bring the floor back under", () => {
    const r = testCreditLimit(partialOver, 100_000n);
    expect(r.outcome).toBe("exceeded");
    if (r.outcome === "exceeded") expect(r.publishable).toBe("credit.limit.exceeded");
  });
  it("compliance is NEVER assertible on partial evidence", () => {
    const r = testCreditLimit(partialUnder, 100_000n);
    expect(r.outcome).toBe("indeterminate");
    if (r.outcome === "indeterminate") expect(r.missingClasses.length).toBeGreaterThan(0);
  });
  it("within-limit only on determinate exposure, and it has NO publishable event", () => {
    const r = testCreditLimit(completeUnder, 100_000n);
    expect(r.outcome).toBe("within-limit");
    if (r.outcome === "within-limit") expect(r.publishable).toBeNull();
  });
  it("utilisation over an indeterminate exposure is undefined, never 0; hold criteria go indeterminate", () => {
    const ratio = utilisation(partialUnder, 100_000n);
    expect(ratio.defined).toBe(false);
    expect(holdCriterionUtilisationAbove(ratio, 800n)).toBe("indeterminate"); // NOT not-met
    const defined = utilisation(completeUnder, 100_000n);
    expect(holdCriterionUtilisationAbove(defined, 500n)).toBe("met"); // 70% > 50%
  });
});

describe("§16.5 limit derivation", () => {
  const rules: LimitRule[] = [
    { ruleId: "segment-a", precedence: 2, requiredEvidenceRefs: ["financials"], proposedMinor: 200_000n, ceilingMinor: 150_000n },
    { ruleId: "fallback", precedence: 1, requiredEvidenceRefs: [], proposedMinor: 25_000n, ceilingMinor: 50_000n },
  ];
  it("a rule with absent evidence yields no proposal — it does not fall back", () => {
    const r = deriveLimit([rules[0]!], new Set());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("noProposal" in r.value && r.value.noProposal).toBe(true);
  });
  it("the winning rule's ceiling caps the proposal and the cap is recorded", () => {
    const r = deriveLimit(rules, new Set(["financials"]));
    expect(r.ok).toBe(true);
    if (!r.ok || "noProposal" in r.value) return;
    expect(r.value.amountMinor).toBe(150_000n);
    expect(r.value.ceilingApplied).toBe(true); // part of the adverse-action reason set
  });
  it("an unresolvable precedence overlap refuses — silent first-match is two rules become one", () => {
    const overlapping = [rules[0]!, { ...rules[0]!, ruleId: "segment-a2" }];
    const r = deriveLimit(overlapping, new Set(["financials"]));
    expect(!r.ok && r.refusal.kind).toBe("limit_rule_overlap_unresolvable");
  });
  it("expiresAt without temporaryReason refuses", () => {
    const r = deriveLimit(rules, new Set(["financials"]), { expiresAt: "2027-01-01" });
    expect(!r.ok && r.refusal.kind).toBe("temporary_limit_without_reason");
  });
});

describe("§16.6 behaviour — the caveats are computation", () => {
  it("prepaid history carries evidential value none — perfect behaviour from never being trusted", () => {
    const m = behaviourMeasure(0n, true, false);
    expect(m.evidentialValue).toBe("none-terms-not-extended");
  });
  it("an unbound dispute flag yields the LABELLED unadjusted figure, not a corrected guess", () => {
    const m = behaviourMeasure(4_500n, false, true);
    expect(m.disputeAdjusted).toBe(false);
    expect(m.evidentialValue).toBe("normal");
  });
});

describe("§16.7 adverse action — the hard gate", () => {
  it("an undeclared regime refuses: no default, no inference, no unknown that proceeds", () => {
    const r = declareRegime(undefined);
    expect(!r.ok && r.refusal.kind).toBe("regime_not_declared");
  });
  it("declared-out-of-scope requires a human assertion with a written basis", () => {
    const bare = declareRegime("declared-out-of-scope");
    expect(!bare.ok && bare.refusal.kind).toBe("out_of_scope_assertion_unattributed");
    const proper = declareRegime("declared-out-of-scope", { assertedBy: "human.steven", writtenBasis: "no US nexus; intra-group settlement only" });
    expect(proper.ok && proper.value.obligations).toBe("none-asserted");
  });
  it("trade credit still owes reasons — B2B is not an exemption", () => {
    const r = declareRegime("us-business-large-or-trade-credit");
    expect(r.ok && r.value.obligations).toBe("reasons-owed");
  });
  it("method selection refuses a no-decomposition method for a regime with obligations", () => {
    const r = selectMethod("reasons-owed", { methodId: "credit.score.opaque", reasonBasis: "none" });
    expect(!r.ok && r.refusal.kind).toBe("reasons_not_extractable_for_regime");
    expect(selectMethod("none-asserted", { methodId: "credit.score.opaque", reasonBasis: "none" }).ok).toBe(true);
  });
  it("reasons derive ONLY from a decomposition that reconciles exactly", () => {
    const broken = deriveReasons(
      { baseline: 700n, score: 640n, contributions: [{ factorId: "dbt", contribution: -50n, evidenceRefs: [], plainLanguage: "past due 60+" }] },
      false,
      new Set(),
    );
    expect(!broken.ok && broken.refusal.kind).toBe("decomposition_does_not_reconcile");
  });
  it("FCRA: adverse factors capped at four, inquiries exempt from the cap", () => {
    const contributions = [
      { factorId: "f1", contribution: -50n, evidenceRefs: [], plainLanguage: "a" },
      { factorId: "f2", contribution: -40n, evidenceRefs: [], plainLanguage: "b" },
      { factorId: "f3", contribution: -30n, evidenceRefs: [], plainLanguage: "c" },
      { factorId: "f4", contribution: -20n, evidenceRefs: [], plainLanguage: "d" },
      { factorId: "f5", contribution: -10n, evidenceRefs: [], plainLanguage: "e" },
      { factorId: "inquiries", contribution: -5n, evidenceRefs: [], plainLanguage: "recent inquiries" },
      { factorId: "good", contribution: 55n, evidenceRefs: [], plainLanguage: "on-time" },
    ];
    const total = contributions.reduce((a, c) => a + c.contribution, 0n);
    const r = deriveReasons({ baseline: 700n, score: 700n + total, contributions }, true, new Set(["inquiries"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((c) => c.factorId);
    expect(ids).toEqual(["f1", "f2", "f3", "f4", "inquiries"]); // 4 + exempt inquiries; f5 dropped; good excluded
  });
  it("a consumer report consumed for a different purpose than obtained refuses", () => {
    const r = checkPermissiblePurpose("credit-transaction", "employment-screening");
    expect(!r.ok && r.refusal.kind).toBe("permissible_purpose_mismatch");
    expect(checkPermissiblePurpose("credit-transaction", "credit-transaction").ok).toBe(true);
  });
});
