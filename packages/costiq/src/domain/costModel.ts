/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/domain/costModel.ts
 * Module:   cost-iq-engine / domain
 * Purpose:  What a cost is ABOUT, what it is made OF, and where each number
 *           in it came from.
 */

import { z } from "zod";

import { costEvidenceQualitySchema, provenanceSchema } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC ON PURPOSE
//
// v1 knows about jobs, workstations and consumables. That is a fine model of a
// print shop and a poor model of anything else, and CostIQ is meant to cost a
// machined part, a construction task, a lab assay or a batch of shirts without
// caring which.
//
// So nothing here names an industry. A `CostObjectRef` is "the thing being
// costed" — the caller says what kind. A `CostComponent` is "a piece of the
// cost" with a KIND from a fixed list, because a fixed list is what makes
// rollup, comparison and variance possible across domains. The industry
// vocabulary lives in adapters, which is where it can change without
// disturbing the kernel.
//
// AMOUNTS ARE STRINGS AT THE BOUNDARY
//
// Every schema here carries money and quantity as decimal STRINGS, not
// numbers. A JSON number has already been through a float by the time zod sees
// it, so accepting one would reintroduce the error this engine exists to
// remove. The strings are parsed into exact `Decimal` on the way in and
// serialised back on the way out, and the boundary is the only place the
// conversion happens.
// ─────────────────────────────────────────────────────────────────────────────

/** A decimal string. The only shape an amount may take at a public boundary. */
export const decimalStringSchema = z
  .string()
  .regex(/^[+-]?(\d+(\.\d*)?|\.\d+)$/, {
    message:
      "Amounts cross this boundary as decimal strings, never as JSON numbers — a JSON number has already been through a binary float and lost digits.",
  });

/** An ISO 4217 code. */
export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, {
  message: "Expected an ISO 4217 currency code such as GBP.",
});

/** Who a cost belongs to. Present on everything that could cross a boundary. */
export const costScopeSchema = z
  .object({
    /** The Hive instance that owns this. Never inferred from a request. */
    instanceId: z.string().min(1),
    /** The tenant within it. */
    tenantId: z.string().min(1),
    /** Optional site/plant, because rates legitimately differ by location. */
    siteId: z.string().min(1).optional(),
  })
  .strict();
export type CostScope = z.infer<typeof costScopeSchema>;

/**
 * The thing being costed.
 *
 * A REFERENCE, not a copy. CostIQ does not own products, work orders or
 * assemblies; it points at them. Copying another engine's record here would
 * make CostIQ a second source of truth for something it cannot keep current.
 */
export const costObjectRefSchema = z
  .object({
    /**
     * What kind of thing this is, in the CALLER's vocabulary.
     *
     * Free text because the list is not CostIQ's to close: "product",
     * "work_order", "assembly", "operation", "assay", "task". Fixing it would
     * make adding a new kind a CostIQ release.
     */
    objectType: z.string().min(1),
    /** The owning system's identifier, verbatim. */
    objectId: z.string().min(1),
    /** Which engine or system owns the underlying record. */
    ownedBy: z.string().min(1),
    /** A human label, for explanations. Never used as an identifier. */
    label: z.string().min(1).optional(),
  })
  .strict();
export type CostObjectRef = z.infer<typeof costObjectRefSchema>;

/**
 * The kinds of cost a component can be.
 *
 * CLOSED, unlike `objectType`, and that asymmetry is deliberate. What is being
 * costed varies endlessly by industry; what a cost is MADE OF does not.
 * Material, labour, machine time, subcontract, freight, energy, tooling,
 * scrap, overhead and contingency cover a machined part and a lab assay alike
 * — and a closed list is what lets two estimates from different domains be
 * compared, rolled up and varianced.
 *
 * A kind that genuinely does not fit is a signal to discuss the model, not to
 * add a string.
 */
export const costComponentKindSchema = z.enum([
  /** Stuff consumed and embodied in the output. */
  "MATERIAL",
  /** Stuff consumed but not embodied — abrasives, coolant, thread. */
  "CONSUMABLE",
  /** People's time. */
  "LABOR",
  /** Equipment time. */
  "MACHINE",
  /** Getting ready and putting away. Distinct because it does not scale with volume. */
  "SETUP",
  /** Work bought in from outside. */
  "SUBCONTRACT",
  /** Moving things. */
  "FREIGHT",
  /** Duty, tariffs, customs handling. Separate from freight because policy differs. */
  "DUTY",
  /** Power, gas, compressed air. */
  "ENERGY",
  /** Tooling and non-recurring engineering, usually amortised. */
  "TOOLING",
  /** Value lost to scrap and rework. */
  "SCRAP",
  /** Indirect cost applied by a driver. */
  "OVERHEAD",
  /** A deliberate allowance for what is not yet known. */
  "CONTINGENCY",
  /**
   * Cost that exists but has no basis to price it.
   *
   * The most important kind. An estimate with unpriced components is
   * incomplete, and an engine that silently costed them at zero would report
   * a total that is confidently too low.
   */
  "UNPRICED",
]);
export type CostComponentKind = z.infer<typeof costComponentKindSchema>;

/**
 * A rate: an amount of money for each unit of something.
 *
 * The unit is REQUIRED. "£12" is not a rate; "£12 per kg" is. That requirement
 * is what makes the unit check possible at the point a rate meets a quantity,
 * which is where a cost engine most often goes silently and enormously wrong.
 */
export const costRateSchema = z
  .object({
    rateId: z.string().min(1),
    scope: costScopeSchema,
    amount: decimalStringSchema,
    currency: currencyCodeSchema,
    /** The unit the amount is PER. */
    perUnit: z.string().min(1),
    /** What this rate prices. */
    appliesTo: costComponentKindSchema,
    /** From when this rate is the right one to use. */
    effectiveFrom: z.string().min(1),
    /** Until when. Absent means "still current". */
    effectiveTo: z.string().min(1).optional(),
    provenance: provenanceSchema,
    /** A rate this one replaced, so supersession is traceable. */
    supersedes: z.string().min(1).optional(),
  })
  .strict();
export type CostRate = z.infer<typeof costRateSchema>;

/**
 * The evidence behind a price, and the rules for choosing among candidates.
 *
 * A basis is not a rate. A rate is one number; a basis is the considered
 * answer to "what should this cost", including which candidates were
 * available, which was chosen, and why the others were not. That distinction
 * is what makes an explanation possible later — "we used the contract price,
 * not the observed average, because the contract is in force" is only sayable
 * if the rejected candidates survived.
 */
export const costBasisSchema = z
  .object({
    basisId: z.string().min(1),
    scope: costScopeSchema,
    /** What is being priced. */
    subject: costObjectRefSchema,
    appliesTo: costComponentKindSchema,
    /** The rate actually used. */
    selectedRate: costRateSchema,
    /**
     * Rates that were available and not chosen, with the reason.
     *
     * Kept because "why is this number what it is" is usually really "why is
     * it not the other number".
     */
    rejected: z
      .array(
        z
          .object({
            rate: costRateSchema,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    /** When this basis was determined. */
    determinedAt: z.string().min(1),
    /**
     * Whether the selection fell back rather than chose.
     *
     * Never inferred from the source kind alone: a policy can legitimately
     * select an approved rate as its first choice, and that is not a fallback.
     * A fallback is when the policy's preferred sources were all unavailable.
     */
    wasFallback: z.boolean().default(false),
  })
  .strict();
export type CostBasis = z.infer<typeof costBasisSchema>;

/**
 * One line of a cost.
 *
 * Carries a quantity, a rate and the resulting amount — all three, even though
 * the third is derivable. Storing the result makes an estimate self-contained
 * evidence: reproducing it later requires the method version and the inputs,
 * and comparing what WAS computed against what WOULD BE computed now is how
 * replay proves determinism.
 */
export const costComponentSchema = z
  .object({
    componentId: z.string().min(1),
    kind: costComponentKindSchema,
    /** A human label for explanations. */
    label: z.string().min(1),
    /** The node this hangs from in the cost graph. Absent means top level. */
    parentId: z.string().min(1).optional(),

    /** How much of the thing. Absent for components that are just an amount. */
    quantity: decimalStringSchema.optional(),
    quantityUnit: z.string().min(1).optional(),

    /** The basis that priced it. Absent only for UNPRICED components. */
    basisId: z.string().min(1).optional(),

    /** The resulting amount. */
    amount: decimalStringSchema,
    currency: currencyCodeSchema,

    /**
     * Whether this amount is included in the parent's total.
     *
     * Memo components exist — a comparison figure, a should-cost alongside an
     * actual — and adding them would double-count. Defaulting to true means
     * forgetting the flag over-counts rather than under-counts, which is the
     * error that gets noticed.
     */
    included: z.boolean().default(true),

    provenance: provenanceSchema.optional(),
    /** Anything that qualifies this line specifically. */
    notes: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((c) => c.quantity === undefined || c.quantityUnit !== undefined, {
    message: "A quantity without a unit is a number with no meaning. Supply quantityUnit alongside quantity.",
    path: ["quantityUnit"],
  })
  .refine((c) => c.kind === "UNPRICED" || c.basisId !== undefined || c.kind === "CONTINGENCY", {
    message:
      "A priced component must name the basis that priced it. If nothing priced it, its kind is UNPRICED — an unpriced line costed silently at zero makes a total that is confidently too low.",
    path: ["basisId"],
  });
export type CostComponent = z.infer<typeof costComponentSchema>;

/**
 * How a calculation should behave.
 *
 * Policy is data and travels WITH the estimate, because "what did we assume"
 * is part of the answer. Two estimates that differ only by rounding stage are
 * genuinely different estimates, and an estimate that did not record its
 * policy cannot be reproduced.
 */
export const costPolicySchema = z
  .object({
    policyId: z.string().min(1),
    policyVersion: z.string().min(1),

    /** The currency every amount in the estimate is expressed in. */
    currency: currencyCodeSchema,
    roundingMode: z.enum(["HALF_UP", "HALF_DOWN", "HALF_EVEN", "DOWN", "UP", "CEILING", "FLOOR"]),
    roundingStage: z.enum(["NONE", "COMPONENT", "TOTAL", "PRESENTATION"]),
    /** Digits to round to, or null for the currency's own minor units. */
    roundingScale: z.number().int().min(0).max(12).nullable(),
    /** Working precision for intermediate division. Higher than payment precision. */
    calculationScale: z.number().int().min(2).max(20),

    /**
     * Source kinds this policy will accept, best first.
     *
     * An ordered allowlist rather than a threshold: it says both what is
     * permitted and what is preferred, and anything absent is not merely
     * lower-ranked but refused.
     */
    acceptedSources: z.array(z.string().min(1)).min(1),
    /** Whether falling back below the preferred sources is allowed at all. */
    allowFallback: z.boolean(),
    /** Evidence older than this is stale. Days. */
    freshnessWindowDays: z.number().int().positive(),
    /** Minimum observations before an observed rate counts as a rate. */
    minimumSampleSize: z.number().int().positive(),
  })
  .strict();
export type CostPolicy = z.infer<typeof costPolicySchema>;

/**
 * A recommendation CostIQ can make.
 *
 * A RECOMMENDATION, never an action. CostIQ can observe that a rate is stale,
 * that a family of estimates is consistently 8% under, or that a component has
 * no basis. It cannot fix any of them: changing an authoritative rate is a
 * governed act, and an engine that quietly corrected its own inputs would make
 * every historical estimate unreproducible.
 */
export const costRecommendationSchema = z
  .object({
    recommendationId: z.string().min(1),
    scope: costScopeSchema,
    kind: z.enum([
      "STALE_BASIS",
      "PERSISTENT_BIAS",
      "HIGH_FALLBACK_RATE",
      "UNPRICED_COVERAGE",
      "UNEXPLAINED_VARIANCE",
      "INSUFFICIENT_VALIDATION",
      "OVERRIDE_CONCENTRATION",
    ]),
    /** What was noticed, in plain words. */
    finding: z.string().min(1),
    /** The evidence, so a person can check rather than trust. */
    evidenceRefs: z.array(z.string().min(1)).min(1),
    /** What could be done. Phrased as an option, not an instruction. */
    suggestion: z.string().min(1),
    /** How much money is affected, if that can be quantified. */
    materialAmount: decimalStringSchema.optional(),
    currency: currencyCodeSchema.optional(),
    raisedAt: z.string().min(1),
  })
  .strict();
export type CostRecommendation = z.infer<typeof costRecommendationSchema>;

/** Re-exported so consumers get the quality shape from the model module too. */
export { costEvidenceQualitySchema };
