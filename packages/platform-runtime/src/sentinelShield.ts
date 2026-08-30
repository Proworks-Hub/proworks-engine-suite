// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  externalSecurityGrantSchema,
  grantPermits,
  securityHandshakeSchema,
  stricterOf,
  type Boundary,
  type ExternalAction,
  type ExternalSecurityGrant,
  type SecurityHandshake,
  type ShieldResponse,
} from "@proworks-hub/contracts";

import type { ContainmentPrimitive, SecurityCore } from "./securityCore.js";

// ─────────────────────────────────────────────────────────────────────────────
// SENTINEL SHIELD — an adapter at the edge, not a second security engine.
//
// The directive is explicit about that and it is the main design pressure in
// this file. Everything the Shield can actually DO, it does through Security
// Core: credentials are revoked there, quarantine happens there, trust is
// assessed there. What the Shield adds is the boundary — where a request
// entered, whose jurisdiction it is in, and which of two policies is stricter.
//
// So there is no key material here, no credential store, no second trust
// model, and the quarantine rung maps onto `ContainmentPrimitive` rather than
// restating it. If this file grew any of those it would have become the
// parallel stack it exists not to be.
//
// THE MAPPING IS DELIBERATELY PARTIAL
//
// Five of the seven rungs are local and mechanical. `external_assist` requires
// the host's grant and reaches a system the Hive does not own. `escalate`
// builds a package for a person and takes no action at all — it is the top of
// the ladder because involving a human is the most disruptive thing available
// and also the safest, and a composition treating it as weaker than quarantine
// would silently prefer machine action over judgement.
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundaryObservation {
  readonly boundary: Boundary;
  /** Who or what is on the other side. A reference, never a principal object. */
  readonly subjectId: string;
  /** Which resource of the host's, when the boundary is a host's. */
  readonly resource?: string;
  /** What the detector saw. */
  readonly signals: readonly {
    readonly signal: string;
    /** 0..1. How far from normal. */
    readonly severity: number;
    readonly evidenceRef: string;
  }[];
  readonly observedAt: string;
}

export interface ShieldDecision {
  readonly response: ShieldResponse;
  /** Why, in words an operator can act on. */
  readonly reason: string;
  /** Which policy produced it: the Hive's, the host's, or the stricter of both. */
  readonly source: "hive" | "host" | "stricter_of_both";
  /** What was actually done, if anything. */
  readonly applied: {
    readonly containment?: ContainmentPrimitive;
    readonly externalAction?: ExternalAction;
    readonly escalated?: boolean;
  };
  /** The authority the action was taken under. Null when nothing was done. */
  readonly authorityRef: string | null;
}

/**
 * A host's own security system, reached through an adapter.
 *
 * One interface, no vendor. A WAF, an EDR and an IAM all answer the same
 * question here — "perform this action on this resource" — and the Shield does
 * not know which it is talking to, which is what stops a vendor's model
 * leaking into the boundary logic.
 */
export interface ExternalSecurityProvider {
  readonly providerId: string;
  perform(input: {
    action: ExternalAction;
    resource: string;
    reason: string;
  }): { performed: boolean; reason: string };
}

export interface ShieldPolicy {
  /** The Hive's own view of what this observation warrants. */
  hiveResponse(observation: BoundaryObservation): { response: ShieldResponse; reason: string };
  /**
   * The host's view, when the host has one.
   *
   * Absent means the host has expressed no opinion — which is not the same as
   * the host saying "allow", and is why this returns `null` rather than the
   * gentlest rung.
   */
  hostResponse?(observation: BoundaryObservation): { response: ShieldResponse; reason: string } | null;
}

export interface SentinelShield {
  /** Evaluates one crossing and applies the response. */
  evaluate(observation: BoundaryObservation): ShieldDecision;

  /** Records a host's grant. */
  acceptGrant(input: unknown): { accepted: true; grant: ExternalSecurityGrant } | { accepted: false; reason: string };

  /** Withdraws one. External actions stop immediately. */
  revokeGrant(grantId: string, reason: string): { revoked: boolean; reason: string };

  /**
   * The metadata this instance offers a peer before a sensitive transfer.
   *
   * Built here rather than accepted from a caller, so there is no path by
   * which a payload gets attached to it.
   */
  handshake(): SecurityHandshake;

  /** Whether a peer's handshake is acceptable under policy. */
  acceptPeer(peer: unknown, requireAttestation: boolean): { accepted: boolean; reason: string };

  /**
   * Performs an external action under a grant this shield holds.
   *
   * Takes a grant ID and looks it up, rather than taking a grant object. A
   * caller that could pass the grant would be a caller holding a copy, and a
   * copy taken before a revocation still says "active" — which would make
   * revocation effective only for callers who happened to re-read it.
   *
   * A mutation found this: `acceptGrant` and `revokeGrant` were writing to a
   * map nothing read, which is the declared-and-never-read defect this
   * codebase keeps finding, here in its own new code.
   */
  performExternal(input: {
    grantId: string;
    action: ExternalAction;
    resource: string;
    reason: string;
  }): { performed: boolean; reason: string };

  /** Every decision, with actor, rule, evidence, action and authority. */
  audit(): readonly ShieldAuditEntry[];

  /** Whether grants and the audit trail survive a restart. */
  durability(): "in-memory" | "durable";
}

export interface ShieldAuditEntry {
  readonly boundary: Boundary;
  readonly subjectId: string;
  readonly response: ShieldResponse;
  readonly reason: string;
  readonly source: ShieldDecision["source"];
  readonly evidenceRefs: readonly string[];
  readonly authorityRef: string | null;
  readonly at: string;
}

/**
 * Where grants and the audit trail live.
 *
 * The durability guard's fourth catch, and the same hole for the fourth time:
 * a revoked GRANT returning after a restart, exactly as a revoked link and a
 * revoked credential would have. A host that withdrew the Hive's permission to
 * touch their WAF must not find it restored because a process came back up.
 *
 * The audit trail matters for the other reason this whole file exists: a
 * security response nobody can explain afterwards is indistinguishable from
 * one nobody authorized.
 */
export interface ShieldStore {
  readonly durability: "in-memory" | "durable";
  grant(grantId: string): ExternalSecurityGrant | null;
  putGrant(grant: ExternalSecurityGrant): void;
  appendAudit(entry: ShieldAuditEntry): void;
  audit(): readonly ShieldAuditEntry[];
}

export function createInMemoryShieldStore(): ShieldStore {
  const heldGrants = new Map<string, ExternalSecurityGrant>();
  const entries: ShieldAuditEntry[] = [];
  return {
    durability: "in-memory",
    grant: (id) => heldGrants.get(id) ?? null,
    putGrant: (g) => {
      heldGrants.set(g.grantId, g);
    },
    appendAudit: (e) => {
      entries.push(e);
    },
    audit: () => entries,
  };
}

export interface SentinelShieldOptions {
  readonly instanceId: string;
  /** Everything the Shield can do, it does through this. */
  readonly securityCore: SecurityCore;
  readonly policy: ShieldPolicy;
  readonly providers?: readonly ExternalSecurityProvider[];
  /** Where grants and the audit trail live. Defaults to in-memory. */
  readonly store?: ShieldStore;
  readonly now?: () => Date;
  /** Where an escalation goes. The Shield builds the package; a person decides. */
  readonly onEscalation?: (entry: ShieldAuditEntry) => void;
}

/** Which containment primitive a quarantine at this boundary means. */
function containmentFor(boundary: Boundary): ContainmentPrimitive {
  switch (boundary) {
    case "instance_to_instance":
      return "isolate_integration";
    case "instance_to_collective":
      return "restrict_data_movement";
    case "host_to_instance":
    case "instance_to_host":
    case "external_security_to_hive":
      return "revoke_access";
  }
}

export function createSentinelShield(options: SentinelShieldOptions): SentinelShield {
  const now = options.now ?? (() => new Date());
  const held = options.store ?? createInMemoryShieldStore();

  const record = (entry: ShieldAuditEntry): void => {
    held.appendAudit(entry);
    if (entry.response === "escalate") options.onEscalation?.(entry);
  };

  return {
    evaluate(observation) {
      const hive = options.policy.hiveResponse(observation);
      const host = options.policy.hostResponse?.(observation) ?? null;

      // The stricter applicable restriction wins. Left to call sites, somebody
      // eventually picks the one that lets the request through, and that
      // choice looks reasonable in isolation every time.
      const response = host ? stricterOf(hive.response, host.response) : hive.response;
      const source: ShieldDecision["source"] = !host
        ? "hive"
        : hive.response === host.response
          ? "stricter_of_both"
          : response === host.response
            ? "host"
            : "hive";
      const reason = host ? `${hive.reason} | host: ${host.reason}` : hive.reason;

      const evidenceRefs = observation.signals.map((s) => s.evidenceRef);
      const applied: {
        containment?: ContainmentPrimitive;
        externalAction?: ExternalAction;
        escalated?: boolean;
      } = {};
      let authorityRef: string | null = null;

      if (response === "quarantine") {
        // Through Security Core, which requires a named authorizer. The Shield
        // is not the authority here; it is the thing that noticed.
        const primitive = containmentFor(observation.boundary);
        const applyResult = options.securityCore.contain({
          primitive,
          subjectId: observation.subjectId,
          reason,
          authorizedBy: "sentinel-shield",
          authorizationRef: `shield:${observation.boundary}:${observation.observedAt}`,
        });
        if (applyResult.applied) {
          applied.containment = primitive;
          authorityRef = `shield:${observation.boundary}:${observation.observedAt}`;
        }
      }

      if (response === "escalate") {
        // No action taken. A package for a person, which is the point.
        applied.escalated = true;
      }

      const entry: ShieldAuditEntry = {
        boundary: observation.boundary,
        subjectId: observation.subjectId,
        response,
        reason,
        source,
        evidenceRefs,
        authorityRef,
        at: now().toISOString(),
      };
      record(entry);

      return { response, reason, source, applied, authorityRef };
    },

    acceptGrant(input) {
      const parsed = externalSecurityGrantSchema.safeParse(input);
      if (!parsed.success) {
        return { accepted: false, reason: `Not a valid grant: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (parsed.data.hiveInstanceId !== options.instanceId) {
        return {
          accepted: false,
          reason: `This grant was issued to ${parsed.data.hiveInstanceId} and this instance is ${options.instanceId}.`,
        };
      }
      held.putGrant(parsed.data);
      return { accepted: true, grant: parsed.data };
    },

    revokeGrant(grantId, reason) {
      const grant = held.grant(grantId);
      if (!grant) return { revoked: false, reason: `No grant ${grantId}.` };
      if (grant.revokedAt) return { revoked: false, reason: "Already revoked." };
      held.putGrant({
        ...grant,
        revokedAt: now().toISOString(),
        revocationReason: reason,
      });
      // Effective immediately: the next external action consults this map, so
      // there is no window in which a withdrawn grant still authorizes.
      return { revoked: true, reason: "Revoked; further external actions stop immediately." };
    },

    handshake() {
      // Built here, never accepted from a caller. There is no path by which a
      // payload gets attached to it, because nothing is copied into it.
      const contained = options.securityCore.contained();
      return securityHandshakeSchema.parse({
        instanceId: options.instanceId,
        certificateHealth: "healthy",
        cryptoProfileVersion: "crypto.v1",
        attestationState: "not_required",
        policyVersion: "shield.v1",
        linkStatus: "active",
        sentinelHealth: contained.length > 0 ? "degraded" : "healthy",
        securityCoreHealth: "healthy",
      });
    },

    acceptPeer(peer, requireAttestation) {
      const parsed = securityHandshakeSchema.safeParse(peer);
      if (!parsed.success) {
        return { accepted: false, reason: `Not a valid handshake: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const p = parsed.data;

      if (p.linkStatus !== "active") {
        return { accepted: false, reason: `The peer reports its link is ${p.linkStatus}.` };
      }
      if (p.certificateHealth === "expired" || p.certificateHealth === "revoked") {
        return { accepted: false, reason: `The peer's certificate is ${p.certificateHealth}.` };
      }
      if (p.securityCoreHealth === "unavailable") {
        // A peer whose security core is down cannot enforce its own side of
        // the boundary, so accepting from it is accepting from nothing.
        return { accepted: false, reason: "The peer's security core is unavailable." };
      }
      if (requireAttestation && p.attestationState !== "attested") {
        return {
          accepted: false,
          reason: `Policy requires attestation and the peer reports "${p.attestationState}".`,
        };
      }
      return { accepted: true, reason: "Peer metadata is acceptable." };
    },

    performExternal({ grantId, action, resource, reason }) {
      const grant = held.grant(grantId);
      const provider =
        options.providers?.find((p) => grant?.securityProviderRefs.includes(p.providerId)) ?? null;

      return performExternalAction({
        grant,
        provider,
        action,
        resource,
        hiveInstanceId: options.instanceId,
        reason,
        now: now().toISOString(),
      });
    },

    audit: () => [...held.audit()],
    durability: () => held.durability,
  };
}

/**
 * Performs an external action, if and only if a grant permits it.
 *
 * Separate from `evaluate` on purpose. Reaching into somebody else's
 * infrastructure is not a rung the Shield climbs on its own reading of a
 * signal — it is a distinct call with a distinct authorization, and keeping it
 * out of the response path means no observation can lead there by accident.
 */
export function performExternalAction(input: {
  grant: ExternalSecurityGrant | null;
  provider: ExternalSecurityProvider | null;
  action: ExternalAction;
  resource: string;
  hiveInstanceId: string;
  reason: string;
  now: string;
}): { performed: boolean; reason: string } {
  if (!input.grant) {
    return {
      performed: false,
      reason:
        "No external security grant. Absent one the Shield observes what is inherently visible at its own boundary and does nothing outward — and absent is the default, not a setting.",
    };
  }
  const verdict = grantPermits({
    grant: input.grant,
    action: input.action,
    resource: input.resource,
    hiveInstanceId: input.hiveInstanceId,
    now: input.now,
  });
  if (!verdict.permitted) return { performed: false, reason: verdict.reason };

  if (!input.provider) {
    return { performed: false, reason: "No adapter is bound for this provider." };
  }
  return input.provider.perform({
    action: input.action,
    resource: input.resource,
    reason: input.reason,
  });
}

/**
 * Whether the Shield holds identity or key material of its own.
 *
 * Always false. Everything it can do, it does through Security Core: there is
 * no credential store here, no second trust model, and the quarantine rung
 * maps onto an existing primitive rather than restating it. A Shield that grew
 * any of those would be the parallel stack it exists not to be.
 */
export function shieldIsASecondSecurityEngine(): false {
  return false;
}
