// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  buildForecast,
  cashConversionCycle,
  consolidateFx,
  daysOfOutflowRequirement,
  dedupInFlight,
  evaluateBuffer,
  identifyFundingGap,
  notionalPoolView,
  workingCapitalMetric,
  type BucketInput,
  type WorkingCapitalVariant,
} from "../kernel.js";

const bucket = (bucketRef: string, inflow: bigint, outflow: bigint, extra?: Partial<BucketInput>): BucketInput => ({
  bucketRef,
  knownInflowMinor: inflow,
  knownOutflowMinor: outflow,
  missingLegs: [],
  quarantined: [],
  ...extra,
});

describe("§16.4 the coverage lattice — partiality propagates and never recovers", () => {
  it("complete buckets chain closing balances; only the complete variant has one", () => {
    const f = buildForecast(1_000_000n, [bucket("w1", 500_000n, 200_000n), bucket("w2", 0n, 300_000n)]);
    expect(f[0]!.completeness).toBe("complete");
    if (f[0]!.completeness !== "complete" || f[1]!.completeness !== "complete") return;
    expect(f[0]!.projectedClosingMinor).toBe(1_300_000n);
    expect(f[1]!.projectedClosingMinor).toBe(1_000_000n);
  });
  it("one missing leg makes every SUBSEQUENT bucket at best partial — no closing balance ever again", () => {
    const f = buildForecast(1_000_000n, [
      bucket("w1", 100_000n, 0n, { missingLegs: ["PaymentInFlightPort"] }),
      bucket("w2", 100_000n, 0n), // itself clean — but downstream of a hole
      bucket("w3", 100_000n, 0n),
    ]);
    for (const b of f) {
      expect(b.completeness).toBe("partial");
      expect("projectedClosingMinor" in b).toBe(false);
    }
    if (f[0]!.completeness === "partial") {
      expect(f[0]!.missingLegs).toContain("PaymentInFlightPort");
    }
  });
  it("an unknown opening balance makes every bucket insufficient — no numbers at all", () => {
    const f = buildForecast({ unknown: "no statement feed bound" }, [bucket("w1", 100n, 0n), bucket("w2", 0n, 50n)]);
    for (const b of f) {
      expect(b.completeness).toBe("insufficient");
      expect("netOfKnownMinor" in b).toBe(false);
    }
  });
  it("a TimingProfile quarantines its bucket: a labelled assumption is partial, not complete", () => {
    const f = buildForecast(500n, [bucket("w1", 0n, 0n, { quarantined: ["timing-profile:segment-a-pays-late"] })]);
    expect(f[0]!.completeness).toBe("partial");
  });
});

describe("§16.6 working-capital metrics — the variant is required, CCC refuses mixed bases", () => {
  const variant: WorkingCapitalVariant = { balanceBasis: "average-of-endpoints", dayCount: 365, denominator: "credit-sales" };
  it("an unselected variant refuses", () => {
    const r = workingCapitalMetric("dso", 100n, 200n, 1000n, undefined);
    expect(!r.ok && r.refusal.kind).toBe("variant_axis_unselected");
  });
  it("DSO with average balance: (150/1000)×365 = 54.75 days", () => {
    const r = workingCapitalMetric("dso", 100_000n, 200_000n, 1_000_000n, variant);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.daysTimes100).toBe(5475n);
  });
  it("CCC over mixed bases refuses — a cycle over different clocks is not a cycle", () => {
    const dso = workingCapitalMetric("dso", 0n, 200_000n, 1_000_000n, { ...variant, balanceBasis: "ending" });
    const dpo = workingCapitalMetric("dpo", 100_000n, 200_000n, 1_000_000n, { ...variant, denominator: "cogs" });
    const dio = workingCapitalMetric("dio", 100_000n, 200_000n, 1_000_000n, { ...variant, denominator: "cogs" });
    if (!dso.ok || !dpo.ok || !dio.ok) return;
    const r = cashConversionCycle(dso.value, dpo.value, dio.value);
    expect(!r.ok && r.refusal.kind).toBe("ccc_basis_mismatch");
    const matched = workingCapitalMetric("dso", 100_000n, 200_000n, 1_000_000n, variant);
    if (!matched.ok) return;
    const okCcc = cashConversionCycle(matched.value, dpo.value, dio.value);
    expect(okCcc.ok).toBe(true);
    if (!okCcc.ok) return;
    // CCC = DIO + DSO − DPO = 54.75 + 54.75 − 54.75
    expect(okCcc.value.cccDaysTimes100).toBe(5475n);
  });
});

describe("§16.7 buffers — the cell is typed, the window must be complete", () => {
  it("comparing an available@value minimum to a ledger@booking balance refuses", () => {
    const r = evaluateBuffer(
      { policyRef: "pol-1", requiredMinimumMinor: 1_000_000n, measuredAgainst: "available@value" },
      { cell: "ledger@booking", minor: 2_000_000n },
    );
    expect(!r.ok && r.refusal.kind).toBe("buffer_cell_mismatch");
  });
  it("sufficiency is above/at/below — deliberately no 'healthy'", () => {
    const r = evaluateBuffer(
      { policyRef: "pol-1", requiredMinimumMinor: 1_000_000n, measuredAgainst: "available@value" },
      { cell: "available@value", minor: 900_000n },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sufficiency).toBe("below");
    expect(r.value.headroomMinor).toBe(-100_000n);
  });
  it("days-of-outflow over a partial window is undeterminable, not smaller", () => {
    const partial = buildForecast(1_000n, [
      bucket("d1", 0n, 500n),
      bucket("d2", 0n, 300n, { missingLegs: ["CommitmentPort"] }),
      bucket("d3", 0n, 100n),
    ]);
    const r = daysOfOutflowRequirement(partial, 3);
    expect(!r.ok && r.refusal.kind).toBe("buffer_window_not_complete");
    const complete = buildForecast(1_000n, [bucket("d1", 0n, 500n), bucket("d2", 0n, 300n), bucket("d3", 100n, 0n)]);
    const okReq = daysOfOutflowRequirement(complete, 3);
    expect(okReq.ok).toBe(true);
    if (!okReq.ok) return;
    expect(okReq.value.requiredMinimumMinor).toBe(800n);
  });
});

describe("§16.9 funding gap — two thresholds, confidence stated", () => {
  it("below-buffer and below-zero are different questions with different first dates", () => {
    const f = buildForecast(1_000n, [bucket("w1", 0n, 600n), bucket("w2", 0n, 600n), bucket("w3", 0n, 600n)]);
    const gap = identifyFundingGap(f, 500n);
    expect(gap.firstBucketBelowBuffer).toBe("w1"); // closing 400 < buffer 500
    expect(gap.firstBucketBelowZero).toBe("w2"); // closing −200
    expect(gap.peakShortfallMinor).toBe(800n);
    expect(gap.gapConfidence).toBe("evidenced");
  });
  it("a gap over partial buckets is partial-evidence — a missing leg could move it either way", () => {
    const f = buildForecast(1_000n, [bucket("w1", 0n, 600n), bucket("w2", 0n, 600n, { missingLegs: ["x"] })]);
    const gap = identifyFundingGap(f, 500n);
    expect(gap.gapConfidence).toBe("partial-evidence");
  });
});

describe("§16.8 pooling — a notional offset is a view, never a balance", () => {
  it("the PooledView carries the agreement and set-off status; multi-currency needs a rate set", () => {
    const single = notionalPoolView(
      [
        { accountRef: "a1", balanceMinor: 500_000n, currencyCode: "GBP" },
        { accountRef: "a2", balanceMinor: -200_000n, currencyCode: "GBP" },
      ],
      "agreement-77",
      "asserted",
    );
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.value.kind).toBe("pooled-view");
    expect(single.value.offsetMinor).toBe(300_000n);
    expect(single.value.rightOfSetOffStatus).toBe("asserted");
    const multi = notionalPoolView(
      [
        { accountRef: "a1", balanceMinor: 500_000n, currencyCode: "GBP" },
        { accountRef: "a3", balanceMinor: -100_000n, currencyCode: "EUR" },
      ],
      "agreement-77",
      "confirmed",
    );
    expect(!multi.ok && multi.refusal.kind).toBe("notional_pool_needs_rate_set");
  });
});

describe("§16.10 dedup — exact match only, unbound port states the error direction", () => {
  it("a matched bank reference removes the commitment; unmatched stays", () => {
    const r = dedupInFlight(
      [
        { commitmentRef: "c1", bankReference: "ref-100" },
        { commitmentRef: "c2", bankReference: "ref-999" },
        { commitmentRef: "c3", bankReference: null },
      ],
      new Set(["ref-100"]),
    );
    expect(r.removedCommitmentRefs).toEqual(["c1"]);
    expect(r.retainedCommitmentRefs).toEqual(["c2", "c3"]);
    expect(r.portUnbound).toBeNull();
  });
  it("an unbound port states the DIRECTION: outflows may double-count, forecast pessimistic", () => {
    const r = dedupInFlight({ unbound: true }, new Set());
    expect(r.portUnbound?.errorDirection).toBe("pessimistic-outflows-may-double-count");
  });
});

describe("§16.13 FX consolidation — whole or refused", () => {
  it("a missing rate set refuses naming the pairs — never a partial sum presented as the total", () => {
    const r = consolidateFx(
      [
        { currencyCode: "GBP", minor: 1_000n },
        { currencyCode: "EUR", minor: 2_000n },
      ],
      "GBP",
      undefined,
    );
    expect(!r.ok && r.refusal.kind).toBe("fx_rate_unavailable");
    if (r.ok) return;
    expect(r.refusal.detail).toContain("EUR/GBP");
  });
  it("consolidates exactly with a supplied rate set", () => {
    const r = consolidateFx(
      [
        { currencyCode: "GBP", minor: 1_000n },
        { currencyCode: "EUR", minor: 2_000n },
      ],
      "GBP",
      {
        rateSetId: "rs-1",
        source: "ecb",
        effectiveDate: "2026-08-30",
        quotes: [{ base: "EUR", quote: "GBP", rateE8: 85_000_000n }], // 0.85
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.consolidatedMinor).toBe(1_000n + 1_700n);
  });
});

// ── Guards for all five Family 4 packages ───────────────────────────────────

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

describe("guards — liquidityiq, paymentsiq, debtiq, investmentiq, financialriskiq", () => {
  const roots = ["liquidityiq", "paymentsiq", "debtiq", "investmentiq", "financialriskiq"].map((p) =>
    join(process.cwd(), "packages", p, "src"),
  );
  const files = roots.flatMap((r) => sourceFiles(r)).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  it("platform imports only; no clock; no float leaks", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      expect(/(?:from|import)\s+"@proworks-hub\/(?!contracts|core-kit)[a-z-]+/.test(f.text), f.path).toBe(false);
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|Math\.round|parseFloat|toFixed\(/.test(f.text), f.path).toBe(false);
    }
  });
  it("no coverage percentage anywhere in financialriskiq — the denominator is the unknown thing", () => {
    const risk = files.filter((f) => f.path.includes("financialriskiq"));
    for (const f of risk) {
      expect(/coveragePercent|coveragePct|coverageRatio/.test(f.text), f.path).toBe(false);
    }
  });
  it("no healthy anywhere in liquidityiq sufficiency vocabulary", () => {
    const liq = files.filter((f) => f.path.includes("liquidityiq"));
    for (const f of liq) {
      expect(/"healthy"/.test(f.text), f.path).toBe(false);
    }
  });
});
