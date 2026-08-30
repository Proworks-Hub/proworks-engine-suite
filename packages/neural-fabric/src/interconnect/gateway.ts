/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interconnect/gateway.ts
 * Module:   neural-fabric / interconnect
 * Purpose:  The one door between instances, and everything it checks before opening.
 */

import { z } from "zod";

import {
  classificationPermitsExport,
  fabricEnvelopeSchema,
  type FabricEnvelope,
} from "../domain/envelope.js";
import type { InstanceIdentityPort, SecurityVerdict } from "../ports/securityPorts.js";

// ─────────────────────────────────────────────────────────────────────────────
// CROSS-INSTANCE TRUST IS EXPLICIT, NON-TRANSITIVE, AND CHECKED AT BOTH ENDS
//
// §17 and §33.6: cross-instance routes terminate at explicit governed
// Interconnect boundaries, and the Fabric never traverses another instance's
// private store. This module is that boundary — the EGRESS side checks before
// anything leaves, the INGRESS side re-checks everything on arrival, and
// neither trusts the other's checking.
//
// Both ends check the same things, deliberately. It looks redundant and is
// not: the egress check protects THIS instance's data from leaving without a
// grant; the ingress check protects the receiving instance from a compromised
// or buggy sender. A gateway that trusted the far side's egress checking
// would make every instance's security equal to its least careful peer's.
//
// NON-TRANSITIVE MEANS THE GRANT NAMES BOTH ENDS
//
// A grant is from one instance to one instance for one capability set. If A
// may reach B and B may reach C, nothing follows about A and C — and the
// mechanical enforcement is that the ingress check matches the VERIFIED origin
// instance against the grant, not the claimed one. A message relayed through
// B still carries A's provenance, verifies as B (the presenter), and fails
// the match: B's identity, A's origin, no grant covering that pair.
//
// AND THE GATEWAY MINIMIZES
//
// §17: cross-instance envelopes are minimized to the authorized purpose. What
// leaves is a REBUILT envelope carrying only what the far side needs —
// participant ids and internal zone names stay home. The topology of this
// instance is not the far side's business, even a trusted far side.
// ─────────────────────────────────────────────────────────────────────────────

export const interconnectGrantSchema = z
  .object({
    grantId: z.string().min(1),
    fromInstanceId: z.string().min(1),
    toInstanceId: z.string().min(1),
    /** The capabilities this grant permits addressing. Closed list. */
    capabilities: z.array(z.string().min(1)).min(1).max(100),
    /** The lanes it permits. A grant for events is not a grant for commands. */
    lanes: z.array(z.enum(["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"])).min(1),
    /** The Governance decision behind it. Grants do not self-exist. */
    authorizingDecisionRef: z.string().min(1),
    notAfter: z.string().min(1),
    revoked: z.boolean(),
  })
  .strict();
export type InterconnectGrant = z.infer<typeof interconnectGrantSchema>;

export type GatewayVerdict =
  | { readonly passed: true; readonly minimized: FabricEnvelope; readonly grantId: string; readonly note: string }
  | {
      readonly passed: false;
      readonly stage:
        | "ENVELOPE"
        | "IDENTITY"
        | "GRANT"
        | "GRANT_EXPIRED"
        | "GRANT_REVOKED"
        | "LANE"
        | "CAPABILITY"
        | "CLASSIFICATION"
        | "TENANT"
        | "REPLAY"
        | "TRANSIT";
      readonly reason: string;
    };

export interface GatewayConfig {
  /** The instance this gateway belongs to. */
  readonly localInstanceId: string;
  readonly grants: readonly InterconnectGrant[];
  readonly instanceIdentity: InstanceIdentityPort;
  /** Message ids already seen at this gateway, for replay refusal. */
  readonly seenMessageIds: ReadonlySet<string>;
  /** Tenants this instance recognises. Ingress-side check. */
  readonly knownTenants: ReadonlySet<string>;
}

/**
 * EGRESS: whether a signal may leave this instance.
 *
 * Runs on the sending side, before any transport is touched. The order puts
 * classification first — whether the DATA may leave is a property of the data,
 * and no grant overrides it.
 */
export function egressCheck(
  raw: unknown,
  config: GatewayConfig,
  targetInstanceId: string,
  now: string,
): GatewayVerdict {
  const parsed = fabricEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { passed: false, stage: "ENVELOPE", reason: "Not a valid Fabric envelope. Nothing malformed crosses an instance boundary — the far side would have to guess what it meant, and a gateway that forwards guesses is not a boundary." };
  }
  const envelope = parsed.data;

  const exportable = classificationPermitsExport(envelope.classification);
  if (!exportable.permitted) {
    return {
      passed: false,
      stage: "CLASSIFICATION",
      reason: `${exportable.note} No grant overrides this: whether the data may leave is a property of the data.`,
    };
  }

  const grant = findGrant(config.grants, config.localInstanceId, targetInstanceId);
  if (grant === null) {
    return {
      passed: false,
      stage: "GRANT",
      reason: `No grant permits ${config.localInstanceId} to reach ${targetInstanceId}. Cross-instance trust is explicit — a route existing, a peer being known, or a grant existing in the OTHER direction creates nothing in this one.`,
    };
  }
  const grantCheck = checkGrant(grant, envelope, now);
  if (grantCheck !== null) return grantCheck;

  return {
    passed: true,
    grantId: grant.grantId,
    minimized: minimize(envelope),
    note: `Egress permitted under ${grant.grantId} (${grant.authorizingDecisionRef}). The envelope was minimized: participant ids and zone detail stay home — this instance's topology is not the far side's business, even a trusted far side.`,
  };
}

/**
 * INGRESS: whether an arriving signal may enter this instance.
 *
 * Re-checks everything, trusting nothing about the far side's egress. The
 * identity check verifies the PRESENTING instance cryptographically through
 * Security IQ's port, then matches the envelope's claimed origin against it —
 * which is the non-transitivity enforcement: a signal relayed through a
 * middleman verifies as the middleman and fails the match.
 */
export async function ingressCheck(
  raw: unknown,
  config: GatewayConfig,
  presentedInstanceIdentityRef: string,
  now: string,
): Promise<GatewayVerdict> {
  const parsed = fabricEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { passed: false, stage: "ENVELOPE", reason: "Not a valid Fabric envelope." };
  }
  const envelope = parsed.data;

  let identity: SecurityVerdict<{ readonly instanceId: string; readonly trustDomain: string }>;
  try {
    identity = await config.instanceIdentity.verify({ presentedIdentityRef: presentedInstanceIdentityRef, now });
  } catch {
    identity = { outcome: "UNAVAILABLE", reason: "The instance identity verifier threw." };
  }

  if (identity.outcome !== "VERIFIED") {
    return {
      passed: false,
      stage: "IDENTITY",
      reason:
        identity.outcome === "UNAVAILABLE"
          ? `The presenting instance could not be verified: ${identity.reason} Failed closed — an unverifiable peer is not a slightly-trusted peer.`
          : `The presenting instance was refused: ${identity.reason}`,
    };
  }
  if (now >= identity.validUntil) {
    return { passed: false, stage: "IDENTITY", reason: `The instance identity verification expired at ${identity.validUntil}.` };
  }

  const verifiedInstance = identity.detail.instanceId;

  // NON-TRANSITIVITY. The envelope claims an origin; the transport verified a
  // presenter. They must be the same instance, or this is a relay — B
  // presenting A's traffic — and no grant covers that pair by construction.
  if (envelope.provenance.originInstanceId !== verifiedInstance) {
    return {
      passed: false,
      stage: "TRANSIT",
      reason: `The envelope claims origin "${envelope.provenance.originInstanceId}" and the transport verified "${verifiedInstance}". This is a relay — trust is non-transitive, and a signal that travelled A→B→here needs A's own grant to here, which would have made A the presenter.`,
    };
  }

  const grant = findGrant(config.grants, verifiedInstance, config.localInstanceId);
  if (grant === null) {
    return {
      passed: false,
      stage: "GRANT",
      reason: `No grant permits ${verifiedInstance} to reach ${config.localInstanceId}. The far side may believe one exists; this side's grant table is the one that binds this side's door.`,
    };
  }
  const grantCheck = checkGrant(grant, envelope, now);
  if (grantCheck !== null) return grantCheck;

  if (!config.knownTenants.has(envelope.tenantId)) {
    return {
      passed: false,
      stage: "TENANT",
      reason: `Tenant "${envelope.tenantId}" is not known to this instance. A signal for a tenant that does not exist here is misaddressed at best, and at worst is probing which tenants do.`,
    };
  }

  if (config.seenMessageIds.has(envelope.fabricMessageId)) {
    return {
      passed: false,
      stage: "REPLAY",
      reason: `Message "${envelope.fabricMessageId}" has already crossed this gateway. A replayed gateway message is refused at the door rather than left for the consumer's idempotency to absorb — idempotency is the last defence, not the first.`,
    };
  }

  return {
    passed: true,
    grantId: grant.grantId,
    minimized: minimize(envelope),
    note: `Ingress permitted from ${verifiedInstance} under ${grant.grantId}. Everything was re-checked on this side: a gateway that trusted the far side's egress checking would make this instance's security equal to its least careful peer's.`,
  };
}

function findGrant(
  grants: readonly InterconnectGrant[],
  from: string,
  to: string,
): InterconnectGrant | null {
  // Directional, exact. A→B says nothing about B→A.
  return grants.find((g) => g.fromInstanceId === from && g.toInstanceId === to) ?? null;
}

function checkGrant(grant: InterconnectGrant, envelope: FabricEnvelope, now: string): GatewayVerdict | null {
  if (grant.revoked) {
    return {
      passed: false,
      stage: "GRANT_REVOKED",
      reason: `Grant ${grant.grantId} is revoked. A revoked grant refusing traffic is the revocation working; the inconvenience is the point.`,
    };
  }
  if (now >= grant.notAfter) {
    return {
      passed: false,
      stage: "GRANT_EXPIRED",
      reason: `Grant ${grant.grantId} expired at ${grant.notAfter}. A stale grant is refused, not honoured with a warning — the expiry was set when somebody still remembered why.`,
    };
  }
  if (!grant.lanes.includes(envelope.lane)) {
    return {
      passed: false,
      stage: "LANE",
      reason: `Grant ${grant.grantId} permits ${grant.lanes.join(", ")} and this signal is on ${envelope.lane}. A grant for events is not a grant for commands.`,
    };
  }
  if (!grant.capabilities.includes(envelope.destination.capability)) {
    return {
      passed: false,
      stage: "CAPABILITY",
      reason: `Grant ${grant.grantId} does not cover "${envelope.destination.capability}". The capability list is closed; reaching anything else needs a governed change to the grant.`,
    };
  }
  return null;
}

/**
 * Strips what the far side has no business seeing.
 *
 * Participant ids name specific workloads on specific hosts; zone paths
 * describe internal topology; transformation history describes internal
 * processing. All stay home. What crosses is the capability being addressed
 * and the provenance facts the far side genuinely needs — origin instance,
 * principal kind, and model provenance where an AI originated it, because
 * §34.3's labelling requirement does not stop at the boundary.
 */
export function minimize(envelope: FabricEnvelope): FabricEnvelope {
  return fabricEnvelopeSchema.parse({
    ...envelope,
    source: { capability: envelope.source.capability },
    destination: { capability: envelope.destination.capability },
    provenance: {
      originComponent: envelope.provenance.originComponent,
      originInstanceId: envelope.provenance.originInstanceId,
      principalKind: envelope.provenance.principalKind,
      ...(envelope.provenance.modelProvenance ? { modelProvenance: envelope.provenance.modelProvenance } : {}),
      transformations: [],
    },
  });
}

/** Whether one grant can ever imply another. Never — trust is non-transitive. */
export function grantsCompose(): false {
  return false;
}
