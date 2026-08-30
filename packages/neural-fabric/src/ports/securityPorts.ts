/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/ports/securityPorts.ts
 * Module:   neural-fabric / ports
 * Purpose:  What the Fabric asks Security IQ, and what it does when nobody answers.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE FABRIC NEVER CREATES ITS OWN ROOT OF TRUST
//
// Every function of consequence in this file returns a VERDICT that arrived
// from outside — Security IQ, IdentityIQ, Governance — through a port a host
// bound. There is no keypair in this package, no certificate store, no signing
// function. That is not modesty; it is the only arrangement under which
// "Security IQ owns trust roots" is a fact rather than a hope, because a
// package with no crypto in it cannot quietly grow a second authority.
//
// FAIL CLOSED IS A SHAPE, NOT A SETTING
//
// The temptation with security ports is a boolean: `verified: true`. The
// problem is what `false` means — was the identity forged, expired, revoked,
// or did the verifier simply not answer? Those need different responses, and
// a boolean collapses them into one, which in practice becomes "retry until
// true".
//
// So every verdict here is a discriminated union in which UNAVAILABLE is its
// own case, distinct from refusal. And the composition rule is uniform: for a
// protected operation, UNAVAILABLE is treated as refusal — a verifier that
// did not answer has not said yes — while carrying its own reason, so an
// outage reads as an outage in the evidence rather than as an attack.
//
// EVERY VERDICT IS BOUNDED IN TIME
//
// A verification that never expires is a verification that outlives its
// truth: the workload is re-imaged, the certificate rotates, the grant is
// revoked, and the cached "yes" keeps working. Every affirmative verdict
// carries `validUntil`, checked against a supplied `now` — never a clock read,
// so a decision can be replayed and explained after the fact.
// ─────────────────────────────────────────────────────────────────────────────

/** The uniform shape of an answer from a security dependency. */
export type SecurityVerdict<T> =
  | { readonly outcome: "VERIFIED"; readonly detail: T; readonly validUntil: string }
  | { readonly outcome: "REFUSED"; readonly reason: string }
  | { readonly outcome: "UNAVAILABLE"; readonly reason: string };

/** What a verified workload identity asserts. */
export interface WorkloadIdentity {
  /** SPIFFE-style identifier the issuing authority assigned. */
  readonly workloadId: string;
  readonly instanceId: string;
  readonly tenantId: string | null;
  /** The trust domain the identity was issued under. */
  readonly trustDomain: string;
}

export interface InstanceIdentity {
  readonly instanceId: string;
  readonly trustDomain: string;
}

export interface AuthorizationGrant {
  readonly decisionRef: string;
  readonly principalId: string;
  /** What the grant permits, in Governance's vocabulary. */
  readonly scope: string;
  readonly tenantId: string;
}

/** Verifies who a workload is. IdentityIQ / Security IQ answer; Fabric asks. */
export interface WorkloadIdentityPort {
  verify(input: {
    readonly presentedIdentityRef: string;
    readonly expectedInstanceId: string;
    readonly now: string;
  }): Promise<SecurityVerdict<WorkloadIdentity>>;
}

/** Verifies which INSTANCE is speaking, for cross-instance traffic. */
export interface InstanceIdentityPort {
  verify(input: {
    readonly presentedIdentityRef: string;
    readonly now: string;
  }): Promise<SecurityVerdict<InstanceIdentity>>;
}

/** Resolves an authorization evidence reference into a decision. Governance's. */
export interface AuthorizationPort {
  verify(input: {
    readonly evidenceRef: string;
    readonly principalId: string;
    readonly requiredScope: string;
    readonly tenantId: string;
    readonly now: string;
  }): Promise<SecurityVerdict<AuthorizationGrant>>;
}

/** Whether an identity or grant has been revoked since issue. */
export interface RevocationPort {
  check(input: {
    readonly subjectRef: string;
    readonly now: string;
  }): Promise<
    | { readonly outcome: "NOT_REVOKED"; readonly checkedAt: string }
    | { readonly outcome: "REVOKED"; readonly revokedAt: string; readonly reason: string }
    | { readonly outcome: "UNAVAILABLE"; readonly reason: string }
  >;
}

/** Verifies a signature over canonical bytes. Security IQ owns the algorithms. */
export interface IntegrityPort {
  verify(input: {
    readonly canonical: string;
    readonly signature: string;
    readonly signedBy: string;
    readonly algorithmProfile: string;
  }): Promise<SecurityVerdict<{ readonly signedBy: string }>>;
}

/** Validates a certificate / SVID chain. Never implemented in this package. */
export interface CertificateValidationPort {
  validate(input: {
    readonly certificateRef: string;
    readonly expectedTrustDomain: string;
    readonly now: string;
  }): Promise<SecurityVerdict<{ readonly subject: string; readonly notAfter: string }>>;
}

/** The full set a runtime needs. A host binds all of them or accepts refusals. */
export interface SecurityPortSet {
  readonly workloadIdentity: WorkloadIdentityPort;
  readonly authorization: AuthorizationPort;
  readonly revocation: RevocationPort;
  readonly integrity: IntegrityPort;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAIL-CLOSED COMPOSITION
// ─────────────────────────────────────────────────────────────────────────────

export type TrustResolution =
  | {
      readonly trusted: true;
      readonly identity: WorkloadIdentity;
      readonly grant: AuthorizationGrant | null;
      readonly evidence: readonly string[];
    }
  | {
      readonly trusted: false;
      readonly failedAt: "IDENTITY" | "REVOCATION" | "AUTHORIZATION" | "SCOPE";
      readonly reason: string;
      /** True when the failure was an outage rather than a refusal. */
      readonly dependencyOutage: boolean;
      readonly evidence: readonly string[];
    };

/**
 * The one composition every protected operation goes through.
 *
 * Ordered deliberately: identity, then revocation of that identity, then
 * authorization, then scope. Checking authorization before identity would
 * verify that SOMEBODY may do this before establishing who is asking — and
 * the answer to "may somebody" is almost always yes.
 *
 * A thrown port is caught and treated as UNAVAILABLE, which is treated as
 * refusal. A verifier that errored has not said yes, and the worst outage this
 * system could have is the one where it did.
 */
export async function resolveTrust(
  ports: SecurityPortSet,
  input: {
    readonly presentedIdentityRef: string;
    readonly expectedInstanceId: string;
    readonly expectedTenantId: string;
    readonly authorizationEvidenceRef: string | null;
    readonly requiredScope: string | null;
    readonly now: string;
  },
): Promise<TrustResolution> {
  const evidence: string[] = [];

  // ── 1. Identity ──────────────────────────────────────────────────────────
  let identityVerdict: SecurityVerdict<WorkloadIdentity>;
  try {
    identityVerdict = await ports.workloadIdentity.verify({
      presentedIdentityRef: input.presentedIdentityRef,
      expectedInstanceId: input.expectedInstanceId,
      now: input.now,
    });
  } catch {
    identityVerdict = {
      outcome: "UNAVAILABLE",
      reason: "The identity verifier threw. Its message is not quoted — a thrown value from a bound port is untrusted, and this reason lands in evidence.",
    };
  }

  if (identityVerdict.outcome !== "VERIFIED") {
    return {
      trusted: false,
      failedAt: "IDENTITY",
      dependencyOutage: identityVerdict.outcome === "UNAVAILABLE",
      reason:
        identityVerdict.outcome === "UNAVAILABLE"
          ? `Identity could not be verified because the verifier is unavailable: ${identityVerdict.reason} Treated as refusal — a verifier that did not answer has not said yes.`
          : `Identity refused: ${identityVerdict.reason}`,
      evidence,
    };
  }

  if (input.now >= identityVerdict.validUntil) {
    return {
      trusted: false,
      failedAt: "IDENTITY",
      dependencyOutage: false,
      reason: `The identity verification expired at ${identityVerdict.validUntil}. A cached "yes" that outlives its truth keeps working after the workload is re-imaged, which is precisely what the expiry exists to stop.`,
      evidence,
    };
  }

  const identity = identityVerdict.detail;
  evidence.push(`identity:${identity.workloadId}@${identity.trustDomain}`);

  if (identity.instanceId !== input.expectedInstanceId) {
    return {
      trusted: false,
      failedAt: "SCOPE",
      dependencyOutage: false,
      reason: `The identity was issued for instance "${identity.instanceId}" and this signal claims instance "${input.expectedInstanceId}". A valid identity in the wrong scope is not a weaker pass — it is the shape a cross-instance replay takes.`,
      evidence,
    };
  }

  if (identity.tenantId !== null && identity.tenantId !== input.expectedTenantId) {
    return {
      trusted: false,
      failedAt: "SCOPE",
      dependencyOutage: false,
      reason: `The identity is tenant-scoped to "${identity.tenantId}" and the signal is for tenant "${input.expectedTenantId}".`,
      evidence,
    };
  }

  // ── 2. Revocation ────────────────────────────────────────────────────────
  let revocation: Awaited<ReturnType<RevocationPort["check"]>>;
  try {
    revocation = await ports.revocation.check({ subjectRef: identity.workloadId, now: input.now });
  } catch {
    revocation = { outcome: "UNAVAILABLE", reason: "The revocation checker threw." };
  }

  if (revocation.outcome === "REVOKED") {
    return {
      trusted: false,
      failedAt: "REVOCATION",
      dependencyOutage: false,
      reason: `"${identity.workloadId}" was revoked at ${revocation.revokedAt}: ${revocation.reason}. Revocation exists for identities that are otherwise valid, which is why it is a separate check rather than folded into verification.`,
      evidence,
    };
  }
  if (revocation.outcome === "UNAVAILABLE") {
    return {
      trusted: false,
      failedAt: "REVOCATION",
      dependencyOutage: true,
      reason: `Revocation could not be checked: ${revocation.reason} Treated as refusal for a protected operation — "probably not revoked" is exactly the assumption a stolen credential relies on.`,
      evidence,
    };
  }
  evidence.push(`revocation:clear@${revocation.checkedAt}`);

  // ── 3. Authorization, where the operation needs one ──────────────────────
  if (input.requiredScope === null) {
    return { trusted: true, identity, grant: null, evidence };
  }

  if (input.authorizationEvidenceRef === null) {
    return {
      trusted: false,
      failedAt: "AUTHORIZATION",
      dependencyOutage: false,
      reason: `This operation requires the "${input.requiredScope}" scope and the signal carries no authorization evidence reference. There is nothing to verify, and nothing to verify is not a pass.`,
      evidence,
    };
  }

  let authzVerdict: SecurityVerdict<AuthorizationGrant>;
  try {
    authzVerdict = await ports.authorization.verify({
      evidenceRef: input.authorizationEvidenceRef,
      principalId: identity.workloadId,
      requiredScope: input.requiredScope,
      tenantId: input.expectedTenantId,
      now: input.now,
    });
  } catch {
    authzVerdict = { outcome: "UNAVAILABLE", reason: "The authorization verifier threw." };
  }

  if (authzVerdict.outcome !== "VERIFIED") {
    return {
      trusted: false,
      failedAt: "AUTHORIZATION",
      dependencyOutage: authzVerdict.outcome === "UNAVAILABLE",
      reason:
        authzVerdict.outcome === "UNAVAILABLE"
          ? `Authorization could not be verified: ${authzVerdict.reason} Treated as refusal.`
          : `Authorization refused: ${authzVerdict.reason}`,
      evidence,
    };
  }

  if (input.now >= authzVerdict.validUntil) {
    return {
      trusted: false,
      failedAt: "AUTHORIZATION",
      dependencyOutage: false,
      reason: `The authorization was valid until ${authzVerdict.validUntil} and it is now ${input.now}. A stale grant is not a weaker grant; it is what "revoked" looks like from the caller's side.`,
      evidence,
    };
  }

  const grant = authzVerdict.detail;
  if (grant.principalId !== identity.workloadId) {
    return {
      trusted: false,
      failedAt: "AUTHORIZATION",
      dependencyOutage: false,
      reason: `The grant was issued to "${grant.principalId}" and the verified identity is "${identity.workloadId}". A grant is not bearer paper — carrying someone else's authorization reference proves possession of a string, not permission.`,
      evidence,
    };
  }
  if (grant.tenantId !== input.expectedTenantId) {
    return {
      trusted: false,
      failedAt: "SCOPE",
      dependencyOutage: false,
      reason: `The grant is scoped to tenant "${grant.tenantId}" and the signal is for "${input.expectedTenantId}".`,
      evidence,
    };
  }
  if (grant.scope !== input.requiredScope) {
    return {
      trusted: false,
      failedAt: "SCOPE",
      dependencyOutage: false,
      reason: `The grant carries scope "${grant.scope}" and this operation needs "${input.requiredScope}". A grant for something else is a grant for something else.`,
      evidence,
    };
  }

  evidence.push(`authorization:${grant.decisionRef}`);
  return { trusted: true, identity, grant, evidence };
}

/**
 * Whether the Fabric holds any root of trust of its own.
 *
 * Always false, and structurally so: there is no key material, signing
 * function or certificate store anywhere in this package. The function exists
 * so CI asserts what the imports already guarantee.
 */
export function fabricHoldsTrustRoot(): false {
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE VERIFIER — for tests and single-process deployments only
// ─────────────────────────────────────────────────────────────────────────────

export const issuedIdentitySchema = z
  .object({
    identityRef: z.string().min(1),
    workloadId: z.string().min(1),
    instanceId: z.string().min(1),
    tenantId: z.string().min(1).nullable(),
    trustDomain: z.string().min(1),
    notAfter: z.string().min(1),
  })
  .strict();
export type IssuedIdentity = z.infer<typeof issuedIdentitySchema>;

/**
 * A reference implementation backed by records a HOST supplies.
 *
 * This is not a trust root: it verifies presented references against issued
 * records it was HANDED, the way a real deployment verifies against Security
 * IQ's store. It signs nothing, issues nothing, and cannot mint an identity —
 * a test that wants a valid identity must construct the issued record itself,
 * which is exactly the honesty this arrangement is for.
 */
export function referenceSecurityPorts(state: {
  readonly issued: readonly IssuedIdentity[];
  readonly revoked: ReadonlyMap<string, { readonly revokedAt: string; readonly reason: string }>;
  readonly grants: readonly (AuthorizationGrant & { readonly evidenceRef: string; readonly notAfter: string })[];
  /** When true, every port reports UNAVAILABLE — the outage everyone forgets to test. */
  readonly unavailable?: boolean;
}): SecurityPortSet {
  const unavailable = state.unavailable === true;

  return {
    workloadIdentity: {
      verify: async ({ presentedIdentityRef, now }) => {
        if (unavailable) return { outcome: "UNAVAILABLE", reason: "Security IQ is unreachable." };
        const record = state.issued.find((i) => i.identityRef === presentedIdentityRef);
        if (!record) {
          return {
            outcome: "REFUSED",
            reason: `No identity was ever issued under "${presentedIdentityRef}". A reference nobody issued is a forgery, however well-formed.`,
          };
        }
        if (now >= record.notAfter) {
          return { outcome: "REFUSED", reason: `The identity expired at ${record.notAfter}.` };
        }
        return {
          outcome: "VERIFIED",
          validUntil: record.notAfter,
          detail: {
            workloadId: record.workloadId,
            instanceId: record.instanceId,
            tenantId: record.tenantId,
            trustDomain: record.trustDomain,
          },
        };
      },
    },
    authorization: {
      verify: async ({ evidenceRef, now }) => {
        if (unavailable) return { outcome: "UNAVAILABLE", reason: "Governance is unreachable." };
        const grant = state.grants.find((g) => g.evidenceRef === evidenceRef);
        if (!grant) return { outcome: "REFUSED", reason: `No decision exists at "${evidenceRef}".` };
        if (now >= grant.notAfter) return { outcome: "REFUSED", reason: `The grant expired at ${grant.notAfter}.` };
        return {
          outcome: "VERIFIED",
          validUntil: grant.notAfter,
          detail: {
            decisionRef: grant.decisionRef,
            principalId: grant.principalId,
            scope: grant.scope,
            tenantId: grant.tenantId,
          },
        };
      },
    },
    revocation: {
      check: async ({ subjectRef, now }) => {
        if (unavailable) return { outcome: "UNAVAILABLE", reason: "The revocation list is unreachable." };
        const entry = state.revoked.get(subjectRef);
        if (entry) return { outcome: "REVOKED", revokedAt: entry.revokedAt, reason: entry.reason };
        return { outcome: "NOT_REVOKED", checkedAt: now };
      },
    },
    integrity: {
      verify: async ({ signedBy }) => {
        if (unavailable) return { outcome: "UNAVAILABLE", reason: "The integrity verifier is unreachable." };
        // The reference verifier cannot verify a real signature, and says so
        // rather than pretending. Anything security-consequential must bind a
        // real IntegrityPort; this one refuses so a test cannot accidentally
        // rely on it passing.
        return {
          outcome: "REFUSED",
          reason: `The reference integrity verifier cannot verify signatures — it holds no key material by design, and pretending to verify would let a test pass on a check that does not exist. Bind a real Security IQ integrity port. (Presented signer: ${signedBy}.)`,
        };
      },
    },
  };
}
