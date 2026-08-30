// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";
import { trustStateSchema, type TrustState } from "./principal.js";

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY CORE — mechanisms, not judgement.
//
// Sentinel observes and finds; Security Core provides the machinery. Keeping
// them apart is the point: a system where the same component supplies the
// security controls AND audits whether they were adequate has no independent
// opinion about itself, and the first thing it would stop noticing is its own
// failures.
//
// So nothing here decides whether something is safe. It issues credentials,
// expires them, assesses trust from evidence, and offers containment
// primitives that somebody else's decision invokes.
//
// THE RULE THIS FILE EXISTS TO KEEP
//
//   TRUST MAY RESTRICT. TRUST MAY NEVER GRANT.
//
// A rising trust score must not open a capability that was closed, because the
// score is computed from signals — identity age, patch posture, link history —
// and a system where good behaviour accrues permissions is one where an
// attacker who behaves well for a fortnight is rewarded with more surface.
// `capabilitiesUnder` below returns a SUBSET of what it was given, always, and
// a property test walks every trust state to prove it.
//
// AND WHAT IS DELIBERATELY ABSENT
//
// No cryptography is implemented here. No algorithm, no digest, no key
// derivation. `CryptoProvider` is a port; a host binds a real one. Home-grown
// cryptography is forbidden, and an interface is how that rule survives a
// deadline — there is nothing to reach for at 2am because nothing is here.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a credential belongs to.
 *
 * Every engine, service and agent gets its OWN workload identity rather than
 * sharing one broad instance credential. That is the difference between
 * compromising a component and compromising an instance — and the acceptance
 * test the whole model rests on.
 */
export const workloadIdentitySchema = z
  .object({
    /** Which instance it runs in. */
    globalInstanceId: identifierSchema,
    /** The engine, service or agent. Unique WITHIN the instance, not globally. */
    workloadId: identifierSchema,
    workloadKind: z.enum(["engine", "service", "agent", "connector"]),
    /** Which build. A credential outliving a version cannot be reasoned about. */
    version: z.string().min(1),
  })
  .strict();
export type WorkloadIdentity = z.infer<typeof workloadIdentitySchema>;

export const credentialStatusSchema = z.enum(["active", "rotating", "expired", "revoked"]);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

/**
 * A short-lived credential.
 *
 * `notAfter` is REQUIRED. A credential with no expiry is a permanent one, and
 * the entire value of short-lived credentials is that a leaked one stops
 * working without anybody having to notice it leaked.
 *
 * There is no `privateKey` field, and there will not be one. This carries a
 * REFERENCE to key material held by a KMS, an HSM or a host's secret store.
 */
export const credentialSchema = z
  .object({
    credentialId: identifierSchema,
    identity: workloadIdentitySchema,
    /** Where the key actually lives. Never the key. */
    keyRef: z.string().min(1),
    /** Which crypto profile issued it, so a weak one can be found later. */
    cryptoProfileVersion: z.string().min(1),
    notBefore: z.string().min(1),
    notAfter: z.string().min(1),
    status: credentialStatusSchema,
    /** The credential this replaces, so a rotation is a chain and not a gap. */
    rotatedFrom: identifierSchema.optional(),
    revokedAt: z.string().min(1).optional(),
    revocationReason: z.string().min(1).optional(),
    /** Present when policy required hardware-backed material. */
    attestationRef: z.string().min(1).optional(),
  })
  .strict()
  .refine((c) => Date.parse(c.notAfter) > Date.parse(c.notBefore), {
    message: "A credential must expire after it begins. One that does not is valid for no time or forever, and neither is a credential.",
    path: ["notAfter"],
  })
  .refine((c) => c.status !== "revoked" || Boolean(c.revocationReason), {
    message: "A revoked credential must say why, so a revocation can be distinguished from an expiry.",
    path: ["revocationReason"],
  });
export type Credential = z.infer<typeof credentialSchema>;

/**
 * One signal feeding a trust assessment.
 *
 * Evidence, with a weight and a source. An assessment built from unattributed
 * numbers cannot be argued with, and the whole point of a dynamic score is
 * that somebody can ask why it moved.
 */
export const trustSignalSchema = z
  .object({
    signal: z.enum([
      "identity_age",
      "certificate_health",
      "attestation",
      "anomalous_behavior",
      "failed_authorization_attempts",
      "environment_posture",
      "sentinel_finding",
      "connector_risk",
      "recent_compromise",
      "patch_posture",
      "link_history",
    ]),
    /** -1..1. Negative lowers trust. */
    contribution: z.number().min(-1).max(1),
    observedAt: z.string().min(1),
    /** A reference to what was observed. Never the observation itself. */
    evidenceRef: z.string().min(1),
  })
  .strict();
export type TrustSignal = z.infer<typeof trustSignalSchema>;

/**
 * A trust assessment, which EXPIRES.
 *
 * The directive's phrase is "not a permanent binary flag", and expiry is what
 * makes that true rather than aspirational. An assessment with no expiry is a
 * permanent flag wearing a dynamic name — and the failure mode is specific: a
 * workload assessed as trusted in March is still trusted in December, long
 * after every signal behind that judgement stopped being observed.
 *
 * An expired assessment reads as `unknown`, which does not permit work. Same
 * doctrine as everywhere else in this codebase: unknown is not trusted.
 */
export const trustAssessmentSchema = z
  .object({
    subjectId: identifierSchema,
    subjectKind: z.enum(["instance", "workload", "link", "actor"]),
    state: trustStateSchema,
    /** 0..1, or null when nothing has been measured. Never defaulted to a number. */
    score: z.number().min(0).max(1).nullable(),
    /** At least one. An assessment from no signals is an opinion. */
    signals: z.array(trustSignalSchema).min(1),
    assessedAt: z.string().min(1),
    /** REQUIRED. See above. */
    expiresAt: z.string().min(1),
  })
  .strict()
  .refine((a) => Date.parse(a.expiresAt) > Date.parse(a.assessedAt), {
    message: "A trust assessment must expire after it was made.",
    path: ["expiresAt"],
  })
  .refine((a) => a.state !== "unknown" || a.score === null, {
    message:
      "An unknown trust state carries no score. A number attached to `unknown` invites somebody to compare it, and an unmeasured thing does not compare.",
    path: ["score"],
  });
export type TrustAssessment = z.infer<typeof trustAssessmentSchema>;

/** The effective state of an assessment at a moment, honouring expiry. */
export function effectiveTrust(assessment: TrustAssessment, now: string): TrustState {
  const at = Date.parse(now);
  if (Number.isNaN(at)) return "unknown";
  // Expired reads as unknown, not as whatever it last said. The evidence
  // behind the judgement stopped being current; the judgement should too.
  return at >= Date.parse(assessment.expiresAt) ? "unknown" : assessment.state;
}

/**
 * Which capabilities remain under a trust state.
 *
 * Returns a SUBSET of `base`, always. Not by convention — by construction: the
 * only operation performed is a filter, and there is no branch that adds.
 *
 * This is where "trust may restrict but never grant" stops being a sentence in
 * a document. A rising score cannot open a capability that was closed, because
 * a filter has nothing to open it with.
 */
export function capabilitiesUnder(
  base: readonly string[],
  trust: TrustState,
  restrictedSet: readonly string[] = [],
): readonly string[] {
  switch (trust) {
    case "trusted":
      return [...base];
    case "watched":
      // Watched means observed, not curtailed. Costing availability for
      // observation is how people stop marking things watched.
      return [...base];
    case "restricted":
      return base.filter((c) => restrictedSet.includes(c));
    case "revoked":
    case "unknown":
      return [];
  }
}

/**
 * A reference to a secret. There is no field that can hold one.
 *
 * The strongest form of "secrets never appear in events or logs": not a rule
 * about what to put in the field, but the absence of a field to put it in.
 */
export const secretRefSchema = z
  .object({
    secretRef: z.string().min(1),
    /** Which store holds it. */
    custodian: z.enum(["kms", "hsm", "host_vault", "external_provider"]),
    /** What it is for, so an access record is meaningful without the value. */
    purpose: z.string().min(1),
    rotatedAt: z.string().min(1).optional(),
  })
  .strict();
export type SecretRef = z.infer<typeof secretRefSchema>;

/**
 * A versioned crypto profile.
 *
 * Versioned so stronger requirements roll out without undocumented behaviour
 * changes — an instance can be told it is on profile 1 while the collective
 * moved to 2, which is a fact somebody can act on rather than a silent
 * difference in what "signed" means.
 */
export const cryptoProfileSchema = z
  .object({
    profileVersion: z.string().min(1),
    signatureAlgorithm: z.string().min(1),
    transportRequirement: z.enum(["tls", "mtls"]),
    /** Whether payloads crossing instances must be encrypted end-to-end. */
    endToEndPayloadEncryption: z.boolean(),
    /** Whether key material must be hardware-backed. */
    requiresHardwareAttestation: z.boolean(),
    maxCredentialLifetimeSeconds: z.number().int().positive(),
  })
  .strict();
export type CryptoProfile = z.infer<typeof cryptoProfileSchema>;

/** The security events this core emits. Metadata only, always. */
export const securityEventSchema = z.enum([
  "security.identity.issued",
  "security.identity.rotated",
  "security.identity.revoked",
  "security.authorization.denied",
  "security.trust.changed",
  "security.link.quarantined",
  /** Metadata only — that a secret was accessed, never which value. */
  "security.secret.accessed",
  "security.attestation.failed",
  "security.crypto.policy_violation",
  "security.threat.candidate.created",
  "security.containment.executed",
]);
export type SecurityEvent = z.infer<typeof securityEventSchema>;

/**
 * Whether a trust score can grant authority it did not already have.
 *
 * Always false, and `capabilitiesUnder` makes it structural rather than
 * promised. A system where good behaviour accrues permissions rewards an
 * attacker who behaves well for a fortnight with more surface.
 */
export function trustCanGrantAuthority(): false {
  return false;
}

/**
 * Whether Security Core decides what is safe.
 *
 * Always false. It provides mechanisms; Sentinel finds, Governance authorizes.
 * A component that supplied the controls and also judged their adequacy would
 * have no independent opinion about itself, and its own failures are the first
 * thing it would stop noticing.
 */
export function securityCoreAdjudicates(): false {
  return false;
}
