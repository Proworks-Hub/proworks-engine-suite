// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { changeClassSchema } from "./evolution.js";
import { identifierSchema } from "./identifiers.js";

// ─────────────────────────────────────────────────────────────────────────────
// MACHINES MAY PREPARE EVERYTHING. PEOPLE DECIDE THE THINGS THAT MATTER.
//
// The whole design is that split, and it is worth being exact about why it is
// drawn where it is. It is not that machines cannot be trusted to build. They
// can build, test, simulate, gather opinions and assemble a complete case —
// all of it, unattended. What they may not do is be the last signature on a
// change to what they themselves are allowed to do.
//
// So the expensive, slow, careful work is automatable and the decision is not.
// A system that made humans do the preparation would get skipped under
// deadline; one that let machines make the decision would drift, correctly and
// gradually, into a shape nobody chose.
//
// THE GUARDRAIL THAT CARRIES THE MOST WEIGHT
//
// No component may satisfy its own required human approval. Not "should not" —
// the approver is compared against the proposer and against the affected
// engine, and an approval that fails either comparison is refused. Without
// that, an engine proposing an expansion of its own authority and then
// "approving" it under a service identity would be a complete, valid,
// auditable path to unlimited self-grant.
//
// AND THE ONE PEOPLE FORGET
//
// Approval is SCOPED and approval EXPIRES on material change. A human who
// approved version 0.20.0 approved that artifact, not the branch it came from.
// Rebuilding it and shipping the result under the same approval is the quiet
// version of shipping something nobody agreed to.
// ─────────────────────────────────────────────────────────────────────────────

export const proposalStateSchema = z.enum([
  /** Something was noticed. Not yet a proposal. */
  "OBSERVED",
  "PROPOSED",
  /** Classified, scoped, blast radius estimated. */
  "TRIAGED",
  "INVESTIGATING",
  /** Foundry has implemented it somewhere safe. */
  "BUILT_IN_SANDBOX",
  "VALIDATED",
  /** Gathering the opinions the decision needs. */
  "OPINION_ASSEMBLY",
  "AWAITING_HUMAN_AUTHORIZATION",
  "APPROVED",
  "REJECTED",
  /** Handed to the release pipeline. Still not deployed. */
  "RELEASE_PIPELINE",
]);
export type ProposalState = z.infer<typeof proposalStateSchema>;

/** Who or what may put a proposal forward. */
export const proposerKindSchema = z.enum([
  "engine",
  "aria",
  "sentinel",
  "foundry",
  "prime",
  "human",
]);
export type ProposerKind = z.infer<typeof proposerKindSchema>;

export const proposalSchema = z
  .object({
    proposalId: identifierSchema,
    proposerId: identifierSchema,
    proposerKind: proposerKindSchema,
    /** What is wrong. Required — a proposal with no problem is a preference. */
    problem: z.string().min(1),
    proposedOutcome: z.string().min(1),
    changeClass: changeClassSchema,
    affectedDomains: z.array(identifierSchema).default([]),
    /** References to evidence. Never the evidence itself. */
    evidenceRefs: z.array(z.string().min(1)).default([]),
    estimatedValue: z.enum(["low", "moderate", "high"]),
    estimatedRisk: z.enum(["low", "moderate", "high", "severe"]),
    /**
     * The proposal this revises, when it revises one.
     *
     * A rejected proposal may be revised and must not be silently
     * reintroduced. Without this field, resubmitting the same idea under a new
     * id is indistinguishable from a new one — and the reviewer who rejected
     * it last month has no way to know they are reading it again.
     */
    revises: identifierSchema.optional(),
    proposedAt: z.string().min(1),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;

/**
 * One engine's view.
 *
 * ADVISORY. An engine's support does not lift a constitutional prohibition and
 * its objection does not create one — which is why `stance` sits beside
 * Sentinel's separate opinion rather than being averaged with it.
 */
export const engineOpinionSchema = z
  .object({
    engineId: identifierSchema,
    stance: z.enum(["supports", "neutral", "objects", "abstains"]),
    /** How sure. `abstains` with high confidence is a contradiction and is refused. */
    confidence: z.enum(["low", "moderate", "high"]),
    benefits: z.array(z.string().min(1)).default([]),
    risks: z.array(z.string().min(1)).default([]),
    dependencies: z.array(identifierSchema).default([]),
    /** Required when objecting. An objection with no stated reason cannot be answered. */
    objections: z.array(z.string().min(1)).default([]),
    evidenceRefs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((o) => o.stance !== "objects" || o.objections.length > 0, {
    message:
      "An objecting engine must say what it objects to. An objection with no stated reason cannot be answered, which makes it a veto rather than an opinion.",
    path: ["objections"],
  })
  .refine((o) => o.stance !== "abstains" || o.confidence === "low", {
    message:
      "An engine that abstains is saying it does not know. High confidence in not knowing is a contradiction, and it would let an abstention be read as weight.",
    path: ["confidence"],
  });
export type EngineOpinion = z.infer<typeof engineOpinionSchema>;

/**
 * Sentinel's separate opinion.
 *
 * Separate from the engine opinions and never averaged with them, because it
 * answers a different question: not "is this a good idea" but "does this
 * violate something". A `blockReason` is not a strong objection — it stops the
 * proposal.
 */
export const sentinelOpinionSchema = z
  .object({
    safetyFindings: z.array(z.string().min(1)).default([]),
    constitutionalFindings: z.array(z.string().min(1)).default([]),
    /** Controls that must be in place before this may proceed. */
    requiredControls: z.array(z.string().min(1)).default([]),
    /** Present means stop. Not advisory. */
    blockReason: z.string().min(1).optional(),
    assessedAt: z.string().min(1),
  })
  .strict();
export type SentinelOpinion = z.infer<typeof sentinelOpinionSchema>;

/** What Foundry built and what it found. */
export const foundryReportSchema = z
  .object({
    designSummary: z.string().min(1),
    buildArtifactRefs: z.array(z.string().min(1)).default([]),
    testResults: z.array(z.string().min(1)).min(1),
    migrationPlan: z.string().min(1).optional(),
    /** Required. A change with no way back is one whose failure has no remedy. */
    rollbackPlan: z.string().min(1),
    betaPlan: z.string().min(1).optional(),
    /**
     * What Foundry recommends, WITH a reason.
     *
     * A recommendation and not a decision. Foundry may say "ready"; whether it
     * ships is not Foundry's to answer.
     */
    readinessRecommendation: z.enum(["ready", "ready_with_conditions", "not_ready"]),
    recommendationBasis: z.string().min(1),
    /**
     * A digest of exactly what was built.
     *
     * The field that makes a scoped approval enforceable. An approval names
     * this; a later artifact with a different digest is a different thing, and
     * the approval does not reach it.
     */
    artifactDigest: z.string().min(1),
  })
  .strict();
export type FoundryReport = z.infer<typeof foundryReportSchema>;

/**
 * What a person actually authorized.
 *
 * `scopeAuthorized` is required and specific. "Approved" on its own is the
 * failure this field exists to prevent: a year later nobody can tell whether
 * the person agreed to the change, the version, the rollout, or all three.
 */
export const humanDecisionSchema = z
  .object({
    proposalId: identifierSchema,
    approverId: identifierSchema,
    decision: z.enum(["approved", "rejected"]),
    /** Exactly what is authorized: the engine, the version, the change class. */
    scopeAuthorized: z
      .object({
        engineId: identifierSchema,
        version: z.string().min(1),
        changeClass: changeClassSchema,
        /** The digest this approval is bound to. */
        artifactDigest: z.string().min(1),
      })
      .strict(),
    conditions: z.array(z.string().min(1)).default([]),
    /** Required on a rejection so it can be revised rather than re-argued. */
    reason: z.string().min(1),
    decidedAt: z.string().min(1),
  })
  .strict();
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

/**
 * Whether an engine opinion can lift a Sentinel block.
 *
 * Always false. Opinions are advisory; a block is not an opinion. Averaging
 * them would let three supportive engines outvote a constitutional finding,
 * which is a majority overturning a prohibition.
 */
export function opinionsCanOverrideBlock(): false {
  return false;
}

/**
 * Whether a component may satisfy its own required human approval.
 *
 * Always false, and the guardrail carrying the most weight in this file.
 * Without it, an engine proposing an expansion of its own authority and then
 * approving it under a service identity is a complete, valid, auditable path
 * to unlimited self-grant.
 */
export function componentMaySatisfyOwnApproval(): false {
  return false;
}
