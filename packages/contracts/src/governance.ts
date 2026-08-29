// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Governance seam.
//
// Constitution §1.9: "Capability does not imply permission."
//
// That is the doctrine line this file exists to make enforceable. Until now the
// coordinator resolved a capability and invoked it — so being able to reach an
// endpoint was the same thing as being allowed to use it. The approved
// Governance Reference Book states the rule the code was missing:
//
//   "Every Hive component must distinguish capability from authority. A
//    component may be technically capable of an action but still lack
//    constitutional permission to perform it."
//
// This is deliberately the SMALLEST contract that ends that ambiguity. It is a
// seam, not a policy engine. Policy administration, RBAC/ABAC, override UX and
// PolicyIQ all live behind it and none of them is built here.
//
// WHAT MAKES A DECISION A DECISION
//
// A caller's claims are evidence. A Governance decision is authority. The two
// are different types on purpose, so no call site can pass one where the other
// is required.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What Governance may answer.
 *
 * SEVEN outcomes, taken from the approved Governance Reference Book §5:
 * "permitted, permitted with conditions, requires additional authority,
 * requires human approval, requires constitutional deliberation, denied, or
 * prohibited."
 *
 * The two that are easiest to lose, and most important to keep:
 *
 *   DENIED vs PROHIBITED. Denied is a policy answer — the same request might be
 *   permitted tomorrow, under a different policy or a broader grant. Prohibited
 *   is constitutional: no policy, grant or override can make it permitted,
 *   because a Core Protection forbids it. Collapsing them would let somebody
 *   respond to a prohibition by widening a policy.
 *
 * V1 evaluators may return a narrow subset. The CONTRACT carries all seven so
 * that adding an evaluator which uses them is not a breaking change.
 */
export const governanceDecisionKindSchema = z.enum([
  "PERMITTED",
  "PERMITTED_WITH_CONDITIONS",
  "REQUIRES_ADDITIONAL_AUTHORITY",
  "REQUIRES_HUMAN_APPROVAL",
  "REQUIRES_CONSTITUTIONAL_DELIBERATION",
  "DENIED",
  "PROHIBITED",
]);
export type GovernanceDecisionKind = z.infer<typeof governanceDecisionKindSchema>;

/**
 * How consequential the requested action is.
 *
 * Present because the Constitution ties required controls to consequence rather
 * than applying one ceremony to everything (§1.6: humans "shall not be required
 * to approve actions merely for the appearance of human involvement").
 */
export const riskClassSchema = z.enum(["routine", "elevated", "high", "critical"]);
export type RiskClass = z.infer<typeof riskClassSchema>;

/**
 * Claims a caller asserts about itself.
 *
 * EVIDENCE, NOT AUTHORITY. Named so misuse reads wrongly: nothing called
 * `asserted` should look like a decision. Governance may consider these; it is
 * never bound by them.
 */
export const assertedClaimsSchema = z
  .object({
    /** Coarse roles the boundary resolved. */
    roles: z.array(z.string()).default([]),
    /** What the caller claims it may do. Considered, never trusted. */
    assertedCapabilities: z.array(z.string()).default([]),
    /** Where the claims came from, e.g. a token issuer. */
    issuer: z.string().min(1).optional(),
    expiresAt: z.string().optional(),
  })
  .strict();
export type AssertedClaims = z.infer<typeof assertedClaimsSchema>;

/**
 * The question put to Governance.
 *
 * Carries the fields the approved reference book names: actor, tenant, purpose,
 * requested action, target, context, and the caller's claims — kept in their
 * own field so they cannot be mistaken for an authorization.
 */
export const authorityEnvelopeSchema = z
  .object({
    requestId: z.string().min(1),
    /** Who is asking. Never taken from a request body. */
    actorId: z.string().min(1),
    tenant: tenantContextSchema,
    /**
     * Why. Purpose-bound authority is a constitutional requirement (§1.7):
     * access for one purpose does not authorize another.
     */
    purpose: z.string().min(1),
    /** The capability or action requested. */
    requestedAction: z.string().min(1),
    /** What it acts on, when the action names a specific object. */
    targetResource: z.string().min(1).optional(),
    /** On whose behalf, when acting as a delegate. */
    actingOnBehalfOf: z.string().min(1).optional(),
    /** Each hop that led here. An empty chain means the actor asked directly. */
    delegationChain: z.array(z.string()).default([]),
    riskClass: riskClassSchema.default("routine"),
    claims: assertedClaimsSchema.optional(),
    trace: traceContextSchema.optional(),
    issuedAt: z.string().min(1),
    /** When this request's authority basis stops being believable. */
    expiresAt: z.string().optional(),
  })
  .strict();
export type AuthorityEnvelope = z.infer<typeof authorityEnvelopeSchema>;

/**
 * Governance's answer.
 *
 * `reason` is required on every outcome including PERMITTED. A decision nobody
 * can explain is one nobody can audit, and the audit record is the only thing
 * that makes an authorization reviewable after the fact.
 */
export const governanceDecisionSchema = z
  .object({
    decision: governanceDecisionKindSchema,
    reason: z.string().min(1),
    /** Which policy decided. Lets a decision be traced to its rule. */
    policyId: z.string().min(1).optional(),
    policyVersion: z.string().min(1).optional(),
    constitutionVersion: z.string().min(1).optional(),
    /** Required when PERMITTED_WITH_CONDITIONS. */
    conditions: z.array(z.string()).default([]),
    /** A durable handle for the audit trail. */
    decisionId: z.string().min(1).optional(),
    decidedAt: z.string().min(1),
  })
  .strict()
  .refine((d) => d.decision !== "PERMITTED_WITH_CONDITIONS" || d.conditions.length > 0, {
    message:
      "PERMITTED_WITH_CONDITIONS must state its conditions. A conditional permission with no conditions is an unconditional one wearing a safer label.",
    path: ["conditions"],
  });
export type GovernanceDecision = z.infer<typeof governanceDecisionSchema>;

/**
 * True only for the two outcomes that permit execution now.
 *
 * A function rather than a comparison at each call site, so nobody has to
 * remember which of seven outcomes are permissive. Everything that is not
 * explicitly permissive is refused — including outcomes that mean "not yet",
 * which are the ones most likely to be mistaken for success.
 */
export function isPermitted(decision: GovernanceDecision): boolean {
  return (
    decision.decision === "PERMITTED" || decision.decision === "PERMITTED_WITH_CONDITIONS"
  );
}

/**
 * True when no policy change could make this permitted.
 *
 * Distinguishes a Core Protection from an ordinary denial, so a caller does not
 * respond to a prohibition by requesting a broader grant.
 */
export function isConstitutionallyProhibited(decision: GovernanceDecision): boolean {
  return decision.decision === "PROHIBITED";
}

/**
 * The port every host binds.
 *
 * One method. Governance answers whether an action may happen; it does not
 * execute, own domain state, or reason — the reference book's boundary, kept in
 * the shape of the interface.
 */
export interface Governance {
  authorize(envelope: AuthorityEnvelope): Promise<GovernanceDecision>;
}

/**
 * Governance that denies everything, with a stated reason.
 *
 * The default when nothing is configured. Unconfigured must mean "nobody gets
 * in" — the same rule `hiveIdentity.ts` already applies to Hive access, and the
 * opposite of the `if (!permSvc) return` pattern that let eight services
 * authorize nothing while appearing to.
 */
export function createDenyAllGovernance(reason?: string): Governance {
  const message =
    reason ??
    "No Governance is configured, so no authority can be established. Unconfigured means nobody is authorized, never everybody.";
  return {
    async authorize() {
      return {
        decision: "DENIED" as const,
        reason: message,
        conditions: [],
        decidedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * Governance that permits everything. **Tests and local development only.**
 *
 * Same discipline as the permissive authorizer in hub-server, for the same
 * reason: permissiveness must be a value somebody constructs on purpose, with a
 * written reason, never a state the system falls into. It refuses to exist
 * where it must never run.
 *
 * The environment check is a REFUSAL, not a selector. Nothing chooses this
 * because an environment looks like development — a caller chooses it, and this
 * only stops that choice somewhere catastrophic.
 */
export function createAllowAllGovernanceForTests(options: {
  reason: string;
  /**
   * The environment to check against. REQUIRED, and deliberately not defaulted
   * to `process.env`: `contracts` is a pure package and the portability guard
   * forbids ambient I/O in it. It caught this exact line. Requiring the caller
   * to pass its environment is also the more honest shape — a pure contract
   * should not know what an environment is.
   */
  env: Record<string, string | undefined>;
}): Governance {
  const env = options.env;
  if (env["NODE_ENV"] === "production") {
    throw new Error(
      "Refusing to construct allow-all Governance in production. It authorizes every action and exists only for tests.",
    );
  }
  if (!options.reason?.trim()) {
    throw new Error(
      "Allow-all Governance requires a written reason. If the reason cannot be stated, it should not be used.",
    );
  }
  const reason = `Allow-all Governance (tests only): ${options.reason.trim()}`;
  return {
    async authorize() {
      return {
        decision: "PERMITTED" as const,
        reason,
        conditions: [],
        decidedAt: new Date().toISOString(),
      };
    },
  };
}
