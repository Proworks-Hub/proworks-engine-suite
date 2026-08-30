// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * File:    packages/governance-engine/src/interoperability.ts
 * Module:  governance-engine
 * Purpose: The ten interoperability decisions, so nothing downstream has to guess.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// EVERY INFERENCE THE FABRIC MAKES ABOUT PERMISSION IS A DECISION NOBODY TOOK
//
// The addendum's framing is the right one: add explicit decision types "so
// Fabric never has to infer permission." That sentence describes a failure
// mode rather than a feature request. When there is no decision type for
// "this adapter may enter production", the code that needs the answer does not
// stop — it finds a proxy. The adapter is signed, so it is probably fine. The
// mapping passed its tests, so it is probably approved. The route exists, so
// somebody must have wanted it. Each proxy is defensible in isolation and the
// aggregate is a system where authority is an emergent property of plumbing.
//
// So there are ten decision types here, named for what they permit, and each
// carries scope, expiry, evidence and a revocation path. The four rules at the
// bottom of the addendum are encoded as functions rather than prose, because a
// rule that only exists in a document is one that gets rediscovered during an
// incident.
//
// WHAT THIS FILE IS NOT
//
// It is not an approval engine. Nothing here decides anything: these are the
// SHAPES a decision takes, plus the checks that say whether a given decision
// actually covers a given request. A human (or a quorum, per the constitution's
// bootstrap rules) produces the record; this module refuses to over-read it.
// ─────────────────────────────────────────────────────────────────────────────

export const interoperabilityDecisionTypeSchema = z.enum([
  /** A may talk to B on a lane, inside one instance. */
  "ApproveTopologyRelation",
  /** Two instances may hold a governed relationship at all. */
  "ApproveCrossInstanceRelationship",
  /** A specific adapter version may enter a production path. */
  "ApproveExternalAdapterAdmission",
  /** An already-admitted adapter may claim more than it did. */
  "ApproveAdapterCapabilityExpansion",
  /** A semantic mapping may be applied to live traffic. */
  "ApproveSemanticMappingContract",
  /** A weaker protocol may be used, narrowly and temporarily. */
  "ApproveProtocolDowngradeException",
  /** An experimental plugin may run, sandboxed. */
  "ApproveExperimentalPluginSandbox",
  /** A risky provider may be rolled out, in stages. */
  "ApproveHighRiskProviderRollout",
  /** A research source may be consulted under a policy. */
  "ApproveResearchSourcePolicy",
  /** A generalized lesson may be promoted to other instances. */
  "ApprovePromotionOfGeneralizedIntegrationLesson",
]);
export type InteroperabilityDecisionType = z.infer<typeof interoperabilityDecisionTypeSchema>;

export const decisionScopeSchema = z
  .object({
    /** Instances this covers, or ["*"] for every instance in the collective. */
    instanceIds: z.array(z.string().min(1)).min(1),
    /** Tenants this covers, or ["*"]. */
    tenantIds: z.array(z.string().min(1)).min(1),
    /**
     * Data classifications the decision reaches.
     *
     * Explicit because a decision taken about internal traffic is routinely
     * reused for personal data by whoever finds it next, and the reuse looks
     * like consistency rather than a widening.
     */
    classifications: z.array(z.enum(["PUBLIC", "INTERNAL", "TENANT_PRIVATE", "PERSONAL", "RESTRICTED"])).min(1),
    /** Lanes, capabilities or protocols this reaches. Never ["*"] by default. */
    subjects: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DecisionScope = z.infer<typeof decisionScopeSchema>;

export const interoperabilityDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    type: interoperabilityDecisionTypeSchema,

    /** What is being permitted, identified precisely. */
    targetId: z.string().min(1),
    /**
     * The exact version this covers.
     *
     * Required and not nullable. An approval of v1 that silently covers v2 is
     * the single most useful thing an attacker could obtain, because the
     * update path looks like maintenance to everyone watching.
     */
    targetVersion: z.string().min(1),

    /** Who decided. A named actor, never a service account. */
    decidedBy: z.array(z.string().min(1)).min(1),
    /** Signatures over the decision, when the deployment requires them. */
    signatures: z.array(z.string().min(1)),

    scope: decisionScopeSchema,
    /** Capabilities this grants. Closed list; ["*"] is refused below. */
    allowedCapabilities: z.array(z.string().min(1)).min(1).max(64),
    /** Conditions the requester must satisfy. Produces a conditional permit. */
    conditions: z.array(z.string().min(1)).max(32),

    effectiveFrom: z.string().min(1),
    /** Every decision expires. See the refinement. */
    expiresAt: z.string().min(1),

    /** Evidence considered: certification runs, simulations, Sentinel findings. */
    evidenceRefs: z.array(z.string().min(1)).max(64),
    /** Why. Required — an unexplained approval cannot be reviewed or renewed. */
    rationale: z.string().min(1),

    /** How to undo it, in operational terms. */
    rollbackPlan: z.string().min(1),
    revoked: z.boolean(),
    revokedReason: z.string().min(1).nullable(),

    /** Where the durable record lives. */
    auditRef: z.string().min(1),
  })
  .strict()
  .refine((d) => d.effectiveFrom < d.expiresAt, {
    message: "A decision must expire after it begins.",
    path: ["expiresAt"],
  })
  .refine((d) => !d.allowedCapabilities.includes("*"), {
    message:
      "An interoperability decision may not grant every capability. '*' is not a scope, it is the absence of one, and it turns a specific approval into a standing permission nobody will re-read.",
    path: ["allowedCapabilities"],
  })
  .refine((d) => !d.revoked || d.revokedReason !== null, {
    message: "A revoked decision must say why, or the revocation cannot be reviewed and will be reversed by whoever finds it next.",
    path: ["revokedReason"],
  })
  .refine(
    (d) => !d.scope.classifications.includes("RESTRICTED") || d.evidenceRefs.length > 0,
    {
      message:
        "A decision reaching RESTRICTED data must cite the evidence it considered. Approving the most sensitive class on nothing recorded is the decision most likely to be regretted and least likely to be reconstructable.",
      path: ["evidenceRefs"],
    },
  );
export type InteroperabilityDecision = z.infer<typeof interoperabilityDecisionSchema>;

export interface CoverageRequest {
  readonly type: InteroperabilityDecisionType;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly classification: DecisionScope["classifications"][number];
  readonly subject: string;
  readonly capability: string;
  readonly now: string;
}

export type CoverageVerdict =
  | { readonly covered: true; readonly conditions: readonly string[]; readonly reason: string }
  | { readonly covered: false; readonly reason: string };

const matches = (values: readonly string[], candidate: string): boolean =>
  values.includes("*") || values.includes(candidate);

/**
 * Whether a decision actually covers a request.
 *
 * Deliberately literal. Every mismatch is a refusal with the specific reason,
 * and there is no "close enough" branch — the whole value of an explicit
 * decision type is lost the moment something interprets one generously on
 * somebody's behalf.
 */
export function decisionCovers(decision: InteroperabilityDecision, request: CoverageRequest): CoverageVerdict {
  if (decision.revoked) {
    return { covered: false, reason: `Decision ${decision.decisionId} was revoked: ${decision.revokedReason}` };
  }
  if (decision.type !== request.type) {
    return {
      covered: false,
      reason: `Decision ${decision.decisionId} is a ${decision.type} and this request needs a ${request.type}. Approving one kind of thing is not approving another, however adjacent they feel.`,
    };
  }
  if (decision.targetId !== request.targetId) {
    return { covered: false, reason: `Decision ${decision.decisionId} covers ${decision.targetId}, not ${request.targetId}.` };
  }
  if (decision.targetVersion !== request.targetVersion) {
    return {
      covered: false,
      reason: `Decision ${decision.decisionId} covers version ${decision.targetVersion} and this is ${request.targetVersion}. Version-specific approval is what makes the update path a permission question rather than a deployment detail.`,
    };
  }
  if (request.now < decision.effectiveFrom) {
    return { covered: false, reason: `Decision ${decision.decisionId} is not effective until ${decision.effectiveFrom}.` };
  }
  if (request.now >= decision.expiresAt) {
    return {
      covered: false,
      reason: `Decision ${decision.decisionId} expired at ${decision.expiresAt}. An expired approval is not a weaker approval; renewal is where somebody asks whether this is still a good idea.`,
    };
  }
  if (!matches(decision.scope.instanceIds, request.instanceId)) {
    return { covered: false, reason: `Decision ${decision.decisionId} does not reach instance ${request.instanceId}.` };
  }
  if (!matches(decision.scope.tenantIds, request.tenantId)) {
    return { covered: false, reason: `Decision ${decision.decisionId} does not reach tenant ${request.tenantId}.` };
  }
  if (!decision.scope.classifications.includes(request.classification)) {
    return {
      covered: false,
      reason: `Decision ${decision.decisionId} covers ${decision.scope.classifications.join(", ")} and this request carries ${request.classification}. A decision taken about one class of data is routinely reused for a more sensitive one, and the reuse looks like consistency.`,
    };
  }
  if (!matches(decision.scope.subjects, request.subject)) {
    return { covered: false, reason: `Decision ${decision.decisionId} does not cover subject ${request.subject}.` };
  }
  if (!decision.allowedCapabilities.includes(request.capability)) {
    return {
      covered: false,
      reason: `Decision ${decision.decisionId} allows ${decision.allowedCapabilities.join(", ")} and this request needs ${request.capability}.`,
    };
  }
  return {
    covered: true,
    conditions: decision.conditions,
    reason:
      decision.conditions.length === 0
        ? `Covered by ${decision.decisionId} until ${decision.expiresAt}.`
        : `Covered by ${decision.decisionId} until ${decision.expiresAt}, subject to ${decision.conditions.length} condition(s) the caller must satisfy.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The addendum's four rules, as functions rather than prose.
// ─────────────────────────────────────────────────────────────────────────────

/** Finding a capability is not being allowed to use it. */
export function discoveryIsAuthorization(): false {
  return false;
}

/** Passing the certification suite is not admission to production. */
export function certificationIsProductionAdmission(): false {
  return false;
}

/** A mapping that works is not a mapping you may run on this data. */
export function technicallyValidMappingGrantsDataAccess(): false {
  return false;
}

/**
 * Degraded mode never widens policy.
 *
 * The tempting failure is the opposite: during an outage, relax a check to
 * keep things moving. That converts every outage into a privilege escalation
 * window, and an attacker who can cause an outage can then cause the
 * escalation.
 */
export function degradedModeMayWidenPolicy(): false {
  return false;
}
