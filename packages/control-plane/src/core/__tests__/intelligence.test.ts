// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  MIN_CORROBORATING_TENANTS,
  MIN_SUPPORTING_OBSERVATIONS,
  PRICE_TABLE_STALE_AFTER_DAYS,
  assessPromotion,
  estimateModelCost,
  summariseDecisions,
  summariseModelSpend,
  type KnowledgePromotionCandidate,
  type ModelPriceTable,
  type ModelUsageWindow,
} from "../intelligence.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

const table: ModelPriceTable = {
  asOf: "2026-08-20",
  prices: {
    "claude-sonnet-4-5": { inputPerMillionCents: 300, outputPerMillionCents: 1_500 },
    "gpt-4o": { inputPerMillionCents: 250, outputPerMillionCents: 1_000 },
  },
};

const usage = (over: Partial<ModelUsageWindow> = {}): ModelUsageWindow => ({
  modelId: "claude-sonnet-4-5",
  windowStart: "2026-08-26T12:00:00.000Z",
  windowEnd: "2026-08-27T12:00:00.000Z",
  requests: 2_018,
  failures: 6,
  inputTokens: 600_000,
  outputTokens: 254_000,
  ...over,
});

describe("what the AI layer costs, said honestly", () => {
  it("multiplies tokens by the table and marks the result estimated", () => {
    const estimate = estimateModelCost(usage(), table, NOW);
    expect(estimate.cents).toBeCloseTo(600_000 / 1e6 * 300 + 254_000 / 1e6 * 1_500, 6);
    expect(estimate.estimated).toBe(true);
    expect(estimate.pricingAsOf).toBe("2026-08-20");
  });

  it("returns null for an unpriced model rather than zero", () => {
    // Zero renders as "$0.00" and reads as a measurement, so the dashboard
    // quietly reports that a local model is free. "Not priced" is the true
    // statement, and it is the one that gets fixed.
    const estimate = estimateModelCost(usage({ modelId: "llama-3-70b-local" }), table, NOW);
    expect(estimate.cents).toBeNull();
    expect(estimate.note).toContain("llama-3-70b-local");
  });

  it("flags a price table old enough to be wrong", () => {
    const old: ModelPriceTable = {
      ...table,
      asOf: new Date(NOW - (PRICE_TABLE_STALE_AFTER_DAYS + 5) * 86_400_000).toISOString(),
    };
    expect(estimateModelCost(usage(), old, NOW).pricingStale).toBe(true);
    expect(estimateModelCost(usage(), table, NOW).pricingStale).toBe(false);
  });

  it("treats an unreadable price date as stale", () => {
    expect(estimateModelCost(usage(), { ...table, asOf: "recently" }, NOW).pricingStale).toBe(true);
  });

  it("counts unpriced usage separately instead of folding it in as free", () => {
    const summary = summariseModelSpend(
      [usage(), usage({ modelId: "llama-3-70b-local", requests: 842, inputTokens: 200_000, outputTokens: 8_000 })],
      table,
      NOW,
    );
    expect(summary.unpricedModels).toEqual(["llama-3-70b-local"]);
    expect(summary.unpricedRequests).toBe(842);
    expect(summary.totalRequests).toBe(2_860);
    expect(summary.totalTokens).toBe(600_000 + 254_000 + 200_000 + 8_000);
    expect(summary.estimated).toBe(true);
  });
});

describe("how often the engines were right", () => {
  const decisions = (counts: { accepted: number; corrected: number; rejected: number; unresolved: number }) =>
    [
      ...Array.from({ length: counts.accepted }, (_, i) => ({ outcome: "accepted" as const, i })),
      ...Array.from({ length: counts.corrected }, (_, i) => ({ outcome: "corrected" as const, i })),
      ...Array.from({ length: counts.rejected }, (_, i) => ({ outcome: "rejected" as const, i })),
      ...Array.from({ length: counts.unresolved }, (_, i) => ({ outcome: "unresolved" as const, i })),
    ].map((d, index) => ({
      decisionId: `d-${index}`,
      engineId: "visioniq",
      kind: "laser.tone.curve",
      outcome: d.outcome,
      occurredAt: "2026-08-27T00:00:00.000Z",
    }));

  it("leaves unreviewed decisions out of the denominator", () => {
    // Treating "nobody looked" as "nobody objected" is how a model reports 99%
    // accuracy on a queue nobody reviews.
    const summary = summariseDecisions(decisions({ accepted: 8, corrected: 2, rejected: 0, unresolved: 990 }));
    expect(summary.reviewed).toBe(10);
    expect(summary.acceptanceRate).toBeCloseTo(0.8);
    expect(summary.unresolved).toBe(990);
  });

  it("reports no rate at all when nothing has been reviewed", () => {
    // Not 1, and not 0. Both are claims the data does not support.
    const summary = summariseDecisions(decisions({ accepted: 0, corrected: 0, rejected: 0, unresolved: 50 }));
    expect(summary.acceptanceRate).toBeNull();
  });
});

describe("the gate between one shop and everybody", () => {
  const candidate = (over: Partial<KnowledgePromotionCandidate> = {}): KnowledgePromotionCandidate => ({
    candidateId: "cand-1",
    engineId: "visioniq",
    kind: "laser.tone.curve",
    knowledge: { material: "anodised-aluminium", toneOffset: 0.12 },
    corroboratingOwnerRefs: ["org:1", "org:2", "org:3"],
    supportingObservations: 120,
    provenance: {
      firstObservedAt: "2026-05-01T00:00:00.000Z",
      lastObservedAt: "2026-08-20T00:00:00.000Z",
      engineVersion: "1.6.0",
      derivedFrom: "operator-corrections",
    },
    ...over,
  });

  it("allows a well-corroborated, anonymous, traceable candidate", () => {
    const assessment = assessPromotion(candidate());
    expect(assessment.blockers).toEqual([]);
    expect(assessment.promotable).toBe(true);
  });

  it("refuses knowledge that can name where it came from", () => {
    // The moment a canonical record can name its contributor, the shared
    // KNOWLEDGE layer has become a shared DATA layer.
    const assessment = assessPromotion(
      candidate({ knowledge: { material: "oak", organizationId: "org-7", toneOffset: 0.2 } }),
    );
    expect(assessment.promotable).toBe(false);
    expect(assessment.blockers.join(" ")).toContain("organizationId");
  });

  it("refuses knowledge whose identity is buried in a nested object", () => {
    const assessment = assessPromotion(
      candidate({ knowledge: { material: "oak", meta: { capturedBy: "user-3" } } }),
    );
    expect(assessment.promotable).toBe(false);
  });

  it("refuses one shop agreeing with itself a thousand times", () => {
    // This is the actual failure §12 names: an engine notices that one shop
    // always offsets a cut because their machine is worn, and teaches every
    // other shop to do the same.
    const assessment = assessPromotion(
      candidate({ corroboratingOwnerRefs: ["org:1", "org:1", "org:1", "org:1"], supportingObservations: 5_000 }),
    );
    expect(assessment.distinctTenants).toBe(1);
    expect(assessment.promotable).toBe(false);
    expect(assessment.blockers.join(" ")).toContain(`${MIN_CORROBORATING_TENANTS} independent tenants`);
  });

  it("refuses three tenants who each saw it twice", () => {
    const assessment = assessPromotion(candidate({ supportingObservations: 6 }));
    expect(assessment.promotable).toBe(false);
    expect(assessment.blockers.join(" ")).toContain(`${MIN_SUPPORTING_OBSERVATIONS} are required`);
  });

  it("refuses a candidate nobody could reverse", () => {
    const assessment = assessPromotion(
      candidate({
        provenance: {
          firstObservedAt: "",
          lastObservedAt: "",
          engineVersion: "",
          derivedFrom: "",
        },
      }),
    );
    expect(assessment.promotable).toBe(false);
    expect(assessment.blockers.join(" ")).toContain("provenance");
  });

  it("reports every blocker at once", () => {
    // An operator who fixes one and resubmits, only to hit the next, learns to
    // distrust the tool.
    const assessment = assessPromotion(
      candidate({
        knowledge: { shopId: "shop-2" },
        corroboratingOwnerRefs: ["org:1"],
        supportingObservations: 2,
        provenance: { firstObservedAt: "", lastObservedAt: "", engineVersion: "", derivedFrom: "" },
      }),
    );
    expect(assessment.blockers.length).toBeGreaterThanOrEqual(4);
  });

  it("promotes nothing by itself", () => {
    // The function assesses. Promotion is a dangerous operation requiring the
    // owner role, a reason and a re-authentication — nothing here can do it.
    const module = assessPromotion(candidate());
    expect(Object.keys(module)).toEqual(["candidateId", "promotable", "blockers", "distinctTenants"]);
  });
});
