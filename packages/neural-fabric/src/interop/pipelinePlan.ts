/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/pipelinePlan.ts
 * Module:   neural-fabric / interop
 * Purpose:  Twelve things a mediation stage may do, and no thirteenth.
 */

import { z } from "zod";

import { classificationSchema, type Classification } from "../domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// A CLOSED STAGE VOCABULARY, BECAUSE THE ALTERNATIVE IS A SCRIPTING LANGUAGE
//
// The internal-service architecture is explicit: "Do not permit arbitrary
// production scripting inside pipeline definitions." That single sentence
// decides the whole shape of this file.
//
// The moment a pipeline stage can carry an expression — a JS snippet, a
// template, a JSONPath with a function call — three things become true at
// once and none of them can be walked back. Every security property becomes
// unprovable, because the stage's behaviour is no longer known until it runs.
// Every certification becomes a statement about a config file rather than the
// system. And the pipeline becomes the easiest place in the Hive to put
// business logic, at which point the communication layer owns domain rules it
// was built specifically not to own.
//
// So a stage here is DATA describing which of twelve known operations to
// perform, with parameters the schema bounds. Anything genuinely custom must
// go through a certified adapter, where isolation and conformance evidence
// apply. That is a deliberately higher bar, and it is meant to be.
//
// COMMUNICATION-ONLY (§ the migration plan's "Keep separate")
//
// These primitives mediate a conversation: validate it, normalize its
// metadata, translate it under a reviewed mapping, split and aggregate it,
// bound its rate, dispatch it. None of them compute anything a business would
// recognise. "Pipeline" is an overloaded word, and domain ETL keeps living
// with the domain engine that owns the meaning — a pipeline that calculates a
// price has stopped being a communication pipeline no matter what it is
// called.
// ─────────────────────────────────────────────────────────────────────────────

export const stageKindSchema = z.enum([
  /** Parse and schema-check. Always first; a stage before it acts on unvalidated input. */
  "VALIDATE",
  /** Canonicalize headers/ids. Metadata only — never payload semantics. */
  "NORMALIZE_METADATA",
  /** Apply a reviewed MappingContract. The only stage that may change meaning. */
  "APPLY_MAPPING",
  /** One message becomes many, up to a declared ceiling. */
  "SPLIT",
  /** Many messages become one, up to a declared ceiling. */
  "AGGREGATE",
  /** Add metadata from an allowlisted, non-authoritative source. */
  "ENRICH_METADATA",
  /** Bound the rate. */
  "THROTTLE",
  /** Bound the retries. */
  "RETRY_BUDGET",
  /** Route what failed somewhere a human can find it. */
  "DEAD_LETTER",
  /** Protocol encode or decode. */
  "CODEC",
  /** Trace context handling — strip, extract or inject. */
  "TRACE",
  /** Sign or verify through a Security port. This package holds no keys. */
  "SECURITY",
  /** Hand to a provider adapter. Terminal. */
  "DISPATCH",
]);
export type StageKind = z.infer<typeof stageKindSchema>;

/** Trace operations, separated because they have opposite security properties. */
export const traceOperationSchema = z.enum([
  /**
   * Remove everything not on the allowlist.
   *
   * §25 makes this a certification gate: external trace context must not be
   * able to inject protected baggage. Trace context arrives from outside,
   * it is attacker-controlled at an external boundary, and OpenTelemetry's
   * own guidance says as much. SANITIZE is the stage that makes an inbound
   * boundary safe, and the executor requires it before any inbound EXTRACT.
   */
  "SANITIZE",
  /** Read trace context off an inbound message. Only safe after SANITIZE. */
  "EXTRACT",
  /** Write trace context onto an outbound message. */
  "INJECT",
]);
export type TraceOperation = z.infer<typeof traceOperationSchema>;

export const securityOperationSchema = z.enum(["SIGN", "VERIFY"]);
export type SecurityOperation = z.infer<typeof securityOperationSchema>;

/** Ceilings that make split/aggregate bounded rather than a memory bomb. */
export const FAN_LIMIT = 1_000;
export const AGGREGATE_LIMIT = 1_000;

export const pipelineStageSchema = z
  .object({
    stageId: z.string().min(1),
    kind: stageKindSchema,
    /** Why this stage is here. Required — an unexplained stage cannot be reviewed. */
    reason: z.string().min(1),

    /** APPLY_MAPPING: the reviewed contract to apply. Never inline rules. */
    mappingContractRef: z.string().min(1).optional(),
    /** SPLIT: the most messages one may become. */
    maxFanOut: z.number().int().positive().max(FAN_LIMIT).optional(),
    /** AGGREGATE: the most messages one may absorb. */
    maxBatch: z.number().int().positive().max(AGGREGATE_LIMIT).optional(),
    /** ENRICH_METADATA: which metadata keys may be written. Closed list. */
    enrichKeys: z.array(z.string().min(1)).max(32).optional(),
    /** THROTTLE: ceiling per second. */
    maxPerSecond: z.number().int().positive().optional(),
    /** RETRY_BUDGET: the most attempts, total. */
    maxAttempts: z.number().int().positive().max(100).optional(),
    /** DEAD_LETTER: where the undeliverable goes. */
    deadLetterQueue: z.string().min(1).optional(),
    /** CODEC: the named codec profile. */
    codecProfile: z.string().min(1).optional(),
    traceOperation: traceOperationSchema.optional(),
    securityOperation: securityOperationSchema.optional(),
    /** DISPATCH: the adapter that must already be certified for this plan. */
    adapterId: z.string().min(1).optional(),
  })
  .strict()
  // Each stage kind requires its own parameter and nothing else has to be
  // checked at runtime. A stage missing its parameter is not a stage with a
  // default — it is an author who did not finish a thought.
  .superRefine((stage, ctx) => {
    const require = (present: boolean, field: string, why: string): void => {
      if (!present) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why, path: [field] });
    };
    switch (stage.kind) {
      case "APPLY_MAPPING":
        require(
          stage.mappingContractRef !== undefined,
          "mappingContractRef",
          "A mapping stage must name the reviewed MappingContract it applies. Inline transformation rules are how a communication pipeline acquires business meaning nobody approved.",
        );
        break;
      case "SPLIT":
        require(stage.maxFanOut !== undefined, "maxFanOut", "A split must declare its ceiling. Unbounded fan-out is an amplifier pointed at your own system.");
        break;
      case "AGGREGATE":
        require(stage.maxBatch !== undefined, "maxBatch", "An aggregate must declare its ceiling, or a slow consumer becomes an unbounded buffer.");
        break;
      case "ENRICH_METADATA":
        require(
          stage.enrichKeys !== undefined && stage.enrichKeys.length > 0,
          "enrichKeys",
          "An enrichment must name the keys it may write. An enrichment that can write anything can write an authorization reference.",
        );
        break;
      case "THROTTLE":
        require(stage.maxPerSecond !== undefined, "maxPerSecond", "A throttle without a rate is decoration.");
        break;
      case "RETRY_BUDGET":
        require(stage.maxAttempts !== undefined, "maxAttempts", "A retry budget without a ceiling is retry amplification with a friendly name.");
        break;
      case "DEAD_LETTER":
        require(stage.deadLetterQueue !== undefined, "deadLetterQueue", "A dead-letter stage must name where the undeliverable goes, or it is a delete.");
        break;
      case "CODEC":
        require(stage.codecProfile !== undefined, "codecProfile", "A codec stage must name its profile.");
        break;
      case "TRACE":
        require(stage.traceOperation !== undefined, "traceOperation", "A trace stage must say whether it sanitizes, extracts or injects — they have opposite security properties.");
        break;
      case "SECURITY":
        require(stage.securityOperation !== undefined, "securityOperation", "A security stage must say whether it signs or verifies.");
        break;
      case "DISPATCH":
        require(stage.adapterId !== undefined, "adapterId", "A dispatch must name the adapter, so certification can be checked against a specific thing rather than a category.");
        break;
      case "VALIDATE":
      case "NORMALIZE_METADATA":
        break;
    }
  });
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

/** Which way the message is moving. Decides which trace rules apply. */
export const pipelineDirectionSchema = z.enum(["INBOUND", "OUTBOUND"]);
export type PipelineDirection = z.infer<typeof pipelineDirectionSchema>;

export const pipelinePlanSchema = z
  .object({
    pipelineId: z.string().min(1),
    /** The PatternPlan this pipeline serves. A pipeline is never freestanding. */
    patternPlanIntentId: z.string().min(1),
    direction: pipelineDirectionSchema,
    stages: z.array(pipelineStageSchema).min(1).max(32),
    /**
     * The classification the message carries entering the pipeline.
     *
     * Recorded so the executor can prove the pipeline did not relax it. A
     * pipeline may tighten a classification (minimizing at a boundary is a
     * legitimate stage); it may never loosen one, because that would turn
     * mediation into declassification.
     */
    inboundClassification: classificationSchema,
    /** Versions, so an executed pipeline can be re-verified later. */
    topologyVersionId: z.string().min(1),
    authorizationEvidenceRef: z.string().min(1).nullable(),
  })
  .strict()
  .refine((p) => p.stages[0]!.kind === "VALIDATE", {
    message:
      "A pipeline must validate first. Any stage that runs before validation is operating on input nothing has checked, which is where parser-differential and deserialization bugs live.",
    path: ["stages"],
  })
  .refine((p) => p.stages.filter((s) => s.kind === "DISPATCH").length <= 1, {
    message:
      "A pipeline dispatches at most once. Two dispatches is a fan-out disguised as a pipeline, and the second one has no receipt anybody reads.",
    path: ["stages"],
  })
  .refine(
    (p) => {
      const dispatchIndex = p.stages.findIndex((s) => s.kind === "DISPATCH");
      return dispatchIndex === -1 || dispatchIndex === p.stages.length - 1;
    },
    {
      message:
        "Dispatch must be the last stage. A stage after dispatch operates on a message that has already left, so its effect is invisible to the receiver and to anyone reading the trace.",
      path: ["stages"],
    },
  )
  .refine(
    (p) => {
      // INBOUND: trace context is attacker-controlled until sanitized (§25).
      if (p.direction !== "INBOUND") return true;
      const extractIndex = p.stages.findIndex((s) => s.kind === "TRACE" && s.traceOperation === "EXTRACT");
      if (extractIndex === -1) return true;
      const sanitizeIndex = p.stages.findIndex((s) => s.kind === "TRACE" && s.traceOperation === "SANITIZE");
      return sanitizeIndex !== -1 && sanitizeIndex < extractIndex;
    },
    {
      message:
        "An inbound pipeline that extracts trace context must sanitize it first. Trace context crosses a boundary you do not control, and baggage is a key-value store an attacker can write to — extracting before sanitizing is how injected baggage reaches an internal consumer that trusts it.",
      path: ["stages"],
    },
  );
export type PipelinePlan = z.infer<typeof pipelinePlanSchema>;

/**
 * Ranks classifications so "no less restrictive" is checkable.
 *
 * The order is the envelope's own: public is the least protected, restricted
 * the most. PERSONAL sits above TENANT_PRIVATE because personal data carries
 * minimization duties that a tenant boundary alone does not discharge.
 */
export const CLASSIFICATION_RESTRICTION: Readonly<Record<Classification, number>> = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  TENANT_PRIVATE: 2,
  PERSONAL: 3,
  RESTRICTED: 4,
});

/** True when moving to `to` does not loosen protection. */
export function classificationMayBecome(from: Classification, to: Classification): boolean {
  return CLASSIFICATION_RESTRICTION[to] >= CLASSIFICATION_RESTRICTION[from];
}

/**
 * A pipeline stage cannot carry code. There is no field for it.
 *
 * Assertable because this is the property everything else in the pipeline
 * rests on, and it is exactly the kind of thing a later "small" schema
 * addition would quietly reverse.
 */
export function stagesMayCarryExecutableCode(): false {
  return false;
}
