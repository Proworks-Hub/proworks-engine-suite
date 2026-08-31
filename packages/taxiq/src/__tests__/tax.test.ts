// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  aggregateFiling,
  computeStack,
  computeTax,
  determineTaxability,
  determineWithholding,
  evaluateExemption,
  evaluateNexus,
  taxInclusiveSplit,
  type NexusThreshold,
  type NexusWindowCoverage,
} from "../kernel.js";

describe("M-TAXABILITY — no default in either direction", () => {
  const rules = new Map([["food-groceries", "exempt" as const], ["general-goods", "taxable" as const]]);
  it("an unmapped item is UNDETERMINED — never default-taxable, never default-exempt", () => {
    const r = determineTaxability(null, rules);
    expect(!r.ok && r.refusal.kind).toBe("item_not_classified");
  });
  it("a category not in the content set refuses rather than passing through", () => {
    const r = determineTaxability("mystery-category", rules);
    expect(!r.ok && r.refusal.kind).toBe("no_content_for_jurisdiction");
  });
  it("a mapped category resolves with the rule key recorded", () => {
    const r = determineTaxability("food-groceries", rules);
    expect(r.ok && r.value.outcome).toBe("exempt");
  });
});

describe("M-NEXUS — partial history establishes, never refutes", () => {
  const threshold: NexusThreshold = {
    jurisdictionRef: "us-sd",
    amountMinor: 10_000_000n, // $100,000
    transactionCount: 200,
    combinator: "or",
    includesExemptSales: true,
    includesResale: false,
    collectionStartLagMonths: 4,
  };
  const coverage = (overrides?: Partial<NexusWindowCoverage>): NexusWindowCoverage => ({
    observedMeasureMinor: 0n,
    observedTransactionCount: 0,
    completeness: "engine-observed-only",
    observedSetMayOverstate: false,
    ...overrides,
  });
  it("an above-threshold PARTIAL observation establishes the obligation a fortiori", () => {
    const r = evaluateNexus(threshold, coverage({ observedMeasureMinor: 12_000_000n }));
    expect(r.kind).toBe("obligation-established");
    if (r.kind !== "obligation-established") return;
    expect(r.basis).toBe("monotone-a-fortiori");
    // Crossing is not collecting: the two dates differ.
    expect(r.collectionStartLagMonths).toBe(4);
  });
  it("a below-threshold PARTIAL observation is INDETERMINATE — never no-obligation", () => {
    const r = evaluateNexus(threshold, coverage({ observedMeasureMinor: 4_000_000n }));
    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") return;
    expect(r.reason).toBe("incomplete-transaction-coverage");
  });
  it("no-obligation requires a completeness attestation, and reports the margin", () => {
    const r = evaluateNexus(threshold, coverage({ observedMeasureMinor: 4_000_000n, completeness: "complete-attested", attestedBy: "human.steven" }));
    expect(r.kind).toBe("no-obligation");
    if (r.kind !== "no-obligation") return;
    expect(r.marginToThresholdMinor).toBe(6_000_000n);
  });
  it("an over-inclusive observed set voids the monotone basis even ABOVE threshold", () => {
    // The threshold excludes resale but the observed set contains it: the
    // observation could overstate, so the a-fortiori argument fails.
    const r = evaluateNexus(threshold, coverage({ observedMeasureMinor: 12_000_000n, observedSetMayOverstate: true }));
    expect(r.kind).toBe("indeterminate");
    if (r.kind !== "indeterminate") return;
    expect(r.reason).toBe("measure-not-computable-from-available-fields");
  });
  it("transaction count alone crosses an OR threshold", () => {
    const r = evaluateNexus(threshold, coverage({ observedTransactionCount: 201 }));
    expect(r.kind).toBe("obligation-established");
  });
});

describe("M-EXEMPTION — per-jurisdiction, evidenced, replay-stable", () => {
  const certificate = {
    certificateRef: "cert-1",
    coveredJurisdictionRefs: ["us-tx", "us-tx-harris"],
    validFrom: "2025-01-01",
    validTo: "2026-06-30",
    scope: "resale" as const,
    consumedByTransactionRef: null,
  };
  it("a claimed exemption with no certificate is a BLOCKING refusal", () => {
    const r = evaluateExemption(["us-tx"], "resale", undefined, "2026-01-15", "txn-1");
    expect(!r.ok && r.refusal.kind).toBe("exemption_claimed_without_evidence");
  });
  it("validity is PER JURISDICTION: the uncovered layer of the stack still taxes", () => {
    const r = evaluateExemption(["us-tx", "us-tx-harris", "us-tx-houston"], "resale", certificate, "2026-01-15", "txn-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.outcome).toBe("exempt");
    expect(r.value[1]!.outcome).toBe("exempt");
    expect(r.value[2]!.outcome).toBe("taxable"); // the partial-exemption case, explicit
  });
  it("expiry is evaluated against the TAX POINT DATE, not today — replay stays exempt", () => {
    // Certificate expired 2026-06-30; the supply was 2026-05-01: still exempt.
    const r = evaluateExemption(["us-tx"], "resale", certificate, "2026-05-01", "txn-2");
    expect(r.ok && r.value[0]!.outcome).toBe("exempt");
    const after = evaluateExemption(["us-tx"], "resale", certificate, "2026-07-15", "txn-3");
    expect(after.ok && after.value[0]!.outcome).toBe("taxable");
  });
  it("a single-purchase certificate is consumed by one transaction", () => {
    const consumed = { ...certificate, scope: "single-purchase" as const, consumedByTransactionRef: "txn-9" };
    const other = evaluateExemption(["us-tx"], "single-purchase", consumed, "2026-01-15", "txn-10");
    expect(other.ok && other.value[0]!.outcome).toBe("taxable");
    const same = evaluateExemption(["us-tx"], "single-purchase", consumed, "2026-01-15", "txn-9");
    expect(same.ok && same.value[0]!.outcome).toBe("exempt");
  });
});

describe("M-CALCULATION-AND-ROUNDING — a versioned method, never a setting", () => {
  it("line-level vs invoice-level rounding differ by design, and the allocation is recorded", () => {
    const lines = [333n, 333n, 334n]; // 19% of each: 63.27 each exactly
    const lineLevel = computeTax(lines, 190n, { jurisdictionRef: "de", level: "line", mode: "half-even", residualAllocation: "largest-remainder" });
    const invoiceLevel = computeTax(lines, 190n, { jurisdictionRef: "de", level: "invoice", mode: "half-even", residualAllocation: "largest-remainder" });
    expect(lineLevel.allocationRecorded).toBe(false);
    expect(invoiceLevel.allocationRecorded).toBe(true);
    // Both sum consistently within their own method.
    expect(lineLevel.perLineTaxMinor.reduce((a, t) => a + t, 0n)).toBe(lineLevel.totalTaxMinor);
    expect(invoiceLevel.perLineTaxMinor.reduce((a, t) => a + t, 0n)).toBe(invoiceLevel.totalTaxMinor);
  });
  it("G-11: the tax-inclusive split preserves the GROSS and never presents the apparent rate as the rate", () => {
    const r = taxInclusiveSplit(7_920n, 190n); // 79.20 EUR at 19%
    expect(r.netMinor).toBe(6_655n); // 66.55
    expect(r.taxMinor).toBe(1_265n); // 12.65 — sums to 79.20
    expect(r.netMinor + r.taxMinor).toBe(7_920n);
    expect(r.preservedInvariant).toBe("gross");
    expect(r.appliedRatePermille).toBe(190n); // the rate in the capture is 19%
    expect(r.apparentRateDiffersFromApplied).toBe(true); // and the divergence is stated
  });
});

describe("M-FILING-AGGREGATION — immutable, adjusted never rewritten", () => {
  it("only current determinations aggregate; supersessions of filed periods become adjustments in THIS period", () => {
    const aggregate = aggregateFiling(
      "2026-08",
      "2026-09-05T00:00:00Z",
      [
        { determinationId: "d1", periodRef: "2026-08", outcome: "taxable", taxMinor: 1_900n, supersededBy: null },
        { determinationId: "d2", periodRef: "2026-08", outcome: "taxable", taxMinor: 950n, supersededBy: "d5" }, // excluded
        { determinationId: "d3", periodRef: "2026-08", outcome: "exempt", taxMinor: 0n, supersededBy: null },
      ],
      [{ originalDeterminationId: "old-7", supersedingDeterminationId: "new-7", deltaMinor: -250n }],
    );
    expect(aggregate.byOutcome["taxable"]!.taxMinor).toBe(1_900n);
    expect(aggregate.byOutcome["taxable"]!.determinationIds).toEqual(["d1"]);
    expect(aggregate.byOutcome["exempt"]!.count).toBe(1);
    expect(aggregate.priorPeriodAdjustments).toHaveLength(1); // the filed period is never rewritten
    expect(aggregate.immutable).toBe(true);
  });
});

describe("M-STACKING — ordered components with declared bases", () => {
  it("tax-on-tax is expressed as a declared base, never an implicit running total", () => {
    const stack = computeStack(10_000n, [
      { taxTypeRef: "state", sequence: 1, ratePermille: 62n, baseIncludesComponents: [] },
      { taxTypeRef: "excise", sequence: 2, ratePermille: 100n, baseIncludesComponents: ["state"] }, // base includes state tax
    ]);
    expect(stack[0]!.taxMinor).toBe(620n);
    expect(stack[1]!.baseMinor).toBe(10_620n);
    expect(stack[1]!.taxMinor).toBe(1_062n);
  });
  it("sequence is explicit: array order does not decide", () => {
    const stack = computeStack(10_000n, [
      { taxTypeRef: "excise", sequence: 2, ratePermille: 100n, baseIncludesComponents: ["state"] },
      { taxTypeRef: "state", sequence: 1, ratePermille: 62n, baseIncludesComponents: [] },
    ]);
    expect(stack[0]!.taxTypeRef).toBe("state");
    expect(stack[1]!.baseMinor).toBe(10_620n);
  });
});

describe("M-WITHHOLDING — not-substantiated is a determination, not a fallback", () => {
  it("missing documentation applies the statutory rate WITH the evidence gap named", () => {
    const r = determineWithholding(100_000n, 300n, { treatyRatePermille: 150n, documentationEvidenceRef: null, lobSatisfied: true });
    expect(r.appliedRatePermille).toBe(300n);
    expect(r.treatyRelief).toBe("not-substantiated"); // same number as statutory, different consequences later
    expect(r.evidenceGap).toContain("W-8BEN");
    expect(r.withheldMinor).toBe(30_000n);
  });
  it("all treaty requirements met applies the treaty rate", () => {
    const r = determineWithholding(100_000n, 300n, { treatyRatePermille: 150n, documentationEvidenceRef: "w8-1", lobSatisfied: true });
    expect(r.treatyRelief).toBe("applied");
    expect(r.withheldMinor).toBe(15_000n);
  });
  it("an unsatisfied limitation-on-benefits article stays statutory", () => {
    const r = determineWithholding(100_000n, 300n, { treatyRatePermille: 150n, documentationEvidenceRef: "w8-1", lobSatisfied: false });
    expect(r.treatyRelief).toBe("not-substantiated");
    expect(r.evidenceGap).toContain("limitation-on-benefits");
  });
});

// ── Guards for all three Family 7 packages ──────────────────────────────────

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

describe("guards — taxiq, financialreportingiq, financialcontrolsiq", () => {
  const roots = ["taxiq", "financialreportingiq", "financialcontrolsiq"].map((p) => join(process.cwd(), "packages", p, "src"));
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no float-as-money", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("no severity field on a deficiency candidate anywhere in financialcontrolsiq", () => {
    for (const f of files.filter((x) => x.path.includes("financialcontrolsiq"))) {
      expect(/severity\s*:/.test(f.text), f.path).toBe(false);
    }
  });
  it("no default-taxable or default-exempt vocabulary in taxiq", () => {
    for (const f of files.filter((x) => x.path.includes("taxiq"))) {
      expect(/defaultOutcome|fallbackOutcome/.test(f.text), f.path).toBe(false);
    }
  });
});
