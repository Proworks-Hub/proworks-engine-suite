/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/costEstimate.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  The answer: what it costs, how that was worked out, and what
 *           actually happened afterwards.
 */

import { z } from "zod";

import {
  costComponentSchema,
  costObjectRefSchema,
  costPolicySchema,
  costScopeSchema,
  currencyCodeSchema,
  decimalStringSchema,
} from "./costModel.js";
import { costAssumptionSchema, costEvidenceQualitySchema } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// AN ESTIMATE IS A HISTORICAL FACT, NOT A LIVE VIEW
//
// This is the single most consequential rule in the engine.
//
// A quote goes out on Tuesday at £4,200. On Friday the steel price changes. On
// the following Monday somebody opens the quote. What should it say?
//
// It must say £4,200. It said £4,200 to a customer, a margin was accepted on
// that basis, and a variance analysis six months later is meaningless if the
// baseline moved. An estimate that recalculated itself would destroy the only
// record of what was actually promised — and it would do it silently, which is
// worse.
//
// So an approved estimate is IMMUTABLE. New evidence produces a new version.
// The old version keeps its numbers, its rates, its policy and its
// fingerprint, forever.
//
// THE FINGERPRINT
//
// A stable hash over the canonical inputs, policy and method version. It
// answers "is this the same calculation" without comparing every number, and
// it is what makes replay checkable: recompute an old estimate with its
// recorded method version and the fingerprint must match. If it does not,
// something changed that was not supposed to.
//
// The fingerprint deliberately covers INPUTS AND METHOD, not the result.
// Hashing the result would make it a checksum; hashing the inputs makes it an
// identity, so two runs that should agree can be shown to.
// ─────────────────────────────────────────────────────────────────────────────

/** Which way of costing was used. Versioned, because formulas change. */
export const costMethodRefSchema = z
  .object({
    methodId: z.string().min(1),
    /**
     * The method's version.
     *
     * A change that alters results REQUIRES a new version. Without that rule
     * an old estimate could not be replayed, because the code that made it
     * would no longer exist in reproducible form.
     */
    methodVersion: z.string().min(1),
  })
  .strict();
export type CostMethodRef = z.infer<typeof costMethodRefSchema>;

/**
 * Where an estimate is in its life.
 *
 * DRAFT can change. Everything after it cannot. The transition is governed
 * outside CostIQ — this records the state, it does not grant it.
 */
export const estimateStatusSchema = z.enum([
  /** Being worked on. Mutable. */
  "DRAFT",
  /** Put forward for approval. Frozen so approvers see what they approve. */
  "CANDIDATE",
  /** Approved and in force. Immutable, permanently. */
  "APPROVED",
  /** No longer current, but preserved. Never deleted. */
  "SUPERSEDED",
  /** Withdrawn before approval. */
  "RETIRED",
]);
export type EstimateStatus = z.infer<typeof estimateStatusSchema>;

/** Statuses whose numbers may never change again. */
export const IMMUTABLE_STATUSES: readonly EstimateStatus[] = Object.freeze([
  "CANDIDATE",
  "APPROVED",
  "SUPERSEDED",
  "RETIRED",
]);

export function isImmutable(status: EstimateStatus): boolean {
  return IMMUTABLE_STATUSES.includes(status);
}

/**
 * Whether an estimate may move from one status to another.
 *
 * Deliberately restrictive. The dangerous transition is anything back to
 * DRAFT: it would make an approved estimate editable, which is how the
 * historical record gets quietly rewritten. There is no path back — a
 * correction is a new version that supersedes, so both survive.
 */
export function statusTransitionAllowed(
  from: EstimateStatus,
  to: EstimateStatus,
): { readonly allowed: boolean; readonly reason: string } {
  if (from === to) return { allowed: true, reason: "No change." };

  const permitted: Readonly<Record<EstimateStatus, readonly EstimateStatus[]>> = {
    DRAFT: ["CANDIDATE", "RETIRED"],
    CANDIDATE: ["APPROVED", "RETIRED", "DRAFT"],
    APPROVED: ["SUPERSEDED"],
    SUPERSEDED: [],
    RETIRED: [],
  };

  if (permitted[from].includes(to)) {
    return { allowed: true, reason: `${from} may become ${to}.` };
  }
  if (to === "DRAFT") {
    return {
      allowed: false,
      reason: `Refusing ${from} -> DRAFT. An estimate that has left draft is a record of what was said; making it editable again rewrites history rather than correcting it. Supersede it with a new version instead.`,
    };
  }
  return { allowed: false, reason: `${from} may not become ${to}.` };
}

/**
 * A complete costing.
 *
 * Self-contained on purpose: it carries its own policy, method version,
 * components, assumptions and evidence quality. Reproducing it needs nothing
 * that could have changed since.
 */
export const costEstimateSchema = z
  .object({
    estimateId: z.string().min(1),
    /**
     * Which revision of this estimate.
     *
     * Monotonic per `estimateId`. The pair identifies a calculation forever.
     */
    version: z.number().int().positive(),
    scope: costScopeSchema,
    subject: costObjectRefSchema,
    status: estimateStatusSchema,
    method: costMethodRefSchema,
    policy: costPolicySchema,

    /** The lines. Order is not significant; the graph carries structure. */
    components: z.array(costComponentSchema),

    /** How many of the thing this estimate is for. */
    quantity: decimalStringSchema,
    quantityUnit: z.string().min(1),

    /** Sum of the included components. */
    totalCost: decimalStringSchema,
    /** Total divided by quantity, at the policy's precision. */
    unitCost: decimalStringSchema,
    currency: currencyCodeSchema,

    /** Cost with no basis behind it. Reported, never hidden inside the total. */
    unpricedAmount: decimalStringSchema,

    assumptions: z.array(costAssumptionSchema).default([]),
    evidenceQuality: costEvidenceQualitySchema,

    /**
     * The stable hash over canonical inputs, policy and method version.
     *
     * Covers inputs and method rather than the result, so it is an identity
     * rather than a checksum: two runs that should agree can be shown to.
     */
    fingerprint: z.string().min(1),

    /** When this version was computed. The caller's clock, recorded not read. */
    computedAt: z.string().min(1),
    /** The version this replaced, if any. */
    supersedes: z
      .object({ estimateId: z.string().min(1), version: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();
export type CostEstimate = z.infer<typeof costEstimateSchema>;

/**
 * What actually happened.
 *
 * Deliberately shaped like an estimate — same component kinds, same currency
 * rules — because variance is a comparison and comparing unlike shapes means
 * mapping at the point of comparison, which is where mistakes hide.
 */
export const costActualSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    scope: costScopeSchema,
    subject: costObjectRefSchema,

    /**
     * The estimate version this is measured against.
     *
     * REQUIRED, and required to be a specific VERSION rather than an estimate
     * id. Comparing actuals against "the current estimate" measures drift in
     * the estimate as well as in reality, and reports the sum of the two as
     * though it were performance.
     */
    againstEstimate: z
      .object({ estimateId: z.string().min(1), version: z.number().int().positive() })
      .strict(),

    components: z.array(costComponentSchema),
    quantityProduced: decimalStringSchema,
    quantityUnit: z.string().min(1),
    totalCost: decimalStringSchema,
    currency: currencyCodeSchema,

    /** When the work finished. */
    completedAt: z.string().min(1),
    /** Whether every expected component was captured. */
    complete: z.boolean(),
    /** Kinds expected but missing, so partial data is visibly partial. */
    missingKinds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type CostActualSnapshot = z.infer<typeof costActualSnapshotSchema>;

/**
 * Why an actual differs from its estimate.
 *
 * Attributed rather than totalled. "£300 over" is a fact nobody can act on;
 * "£280 of it is material price, £20 is usage, and the labour was exactly
 * right" points at a supplier conversation.
 */
export const varianceCauseSchema = z.enum([
  /** The rate was different from the one estimated. */
  "RATE",
  /** More or less of the thing was used than estimated. */
  "QUANTITY",
  /** Yield differed — scrap, rework, offcuts. */
  "YIELD",
  /** Time taken differed. */
  "TIME",
  /** The estimate's policy and the actual's differ. */
  "POLICY",
  /** A component existed in one and not the other. */
  "COVERAGE",
  /** Attribution could not be determined from the evidence available. */
  "UNEXPLAINED",
]);
export type VarianceCause = z.infer<typeof varianceCauseSchema>;

export const costVarianceSchema = z
  .object({
    varianceId: z.string().min(1),
    scope: costScopeSchema,
    againstEstimate: z
      .object({ estimateId: z.string().min(1), version: z.number().int().positive() })
      .strict(),
    snapshotId: z.string().min(1),

    /** Actual minus estimated. Positive means it cost more than expected. */
    totalVariance: decimalStringSchema,
    currency: currencyCodeSchema,

    /** The same difference, broken down. Must sum to `totalVariance`. */
    byCause: z.array(
      z
        .object({
          cause: varianceCauseSchema,
          componentKind: z.string().min(1).optional(),
          amount: decimalStringSchema,
          explanation: z.string().min(1),
        })
        .strict(),
    ),

    computedAt: z.string().min(1),
  })
  .strict();
export type CostVariance = z.infer<typeof costVarianceSchema>;

/**
 * A what-if.
 *
 * An OVERLAY, never a mutation. A scenario names a baseline estimate and the
 * inputs to change; it never writes to the baseline. That is what makes
 * scenarios safe to generate freely — comparing twelve suppliers should not
 * risk the quote that was actually sent.
 */
export const costScenarioSchema = z
  .object({
    scenarioId: z.string().min(1),
    scope: costScopeSchema,
    label: z.string().min(1),

    /** The estimate version this varies from. Pinned, so the comparison holds. */
    baseline: z
      .object({ estimateId: z.string().min(1), version: z.number().int().positive() })
      .strict(),

    /**
     * The changes, as named overrides.
     *
     * Data rather than a function. An executable override could do anything,
     * could not be serialised, and could not be replayed — and replay is how
     * a scenario from six months ago is checked.
     */
    overrides: z
      .array(
        z
          .object({
            /** What is being changed: a rate, a quantity, a policy field. */
            target: z.enum(["RATE", "QUANTITY", "POLICY", "YIELD", "COMPONENT_AMOUNT"]),
            /** Which one — a rate id, component id or policy field name. */
            targetRef: z.string().min(1),
            /** The value to use instead. A decimal string, as everywhere. */
            value: decimalStringSchema,
            /** Optional unit, when the override is a quantity. */
            unit: z.string().min(1).optional(),
            /** Why this scenario exists. */
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(1),

    createdAt: z.string().min(1),
  })
  .strict();
export type CostScenario = z.infer<typeof costScenarioSchema>;

/**
 * Whether the components' included amounts reconcile with the stated total.
 *
 * THE INVARIANT THE WHOLE ENGINE RESTS ON. An estimate whose parts do not add
 * up to its total is not a rounding problem — it is an estimate that cannot be
 * explained, because every explanation is ultimately "these pieces make that
 * number".
 *
 * Returns the discrepancy rather than a boolean, so the caller can decide
 * whether it is a rounding artefact or a fault. Comparison uses exact decimal
 * arithmetic supplied by the caller, keeping this module free of arithmetic
 * imports it would otherwise need only here.
 */
export function reconciliationDiscrepancy(
  estimate: Pick<CostEstimate, "components" | "totalCost">,
  add: (a: string, b: string) => string,
  subtract: (a: string, b: string) => string,
): string {
  const included = estimate.components.filter((c) => c.included);
  const sum = included.reduce<string>((acc, c) => add(acc, c.amount), "0");
  return subtract(estimate.totalCost, sum);
}
