// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 Guard chamber modules — §3/§8/§12 and the Guard specialist
// candidates implemented as MODULES (DEC-027 point 2): TrustAssurance,
// Integrity, PolicyAssurance, SupplyChainAssurance.
//
// The zero-trust rule that shapes every gate: deny by default for protected
// operations. Missing identity, trust, policy, authorization or validation
// MUST NOT fall through to allow. Sentinel verifies posture; Security IQ /
// IdentityIQ own the mechanisms; Governance owns the authorization.
// ─────────────────────────────────────────────────────────────────────────────

// ── §8 · the Neural Fabric security handshake, deny-by-default ──────────────

/** The eight handshake steps, each with its OWNER named — Sentinel appears
 * twice (Guard verifies, Shield observes) and owns neither identity nor
 * authorization nor routing nor the audit ledger. */
export const HANDSHAKE_STEPS = [
  { step: "identify-lane", owner: "neural-fabric" },
  { step: "resolve-workload-identity", owner: "security-iq/identity-iq" },
  { step: "verify-posture-and-conformance", owner: "sentinel-guard" },
  { step: "authorize-protected-action", owner: "governance" },
  { step: "select-approved-route", owner: "neural-fabric" },
  { step: "enforce-route-health", owner: "pulse" },
  { step: "observe-flow-behavior", owner: "sentinel-shield" },
  { step: "record-evidence", owner: "audit-iq" }, // Sentinel does NOT keep a parallel ledger
] as const;

export interface HandshakeInputs {
  readonly laneIdentified: boolean;
  readonly workloadIdentityVerified: boolean | null; // null = could not be evaluated
  readonly trustEvidenceFresh: boolean | null;
  readonly policyConformant: boolean | null;
  readonly governanceAuthorized: boolean | null; // null when not required for this action
  readonly governanceRequired: boolean;
}

export type GateVerdict =
  | { readonly verdict: "allow" }
  | { readonly verdict: "deny"; readonly failedChecks: readonly string[]; readonly fellThroughToAllow: false };

/**
 * The deny-by-default gate: every check must be affirmatively true. A null —
 * "could not be evaluated" — denies exactly like a false; there is no branch
 * in this function that reaches allow with a missing check.
 */
export function protectedOperationGate(inputs: HandshakeInputs): GateVerdict {
  const failed: string[] = [];
  if (!inputs.laneIdentified) failed.push("lane-unidentified");
  if (inputs.workloadIdentityVerified !== true) failed.push("workload-identity-not-affirmatively-verified");
  if (inputs.trustEvidenceFresh !== true) failed.push("trust-evidence-not-fresh");
  if (inputs.policyConformant !== true) failed.push("policy-conformance-not-established");
  if (inputs.governanceRequired && inputs.governanceAuthorized !== true) failed.push("governance-authorization-missing");
  if (failed.length > 0) return { verdict: "deny", failedChecks: failed, fellThroughToAllow: false };
  return { verdict: "allow" };
}

// ── TrustAssurance module — evidence freshness, degradation on expiry ───────

export interface TrustEvidence {
  readonly subjectRef: string;
  readonly attestationRef: string;
  readonly issuedAt: string;
  readonly ttlSeconds: number;
}

export type TrustVerdict =
  | { readonly state: "fresh"; readonly remainingSeconds: number }
  | { readonly state: "expired"; readonly expiredForSeconds: number; readonly consequence: "protected actions fail closed" }
  | { readonly state: "unevaluable"; readonly reason: string };

/** Freshness against an EXPLICIT asOf, never a clock read. Expired trust is
 * not "probably fine": protected actions fail closed after TTL (§14). */
export function verifyTrustFreshness(evidence: TrustEvidence | undefined, asOf: string): TrustVerdict {
  if (evidence === undefined) return { state: "unevaluable", reason: "no trust evidence supplied" };
  const issued = Date.parse(evidence.issuedAt);
  const now = Date.parse(asOf);
  if (Number.isNaN(issued) || Number.isNaN(now)) return { state: "unevaluable", reason: "unparseable timestamps" };
  const ageSeconds = Math.floor((now - issued) / 1000);
  if (ageSeconds <= evidence.ttlSeconds) return { state: "fresh", remainingSeconds: evidence.ttlSeconds - ageSeconds };
  return { state: "expired", expiredForSeconds: ageSeconds - evidence.ttlSeconds, consequence: "protected actions fail closed" };
}

// ── Integrity module — trusted baseline comparison ──────────────────────────

export interface IntegrityBaseline {
  readonly artifactRef: string;
  readonly expectedDigest: string;
  readonly baselineRecordedAt: string;
}

export type IntegrityVerdict =
  | { readonly state: "verified"; readonly artifactRef: string }
  | { readonly state: "tampered"; readonly artifactRef: string; readonly expectedDigest: string; readonly observedDigest: string }
  | { readonly state: "unevaluable"; readonly artifactRef: string; readonly reason: string };

/** Digest match against a trusted baseline. A missing observation is
 * UNEVALUABLE, never "assumed intact" — unknown integrity is not integrity. */
export function verifyIntegrity(baseline: IntegrityBaseline, observedDigest: string | undefined): IntegrityVerdict {
  if (observedDigest === undefined) {
    return { state: "unevaluable", artifactRef: baseline.artifactRef, reason: "no observed digest; unknown integrity is not integrity" };
  }
  if (observedDigest !== baseline.expectedDigest) {
    return { state: "tampered", artifactRef: baseline.artifactRef, expectedDigest: baseline.expectedDigest, observedDigest };
  }
  return { state: "verified", artifactRef: baseline.artifactRef };
}

// ── PolicyAssurance module — enforcement matches the versioned policy ───────

export interface PolicyExpectation {
  readonly policyRef: string;
  readonly policyVersion: string;
  readonly expectedEnforcementPoints: readonly string[];
}

export interface PolicyObservation {
  readonly policyRef: string;
  readonly observedVersion: string;
  readonly enforcementPointsSeen: readonly string[];
}

export type PolicyAssuranceVerdict =
  | { readonly state: "conformant" }
  | {
      readonly state: "drift";
      readonly versionMismatch: boolean;
      readonly missingEnforcementPoints: readonly string[];
      /** Sentinel detects drift; it does NOT author the corrected policy. */
      readonly remediationAuthority: "policy-iq/governance";
    };

export function verifyPolicyEnforcement(expected: PolicyExpectation, observed: PolicyObservation): PolicyAssuranceVerdict {
  const versionMismatch = expected.policyVersion !== observed.observedVersion;
  const missing = expected.expectedEnforcementPoints.filter((p) => !observed.enforcementPointsSeen.includes(p));
  if (!versionMismatch && missing.length === 0) return { state: "conformant" };
  return { state: "drift", versionMismatch, missingEnforcementPoints: missing, remediationAuthority: "policy-iq/governance" };
}

// ── SupplyChainAssurance module — §12 ───────────────────────────────────────

export const artifactEvidenceSchema = z
  .object({
    artifactRef: z.string().min(1),
    digest: z.string().min(1),
    provenanceRef: z.string().min(1),
    builderIdentity: z.string().min(1),
    signatures: z.array(z.object({ role: z.string().min(1), signatureRef: z.string().min(1) }).strict()).min(1),
  })
  .strict();
export type ArtifactEvidence = z.infer<typeof artifactEvidenceSchema>;

export type SupplyChainVerdict =
  | {
      readonly state: "verified";
      readonly rolesSatisfied: readonly string[];
      /** Sentinel verifies; it CANNOT deploy (§12: Foundry candidates must
       * pass verification before deployment; Sentinel cannot deploy them). */
      readonly deploymentAuthority: "not-sentinel";
    }
  | { readonly state: "rejected"; readonly reasons: readonly string[] };

/**
 * §12: threshold/role-separated update trust — compromise of ONE signing
 * role/key cannot trivially replace all trusted software, so the required
 * roles are distinct and the threshold counts DISTINCT roles.
 */
export function verifySupplyChain(
  evidence: ArtifactEvidence | undefined,
  expectedBuilderIdentity: string,
  requiredDistinctRoles: number,
): SupplyChainVerdict {
  if (evidence === undefined) {
    return { state: "rejected", reasons: ["no provenance evidence: an unsigned artifact is untrusted, not unverified-but-probably-fine"] };
  }
  const reasons: string[] = [];
  if (evidence.builderIdentity !== expectedBuilderIdentity) {
    reasons.push(`builder identity ${evidence.builderIdentity} does not match expected ${expectedBuilderIdentity}`);
  }
  const distinctRoles = new Set(evidence.signatures.map((s) => s.role));
  if (distinctRoles.size < requiredDistinctRoles) {
    reasons.push(
      `${distinctRoles.size} distinct signing role(s) present; ${requiredDistinctRoles} required — one compromised role must not be able to replace trusted software`,
    );
  }
  if (reasons.length > 0) return { state: "rejected", reasons };
  return { state: "verified", rolesSatisfied: [...distinctRoles].sort(), deploymentAuthority: "not-sentinel" };
}
