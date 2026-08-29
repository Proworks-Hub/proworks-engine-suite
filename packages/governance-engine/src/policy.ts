// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { governanceDecisionKindSchema, riskClassSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Policy: the rules Governance evaluates.
//
// Charter §7 — purpose-bound authority: "Governance shall support authorization
// that includes actor, action, resource, purpose, context, scope, duration,
// conditions, and applicable policy. Permission shall not be broader than its
// legitimate purpose."
//
// So a grant names all of those, and every field it omits is a field it does
// not widen. A grant with no `purposes` matches any purpose — which is why the
// grant schema requires the author to write `purposes: ["*"]` explicitly rather
// than leaving it out. Breadth should be visible in the rule, not inferred from
// its absence.
//
// WHAT THIS IS NOT. Not PolicyIQ. Charter §8: "Governance owns constitutional
// decision authority. PolicyIQ provides reusable policy-evaluation machinery."
// This is the smallest evaluator that can express the grants the Hive needs
// today; PolicyIQ replaces the machinery later without changing who decides.
// ─────────────────────────────────────────────────────────────────────────────

/** Matches anything. Written explicitly so breadth is never accidental. */
export const ANY = "*" as const;

const matcherSchema = z.array(z.string().min(1)).min(1);

/**
 * One authorization rule.
 *
 * Every dimension is REQUIRED, including the ones a permissive grant sets to
 * `["*"]`. Optional dimensions default to "any", and a default that widens is
 * how a narrow rule silently becomes a broad one.
 */
export const policyGrantSchema = z
  .object({
    grantId: z.string().min(1),
    /** Why this grant exists. Required — an unexplained grant cannot be reviewed. */
    reason: z.string().min(1),
    /** Subjects this applies to, or `["*"]`. */
    actors: matcherSchema,
    /** Capabilities or actions, or `["*"]`. */
    actions: matcherSchema,
    /** Tenants, or `["*"]`. */
    tenants: matcherSchema,
    /**
     * Purposes, or `["*"]`.
     *
     * Charter §7 and Constitution §1.7: access for one purpose does not
     * authorize another. A grant that names its purposes is narrower than one
     * that does not, and this schema makes the author say which they meant.
     */
    purposes: matcherSchema,
    /** Highest risk class this grant covers. */
    maxRiskClass: riskClassSchema.default("routine"),
    /** What the caller must satisfy. Produces PERMITTED_WITH_CONDITIONS. */
    conditions: z.array(z.string().min(1)).default([]),
    /** When the grant starts and stops being believable. */
    notBefore: z.string().optional(),
    expiresAt: z.string().optional(),
    /**
     * Charter §14: temporary authority "shall not silently become permanent."
     * A grant with an expiry must say why it is temporary.
     */
    temporaryReason: z.string().min(1).optional(),
  })
  .strict()
  .refine((g) => !g.expiresAt || Boolean(g.temporaryReason), {
    message:
      "A grant with an expiry must state why it is temporary. Charter §14: temporary authority shall not silently become permanent, and an unexplained expiry is renewed rather than reviewed.",
    path: ["temporaryReason"],
  });
export type PolicyGrant = z.infer<typeof policyGrantSchema>;

/**
 * An action no grant may permit.
 *
 * Constitutional Core Protections. These produce PROHIBITED, which is different
 * from DENIED: no policy change, broader grant, or override can lift one.
 * Checked BEFORE grants, so a prohibition cannot be out-voted by a permissive
 * rule that happens to match.
 */
export const coreProtectionSchema = z
  .object({
    protectionId: z.string().min(1),
    /** What it forbids. */
    actions: matcherSchema,
    /** The constitutional basis. A prohibition without one is just a denial. */
    constitutionalBasis: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type CoreProtection = z.infer<typeof coreProtectionSchema>;

export const policySetSchema = z
  .object({
    policyId: z.string().min(1),
    version: z.string().min(1),
    constitutionVersion: z.string().min(1).optional(),
    protections: z.array(coreProtectionSchema).default([]),
    grants: z.array(policyGrantSchema).default([]),
  })
  .strict();
export type PolicySet = z.infer<typeof policySetSchema>;

/** Exact match, or the explicit wildcard. No prefixes, no patterns. */
export function matches(values: readonly string[], candidate: string): boolean {
  // Deliberately not a regex or a prefix match. `steven*` matching `steven2`
  // is the kind of near-miss that reads as correct in review and grants an
  // actor nobody meant to grant.
  return values.includes(ANY) || values.includes(candidate);
}

/**
 * Core Protections the Hive holds regardless of configuration.
 *
 * Taken from the Pre-Runtime Decision Record §5's enumeration of what no
 * override may authorize. They are here rather than in configuration because a
 * protection that can be configured away is not a protection.
 */
export const CONSTITUTIONAL_CORE_PROTECTIONS: readonly CoreProtection[] = Object.freeze([
  {
    protectionId: "protection.self-authority-expansion",
    actions: ["governance.expand_own_authority", "governance.self_grant"],
    constitutionalBasis: "Decision Record §5 — self-issued authority; Constitution §1.9",
    reason:
      "No component may use authorization to increase its own authority. Capability does not imply permission, and neither does already holding some.",
  },
  {
    protectionId: "protection.silent-amendment",
    actions: ["constitution.amend_silently", "constitution.replace"],
    constitutionalBasis: "Decision Record §5 — silent constitutional amendment",
    reason:
      "The Constitution changes only through the amendment process. An override authorizes an exception; it does not redefine the rule.",
  },
  {
    protectionId: "protection.audit-destruction",
    actions: ["audit.destroy_evidence", "audit.suppress"],
    constitutionalBasis: "Decision Record §5 — destruction of constitutional evidence",
    reason:
      "Constitutional and audit evidence may not be erased to conceal activity. Evidence that can be deleted by the thing it records is not evidence.",
  },
  {
    protectionId: "protection.sentinel-neutralization",
    actions: ["sentinel.disable_permanently", "sentinel.suppress_findings"],
    constitutionalBasis: "Decision Record §5 — permanent Sentinel neutralization; Charter §9",
    reason:
      "A specific Sentinel enforcement action may be overridden where constitutionally permitted. Sentinel itself may not be secretly and permanently disabled.",
  },
  {
    protectionId: "protection.authority-provenance",
    actions: ["audit.falsify_authority", "governance.forge_decision"],
    constitutionalBasis: "Decision Record §5 — falsification of authority provenance",
    reason:
      "The Hive may not claim an action had ordinary authorization when it proceeded under override. A false provenance is worse than none.",
  },
]);
