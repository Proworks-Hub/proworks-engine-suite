// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE, AND WHOSE JURISDICTION IT IS.
//
// A Hive instance sits behind somebody else's website, API, device fleet or
// partner system. That host has its own security — a WAF, an IAM, an EDR, a
// SIEM — owned by them, running on their infrastructure, under their legal
// responsibility.
//
// The temptation at this boundary is obvious and wrong: the Hive can see
// suspicious traffic, the host has a WAF, so let the Hive block. That would
// make an autonomous system take enforcement action inside an organization's
// infrastructure on its own reading of the evidence, and the first false
// positive is somebody's storefront going down because a machine decided.
//
// So `ExternalSecurityGrant` is a statement by the HOST of exactly what the
// Hive may observe and do. Absent one, the Shield observes only what is
// inherently visible at its own boundary and takes no external action at all —
// and "absent" is the default, not a configuration.
//
// A GRANT CANNOT EXPAND CONSTITUTIONAL AUTHORITY
//
// It is permission to act in somebody else's system, not permission to do
// something the Hive could not otherwise do. A host cannot grant the Hive the
// right to bypass Governance, widen a tenant boundary or self-authorize —
// those are not the host's to give, and `grantPermits` below never consults
// one for anything except an external action.
//
// NOT A SECOND SECURITY ENGINE
//
// The directive is explicit: Shield is an adapter over Security Core, not a
// parallel identity or enforcement stack. Its ladder therefore MAPS onto
// Security Core's containment primitives rather than restating them, and the
// mapping lives at the runtime layer where both are visible. What is defined
// here is only what is genuinely new: the jurisdiction contract, the boundary
// vocabulary, and how two policies compose.
// ─────────────────────────────────────────────────────────────────────────────

/** Where the Hive meets something it does not own. */
export const boundarySchema = z.enum([
  /** A website, API call, connector, session, webhook or upload coming in. */
  "host_to_instance",
  /** A callback, outbound call, notification or automation going out. */
  "instance_to_host",
  /** An Interconnect handoff or event. */
  "instance_to_instance",
  /** A knowledge query, engine update, policy distribution or telemetry. */
  "instance_to_collective",
  /** A threat feed, posture signal or incident context arriving. */
  "external_security_to_hive",
]);
export type Boundary = z.infer<typeof boundarySchema>;

/**
 * The Shield's response ladder, ordered from least to most disruptive.
 *
 * SEVEN rungs, and deliberately not SentinelIQ's twelve. They answer different
 * questions: Sentinel's ladder is what a constitutional observer may DECIDE
 * about a component, and this is what an edge DOES with one request. `warn`
 * and `protected_mode` have no meaning per-request; `challenge` and `throttle`
 * have no meaning as a standing posture.
 *
 * Where they genuinely overlap — quarantine — this does not restate the
 * primitive. It maps onto Security Core's, at the runtime layer.
 */
export const SHIELD_LADDER = [
  /** Record it, raise the risk score, tell Sentinel. Change nothing. */
  "observe",
  /** Demand re-authentication, fresh attestation or a stronger credential. */
  "challenge",
  /** Rate-limit this principal, link or connector. */
  "throttle",
  /** Reject this request. */
  "block",
  /** Disable the connector, link or credential, through Security Core. */
  "quarantine",
  /** Ask the host's own security to act. Requires a grant. */
  "external_assist",
  /** Build an incident package for a person. */
  "escalate",
] as const;
export const shieldResponseSchema = z.enum(SHIELD_LADDER);
export type ShieldResponse = z.infer<typeof shieldResponseSchema>;

/** How disruptive a response is. Lower is gentler. */
export function disruptionOf(response: ShieldResponse): number {
  return SHIELD_LADDER.indexOf(response);
}

/**
 * The stricter of two responses.
 *
 * Host policy and Hive policy are both evaluated and the stricter applicable
 * restriction wins. Written as a function rather than left to call sites,
 * because the alternative is somebody picking the one that lets the request
 * through — and that choice would look reasonable in isolation every time.
 *
 * `escalate` is deliberately the top of the ladder and therefore always wins.
 * Involving a person is the most disruptive thing the Shield can do and also
 * the safest, and a composition that treated it as weaker than `quarantine`
 * would silently prefer machine action over human judgement.
 */
export function stricterOf(a: ShieldResponse, b: ShieldResponse): ShieldResponse {
  return disruptionOf(a) >= disruptionOf(b) ? a : b;
}

/** What a host permits the Hive to observe at its boundary. */
export const externalSignalSchema = z.enum([
  "auth_anomaly",
  "request_rate",
  "payload_deviation",
  "known_bad_indicator",
  "trust_degradation",
  "route_probing",
  "data_volume_anomaly",
  "replay_failure",
  "host_security_alert",
]);
export type ExternalSignal = z.infer<typeof externalSignalSchema>;

/** What a host permits the Hive to DO inside the host's own systems. */
export const externalActionSchema = z.enum([
  "block_ip",
  "revoke_host_session",
  "raise_waf_rule",
  "disable_host_integration",
  "notify_host_operator",
]);
export type ExternalAction = z.infer<typeof externalActionSchema>;

/**
 * The host's statement of jurisdiction.
 *
 * Every field is the host's to set, and `revocationEndpoint` is required: a
 * grant somebody cannot withdraw is not a grant, it is a transfer.
 */
export const externalSecurityGrantSchema = z
  .object({
    grantId: identifierSchema,
    hostSystemId: identifierSchema,
    hiveInstanceId: identifierSchema,
    /** What the Hive may observe beyond what its own boundary already shows. */
    allowedSignals: z.array(externalSignalSchema).default([]),
    /** What the Hive may do inside the host's systems. Empty means nothing. */
    allowedActions: z.array(externalActionSchema).default([]),
    /** Which of the host's resources are in scope. Empty means none. */
    resourceScopes: z.array(z.string().min(1)).default([]),
    purpose: z.string().min(1),
    securityProviderRefs: z.array(z.string().min(1)).default([]),
    /** Who at the HOST issued it. Not a Hive identity. */
    issuedBy: z.string().min(1),
    approvedAt: z.string().min(1),
    expiresAt: z.string().min(1).optional(),
    /** REQUIRED. A grant that cannot be withdrawn is a transfer. */
    revocationEndpoint: z.string().min(1),
    policyVersion: z.string().min(1),
    auditDestination: z.string().min(1),
    revokedAt: z.string().min(1).optional(),
    revocationReason: z.string().min(1).optional(),
  })
  .strict()
  .refine((g) => !g.revokedAt || Boolean(g.revocationReason), {
    message: "A revoked grant must say why, so a withdrawal can be told from an expiry.",
    path: ["revocationReason"],
  });
export type ExternalSecurityGrant = z.infer<typeof externalSecurityGrantSchema>;

export interface GrantVerdict {
  readonly permitted: boolean;
  readonly reason: string;
}

/**
 * Whether a grant permits one external action on one resource, right now.
 *
 * DENY BY DEFAULT, and the absence of a grant is not a case this function
 * handles — a caller with no grant has nothing to pass, which is the point.
 * Revocation is checked before expiry so a withdrawn grant says it was
 * withdrawn rather than that it lapsed.
 */
export function grantPermits(input: {
  grant: ExternalSecurityGrant;
  action: ExternalAction;
  resource: string;
  hiveInstanceId: string;
  now: string;
}): GrantVerdict {
  const { grant } = input;
  const at = Date.parse(input.now);

  if (grant.hiveInstanceId !== input.hiveInstanceId) {
    return {
      permitted: false,
      reason: `This grant was issued to ${grant.hiveInstanceId} and the caller is ${input.hiveInstanceId}. A host's permission to one instance is not permission to another.`,
    };
  }
  if (grant.revokedAt) {
    return { permitted: false, reason: `Grant ${grant.grantId} was revoked: ${grant.revocationReason}` };
  }
  if (Number.isNaN(at)) {
    return { permitted: false, reason: "The evaluation time is unparseable, so validity cannot be established." };
  }
  if (grant.expiresAt && at >= Date.parse(grant.expiresAt)) {
    return { permitted: false, reason: `Grant ${grant.grantId} expired at ${grant.expiresAt}.` };
  }
  if (!grant.allowedActions.includes(input.action)) {
    return {
      permitted: false,
      reason: `Grant ${grant.grantId} does not permit ${input.action}. A host authorizes specific actions, not a category of helpfulness.`,
    };
  }
  if (!grant.resourceScopes.includes(input.resource)) {
    return {
      permitted: false,
      reason: `Grant ${grant.grantId} does not cover ${input.resource}.`,
    };
  }
  return { permitted: true, reason: `Grant ${grant.grantId} permits ${input.action} on ${input.resource}.` };
}

/**
 * The metadata two instances exchange before a sensitive transfer.
 *
 * There is no payload field, and that is the guarantee. A handshake carrying
 * tenant data would be a transfer happening before the checks that decide
 * whether a transfer may happen.
 */
export const securityHandshakeSchema = z
  .object({
    instanceId: identifierSchema,
    /** Whether this instance's own credentials are healthy. */
    certificateHealth: z.enum(["healthy", "expiring", "expired", "revoked"]),
    cryptoProfileVersion: z.string().min(1),
    attestationState: z.enum(["attested", "not_required", "failed", "unknown"]),
    policyVersion: z.string().min(1),
    linkStatus: z.enum(["active", "suspended", "revoked", "expired"]),
    /** Whether this instance's own Sentinel and Security Core are answering. */
    sentinelHealth: z.enum(["healthy", "degraded", "unavailable"]),
    securityCoreHealth: z.enum(["healthy", "degraded", "unavailable"]),
  })
  .strict();
export type SecurityHandshake = z.infer<typeof securityHandshakeSchema>;

/**
 * Whether a host's grant can widen what the Hive is constitutionally allowed.
 *
 * Always false. A grant is permission to act inside somebody else's system,
 * never permission to do something the Hive could not otherwise do. A host
 * cannot authorize bypassing Governance or widening a tenant boundary —
 * those are not theirs to give.
 */
export function grantExpandsConstitutionalAuthority(): false {
  return false;
}

/**
 * Whether the Shield may act inside a host system without a grant.
 *
 * Always false. Absent a grant it observes what is inherently visible at its
 * own boundary and does nothing outward — and absent is the default rather
 * than a configuration somebody has to remember to choose.
 */
export function shieldActsWithoutGrant(): false {
  return false;
}
