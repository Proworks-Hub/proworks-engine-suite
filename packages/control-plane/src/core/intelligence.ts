// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { assertNoIdentityFields } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The AI layer, watched rather than run.
//
// Two separate things share this file because the console shows them together:
//
//   MODEL OPERATIONS — which providers are being called, how much, how fast,
//   and what it costs. Observability over spend.
//
//   LEARNED KNOWLEDGE — what the engines have concluded, who corrected them,
//   and the gate between one shop's quirk and the global set.
//
// Neither is intelligence itself. Model selection belongs to whichever engine
// makes the call; what VisionIQ learned about a laser belongs to VisionIQ. The
// console reads and, for one carefully gated operation, approves.
// ─────────────────────────────────────────────────────────────────────────────

// ── Model operations ─────────────────────────────────────────────────────────

export const modelDescriptorSchema = z
  .object({
    /** Stable id used in telemetry, e.g. "claude-sonnet-4-5". */
    id: z.string().min(1),
    label: z.string().min(1),
    /** "anthropic", "openai", "google", "local". */
    provider: z.string().min(1),
    /**
     * Runs on hardware we operate. Marked because it changes what the numbers
     * mean: a local model has latency and capacity but no per-token invoice.
     */
    local: z.boolean().default(false),
  })
  .strict();
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export const modelUsageWindowSchema = z
  .object({
    modelId: z.string().min(1),
    /** Which engine made the calls. Absent means every engine, aggregated. */
    engineId: z.string().min(1).optional(),
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    requests: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    avgLatencyMs: z.number().nonnegative().optional(),
    p95LatencyMs: z.number().nonnegative().optional(),
  })
  .strict();
export type ModelUsageWindow = z.infer<typeof modelUsageWindowSchema>;

/** Per-million-token prices, and when somebody last checked them. */
export interface ModelPriceTable {
  /** modelId → { inputPerMillionCents, outputPerMillionCents } */
  readonly prices: Readonly<
    Record<string, { inputPerMillionCents: number; outputPerMillionCents: number }>
  >;
  /** ISO date the table was last verified against the providers' published rates. */
  readonly asOf: string;
}

/** Beyond this, a price table is old enough that the figure needs a caveat. */
export const PRICE_TABLE_STALE_AFTER_DAYS = 45;

export interface ModelCostEstimate {
  readonly modelId: string;
  /**
   * Null when the model has no price entry — a local model, or one nobody has
   * priced yet.
   *
   * Null, NOT zero. Zero renders as "$0.00" and reads as a measurement, so a
   * dashboard quietly reports that half the fleet is free. "Not priced" is
   * the true statement and the one that gets fixed.
   */
  readonly cents: number | null;
  /**
   * Always true. It is a local multiplication against a hand-maintained table,
   * never a provider invoice, and the field exists so no caller can present it
   * as one.
   */
  readonly estimated: true;
  readonly pricingAsOf: string;
  /** True when the price table is older than the staleness window. */
  readonly pricingStale: boolean;
  /** Why there is no number, when there is none. */
  readonly note?: string;
}

/**
 * Estimates what a window of usage cost.
 *
 * The console shows spend, and spend shown without provenance becomes a figure
 * someone puts in a board deck. Everything this returns carries the date the
 * prices were checked and the word "estimated", structurally, so a caller
 * cannot render the number without the caveat being available.
 */
export function estimateModelCost(
  usage: ModelUsageWindow,
  table: ModelPriceTable,
  now: number,
): ModelCostEstimate {
  const asOfMs = Date.parse(table.asOf);
  const pricingStale =
    Number.isNaN(asOfMs) || now - asOfMs > PRICE_TABLE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const price = table.prices[usage.modelId];
  if (!price) {
    return {
      modelId: usage.modelId,
      cents: null,
      estimated: true,
      pricingAsOf: table.asOf,
      pricingStale,
      note: `No published price for "${usage.modelId}".`,
    };
  }

  const cents =
    (usage.inputTokens / 1_000_000) * price.inputPerMillionCents +
    (usage.outputTokens / 1_000_000) * price.outputPerMillionCents;

  return {
    modelId: usage.modelId,
    cents,
    estimated: true,
    pricingAsOf: table.asOf,
    pricingStale,
  };
}

/**
 * Rolls windows up for the dashboard's spend panel.
 *
 * Unpriced models are counted separately rather than folded in as zero, so the
 * total can say "plus 842 requests on an unpriced model" instead of implying
 * they were free.
 */
export function summariseModelSpend(
  usages: readonly ModelUsageWindow[],
  table: ModelPriceTable,
  now: number,
): {
  totalCents: number;
  estimated: true;
  pricingAsOf: string;
  pricingStale: boolean;
  unpricedModels: string[];
  unpricedRequests: number;
  totalRequests: number;
  totalTokens: number;
} {
  let totalCents = 0;
  let unpricedRequests = 0;
  let totalRequests = 0;
  let totalTokens = 0;
  const unpricedModels = new Set<string>();
  let pricingStale = false;

  for (const usage of usages) {
    totalRequests += usage.requests;
    totalTokens += usage.inputTokens + usage.outputTokens;
    const estimate = estimateModelCost(usage, table, now);
    pricingStale ||= estimate.pricingStale;
    if (estimate.cents === null) {
      unpricedModels.add(usage.modelId);
      unpricedRequests += usage.requests;
    } else {
      totalCents += estimate.cents;
    }
  }

  return {
    totalCents,
    estimated: true,
    pricingAsOf: table.asOf,
    pricingStale,
    unpricedModels: [...unpricedModels],
    unpricedRequests,
    totalRequests,
    totalTokens,
  };
}

// ── Learned knowledge ────────────────────────────────────────────────────────

/**
 * Where a piece of learned knowledge lives.
 *
 * The same two-tier split the ownership model already uses, and for the same
 * reason: the moment a canonical record can name the shop it came from, the
 * shared-knowledge layer has become a shared-DATA layer.
 */
export const knowledgeScopeSchema = z.enum(["canonical", "tenant"]);
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

export const decisionOutcomeSchema = z.enum([
  /** An operator let it stand. Weak evidence — most people accept defaults. */
  "accepted",
  /** An operator changed it. The strongest signal available, and the rarest. */
  "corrected",
  "rejected",
  /** Nobody has looked. Not evidence of anything, and must not be counted as acceptance. */
  "unresolved",
]);
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

export const engineDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    engineId: z.string().min(1),
    /** What kind of call this was, e.g. "laser.tone.curve", "material.match". */
    kind: z.string().min(1),
    /** The engine's own confidence, 0..1, when it reports one. */
    confidence: z.number().min(0).max(1).optional(),
    outcome: decisionOutcomeSchema,
    /** The opaque owner reference, never a tenant context. */
    ownerRef: z.string().min(1).optional(),
    occurredAt: z.string().min(1),
    /** Which model produced it, when a model did. */
    modelId: z.string().min(1).optional(),
  })
  .strict();
export type EngineDecision = z.infer<typeof engineDecisionSchema>;

/**
 * How often the engine was right, counted honestly.
 *
 * `unresolved` decisions are excluded from the denominator rather than counted
 * as successes. Treating "nobody looked" as "nobody objected" is how a model
 * reports 99% accuracy on a queue nobody reviews.
 */
export function summariseDecisions(decisions: readonly EngineDecision[]): {
  total: number;
  reviewed: number;
  accepted: number;
  corrected: number;
  rejected: number;
  unresolved: number;
  /** Null when nothing has been reviewed. Not 1, and not 0. */
  acceptanceRate: number | null;
} {
  let accepted = 0;
  let corrected = 0;
  let rejected = 0;
  let unresolved = 0;

  for (const decision of decisions) {
    if (decision.outcome === "accepted") accepted += 1;
    else if (decision.outcome === "corrected") corrected += 1;
    else if (decision.outcome === "rejected") rejected += 1;
    else unresolved += 1;
  }

  const reviewed = accepted + corrected + rejected;
  return {
    total: decisions.length,
    reviewed,
    accepted,
    corrected,
    rejected,
    unresolved,
    acceptanceRate: reviewed === 0 ? null : accepted / reviewed,
  };
}

// ── The gate between one shop and everybody ──────────────────────────────────

/** Distinct tenants that must independently agree before knowledge goes global. */
export const MIN_CORROBORATING_TENANTS = 3;

/** Observations needed before a pattern is a pattern. */
export const MIN_SUPPORTING_OBSERVATIONS = 20;

export interface KnowledgePromotionCandidate {
  readonly candidateId: string;
  readonly engineId: string;
  readonly kind: string;
  /**
   * The knowledge itself. Checked for identifying fields before anything else
   * happens to it.
   */
  readonly knowledge: Record<string, unknown>;
  /** Opaque owner refs that independently produced this. Counted, never stored globally. */
  readonly corroboratingOwnerRefs: readonly string[];
  readonly supportingObservations: number;
  /** Where this came from. A promotion without provenance cannot be undone. */
  readonly provenance: {
    readonly firstObservedAt: string;
    readonly lastObservedAt: string;
    readonly engineVersion: string;
    readonly derivedFrom: string;
  };
}

export interface PromotionAssessment {
  readonly candidateId: string;
  readonly promotable: boolean;
  /** Every reason it cannot go, not just the first. */
  readonly blockers: readonly string[];
  readonly distinctTenants: number;
}

/**
 * Decides whether a candidate MAY be promoted. Never promotes anything.
 *
 * §12: one shop's quirk must not become everybody's default. That happens by
 * accident, not malice — an engine notices that this shop always offsets a
 * cut by 0.2mm because their machine is worn, and absent a gate it teaches
 * every other shop to do the same.
 *
 * Four independent conditions, and all four have to hold:
 *
 *   NO IDENTIFYING FIELDS. Checked with the same assertion the shared-knowledge
 *   layer uses, so the rule cannot drift between the two places it matters.
 *
 *   CORROBORATION FROM DISTINCT TENANTS. One shop agreeing with itself a
 *   thousand times is one shop. Counting observations instead of tenants is
 *   exactly how a single busy shop's habits become global truth.
 *
 *   ENOUGH OBSERVATIONS. Three tenants who each saw it once is a coincidence.
 *
 *   PROVENANCE. Not for tidiness: a promotion that cannot say where it came
 *   from is a promotion nobody can reverse when it turns out to be wrong.
 *
 * Every blocker is reported, because an operator who fixes one and resubmits
 * only to hit the next learns to distrust the tool.
 */
export function assessPromotion(candidate: KnowledgePromotionCandidate): PromotionAssessment {
  const blockers: string[] = [];

  try {
    assertNoIdentityFields(candidate.knowledge, "knowledge");
  } catch (cause) {
    blockers.push(
      cause instanceof Error
        ? cause.message
        : "The knowledge contains a field capable of identifying its source.",
    );
  }

  const distinctTenants = new Set(candidate.corroboratingOwnerRefs).size;
  if (distinctTenants < MIN_CORROBORATING_TENANTS) {
    blockers.push(
      `Observed by ${distinctTenants} tenant${distinctTenants === 1 ? "" : "s"}; ` +
        `${MIN_CORROBORATING_TENANTS} independent tenants are required. One shop's setting is one shop's setting.`,
    );
  }

  if (candidate.supportingObservations < MIN_SUPPORTING_OBSERVATIONS) {
    blockers.push(
      `${candidate.supportingObservations} observations; ${MIN_SUPPORTING_OBSERVATIONS} are required.`,
    );
  }

  const { firstObservedAt, lastObservedAt, engineVersion, derivedFrom } = candidate.provenance;
  if (!firstObservedAt || !lastObservedAt || !engineVersion || !derivedFrom) {
    blockers.push("Incomplete provenance; a promotion that cannot be traced cannot be reversed.");
  }

  return {
    candidateId: candidate.candidateId,
    promotable: blockers.length === 0,
    blockers,
    distinctTenants,
  };
}
