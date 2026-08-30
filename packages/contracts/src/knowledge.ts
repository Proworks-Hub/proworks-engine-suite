// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { dataClassificationSchema } from "./hiveMessage.js";
import { identifierSchema } from "./identifiers.js";
import { ownershipClassSchema } from "./tenancy.js";

// ─────────────────────────────────────────────────────────────────────────────
// ONE DOOR TO SHARED KNOWLEDGE.
//
// The value of collective knowledge is that every instance benefits from what
// any instance learned. The danger is identical in shape: a path that carries
// a fact outward also carries whatever the fact was derived from, and the
// derivation is somebody's jobs, prices and customers.
//
// So there is one door, and the interesting content of this file is what the
// door checks:
//
//   SCOPE, reusing the ownership model rather than inventing a second one.
//   `canonical` knowledge belongs to nobody and is shared. `tenant-private`
//   belongs to one shop and is never served to another. A second vocabulary
//   for the same distinction would eventually disagree with the first, and the
//   disagreement would be a leak.
//
//   FRESHNESS, which is a safety property and not a performance one. A stale
//   machine tolerance is not a slow answer; it is a wrong answer about
//   something that cuts metal.
//
//   PROVENANCE on every response, because knowledge with no source is a rumour
//   an engine will act on with the same confidence as a fact.
//
// AND THE CACHE IS A CACHE
//
// Local copies are cache entries and never independent authorities. An
// instance that could answer from its own store while disagreeing with the
// collective has forked the shared knowledge, and nobody would find out until
// two instances made different decisions from the same question.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How much of an answer a caller is asking for.
 *
 * The ownership model, reused. `canonical` is shared knowledge — a material
 * property, a machine tolerance, a merchant identity. `tenant-private` is one
 * shop's own. `host-private` sits between: one application's, across its
 * tenants.
 */
export const knowledgeScopeSchema = ownershipClassSchema;
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

/**
 * How fresh an answer has to be.
 *
 * A policy on the REQUEST, because the same fact can be safety-critical to one
 * caller and merely useful to another. A cutting tolerance read by a job
 * planner needs `fresh`; the same value on a dashboard does not.
 */
export const freshnessPolicySchema = z.enum([
  /** A cached answer is fine if it has not expired. */
  "cached_ok",
  /**
   * Serve stale while refreshing behind it.
   *
   * Only for knowledge explicitly marked low-risk. Everything else that would
   * qualify for this is knowledge somebody would rather have late than wrong.
   */
  "stale_while_revalidate",
  /** Go to the collective. A cached answer will not do. */
  "fresh",
]);
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;

export const knowledgeRequestSchema = z
  .object({
    tenantId: z.string().min(1).optional(),
    /** Which instance is asking. Bound by the runtime, never self-declared. */
    instanceId: identifierSchema,
    engineId: identifierSchema,
    /** Who, ultimately. A reference — never a principal object. */
    actorId: identifierSchema.optional(),
    domain: z.string().min(1),
    query: z.string().min(1),
    requestedScope: knowledgeScopeSchema,
    freshness: freshnessPolicySchema,
  })
  .strict()
  .refine((r) => r.requestedScope !== "tenant-private" || Boolean(r.tenantId), {
    message:
      "A tenant-private request must name its tenant. Without one the gateway would have to guess whose knowledge was being asked for, and the cheapest guess is the wrong one.",
    path: ["tenantId"],
  });
export type KnowledgeRequest = z.infer<typeof knowledgeRequestSchema>;

/** Where an answer came from. References, never copies of the source records. */
export const provenanceSchema = z
  .object({
    sourceId: z.string().min(1),
    /** Which instance contributed it. Absent for knowledge with no single origin. */
    contributedByInstanceId: identifierSchema.optional(),
    /** How many instances have corroborated it. */
    corroborations: z.number().int().nonnegative().default(0),
    establishedAt: z.string().min(1),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

export const cacheStatusSchema = z.enum(["hit", "miss", "stale", "bypassed", "unavailable"]);
export type CacheStatus = z.infer<typeof cacheStatusSchema>;

export const knowledgeResponseSchema = z
  .object({
    data: z.unknown(),
    /**
     * What was ACTUALLY served, which may be narrower than what was asked for.
     *
     * A request for canonical knowledge answered from a tenant's own store is
     * a different answer, and a caller that could not tell would treat one
     * shop's practice as an industry fact.
     */
    effectiveScope: knowledgeScopeSchema,
    /** At least one. Knowledge with no source is a rumour. */
    provenance: z.array(provenanceSchema).min(1),
    /** The collective version this reflects. Cache entries carry it too. */
    version: z.string().min(1),
    confidence: z.enum(["low", "moderate", "high"]),
    /** The Governance decision that permitted this read. */
    policyDecisionId: identifierSchema,
    cacheStatus: cacheStatusSchema,
    /** When this answer stops being usable. */
    expiresAt: z.string().min(1),
  })
  .strict();
export type KnowledgeResponse = z.infer<typeof knowledgeResponseSchema>;

/**
 * A learning an instance offers to the collective.
 *
 * `privacyAttestation` is REQUIRED and is a claim the submitter makes on the
 * record. It does not replace the gateway's own check — a submitter attesting
 * that something is clean does not make it clean — but an unattested
 * submission is one nobody has taken responsibility for, and the attestation
 * is what makes a later violation attributable rather than anonymous.
 */
export const candidateKnowledgeSchema = z
  .object({
    candidateId: identifierSchema,
    sourceInstanceId: identifierSchema,
    sourceEngineId: identifierSchema,
    domain: z.string().min(1),
    /** The claim, already generalized. Not the observations behind it. */
    generalizedClaim: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).min(1),
    proposedScope: knowledgeScopeSchema,
    confidence: z.enum(["low", "moderate", "high"]),
    privacyAttestation: z
      .object({
        attestedBy: identifierSchema,
        /** What the submitter claims they removed. */
        statement: z.string().min(1),
        attestedAt: z.string().min(1),
      })
      .strict(),
    sensitivity: dataClassificationSchema.default("internal"),
    submittedAt: z.string().min(1),
  })
  .strict()
  .refine((c) => c.proposedScope !== "tenant-private", {
    message:
      "A candidate proposed as tenant-private is not a contribution to the collective — it is that tenant's own record, and submitting it here is the transfer the ownership model exists to prevent.",
    path: ["proposedScope"],
  });
export type CandidateKnowledge = z.infer<typeof candidateKnowledgeSchema>;

export const promotionClassificationSchema = z.enum([
  /** Low-risk, corroborated, no policy concerns. Commits a new version. */
  "auto_promotable",
  /** Goes to a governed approval package. */
  "review_required",
  /** Cannot be promoted at all. */
  "prohibited",
]);
export type PromotionClassification = z.infer<typeof promotionClassificationSchema>;

/**
 * Whether a local cache entry is an authority.
 *
 * Always false. An instance that could answer from its own store while
 * disagreeing with the collective has forked shared knowledge, and nobody
 * finds out until two instances make different decisions from the same
 * question.
 */
export function cacheIsAuthoritative(): false {
  return false;
}

/**
 * Whether an engine may query the collective directly.
 *
 * Always false. One door. A second path would be one the scope, freshness and
 * provenance checks do not stand in front of — and it would be added for a
 * good reason, by somebody in a hurry, on a Friday.
 */
export function engineMayQueryCollectiveDirectly(): false {
  return false;
}
