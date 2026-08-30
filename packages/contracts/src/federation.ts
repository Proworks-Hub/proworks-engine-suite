// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";
import { ownershipClassSchema, type OwnershipClass } from "./tenancy.js";

// ─────────────────────────────────────────────────────────────────────────────
// MANY INSTANCES, ONE ARCHITECTURE, AND NO SHARED MEMORY.
//
// The invariant the whole federation rests on, stated in the directive and
// worth repeating because every shortcut below would violate it: SAME CODE
// DOES NOT MEAN SHARED DATA. Promotion is transformation plus authorization,
// never replication.
//
// A SECOND SCOPE VOCABULARY, AND WHY
//
// `ownershipClass` has three values — canonical, host-private, tenant-private
// — and answers who OWNS a record. Distribution needs five, because it answers
// a different question: how far may this travel. USER_OR_ROLE and EPHEMERAL
// have no ownership meaning at all; they are limits on reach.
//
// Two vocabularies for adjacent ideas is exactly the drift this codebase has
// refused elsewhere, so they are not left to diverge: `ownershipOf` is a TOTAL
// mapping from every distribution scope to the ownership class it implies, and
// a test walks the enum to prove no value is unmapped. Adding a scope without
// deciding what it owns fails to compile.
// ─────────────────────────────────────────────────────────────────────────────

export const distributionScopeSchema = z.enum([
  /** One person or role inside one tenant. Never leaves. */
  "USER_OR_ROLE",
  /** One tenant. Never collective by default. */
  "TENANT",
  /** Authorized instances in a named domain. */
  "DOMAIN",
  /** Every compatible instance. */
  "GLOBAL",
  /**
   * Runtime context that must not be promoted or persisted beyond policy.
   *
   * Present so that "this was never meant to last" is sayable. Without it,
   * short-lived context gets stored as TENANT and then lives forever, which is
   * how a scratch value becomes a record.
   */
  "EPHEMERAL",
]);
export type DistributionScope = z.infer<typeof distributionScopeSchema>;

/**
 * What each distribution scope implies about ownership.
 *
 * TOTAL, and typed as a full record so a new scope fails to compile until
 * somebody decides what it owns. The two vocabularies answer different
 * questions and must never disagree about the same knowledge.
 */
const OWNERSHIP_OF: Readonly<Record<DistributionScope, OwnershipClass>> = Object.freeze({
  USER_OR_ROLE: "tenant-private",
  TENANT: "tenant-private",
  // Domain knowledge belongs to nobody in particular — it is shared among
  // instances that qualify, which is canonical knowledge with an eligibility
  // rule rather than a fourth ownership class.
  DOMAIN: "canonical",
  GLOBAL: "canonical",
  // Ephemeral context is one instance's working state.
  EPHEMERAL: "host-private",
});

export function ownershipOf(scope: DistributionScope): OwnershipClass {
  return OWNERSHIP_OF[scope];
}

/** Scopes that may live in the collective at all. */
export function isCollectiveScope(scope: DistributionScope): boolean {
  return scope === "DOMAIN" || scope === "GLOBAL";
}

/**
 * The lookup order.
 *
 * Most specific first: a user's own preference beats their tenant's default,
 * which beats the domain's, which beats the general one. Narrower knowledge
 * is more likely to be right about this particular situation, and the general
 * answer is the fallback rather than the authority.
 */
export const SCOPE_PRECEDENCE: readonly DistributionScope[] = Object.freeze([
  "USER_OR_ROLE",
  "TENANT",
  "DOMAIN",
  "GLOBAL",
]);

/**
 * Whether a requester may see knowledge at this scope.
 *
 * No lookup widens scope beyond the requester's authority — which is why this
 * takes what the requester HAS rather than what they asked for. A caller with
 * no domain binding cannot reach DOMAIN knowledge by naming a domain.
 */
export function scopeVisibleTo(
  scope: DistributionScope,
  requester: { tenantId?: string; domainId?: string; actorId?: string },
): boolean {
  switch (scope) {
    case "GLOBAL":
      return true;
    case "DOMAIN":
      return Boolean(requester.domainId);
    case "TENANT":
      return Boolean(requester.tenantId);
    case "USER_OR_ROLE":
      return Boolean(requester.actorId && requester.tenantId);
    case "EPHEMERAL":
      // Never resolvable through a lookup. It is runtime context, and serving
      // it from a registry would be persisting the thing that was defined by
      // not being persisted.
      return false;
  }
}

export const validationStatusSchema = z.enum([
  "unvalidated",
  "validated",
  "failed",
  /** Withdrawn after publication. Provenance is kept. */
  "revoked",
]);
export type ValidationStatus = z.infer<typeof validationStatusSchema>;

/**
 * A governed knowledge object.
 *
 * The source tenant is deliberately ABSENT from the distributable shape.
 * Provenance is retained by the publisher for audit; what travels carries the
 * instance and not the tenant, because a bundle naming which shop a lesson
 * came from is a bundle that tells every other shop something about them.
 */
export const knowledgeObjectSchema = z
  .object({
    knowledgeId: identifierSchema,
    scope: distributionScopeSchema,
    /** Required when the scope is DOMAIN. Meaningless otherwise. */
    domainId: identifierSchema.optional(),
    /** Which instance contributed it. Never which tenant. */
    sourceInstanceId: identifierSchema,
    semanticVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    contentType: z.string().min(1),
    /** Scan results, recorded rather than assumed. */
    piiStatus: z.enum(["none_detected", "detected", "not_scanned"]),
    restrictedDataFlags: z.array(z.string().min(1)).default([]),
    validationStatus: validationStatusSchema,
    /** The Governance decision that approved publication. */
    governanceApprovalRef: identifierSchema.optional(),
    /** Sentinel's independent verification. */
    sentinelVerificationRef: identifierSchema.optional(),
    /** What this replaces. Superseding keeps the old one queryable. */
    supersedesId: identifierSchema.optional(),
    promotionParentIds: z.array(identifierSchema).default([]),
    checksum: z.string().min(1),
    /** Minimum engine version an instance needs to use this. */
    minEngineVersion: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    approvedAt: z.string().min(1).optional(),
  })
  .strict()
  .refine((k) => k.scope !== "DOMAIN" || Boolean(k.domainId), {
    message:
      "Domain-scoped knowledge must name its domain. Without one it is global knowledge with a label, and it would reach instances the domain restriction exists to exclude.",
    path: ["domainId"],
  })
  .refine((k) => !isCollectiveScope(k.scope) || k.piiStatus !== "not_scanned", {
    message:
      "Knowledge published to the collective must have been scanned. `not_scanned` is an honest state and a disqualifying one — unknown is not the same as clean.",
    path: ["piiStatus"],
  })
  .refine((k) => !isCollectiveScope(k.scope) || k.piiStatus !== "detected", {
    message:
      "Knowledge with detected personal data is not publishable to the collective at any scope, whatever else approved it.",
    path: ["piiStatus"],
  })
  .refine(
    (k) => k.validationStatus !== "validated" || Boolean(k.governanceApprovalRef),
    {
      message:
        "Validated knowledge must reference the Governance decision that approved it. Validation says it works; approval says it may be distributed.",
      path: ["governanceApprovalRef"],
    },
  );
export type KnowledgeObject = z.infer<typeof knowledgeObjectSchema>;

/** How an instance is registered with the control plane. */
export const instanceRegistrationSchema = z
  .object({
    globalInstanceId: identifierSchema,
    /** Tenants this instance serves. One instance may host several. */
    tenantIds: z.array(z.string().min(1)).min(1),
    /** Domains it is authorized for. Empty means general-purpose. */
    domainIds: z.array(identifierSchema).default([]),
    engineVersions: z.record(z.string(), z.string()).default({}),
    /** Which release channel this instance follows. */
    channel: z.enum(["beta", "stable", "lts"]),
    /** Versions pinned by whoever runs it. A pin is a decision, not a hint. */
    pinnedVersions: z.record(z.string(), z.string()).default({}),
    adoptedBundleIds: z.array(identifierSchema).default([]),
    registeredAt: z.string().min(1),
  })
  .strict();
export type InstanceRegistration = z.infer<typeof instanceRegistrationSchema>;

/**
 * Whether tenant-scoped knowledge can become collective by copying it.
 *
 * Always false. Promotion is transformation plus authorization, never
 * replication — and this is the sentence the whole federation rests on.
 */
export function tenantKnowledgePromotesByCopy(): false {
  return false;
}

/**
 * Whether running the same code implies sharing data.
 *
 * Always false. The twentieth of these, and the one the architecture is named
 * after: same code does not mean shared data, shared intelligence does not
 * mean shared memory.
 */
export function sameCodeMeansSharedData(): false {
  return false;
}
