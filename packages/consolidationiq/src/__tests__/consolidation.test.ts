// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allocateNci,
  capitalConsolidation,
  determineMethod,
  eliminationShare,
  equityPickup,
  integrateOwnership,
  matchIntercompany,
  measureNci,
  ownershipPercent,
  runIdempotencyKey,
  translateAndProveCta,
} from "../kernel.js";
import { ratioFromDecimal, ratioFromPercent, rToDecimalString } from "../rational.js";

const usd = (amount: string) => ({ amount, currency: "USD", scale: 2 });

describe("M-1 integrated ownership — exact rationals, two solve paths", () => {
  it("path-sum on the acyclic chain: 60% of 60% is exactly 36%", () => {
    const outcome = integrateOwnership(
      [
        { from: "P", to: "S1", economicInterest: "0.6", votingInterest: "0.6" },
        { from: "S1", to: "S2", economicInterest: "0.6", votingInterest: "0.6" },
      ],
      "P",
      "economic",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.solveMethod).toBe("path-sum");
    expect(ownershipPercent(outcome.value.integrated.get("S2")!)).toBe("36.0000");
  });
  it("economic and voting are two INDEPENDENT solves, never mixed", () => {
    const interests = [
      { from: "P", to: "S", economicInterest: "0.9", votingInterest: "0.4" },
    ];
    const economic = integrateOwnership(interests, "P", "economic");
    const voting = integrateOwnership(interests, "P", "voting");
    expect(economic.ok && ownershipPercent(economic.value.integrated.get("S")!)).toBe("90.0000");
    expect(voting.ok && ownershipPercent(voting.value.integrated.get("S")!)).toBe("40.0000");
  });
  it("a cross-holding solves the linear system exactly — no iteration, no doubles", () => {
    // P owns 60% of A; A owns 20% of B; B owns 10% of A. The geometric series
    // 0.6·(1 + 0.02 + 0.0004 + …) = 0.6/0.98 = 30/49 exactly.
    const outcome = integrateOwnership(
      [
        { from: "P", to: "A", economicInterest: "0.6", votingInterest: "0.6" },
        { from: "A", to: "B", economicInterest: "0.2", votingInterest: "0.2" },
        { from: "B", to: "A", economicInterest: "0.1", votingInterest: "0.1" },
      ],
      "P",
      "economic",
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.solveMethod).toBe("linear");
    const a = outcome.value.integrated.get("A")!;
    expect(a.num).toBe(30n);
    expect(a.den).toBe(49n);
    // And B = A × 0.2 = 6/49 — exact, which no double can represent.
    const b = outcome.value.integrated.get("B")!;
    expect(b.num).toBe(6n);
    expect(b.den).toBe(49n);
  });
  it("a fully reciprocal structure with no external holder REFUSES — no fallback to path-sum", () => {
    // A and B own 100% of EACH OTHER below the root: the (I − A) block is
    // singular and no external holder can be attributed the shares.
    const outcome = integrateOwnership(
      [
        { from: "P", to: "A", economicInterest: "0.5", votingInterest: "0.5" },
        { from: "A", to: "B", economicInterest: "1", votingInterest: "1" },
        { from: "B", to: "A", economicInterest: "1", votingInterest: "1" },
      ],
      "P",
      "economic",
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("OWNERSHIP_SYSTEM_SINGULAR");
  });
});

describe("M-2 method determination — a recommendation, never an assignment", () => {
  it("plain thresholds recommend; indicators without an approved assessment REFUSE", () => {
    const plain = determineMethod({
      entityRef: "S",
      votingPercent: "80",
      hasContractualPowerIndicators: false,
    });
    expect(plain.ok && plain.value.method).toBe("full");
    const uncertain = determineMethod({
      entityRef: "S",
      votingPercent: "40",
      hasContractualPowerIndicators: true,
    });
    expect(!uncertain.ok && uncertain.refusal.kind).toBe("CONTROL_ASSESSMENT_REQUIRED");
    const assessed = determineMethod({
      entityRef: "S",
      votingPercent: "40",
      hasContractualPowerIndicators: true,
      assessment: { entityRef: "S", conclusion: "full", status: "approved", assessedBy: "human.groupctrl" },
    });
    expect(assessed.ok && assessed.value.method).toBe("full");
    expect(assessed.ok && assessed.value.requiresHumanAssessment).toBe(true);
    // A DRAFT assessment is no assessment.
    const draft = determineMethod({
      entityRef: "S",
      votingPercent: "40",
      hasContractualPowerIndicators: true,
      assessment: { entityRef: "S", conclusion: "full", status: "draft", assessedBy: "human.groupctrl" },
    });
    expect(!draft.ok && draft.refusal.kind).toBe("CONTROL_ASSESSMENT_REQUIRED");
  });
  it("a joint arrangement classifies under IFRS 11: operation→proportional, venture→equity", () => {
    const operation = determineMethod({
      entityRef: "J",
      votingPercent: "50",
      hasContractualPowerIndicators: false,
      jointArrangement: "joint-operation",
    });
    expect(operation.ok && operation.value.method).toBe("proportional");
    const venture = determineMethod({
      entityRef: "J",
      votingPercent: "50",
      hasContractualPowerIndicators: false,
      jointArrangement: "joint-venture",
    });
    expect(venture.ok && venture.value.method).toBe("equity");
  });
});

describe("M-3/M-4 — translation with a required averaging convention and a CTA proof", () => {
  const base = {
    entityRef: "S",
    openingNetAssetsMinor: 100_000_00n,
    resultForPeriodMinor: 12_000_00n,
    equityTranches: [{ trancheRef: "t1", amountMinor: 50_000_00n }],
    rates: {
      closing: "1.1400",
      opening: "1.0450",
      average: "1.0927",
      historicalByTranche: { t1: "0.9800" },
    },
    presentationScale: 2,
    presentationCurrency: "USD",
  };
  it("refuses without a declared averaging convention — nothing is inferred from the RateSet", () => {
    const outcome = translateAndProveCta(base);
    expect(!outcome.ok && outcome.refusal.kind).toBe("AVERAGING_CONVENTION_UNDECLARED");
  });
  it("computes CTA as a SUM OF CAUSES and the independent proof agrees", () => {
    const outcome = translateAndProveCta({ ...base, averagingConvention: "simple-mean" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // opening: 100,000 × (1.1400 − 1.0450) = 9,500.00
    expect(outcome.value.components.openingNetAssets).toBe(9_500_00n);
    // result: 12,000 × (1.1400 − 1.0927) = 567.60
    expect(outcome.value.components.resultRateGap).toBe(567_60n);
    expect(outcome.value.components.equityTranches).toBe(0n); // nil BY CONSTRUCTION
    expect(outcome.value.ctaArisingMinor).toBe(10_067_60n);
  });
  it("the averaging convention moves money between P&L and OCI — the two conventions differ", () => {
    const simple = translateAndProveCta({ ...base, averagingConvention: "simple-mean" });
    const openClose = translateAndProveCta({ ...base, averagingConvention: "open-close-mean" });
    expect(simple.ok && openClose.ok).toBe(true);
    if (!simple.ok || !openClose.ok) return;
    expect(simple.value.translatedResultMinor).not.toBe(openClose.value.translatedResultMinor);
    // And CTA absorbs the difference exactly: total (result + CTA) is invariant.
    expect(simple.value.translatedResultMinor + simple.value.ctaArisingMinor).toBe(
      openClose.value.translatedResultMinor + openClose.value.ctaArisingMinor,
    );
  });
  it("a missing average quote for a mean convention refuses — no fallback to closing", () => {
    const { average: _a, ...rates } = base.rates;
    const outcome = translateAndProveCta({ ...base, rates: rates as typeof base.rates, averagingConvention: "simple-mean" });
    expect(!outcome.ok && outcome.refusal.kind).toBe("RATE_QUOTE_MISSING");
  });
  it("an unregistered equity tranche refuses — share capital never moves", () => {
    const outcome = translateAndProveCta({
      ...base,
      averagingConvention: "simple-mean",
      equityTranches: [{ trancheRef: "t-ghost", amountMinor: 1_000_00n }],
    });
    expect(!outcome.ok && outcome.refusal.kind).toBe("RATE_QUOTE_MISSING");
  });
});

describe("M-6/M-7 — intercompany match and elimination", () => {
  it("matches pairwise, records the residual even within tolerance, refuses ambiguity", () => {
    const outcome = matchIntercompany(
      [
        { declarationId: "d1", entity: "A", counterparty: "B", natureCode: "loan", amount: usd("100.00") },
        { declarationId: "d2", entity: "B", counterparty: "A", natureCode: "loan", amount: usd("99.98") },
      ],
      5n,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.matches[0]?.residualMinor).toBe(2n); // recorded, not suppressed
    expect(outcome.value.matches[0]?.withinTolerance).toBe(true);

    const ambiguous = matchIntercompany(
      [
        { declarationId: "d1", entity: "A", counterparty: "B", natureCode: "loan", amount: usd("100.00") },
        { declarationId: "d2", entity: "B", counterparty: "A", natureCode: "loan", amount: usd("60.00") },
        { declarationId: "d3", entity: "B", counterparty: "A", natureCode: "loan", amount: usd("40.00") },
      ],
      0n,
    );
    expect(!ambiguous.ok && ambiguous.refusal.kind).toBe("AMBIGUOUS_INTERCOMPANY_MATCH");
  });
  it("full elimination regardless of percentage; equity method eliminates at the interest", () => {
    expect(eliminationShare("full", ratioFromPercent("70")).num).toBe(1n);
    const equity = eliminationShare("equity", ratioFromPercent("30"));
    expect(rToDecimalString(equity, 2)).toBe("0.30");
  });
});

describe("M-10..M-12 — goodwill, bargain purchase, NCI", () => {
  it("computes goodwill; a negative result refuses pending human reassessment", () => {
    const goodwill = capitalConsolidation({
      considerationMinor: 800_000_00n,
      nciMeasurementMinor: 200_000_00n,
      previouslyHeldFairValueMinor: 0n,
      identifiableNetAssetsFairValueMinor: 900_000_00n,
      currency: "USD",
      scale: 2,
    });
    expect(goodwill.ok && goodwill.value.goodwill.amount).toBe("100000.00");
    const bargain = capitalConsolidation({
      considerationMinor: 700_000_00n,
      nciMeasurementMinor: 100_000_00n,
      previouslyHeldFairValueMinor: 0n,
      identifiableNetAssetsFairValueMinor: 900_000_00n,
      currency: "USD",
      scale: 2,
    });
    expect(!bargain.ok && bargain.refusal.kind).toBe("BARGAIN_PURCHASE_REQUIRES_REASSESSMENT");
  });
  it("NCI measurement honours the immutable election and refuses without one", () => {
    const missing = measureNci({
      election: undefined,
      identifiableNetAssetsMinor: 900_000_00n,
      nciInterest: ratioFromPercent("30"),
    });
    expect(!missing.ok && missing.refusal.kind).toBe("NCI_ELECTION_MISSING");
    const proportionate = measureNci({
      election: "proportionate",
      identifiableNetAssetsMinor: 900_000_00n,
      nciInterest: ratioFromPercent("30"),
    });
    expect(proportionate.ok && proportionate.value).toBe(270_000_00n);
  });
  it("NCI allocation: parent takes the residual (RB-3) and NCI MAY GO NEGATIVE", () => {
    const profit = allocateNci(100_01n, ratioFromDecimal("1/3"));
    expect(profit.nciMinor + profit.parentMinor).toBe(100_01n); // reconstructs exactly
    const loss = allocateNci(-300_00n, ratioFromPercent("40"));
    expect(loss.nciMinor).toBe(-120_00n); // NOT floored at zero (IFRS 10.B94)
    expect(loss.parentMinor).toBe(-180_00n);
  });
});

describe("M-13 — equity pickup, lowest tier upward", () => {
  it("a tier-3 result reaches tier 1 through tier 2, one generation at a time", () => {
    // P holds 40% of A; A holds 25% of B. B earns 1,000.00.
    // A's pickup from B = 250.00; A's own result 0 → augmented 250.00.
    // P's pickup from A = 40% × 250.00 = 100.00.
    const results = equityPickup([
      { entityRef: "A", heldBy: "P", interest: ratioFromPercent("40"), carryingAmountMinor: 500_000_00n, resultForPeriodMinor: 0n, distributionsMinor: 0n },
      { entityRef: "B", heldBy: "A", interest: ratioFromPercent("25"), carryingAmountMinor: 100_000_00n, resultForPeriodMinor: 100_000n, distributionsMinor: 0n },
    ]);
    expect(results.get("B")?.pickupMinor).toBe(25_000n);
    expect(results.get("A")?.pickupMinor).toBe(10_000n);
  });
  it("losses stop at a zero carrying amount and the excess is TRACKED, not discarded", () => {
    const results = equityPickup([
      { entityRef: "A", heldBy: "P", interest: ratioFromPercent("30"), carryingAmountMinor: 10_00n, resultForPeriodMinor: -100_00n, distributionsMinor: 0n },
    ]);
    const a = results.get("A")!;
    expect(a.newCarryingMinor).toBe(0n);
    expect(a.unrecognisedLossMinor).toBe(20_00n); // 30% of −100 = −30; floor at 0 leaves 20 unrecognised
  });
});

describe("M-17 — the run idempotency key is order-independent over submissions", () => {
  it("sorted hashes: permuted submissions produce the identical key", () => {
    const base = {
      scopeId: "grp-1",
      periodRef: "2026-8",
      framework: "ifrs" as const,
      structureHash: "sh",
      rateSetHash: "rh",
    };
    expect(runIdempotencyKey({ ...base, submissionHashes: ["a", "b", "c"] })).toBe(
      runIdempotencyKey({ ...base, submissionHashes: ["c", "a", "b"] }),
    );
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

const SRC = join(process.cwd(), "packages/consolidationiq/src");
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
  it("imports only contracts, core-kit, zod; no clock; no float ownership; no ledger writer", () => {
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/.test(f.text), f.path).toBe(false);
      expect(/parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
      expect(/postEntry|writeJournal|appendJournal|postToLedger/.test(f.text), f.path).toBe(false);
    }
  });
  it("no iterative ownership solve exists — no convergence tolerance anywhere", () => {
    for (const f of files) {
      expect(/convergence|epsilon|tolerance\s*=\s*0?\.0*1/.test(f.text), f.path).toBe(false);
    }
  });
});
