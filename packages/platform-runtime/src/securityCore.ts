// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  capabilitiesUnder,
  credentialSchema,
  effectiveTrust,
  trustAssessmentSchema,
  workloadIdentitySchema,
  type Credential,
  type CryptoProfile,
  type SecurityEvent,
  type TrustAssessment,
  type TrustState,
  type WorkloadIdentity,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The security core's runtime: credentials, trust, containment.
//
// It provides mechanisms and judges nothing. Sentinel finds, Governance
// authorizes, and this issues, expires, assesses and contains when something
// with authority says to.
//
// WHY WORKLOAD IDENTITY IS PER-COMPONENT
//
// Every engine, service and agent holds its own credential rather than sharing
// one broad instance credential, and the difference is the blast radius of a
// compromise: with a shared credential, one leaked key is the whole instance;
// with per-workload identity it is one component, and the verifier below will
// refuse it for anything else because the identity is inside what was signed.
//
// NO CRYPTOGRAPHY IS IMPLEMENTED
//
// `CryptoProvider` is a port. This file computes no digests, derives no keys
// and holds no secrets — it holds REFERENCES to key material a KMS or HSM
// keeps. That is also why binding the Interconnect's `EnvelopeVerifier` here
// is an adapter over that port rather than an implementation: the interconnect
// asked for verification, and this supplies the seam, not the algorithm.
// ─────────────────────────────────────────────────────────────────────────────

export interface SignatureCheck {
  readonly valid: boolean;
  readonly reason: string;
}

/**
 * Key custody and signature verification, injected.
 *
 * A host binds a KMS, an HSM or a software provider. The interface names what
 * is needed and not how: `verify` takes the identity the signature CLAIMS,
 * because looking up the wrong key is how one engine's credential comes to
 * verify another's message.
 */
export interface CryptoProvider {
  readonly profile: CryptoProfile;
  /** Issues key material and returns a reference to it. Never the material. */
  issueKey(identity: WorkloadIdentity): { keyRef: string; attestationRef?: string };
  /** Whether `signature` over `body` was made by the key behind `keyRef`. */
  verify(input: { keyRef: string; body: string; signature: string }): SignatureCheck;
}

/**
 * Where credentials, assessments and containments live.
 *
 * The durability guard's third catch, and the worst restart behaviour of the
 * three it has found:
 *
 *   A REVOKED CREDENTIAL would come back. Restarting would un-revoke a key
 *   somebody revoked because they believed it was compromised — which makes a
 *   crash the attacker's best move.
 *
 *   A QUARANTINE would lift. The same hole, one layer up: the containment that
 *   was applied because something was behaving badly disappears the moment the
 *   process holding it restarts.
 *
 *   TRUST ASSESSMENTS would be forgotten. This one fails closed — an absent
 *   assessment reads as `unknown`, which permits nothing — so it is the least
 *   dangerous and still worth keeping, because losing every assessment turns a
 *   restart into a fleet-wide outage.
 */
export interface SecurityStore {
  readonly durability: "in-memory" | "durable";
  credential(credentialId: string): Credential | null;
  putCredential(credential: Credential): void;
  credentials(): readonly Credential[];
  assessment(subjectId: string): TrustAssessment | null;
  putAssessment(assessment: TrustAssessment): void;
  appendContainment(entry: { primitive: ContainmentPrimitive; subjectId: string; reason: string }): void;
  containments(): readonly { primitive: ContainmentPrimitive; subjectId: string; reason: string }[];
  nextCredentialId(): string;
}

export function createInMemorySecurityStore(): SecurityStore {
  const creds = new Map<string, Credential>();
  const assessed = new Map<string, TrustAssessment>();
  const contained: { primitive: ContainmentPrimitive; subjectId: string; reason: string }[] = [];
  let counter = 0;
  return {
    durability: "in-memory",
    credential: (id) => creds.get(id) ?? null,
    putCredential: (c) => {
      creds.set(c.credentialId, c);
    },
    credentials: () => [...creds.values()],
    assessment: (id) => assessed.get(id) ?? null,
    putAssessment: (a) => {
      assessed.set(a.subjectId, a);
    },
    appendContainment: (e) => {
      contained.push(e);
    },
    containments: () => contained,
    nextCredentialId: () => `cred_${(counter += 1)}`,
  };
}

export type IssueResult =
  | { readonly issued: true; readonly credential: Credential }
  | { readonly issued: false; readonly reason: string };

export interface SecurityCore {
  /** Issues a short-lived credential for one workload. */
  issue(input: {
    identity: unknown;
    lifetimeSeconds: number;
  }): IssueResult;

  /**
   * Replaces a credential with a fresh one.
   *
   * The old credential stays valid until its own expiry rather than being
   * killed at rotation — otherwise every rotation is a small outage for
   * whatever was mid-request, which is how automatic rotation gets switched
   * off.
   */
  rotate(credentialId: string, lifetimeSeconds: number): IssueResult;

  revoke(credentialId: string, reason: string, by: string): { revoked: boolean; reason: string };

  /** Whether this credential may be used right now, and why not. */
  validate(credentialId: string): SignatureCheck;

  /**
   * Whether a signature was made by the workload it claims.
   *
   * Compares the FULL identity — instance, workload and kind — so one engine's
   * compromised credential cannot be presented as another's.
   */
  verifyFor(input: {
    claimed: unknown;
    body: string;
    signature: string;
  }): SignatureCheck;

  /** Records a trust assessment. Replaces any previous one for that subject. */
  assess(assessment: unknown): { recorded: boolean; reason: string };

  /** The subject's trust right now, honouring expiry. */
  trustOf(subjectId: string): TrustState;

  /** What remains permitted under current trust. Never more than `base`. */
  permittedCapabilities(subjectId: string, base: readonly string[], restrictedSet?: readonly string[]): readonly string[];

  /** Applies a containment primitive. Does not decide that it should be. */
  contain(input: {
    primitive: ContainmentPrimitive;
    subjectId: string;
    reason: string;
    /** Who authorized it. Security Core does not authorize its own containment. */
    authorizedBy: string;
    authorizationRef: string;
  }): { applied: boolean; reason: string };

  /** Subjects currently contained, by primitive. */
  contained(): readonly { primitive: ContainmentPrimitive; subjectId: string; reason: string }[];

  credentialsFor(workloadId: string): readonly Credential[];

  /** Whether credentials, revocations and containments survive a restart. */
  durability(): "in-memory" | "durable";
}

/**
 * The executable side of Sentinel's ladder.
 *
 * Deliberately a SUBSET of `DEFENSIVE_LADDER` and named identically where they
 * overlap: Sentinel decides which rung, this performs the ones that are
 * mechanical. The rungs absent here — `warn`, `require_validation`,
 * `protected_mode`, `emergency_protective_state` — are absent because they are
 * decisions or postures rather than switches, and giving this file a lever for
 * them would be giving it a say in them.
 */
export type ContainmentPrimitive =
  | "revoke_access"
  | "restrict_access"
  | "isolate_integration"
  | "quarantine_engine"
  | "restrict_data_movement";

export interface SecurityCoreOptions {
  readonly instanceId: string;
  readonly crypto: CryptoProvider;
  /** Where credentials, assessments and containments live. Defaults to in-memory. */
  readonly store?: SecurityStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
  /** Every security event. Metadata only — there is nothing else to emit. */
  readonly onEvent?: (
    event: SecurityEvent,
    detail: Readonly<Record<string, string | number | boolean>>,
  ) => void;
}

export function createSecurityCore(options: SecurityCoreOptions): SecurityCore {
  const now = options.now ?? (() => new Date());
  const held = options.store ?? createInMemorySecurityStore();
  const newId = options.generateId ?? (() => held.nextCredentialId());

  const emit = (
    event: SecurityEvent,
    detail: Record<string, string | number | boolean>,
  ): void => {
    options.onEvent?.(event, detail);
  };

  const mint = (identity: WorkloadIdentity, lifetimeSeconds: number, rotatedFrom?: string): IssueResult => {
    const ceiling = options.crypto.profile.maxCredentialLifetimeSeconds;
    if (lifetimeSeconds > ceiling) {
      // The profile's ceiling is not advisory. A caller asking for a year
      // under a profile that permits an hour is asking for a different
      // security posture, and that is a policy change rather than a parameter.
      emit("security.crypto.policy_violation", {
        workloadId: identity.workloadId,
        requestedSeconds: lifetimeSeconds,
        ceilingSeconds: ceiling,
      });
      return {
        issued: false,
        reason: `Profile ${options.crypto.profile.profileVersion} permits at most ${ceiling}s and ${lifetimeSeconds}s was requested.`,
      };
    }

    const key = options.crypto.issueKey(identity);

    if (options.crypto.profile.requiresHardwareAttestation && !key.attestationRef) {
      // Fails closed. A profile demanding hardware-backed material and getting
      // none is not a warning — it is the deployment not being what it says.
      emit("security.attestation.failed", { workloadId: identity.workloadId });
      return {
        issued: false,
        reason: `Profile ${options.crypto.profile.profileVersion} requires hardware attestation and the provider returned none.`,
      };
    }

    const at = now();
    const parsed = credentialSchema.safeParse({
      credentialId: newId(),
      identity,
      keyRef: key.keyRef,
      cryptoProfileVersion: options.crypto.profile.profileVersion,
      notBefore: at.toISOString(),
      notAfter: new Date(at.getTime() + lifetimeSeconds * 1000).toISOString(),
      status: "active",
      ...(rotatedFrom ? { rotatedFrom } : {}),
      ...(key.attestationRef ? { attestationRef: key.attestationRef } : {}),
    });
    if (!parsed.success) {
      return { issued: false, reason: `Not a valid credential: ${JSON.stringify(parsed.error.flatten())}` };
    }

    held.putCredential(parsed.data);
    emit(rotatedFrom ? "security.identity.rotated" : "security.identity.issued", {
      credentialId: parsed.data.credentialId,
      workloadId: identity.workloadId,
      notAfter: parsed.data.notAfter,
    });
    return { issued: true, credential: parsed.data };
  };

  return {
    issue({ identity, lifetimeSeconds }) {
      const parsed = workloadIdentitySchema.safeParse(identity);
      if (!parsed.success) {
        return { issued: false, reason: `Not a valid workload identity: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (parsed.data.globalInstanceId !== options.instanceId) {
        // This core issues for its OWN instance. Issuing for another would
        // make one instance able to mint identities inside its neighbour.
        return {
          issued: false,
          reason: `This security core serves ${options.instanceId} and cannot issue credentials for ${parsed.data.globalInstanceId}.`,
        };
      }
      return mint(parsed.data, lifetimeSeconds);
    },

    rotate(credentialId, lifetimeSeconds) {
      const existing = held.credential(credentialId);
      if (!existing) return { issued: false, reason: `No credential ${credentialId}.` };
      if (existing.status === "revoked") {
        return {
          issued: false,
          reason: "A revoked credential is not rotated, it is replaced by a fresh issue. Rotating one would make revocation recoverable.",
        };
      }

      const fresh = mint(existing.identity, lifetimeSeconds, credentialId);
      if (!fresh.issued) return fresh;

      // The old one keeps its own expiry rather than dying at rotation.
      // Killing it here would make every rotation a small outage for whatever
      // was mid-request, which is how automatic rotation gets switched off.
      held.putCredential({ ...existing, status: "rotating" });
      return fresh;
    },

    revoke(credentialId, reason, by) {
      const existing = held.credential(credentialId);
      if (!existing) return { revoked: false, reason: `No credential ${credentialId}.` };
      if (existing.status === "revoked") return { revoked: false, reason: "Already revoked." };

      held.putCredential({
        ...existing,
        status: "revoked",
        revokedAt: now().toISOString(),
        revocationReason: `${reason} (revoked by ${by})`,
      });
      emit("security.identity.revoked", { credentialId, workloadId: existing.identity.workloadId });
      return { revoked: true, reason: "Revoked; the record remains." };
    },

    validate(credentialId) {
      const credential = held.credential(credentialId);
      if (!credential) return { valid: false, reason: `No credential ${credentialId}.` };
      if (credential.status === "revoked") {
        return { valid: false, reason: `Revoked: ${credential.revocationReason}` };
      }

      const at = now().getTime();
      // Fails closed on expiry, and the check is inclusive at the instant: a
      // credential expiring exactly now is expired, because the alternative is
      // a one-tick window whose behaviour depends on clock resolution.
      if (at >= Date.parse(credential.notAfter)) {
        return { valid: false, reason: `Expired at ${credential.notAfter}.` };
      }
      if (at < Date.parse(credential.notBefore)) {
        return { valid: false, reason: `Not valid until ${credential.notBefore}.` };
      }
      return { valid: true, reason: "Active and unexpired." };
    },

    verifyFor({ claimed, body, signature }) {
      const parsed = workloadIdentitySchema.safeParse(claimed);
      if (!parsed.success) {
        return { valid: false, reason: "The claimed identity is not a well-formed workload identity." };
      }
      const identity = parsed.data;

      // The credential must belong to EXACTLY this workload. Matching on
      // workloadId alone would let one instance's engine present as another
      // instance's engine of the same name — and engine names are shared
      // across instances by design.
      const candidate = held.credentials().find(
        (c) =>
          c.identity.globalInstanceId === identity.globalInstanceId &&
          c.identity.workloadId === identity.workloadId &&
          c.identity.workloadKind === identity.workloadKind,
      );
      if (!candidate) {
        return { valid: false, reason: `No credential is held for ${identity.workloadId} in ${identity.globalInstanceId}.` };
      }

      const usable = this.validate(candidate.credentialId);
      if (!usable.valid) return usable;

      return options.crypto.verify({ keyRef: candidate.keyRef, body, signature });
    },

    assess(assessment) {
      const parsed = trustAssessmentSchema.safeParse(assessment);
      if (!parsed.success) {
        return { recorded: false, reason: `Not a valid assessment: ${JSON.stringify(parsed.error.flatten())}` };
      }
      const previous = held.assessment(parsed.data.subjectId);
      held.putAssessment(parsed.data);

      if (!previous || previous.state !== parsed.data.state) {
        emit("security.trust.changed", {
          subjectId: parsed.data.subjectId,
          from: previous?.state ?? "unknown",
          to: parsed.data.state,
          signals: parsed.data.signals.length,
        });
      }
      return { recorded: true, reason: "Assessment recorded." };
    },

    trustOf(subjectId) {
      const assessment = held.assessment(subjectId);
      // No assessment reads as `unknown`, exactly as an expired one does. A
      // subject nobody has assessed is not one that passed assessment.
      if (!assessment) return "unknown";
      return effectiveTrust(assessment, now().toISOString());
    },

    permittedCapabilities(subjectId, base, restrictedSet) {
      return capabilitiesUnder(base, this.trustOf(subjectId), restrictedSet ?? []);
    },

    contain({ primitive, subjectId, reason, authorizedBy, authorizationRef }) {
      // Security Core does not authorize its own containment. A component that
      // could both decide to quarantine and perform the quarantine would be
      // the security provider and its own auditor.
      if (!authorizedBy || !authorizationRef) {
        return {
          applied: false,
          reason: "Containment requires a named authorizer and a reference. Security Core performs containment; it does not decide it.",
        };
      }

      held.appendContainment({ primitive, subjectId, reason });
      emit("security.containment.executed", {
        primitive,
        subjectId,
        authorizedBy,
        authorizationRef,
      });
      return { applied: true, reason: `${primitive} applied to ${subjectId}.` };
    },

    contained: () => [...held.containments()],
    credentialsFor: (workloadId) =>
      held.credentials().filter((c) => c.identity.workloadId === workloadId),
    durability: () => held.durability,
  };
}

/**
 * Binds the Interconnect's `EnvelopeVerifier` to a security core.
 *
 * The Interconnect asked for verification and deliberately implemented none.
 * This is the adapter, and it is thin on purpose: the signature question goes
 * to the crypto provider, and the identity question goes to the credential
 * store. Neither answer is computed here.
 */
export function envelopeVerifierFor(core: SecurityCore): {
  verifySignature(envelope: {
    sourceInstanceId: string;
    sourceEngineId?: string;
    senderSignature: string;
    integrityHash: string;
  }): SignatureCheck;
  verifyIntegrity(envelope: { integrityHash: string }): SignatureCheck;
} {
  return {
    verifySignature(envelope) {
      return core.verifyFor({
        claimed: {
          globalInstanceId: envelope.sourceInstanceId,
          // An envelope with no named engine is signed by the instance's own
          // gateway workload, which is a workload like any other rather than a
          // special case with weaker checking.
          workloadId: envelope.sourceEngineId ?? "interconnect.gateway",
          workloadKind: "service",
          version: "unknown",
        },
        body: envelope.integrityHash,
        signature: envelope.senderSignature,
      });
    },
    // Integrity is the crypto provider's to answer over the real body; this
    // adapter does not compute digests and says so rather than returning a
    // cheerful true.
    verifyIntegrity: () => ({
      valid: false,
      reason: "No integrity provider is bound. Bind one before accepting handoffs.",
    }),
  };
}

/**
 * Whether Security Core may contain something on its own initiative.
 *
 * Always false. `contain` requires a named authorizer and a reference, and the
 * primitives it offers are the mechanical subset of Sentinel's ladder — the
 * rungs that are decisions rather than switches are deliberately not here.
 */
export function securityCoreContainsUnilaterally(): false {
  return false;
}
