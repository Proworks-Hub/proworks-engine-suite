// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { identifierSchema } from "./identifiers.js";
import { tenantContextSchema } from "./tenancy.js";

// ─────────────────────────────────────────────────────────────────────────────
// WHO is acting.
//
// Every later decision in the Hive depends on this being trustworthy, which is
// why it comes before event durability, ledgers, telemetry and knowledge: a
// tamper-evident audit record of an unidentified actor records nothing, and a
// tenant boundary enforced against an unverified tenant is decoration.
//
// WHAT THIS IS NOT
//
// Not a second Governance. `Governance.authorize(envelope) -> decision` already
// answers "may this happen", and building a parallel answer here would be the
// duplication the architecture forbids — two systems that can disagree about
// permission, with no rule for which wins.
//
// This answers the question BEFORE that one: who is asking, from which
// instance, under what trust state, holding which grants. Governance consumes
// that. A `PermissionGrant` below is EVIDENCE, in exactly the sense DEC-017
// established for `assertedCapabilities` — the rename that happened because a
// field called `permissions` will eventually be treated as one.
//
// NOT THE SAME "CAPABILITY" AS `capabilities.ts`
//
// That file models PRODUCT TIERS: `workorder.basic` unlocks into
// `workorder.routing` unlocks into `workorder.scheduling`. It describes what a
// customer's subscription includes.
//
// This models AUTHORIZATION: which principal may perform which action on which
// resource. The two were deliberately kept apart and deliberately not given the
// same word, because merged, an upgraded subscription would widen security
// authority — which is precisely the collapse §1.9 forbids.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five principal kinds, plus `system`.
 *
 * A closed set, and a discriminated union below rather than one shape with
 * optional fields — an engine principal missing its version, or an agent
 * missing its mission, should fail to parse rather than exist half-formed and
 * be discovered later by whatever dereferenced the missing half.
 *
 * `system` is separate from `service` on purpose: the Hive acting on its own
 * schedule is not a shop's application calling in, and collapsing them would
 * make an internal sweep indistinguishable from an external caller in an audit
 * record.
 */
export const principalKindSchema = z.enum([
  "hive-instance",
  "engine",
  "human",
  "agent",
  "connector",
  "system",
]);
export type PrincipalKind = z.infer<typeof principalKindSchema>;

/**
 * How trusted a principal currently is.
 *
 * Ordered from most to least, and `unknown` is NOT the same as `trusted` — the
 * same doctrine the health vocabulary needed adding to it this week. A
 * principal nobody has assessed is not one that passed assessment.
 */
export const trustStateSchema = z.enum([
  "trusted",
  /** Something is off. Still permitted; recorded and watched. */
  "watched",
  /** Permitted only for a reduced set. Policy tightens automatically. */
  "restricted",
  /** Not permitted at all. Terminal until re-established. */
  "revoked",
  /** Nobody has assessed this. Never a synonym for trusted. */
  "unknown",
]);
export type TrustState = z.infer<typeof trustStateSchema>;

/** Only these two states may perform consequential work. */
export function trustPermitsWork(state: TrustState): boolean {
  // An allowlist, so a state added later is refused by default rather than by
  // somebody remembering to add it to a denylist.
  return state === "trusted" || state === "watched";
}

/**
 * Where a principal is running.
 *
 * REQUIRED on every principal. The Hive is many isolated instances of one
 * architecture, so "same code" must never imply "same data" — and an identity
 * that cannot say which instance it belongs to cannot be checked against that
 * boundary at all.
 */
export const instanceIdentitySchema = z
  .object({
    /** Globally unique across every Hive instance, not merely within one. */
    globalInstanceId: identifierSchema,
    /** The provisioning record that anchors it. Absent while provisional. */
    trustAnchorId: identifierSchema.optional(),
    /**
     * Whether central registration and human verification have completed.
     *
     * Onboarding is not permanent trust — a provisional instance is a real
     * instance that has not finished proving itself, and it must be
     * distinguishable from a verified one at every check.
     */
    provisional: z.boolean().default(true),
  })
  .strict();
export type InstanceIdentity = z.infer<typeof instanceIdentitySchema>;

const base = {
  /**
   * WHO this is, in the vocabulary of its own kind.
   *
   * The directive names a different field per kind — `userId`, `engineId`,
   * `agentId`, `connectorId` — and one field carries all four here on purpose.
   * Two fields holding the same value with nothing making them agree is the
   * defect shape this repository keeps finding, and a principal whose
   * `principalId` and `engineId` had drifted would be two identities in one
   * record with no rule for which one a check should use.
   *
   * Uniqueness is per KIND, not global: an engine and an agent may share a
   * string, which is why every grant match below compares both.
   */
  principalId: identifierSchema,
  instance: instanceIdentitySchema,
  trustState: trustStateSchema.default("unknown"),
  /**
   * 0..1, or null when nobody has scored it.
   *
   * Null rather than 0, because 0 is a score meaning "measured, and bad" and
   * null means "not measured". Defaulting an unscored principal to 0 would
   * restrict it for a reason nobody established; defaulting to 1 would trust
   * it for the same non-reason.
   */
  trustScore: z.number().min(0).max(1).nullable().default(null),
  /** When this identity stops being believable. */
  expiresAt: z.string().min(1).optional(),
};

export const principalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("hive-instance"),
      tenant: tenantContextSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("engine"),
      /** REQUIRED. An engine identity that cannot say which build it is cannot
       * be held to a compatibility or rollback decision. */
      engineVersion: z.string().min(1),
      tenant: tenantContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("human"),
      tenant: tenantContextSchema,
      roles: z.array(z.string().min(1)).default([]),
      /** How strongly they authenticated. Evidence for policy, never a decision. */
      authStrength: z.enum(["password", "mfa", "federated", "hardware"]).default("password"),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("agent"),
      /** REQUIRED. An agent exists for one mission; there is no standing agent. */
      missionId: identifierSchema,
      /** Which engine spawned it, so authority can be traced upward. */
      parentEngineId: identifierSchema,
      tenant: tenantContextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("connector"),
      provider: z.string().min(1),
      tenant: tenantContextSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("system"),
      component: identifierSchema,
    })
    .strict(),
]);
export type Principal = z.infer<typeof principalSchema>;

/**
 * A grant: this principal may perform this action on this resource.
 *
 * EVIDENCE, not authority. Holding a grant is one input to a Governance
 * decision and never a substitute for one — the distinction DEC-017 exists to
 * keep, one layer further in.
 */
export const permissionGrantSchema = z
  .object({
    grantId: identifierSchema,
    /** Who holds it. Matched by id AND kind: ids are only unique within a kind. */
    principalId: identifierSchema,
    principalKind: principalKindSchema,
    /** What it acts on. `*` is a deliberate wildcard, never an accident. */
    resource: z.string().min(1),
    action: z.string().min(1),
    /** Whose data. Absent means the grant is not tenant-scoped, not that it spans tenants. */
    tenantId: z.string().min(1).optional(),
    /** Which instance. Absent means the same. */
    globalInstanceId: identifierSchema.optional(),
    /**
     * Ties this grant to one mission.
     *
     * Elevation. Present, the grant applies ONLY while that mission is the one
     * running — no privilege carries between missions, which is what stops a
     * lease taken for one repair being reused for the next.
     */
    missionId: identifierSchema.optional(),
    expiresAt: z.string().min(1).optional(),
    /** Set when withdrawn. A revoked grant is kept, never deleted. */
    revokedAt: z.string().min(1).optional(),
  })
  .strict();
export type PermissionGrant = z.infer<typeof permissionGrantSchema>;

/** What a principal is asking to do, at the moment of the check. */
export const accessRequestSchema = z
  .object({
    resource: z.string().min(1),
    action: z.string().min(1),
    tenantId: z.string().min(1).optional(),
    globalInstanceId: identifierSchema.optional(),
    /** The mission this runs under, when it runs under one. */
    missionId: identifierSchema.optional(),
    at: z.string().min(1),
  })
  .strict();
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export interface PermissionFinding {
  /** Whether a live, matching, unexpired grant was found. */
  readonly held: boolean;
  /** Why. Populated on both answers — "no" without a reason is unreviewable. */
  readonly reason: string;
  /** Which grant matched. Null whenever `held` is false. */
  readonly grantId: string | null;
}

/**
 * Whether this principal holds a grant for this request.
 *
 * DENY BY DEFAULT, and every refusal below is a separate named branch rather
 * than one catch-all, because "denied" that cannot say which boundary stopped
 * it is a refusal nobody can act on.
 *
 * PURE, and takes the grants as an argument. A principal cannot supply its own
 * — there is no path here by which a caller widens itself, because the widening
 * input is not a parameter it controls. That is the structural version of "no
 * component may widen its own capabilities"; a rule enforced by a check the
 * component calls on itself is a rule it can skip.
 *
 * Returns a FINDING, not a decision. Governance decides.
 */
export function evaluatePermission(input: {
  principal: Principal;
  request: AccessRequest;
  grants: readonly PermissionGrant[];
}): PermissionFinding {
  const { principal, request, grants } = input;
  const now = new Date(request.at).getTime();

  // ── Trust first ──────────────────────────────────────────────────────────
  //
  // Before the grants are even read. A revoked principal holding a valid grant
  // must still be refused, and checking grants first would mean the answer
  // depended on which check happened to run.
  if (!trustPermitsWork(principal.trustState)) {
    return {
      held: false,
      reason: `Principal ${principal.principalId} is ${principal.trustState}, which does not permit consequential work.`,
      grantId: null,
    };
  }

  if (principal.expiresAt && new Date(principal.expiresAt).getTime() <= now) {
    return {
      held: false,
      reason: `Identity for ${principal.principalId} expired at ${principal.expiresAt}. Expired identity is absent identity, not stale identity.`,
      grantId: null,
    };
  }

  const principalTenant =
    "tenant" in principal && principal.tenant ? principal.tenant.organizationId : undefined;

  // ── The tenant boundary ──────────────────────────────────────────────────
  //
  // Checked against the PRINCIPAL's own tenant, not against anything the
  // request supplied about itself. A request naming its own tenant is a
  // request asserting its own authority.
  if (request.tenantId && principalTenant && request.tenantId !== principalTenant) {
    return {
      held: false,
      reason: `Principal belongs to ${principalTenant} and the request is for ${request.tenantId}. Knowing another tenant's identifier is not authority over it.`,
      grantId: null,
    };
  }

  // ── The instance boundary ────────────────────────────────────────────────
  if (
    request.globalInstanceId &&
    request.globalInstanceId !== principal.instance.globalInstanceId
  ) {
    return {
      held: false,
      reason: `Principal is registered to instance ${principal.instance.globalInstanceId} and the request targets ${request.globalInstanceId}. Same architecture is not same instance.`,
      grantId: null,
    };
  }

  for (const grant of grants) {
    if (grant.principalId !== principal.principalId) continue;
    // Ids are unique within a kind, not across kinds, so an engine and an agent
    // could share one. Matching on id alone would let the wrong one through.
    if (grant.principalKind !== principal.kind) continue;

    if (grant.revokedAt && new Date(grant.revokedAt).getTime() <= now) continue;
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now) continue;

    if (grant.resource !== "*" && grant.resource !== request.resource) continue;
    if (grant.action !== "*" && grant.action !== request.action) continue;

    if (grant.tenantId && grant.tenantId !== request.tenantId) continue;
    if (grant.globalInstanceId && grant.globalInstanceId !== request.globalInstanceId) continue;

    // Elevation does not carry between missions. A grant tied to one mission
    // is inert everywhere else, including on a request carrying no mission at
    // all — an unattributed request is not the mission it was granted for.
    if (grant.missionId && grant.missionId !== request.missionId) continue;

    return {
      held: true,
      reason: `Grant ${grant.grantId} covers ${request.action} on ${request.resource}.`,
      grantId: grant.grantId,
    };
  }

  return {
    held: false,
    reason: `No live grant lets ${principal.kind} ${principal.principalId} perform ${request.action} on ${request.resource}.`,
    grantId: null,
  };
}

/**
 * Whether holding a grant authorizes the action.
 *
 * Always false. A grant is evidence that Governance may weigh; Governance
 * decides. The fourteenth of these in the repository, and it guards the exact
 * collapse DEC-017 was raised to prevent — one layer deeper than the field
 * rename, where it would otherwise happen again.
 */
export function grantAuthorizesAction(): false {
  return false;
}

/**
 * Whether a principal may alter its own grants.
 *
 * Always false, and structurally so: `evaluatePermission` takes grants as an
 * argument it does not control. This states the rule the shape already
 * enforces, so a future refactor that gave a principal its own grant store
 * fails a test rather than passing review.
 */
export function principalMayWidenItself(): false {
  return false;
}
