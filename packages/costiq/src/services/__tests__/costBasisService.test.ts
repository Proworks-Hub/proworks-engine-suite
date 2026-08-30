/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, toString } from "../../domain/decimal.js";
import type { CostPolicy, CostRate } from "../../domain/costModel.js";
import type { CostSourceKind } from "../../domain/provenance.js";
import { assessEvidence, selectBasis, unpricedShare } from "../costBasisService.js";

// ─────────────────────────────────────────────────────────────────────────────
// Choosing which price to believe.
//
// The easy case is a contract. The interesting case is when there is a stale
// observation, a forecast and a default nobody has looked at since setup —
// and the dangerous outcome is not choosing badly, it is choosing badly and
// presenting the result identically to a contract price.
// ─────────────────────────────────────────────────────────────────────────────

const scope = { instanceId: "hive.ksix", tenantId: "ksix" };
const ASOF = new Date("2026-08-30T00:00:00.000Z");

const policy = (over: Partial<CostPolicy> = {}): CostPolicy => ({
  policyId: "p",
  policyVersion: "1",
  currency: "GBP",
  roundingMode: "HALF_EVEN",
  roundingStage: "TOTAL",
  roundingScale: null,
  calculationScale: 8,
  acceptedSources: ["CONTRACT", "OBSERVED_TRANSACTION", "APPROVED_RATE"],
  allowFallback: true,
  freshnessWindowDays: 90,
  minimumSampleSize: 3,
  ...over,
});

/**
 * A rate fixture.
 *
 * Provenance fields are pulled OUT of `over` and placed inside `provenance`.
 * An earlier version spread `over` over the whole rate, so `unitConverted`
 * landed at the top level where nothing reads it and the conversion test
 * passed against a value the code never saw.
 */
const rate = (
  id: string,
  kind: CostSourceKind,
  over: Partial<CostRate> & {
    observedAt?: string;
    sampleSize?: number;
    unitConverted?: boolean;
    currencyConvertedFrom?: string;
  } = {},
): CostRate => {
  const { observedAt, sampleSize, unitConverted, currencyConvertedFrom, ...rateFields } = over;
  return {
    rateId: id,
    scope,
    amount: "2.50",
    currency: "GBP",
    perUnit: "kg",
    appliesTo: "MATERIAL",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    ...rateFields,
    provenance: {
      sourceKind: kind,
      sourceRef: `ref:${id}`,
      sourceSystem: "test",
      observedAt: observedAt ?? "2026-08-01T00:00:00.000Z",
      caveats: [],
      unitConverted: unitConverted ?? false,
      ...(sampleSize !== undefined ? { sampleSize } : {}),
      ...(currencyConvertedFrom !== undefined ? { currencyConvertedFrom } : {}),
    },
  };
};

const select = (candidates: readonly CostRate[], p: CostPolicy = policy()) =>
  selectBasis({
    candidates,
    policy: p,
    asOf: ASOF,
    requiredUnit: "kg",
    basisId: "b1",
    subject: { objectType: "material", objectId: "steel", ownedBy: "inventoryiq" },
    appliesTo: "MATERIAL",
  });

describe("preference follows the policy's own ordering", () => {
  it("chooses the policy's first preference when available", () => {
    const result = select([rate("r-observed", "OBSERVED_TRANSACTION", { sampleSize: 10 }), rate("r-contract", "CONTRACT")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.basis.selectedRate.rateId).toBe("r-contract");
    expect(result.wasFallback).toBe(false);
  });

  it("treats a policy's own first choice as NOT a fallback, whatever its strength", () => {
    // A policy that lists APPROVED_RATE first has chosen approved rates
    // deliberately. Calling that a fallback would cry wolf on every estimate.
    const p = policy({ acceptedSources: ["APPROVED_RATE", "CONTRACT"] });
    const result = select([rate("r-approved", "APPROVED_RATE")], p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wasFallback).toBe(false);
  });

  it("marks a drop below the first preference as a fallback", () => {
    const result = select([rate("r-approved", "APPROVED_RATE")]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wasFallback).toBe(true);
    expect(result.basis.wasFallback).toBe(true);
  });

  it("REFUSES to fall back when the policy forbids it", () => {
    // "No silent fallback to demo rates in production-trust output."
    const result = select([rate("r-approved", "APPROVED_RATE")], policy({ allowFallback: false }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("does not allow fallback");
  });

  it("prefers the more recent when two share a source kind", () => {
    const result = select([
      rate("r-old", "CONTRACT", { observedAt: "2026-02-01T00:00:00.000Z" }),
      rate("r-new", "CONTRACT", { observedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.basis.selectedRate.rateId).toBe("r-new");
  });

  it("is deterministic when everything else ties", () => {
    // Two runs over the same candidates must never disagree.
    const candidates = [rate("r-b", "CONTRACT"), rate("r-a", "CONTRACT")];
    const first = select(candidates);
    const second = select([...candidates].reverse());
    if (!first.ok || !second.ok) throw new Error("expected both to succeed");
    expect(second.basis.selectedRate.rateId).toBe(first.basis.selectedRate.rateId);
  });
});

describe("hard disqualifications come before preference", () => {
  it("refuses a rate in the wrong unit", () => {
    // Not a worse choice — not a choice. Using it produces an answer wrong by
    // a conversion factor that looks entirely normal.
    const result = select([rate("r", "CONTRACT", { perUnit: "lb" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("WRONG_UNIT");
    expect(result.rejected[0]!.explanation).toContain("not a silent one");
  });

  it("refuses a rate in the wrong currency", () => {
    const result = select([rate("r", "CONTRACT", { currency: "USD" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("WRONG_CURRENCY");
  });

  it("refuses a rate not yet in force AT THE CALCULATION'S INSTANT", () => {
    // Evaluated against asOf, not now — so replaying a March estimate does not
    // pick up an April rate.
    const result = select([rate("r", "CONTRACT", { effectiveFrom: "2027-01-01T00:00:00.000Z" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("NOT_YET_EFFECTIVE");
  });

  it("refuses an expired rate", () => {
    const result = select([rate("r", "CONTRACT", { effectiveTo: "2026-06-01T00:00:00.000Z" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("EXPIRED");
  });

  it("refuses a source the policy does not list at all", () => {
    // An ordered allowlist: absent means refused, not merely ranked lower.
    const result = select([rate("r", "FORECAST")]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("SOURCE_NOT_ACCEPTED");
  });

  it("refuses evidence older than the policy's window", () => {
    const result = select([rate("r", "CONTRACT", { observedAt: "2025-01-01T00:00:00.000Z" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("TOO_STALE");
    expect(result.rejected[0]!.explanation).toContain("90-day window");
  });

  it("refuses a rate resting on too few observations", () => {
    const result = select([rate("r", "OBSERVED_TRANSACTION", { sampleSize: 1 })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected[0]!.reason).toBe("SAMPLE_TOO_SMALL");
  });

  it("does NOT apply a sample minimum where sampling is meaningless", () => {
    // A contract price is not a sample of one; it is a contract.
    const result = select([rate("r", "CONTRACT")]);
    expect(result.ok).toBe(true);
  });
});

describe("a refusal is diagnosable", () => {
  it("reports every candidate it considered and why each failed", () => {
    const result = select([
      rate("r-unit", "CONTRACT", { perUnit: "lb" }),
      rate("r-stale", "CONTRACT", { observedAt: "2024-01-01T00:00:00.000Z" }),
      rate("r-future", "CONTRACT", { effectiveFrom: "2030-01-01T00:00:00.000Z" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejected).toHaveLength(3);
    expect(result.reason).toContain("3 candidate(s) were considered");
  });

  it("keeps the rejected alternatives ON the basis, for later explanation", () => {
    // "Why is this number what it is" is usually "why is it not the other
    // number", and that is only answerable if the alternatives survived.
    const result = select([rate("r-contract", "CONTRACT"), rate("r-approved", "APPROVED_RATE")]);
    if (!result.ok) throw new Error(result.reason);
    expect(result.basis.rejected).toHaveLength(1);
    expect(result.basis.rejected[0]!.reason).toContain("ranks below");
  });
});

describe("evidence quality is computed from facts", () => {
  const basisFor = (kind: CostSourceKind, observedAt: string, over: { sampleSize?: number; unitConverted?: boolean } = {}) => ({
    basisId: "b",
    scope,
    subject: { objectType: "material", objectId: "x", ownedBy: "i" },
    appliesTo: "MATERIAL" as const,
    selectedRate: rate("r", kind, { observedAt, ...over }),
    rejected: [],
    determinedAt: "2026-08-30T00:00:00.000Z",
    wasFallback: false,
  });

  it("scores strong, fresh, well-sampled evidence highly", () => {
    const q = assessEvidence({
      components: [
        { amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: 95,
    });
    expect(q.coverage).toBe(100);
    expect(q.sourceStrength).toBe(100);
    expect(q.freshness).toBeGreaterThan(95);
  });

  it("weights by money, so a stale washer is not a stale girder", () => {
    // An unweighted mean would treat a £2 line and a £2,000 line alike.
    const fresh = basisFor("CONTRACT", "2026-08-29T00:00:00.000Z");
    const stale = basisFor("CONTRACT", "2026-06-05T00:00:00.000Z");
    const bigFresh = assessEvidence({
      components: [
        { amount: fromString("2000"), basis: fresh, isUnpriced: false },
        { amount: fromString("2"), basis: stale, isUnpriced: false },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    const bigStale = assessEvidence({
      components: [
        { amount: fromString("2"), basis: fresh, isUnpriced: false },
        { amount: fromString("2000"), basis: stale, isUnpriced: false },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(bigFresh.freshness).toBeGreaterThan(bigStale.freshness);
  });

  it("scores a source with no sample at full sufficiency, not zero", () => {
    // A contract price is not a sample of one; it is a contract. Penalising it
    // for having no sample size would rank the STRONGEST evidence lowest —
    // and the selection tests only prove absent samples do not BLOCK a
    // choice, not that they score correctly once chosen.
    const contract = assessEvidence({
      components: [
        { amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(contract.sampleSufficiency).toBe(100);
    expect(contract.weakest).not.toContain("sampleSufficiency");
  });

  it("scores a thin sample below a sufficient one", () => {
    const thin = assessEvidence({
      components: [
        {
          amount: fromString("100"),
          basis: basisFor("OBSERVED_TRANSACTION", "2026-08-29T00:00:00.000Z", { sampleSize: 1 }),
          isUnpriced: false,
        },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    const ample = assessEvidence({
      components: [
        {
          amount: fromString("100"),
          basis: basisFor("OBSERVED_TRANSACTION", "2026-08-29T00:00:00.000Z", { sampleSize: 30 }),
          isUnpriced: false,
        },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(thin.sampleSufficiency).toBeLessThan(ample.sampleSufficiency);
  });

  it("drops coverage when part of the cost has no basis", () => {
    const q = assessEvidence({
      components: [
        { amount: fromString("50"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false },
        { amount: fromString("0"), basis: null, isUnpriced: true },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    // Half the LINES are unpriced even though they carry no money — which is
    // exactly why coverage counts lines as well as money. An unpriced item
    // with an unknown amount contributes nothing to a money-weighted figure
    // and would otherwise be invisible.
    expect(q.coverage).toBe(50);
  });

  it("penalises each conversion, because each is a place a mistake enters", () => {
    const plain = assessEvidence({
      components: [{ amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false }],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    const converted = assessEvidence({
      components: [
        {
          amount: fromString("100"),
          basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z", { unitConverted: true }),
          isUnpriced: false,
        },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(converted.normalization).toBeLessThan(plain.normalization);
  });

  it("penalises assumptions", () => {
    const none = assessEvidence({
      components: [{ amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false }],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    const several = assessEvidence({
      components: [{ amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false }],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 3,
      historicalAccuracy: null,
    });
    expect(several.assumptionLoad).toBeLessThan(none.assumptionLoad);
  });

  it("reports never-validated as a weakness rather than scoring it", () => {
    // Absence is actionable. A silently omitted dimension is not.
    const q = assessEvidence({
      components: [{ amount: fromString("100"), basis: basisFor("CONTRACT", "2026-08-29T00:00:00.000Z"), isUnpriced: false }],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(q.validatedVariance).toBeNull();
    expect(q.weakest).toContain("validatedVariance:never-validated");
  });

  it("names the weakest dimensions, worst first", () => {
    // The actionable part: a score says how bad, this says what to fix.
    const q = assessEvidence({
      components: [
        { amount: fromString("100"), basis: basisFor("APPROVED_RATE", "2026-08-01T00:00:00.000Z"), isUnpriced: false },
        { amount: fromString("100"), basis: null, isUnpriced: true },
      ],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 4,
      historicalAccuracy: null,
    });
    expect(q.weakest.length).toBeGreaterThan(0);
    // Sorted ascending by score, so the first entry is the worst problem.
    expect(q.weakest[0]).toBeTruthy();
  });

  it("returns zero rather than dividing by nothing for an empty estimate", () => {
    const q = assessEvidence({
      components: [],
      policy: policy(),
      asOf: ASOF,
      assumptionCount: 0,
      historicalAccuracy: null,
    });
    expect(q.freshness).toBe(0);
    expect(q.coverage).toBe(100);
  });
});

describe("unpriced cost is measured, not hidden", () => {
  it("reports the amount and the share of the total", () => {
    const share = unpricedShare([
      { amount: fromString("80"), isUnpriced: false },
      { amount: fromString("20"), isUnpriced: true },
    ]);
    expect(toString(share.amount)).toBe("20");
    expect(toString(share.ofTotal)).toBe("20.0000");
  });

  it("reports zero share for an empty estimate rather than dividing by zero", () => {
    expect(toString(unpricedShare([]).ofTotal)).toBe("0");
  });
});
