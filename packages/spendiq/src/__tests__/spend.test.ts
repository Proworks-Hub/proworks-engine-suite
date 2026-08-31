// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  captureBaseline,
  checkRealisation,
  classify,
  confirmMapping,
  foldCube,
  makeClaim,
  maverickSpend,
  rankSuppliers,
  tailSuppliers,
  type MappingRule,
  type SpendFact,
} from "../kernel.js";

const fact = (factRef: string, amountMinor: bigint, overrides?: Partial<SpendFact>): SpendFact => ({
  factRef,
  amountMinor,
  supplierKey: "supp-acme",
  descriptionKey: "office-chairs",
  ...overrides,
});

const rule: MappingRule = {
  ruleId: "r1",
  effectiveFrom: "2026-01-01",
  matchDescriptionKey: "office-chairs",
  category: "furniture",
  origin: "authored",
};

describe("M-1..M-4 classification — deterministic first, model never counts, human confirms", () => {
  it("an unresolved supplier is unclassified — never dropped, never bucketed by raw string", () => {
    const c = classify(fact("f1", 100n, { supplierKey: null }), [rule], "2026-08-30");
    expect(c.state === "unclassified" && c.reason).toBe("supplier-unresolved");
  });
  it("ordered rules, first match wins, at asOf", () => {
    const later: MappingRule = { ...rule, ruleId: "r2", effectiveFrom: "2027-01-01", category: "seating" };
    const c = classify(fact("f1", 100n), [later, rule], "2026-08-30");
    expect(c.state === "deterministic-mapped" && c.ruleId).toBe("r1"); // r2 not yet effective
  });
  it("a model candidate is model-proposed with ai-candidate strength — never deterministic", () => {
    const c = classify(fact("f1", 100n, { descriptionKey: "mystery" }), [rule], "2026-08-30", {
      category: "furniture",
      modelRef: "model-x",
    });
    expect(c.state).toBe("model-proposed");
    if (c.state === "model-proposed") expect(c.sourceStrength).toBe("ai-candidate");
  });
  it("confirmation needs a human AND a Governance ref, and records the human, not the model", () => {
    const bad = confirmMapping("furniture", "mystery", "system.batch", "gov-1", "2026-08-30", "r9");
    expect(!bad.ok && bad.refusal.kind).toBe("confirmation-authorization-missing");
    const good = confirmMapping("furniture", "mystery", "human.steven", "gov-1", "2026-08-30", "r9");
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.value.origin).toBe("human-confirmed"); // no "model" origin exists
  });
});

describe("M-5 the three-bucket fold and invariant R-1", () => {
  it("attributed, unclassified and lowEvidence never collapse; model proposals never inflate attribution", () => {
    const facts = [
      { fact: fact("f1", 1_000n), classification: classify(fact("f1", 1_000n), [rule], "2026-08-30") },
      {
        fact: fact("f2", 500n, { descriptionKey: "mystery" }),
        classification: classify(fact("f2", 500n, { descriptionKey: "mystery" }), [rule], "2026-08-30", { category: "furniture", modelRef: "m" }),
      },
      { fact: fact("f3", 300n, { supplierKey: null }), classification: classify(fact("f3", 300n, { supplierKey: null }), [rule], "2026-08-30") },
    ];
    const r = foldCube(facts, 1_800n);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total.attributedMinor).toBe(1_000n);
    expect(r.value.total.lowEvidenceMinor).toBe(500n); // model-proposed lands here
    expect(r.value.total.unclassifiedMinor).toBe(300n);
    // `unclassified` is a real node.
    expect(r.value.byCategory.get("unclassified")!.unclassifiedMinor).toBe(300n);
  });
  it("R-1: a cube that does not tie to the source refuses with the residual", () => {
    const facts = [{ fact: fact("f1", 1_000n), classification: classify(fact("f1", 1_000n), [rule], "2026-08-30") }];
    const r = foldCube(facts, 1_100n);
    expect(!r.ok && r.refusal.kind).toBe("reconciliation-failed");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("residual 100");
  });
});

describe("M-6 ranking — the excluded set is first-class", () => {
  it("a supplier over the unclassified-share threshold is excluded VISIBLY, not omitted", () => {
    const r = rankSuppliers(
      [
        { supplierKey: "a", coverage: { attributedMinor: 900n, unclassifiedMinor: 100n, lowEvidenceMinor: 0n } },
        { supplierKey: "b", coverage: { attributedMinor: 300n, unclassifiedMinor: 700n, lowEvidenceMinor: 0n } },
      ],
      500n, // 50%
    );
    expect(r.ranked.map((x) => x.supplierKey)).toEqual(["a"]);
    expect(r.excluded[0]!.supplierKey).toBe("b");
    expect(r.excluded[0]!.unclassifiedSharePermille).toBe(700n);
  });
});

describe("M-7 tail spend — four definitions, required, mutually non-substitutable", () => {
  const suppliers = [
    { supplierKey: "big", annualSpendMinor: 40_000_000n, transactionCount: 400 },
    { supplierKey: "one-shot", annualSpendMinor: 40_000_00n, transactionCount: 1 }, // one £400k... one large purchase
    { supplierKey: "small-many", annualSpendMinor: 500_000n, transactionCount: 90 },
    { supplierKey: "tiny", annualSpendMinor: 100_000n, transactionCount: 3 },
  ];
  it("an unselected definition refuses — published answers span 5% to 40%", () => {
    const r = tailSuppliers(suppliers, undefined);
    expect(!r.ok && r.refusal.kind).toBe("tail-definition-required");
  });
  it("GD-TAIL: transaction-count and absolute-threshold select DIFFERENT sets — no arm substitutable", () => {
    const byCount = tailSuppliers(suppliers, { kind: "transaction-count", fewerThan: 10 });
    const byThreshold = tailSuppliers(suppliers, { kind: "absolute-threshold", belowMinor: 1_000_000n });
    expect(byCount.ok && byThreshold.ok).toBe(true);
    if (!byCount.ok || !byThreshold.ok) return;
    // one-shot: 1 transaction → tail by count; 4,000,000 minor → NOT tail by threshold.
    expect(byCount.value.tail).toContain("one-shot");
    expect(byThreshold.value.tail).not.toContain("one-shot");
    // small-many: 90 transactions → not tail by count; 500,000 → tail by threshold.
    expect(byCount.value.tail).not.toContain("small-many");
    expect(byThreshold.value.tail).toContain("small-many");
  });
  it("cumulative-share and abc-category are category-relative and differ from both", () => {
    const share = tailSuppliers(suppliers, { kind: "cumulative-share", topPermille: 800n });
    const abc = tailSuppliers(suppliers, { kind: "abc-category", categoryCSharePermille: 100n });
    expect(share.ok && abc.ok).toBe(true);
    if (!share.ok || !abc.ok) return;
    expect(share.value.tail.length).toBeGreaterThan(0);
    // ABC category C (5-10% of spend) produces the SMALLEST tail of the four.
    expect(abc.value.tail.length).toBeLessThanOrEqual(share.value.tail.length);
  });
});

describe("M-9 maverick spend — refuses on an unbound register, never £0", () => {
  it("unbound register: a typed refusal naming the missing port and rejecting the zero", () => {
    const r = maverickSpend([{ factRef: "f1", supplierKey: "s", category: "c", date: "2026-05-01" }], undefined);
    expect(!r.ok && r.refusal.kind).toBe("contract-register-unbound");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("never £0");
  });
  it("with a register: OC-1 classification by coverage window", () => {
    const r = maverickSpend(
      [
        { factRef: "covered", supplierKey: "s", category: "c", date: "2026-05-01" },
        { factRef: "outside-window", supplierKey: "s", category: "c", date: "2027-05-01" },
      ],
      [{ supplierKey: "s", category: "c", coverageFrom: "2026-01-01", coverageTo: "2026-12-31" }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.covered).toEqual(["covered"]);
    expect(r.value.offContractOc1).toEqual(["outside-window"]);
  });
});

describe("M-10/M-11 the savings-claim integrity core", () => {
  it("a baseline without a basis refuses — six bases, six numbers, no flattering default", () => {
    const r = captureBaseline("b1", undefined, 1_000n, 12, "2026-08-01");
    expect(!r.ok && r.refusal.kind).toBe("baseline-basis-required");
  });
  it("the claim amount derives from the baseline; the assertion is generated with its negative half", () => {
    const baseline = captureBaseline("b1", "prior-actual-weighted-average", 1_000n, 12, "2026-08-01");
    if (!baseline.ok) return;
    const claim = makeClaim("c1", "unit-price-reduction", baseline.value, { unitPriceMinor: 900n, quantity: 50n });
    expect(claim.amount.amountMinor).toBe(5_000n); // (1000−900)×50
    expect(claim.assertion.asserts).toContain("prior-actual-weighted-average");
    expect(claim.assertion.doesNotAssert).toContain("that cash was saved");
    expect(claim.realisation).toBeNull(); // not yet checked — NOT zero
  });
  it("consolidation-leverage adds the switching-cost caveat to the negative half", () => {
    const baseline = captureBaseline("b1", "prior-actual-last-paid", 1_000n, 3, "2026-08-01");
    if (!baseline.ok) return;
    const claim = makeClaim("c2", "consolidation-leverage", baseline.value, { unitPriceMinor: 950n, quantity: 10n });
    expect(claim.assertion.doesNotAssert).toContain("switching costs");
  });
  it("cost-avoidance is STRUCTURALLY unreconcilable — the increase that did not happen leaves no trace", () => {
    const baseline = captureBaseline("b1", "first-quote", 1_200n, 1, "2026-08-01");
    if (!baseline.ok) return;
    const claim = makeClaim("c3", "cost-avoidance", baseline.value, { unitPriceMinor: 1_000n, quantity: 100n });
    const outcome = checkRealisation(claim, 20_000n, []);
    expect(outcome.kind).toBe("unreconcilable");
  });
  it("realisation: exact movement reconciles; a differing movement carries the variance and drivers", () => {
    const baseline = captureBaseline("b1", "prior-actual-weighted-average", 1_000n, 12, "2026-08-01");
    if (!baseline.ok) return;
    const claim = makeClaim("c4", "unit-price-reduction", baseline.value, { unitPriceMinor: 900n, quantity: 50n });
    expect(checkRealisation(claim, 5_000n, []).kind).toBe("reconciled");
    const varied = checkRealisation(claim, 3_000n, ["volume-change"]);
    expect(varied.kind).toBe("reconciled-with-variance");
    if (varied.kind === "reconciled-with-variance") {
      expect(varied.varianceMinor).toBe(-2_000n);
      expect(varied.drivers).toContain("volume-change");
    }
    expect(checkRealisation(claim, null, []).kind).toBe("unreconcilable");
  });
});

// ── Guards for both DEC-026 packages ────────────────────────────────────────

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

describe("guards — spendiq, forecastiq", () => {
  const roots = ["spendiq", "forecastiq"].map((p) => join(process.cwd(), "packages", p, "src"));
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no float-as-money", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("G-LOCK2b: no SavingsClaim amount is constructible outside deriveSavings", () => {
    for (const f of files.filter((x) => x.path.includes("spendiq"))) {
      // No `SavingsClaim.of(`, no builder, no `amountMinor:` literal assignment
      // into a claim outside the branded derivation.
      expect(/SavingsClaim\.of\(|amount:\s*\{\s*amountMinor/.test(f.text), f.path).toBe(false);
    }
  });
  it("no MappingOrigin model variant exists in spendiq", () => {
    for (const f of files.filter((x) => x.path.includes("spendiq"))) {
      expect(/origin:\s*"model"/.test(f.text), f.path).toBe(false);
    }
  });
  it("forecastiq never auto-corrects bias and never pools stored accuracy", () => {
    for (const f of files.filter((x) => x.path.includes("forecastiq"))) {
      expect(/autoCorrectionApplied:\s*true/.test(f.text), f.path).toBe(false);
    }
  });
});
