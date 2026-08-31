// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Chamber, ChamberHealth } from "./chambers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel self-defense — directive §26/§27 (DEC-028 increment 5).
//
// §27: "Sentinel must assume Sentinel itself can be attacked." The self-check
// verifies binaries, configuration, policies, dependencies, identities,
// telemetry integrity, provider state and both chambers' health — against
// SUPPLIED attestations, because a component that attests itself proves
// nothing.
//
// THE RULE THAT SHAPES THE WHOLE MODULE: a self-check cannot clear itself.
// `selfCheck` returns a verdict; a FAILING verdict is not something Sentinel
// can wave away, and no parameter silences one. The response to a
// self-integrity failure is degradation and escalation — because a
// compromised Sentinel that can silence its own alarm is a compromised
// Sentinel with no alarm.
//
// §27 also: compromise of Shield must not automatically compromise Guard, and
// vice versa. `blastContainment` computes what a compromised chamber can
// reach, and the answer is bounded by construction: neither chamber can
// escalate the other's authority, and a self-check finding NEVER expands
// Sentinel's own permissions.
// ─────────────────────────────────────────────────────────────────────────────

export const SELF_CHECK_SURFACES = [
  "binaries",
  "configuration",
  "policy-inputs",
  "dependencies",
  "identities",
  "telemetry-integrity",
  "provider-state",
  "shield-health",
  "guard-health",
] as const;
export type SelfCheckSurface = (typeof SELF_CHECK_SURFACES)[number];

export type SurfaceState =
  | { readonly state: "verified"; readonly attestedBy: string }
  | { readonly state: "mismatch"; readonly expected: string; readonly observed: string }
  | {
      /** No attestation supplied. NOT "probably fine": an unattested surface
       * is an unknown one, and unknown integrity is not integrity. */
      readonly state: "unattested";
      readonly reason: string;
    };

export interface SelfCheckInput {
  readonly surfaces: Readonly<Partial<Record<SelfCheckSurface, SurfaceState>>>;
  readonly shieldHealth: ChamberHealth;
  readonly guardHealth: ChamberHealth;
  readonly asOf: string;
}

export type SelfVerdict = "healthy" | "degraded" | "compromise-suspected";

export interface SelfCheckResult {
  readonly verdict: SelfVerdict;
  readonly mismatchedSurfaces: readonly SelfCheckSurface[];
  readonly unattestedSurfaces: readonly SelfCheckSurface[];
  /** What Sentinel must do about itself. Escalation is always present on a
   * non-healthy verdict; silencing one is not an option anywhere. */
  readonly requiredResponse: readonly string[];
  /** A self-check NEVER grants Sentinel anything. Literal, so the property is
   * visible in every result rather than merely true. */
  readonly authorityChange: "none";
  readonly asOf: string;
}

export function selfCheck(input: SelfCheckInput): SelfCheckResult {
  const mismatched: SelfCheckSurface[] = [];
  const unattested: SelfCheckSurface[] = [];
  for (const surface of SELF_CHECK_SURFACES) {
    const state = input.surfaces[surface];
    if (state === undefined || state.state === "unattested") {
      unattested.push(surface);
      continue;
    }
    if (state.state === "mismatch") mismatched.push(surface);
  }
  const chamberImpaired = input.shieldHealth !== "operational" || input.guardHealth !== "operational";
  const chamberCompromised = input.shieldHealth === "compromised-suspected" || input.guardHealth === "compromised-suspected";
  const verdict: SelfVerdict =
    mismatched.length > 0 || chamberCompromised ? "compromise-suspected" : unattested.length > 0 || chamberImpaired ? "degraded" : "healthy";
  const requiredResponse: string[] = [];
  if (verdict === "compromise-suspected") {
    requiredResponse.push(
      "escalate to Governance and a human operator",
      "preserve forensic evidence before any remediation",
      "request the stricter condition posture through the chartered path",
      "the affected chamber does not verify itself back to health — restoration needs independent evidence",
    );
  } else if (verdict === "degraded") {
    requiredResponse.push(
      `obtain attestation for: ${unattested.join(", ") || "the impaired chamber"}`,
      "report the degradation explicitly; visibility loss is never silent",
    );
  }
  return {
    verdict,
    mismatchedSurfaces: mismatched,
    unattestedSurfaces: unattested,
    requiredResponse,
    authorityChange: "none",
    asOf: input.asOf,
  };
}

/**
 * §27 blast containment: what a compromised chamber can affect. The bounds
 * are structural — the compromised chamber cannot alter the other's
 * authority, cannot clear findings, and cannot change Sentinel's permissions.
 */
export interface ChamberBlastBounds {
  readonly compromisedChamber: Chamber;
  readonly canAffect: readonly string[];
  readonly cannotAffect: readonly string[];
  readonly otherChamberAuthorityIntact: true;
}

export function blastContainment(compromised: Chamber): ChamberBlastBounds {
  const shared = [
    "the other chamber's authority",
    "Sentinel's own permissions",
    "Governance decisions",
    "the AuditIQ ledger",
    "operator hierarchy records",
    "the last constitutional recovery authority",
  ];
  if (compromised === "shield") {
    return {
      compromisedChamber: "shield",
      canAffect: ["threat detection fidelity", "containment REQUESTS it raises (which Governance and executors still gate)"],
      cannotAffect: [...shared, "integrity and trust verification (Guard's)", "policy conformance verdicts"],
      otherChamberAuthorityIntact: true,
    };
  }
  return {
    compromisedChamber: "guard",
    canAffect: ["integrity/trust verdicts it issues", "posture verification results"],
    cannotAffect: [...shared, "threat detection (Shield's)", "containment execution (never Sentinel's at all)"],
    otherChamberAuthorityIntact: true,
  };
}

// ── §26 supply-chain ingest ─────────────────────────────────────────────────

export interface ArtifactRecord {
  readonly artifactRef: string;
  readonly sourceIdentity: string | null;
  readonly repositoryRef: string | null;
  readonly sourceRevision: string | null;
  readonly builderIdentity: string | null;
  readonly buildEnvironmentRef: string | null;
  readonly digest: string | null;
  readonly sbomRef: string | null;
  readonly provenanceRef: string | null;
  readonly signatureRefs: readonly { role: string; ref: string }[];
  readonly testEvidenceRef: string | null;
  readonly approvalRef: string | null;
}

export const REQUIRED_FOR_PROTECTED_DEPLOYMENT: readonly (keyof ArtifactRecord)[] = [
  "sourceIdentity",
  "repositoryRef",
  "sourceRevision",
  "builderIdentity",
  "digest",
  "provenanceRef",
  "testEvidenceRef",
  "approvalRef",
];

export type SupplyChainGateVerdict =
  | {
      readonly cleared: true;
      readonly distinctSigningRoles: readonly string[];
      /** §26/§12: Sentinel verifies; Foundry candidates pass verification
       * BEFORE deployment, and Sentinel cannot deploy them. */
      readonly deploymentAuthority: "not-sentinel";
    }
  | { readonly cleared: false; readonly missing: readonly string[]; readonly reasons: readonly string[] };

/**
 * The pre-deployment gate. An SBOM is EVIDENCE, not a guarantee (§26), so its
 * presence is recorded but never treated as clearing anything on its own; the
 * required set is provenance and attribution, and the signing threshold is
 * counted over DISTINCT roles so one compromised key cannot clear an artifact.
 */
export function supplyChainGate(artifact: ArtifactRecord, requiredDistinctRoles: number): SupplyChainGateVerdict {
  const missing = REQUIRED_FOR_PROTECTED_DEPLOYMENT.filter((field) => {
    const value = artifact[field];
    return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  }).map((f) => String(f));
  const reasons: string[] = [];
  const distinct = [...new Set(artifact.signatureRefs.map((s) => s.role))].sort();
  if (distinct.length < requiredDistinctRoles) {
    reasons.push(
      `${distinct.length} distinct signing role(s); ${requiredDistinctRoles} required — compromise of one role must not replace trusted software`,
    );
  }
  if (artifact.sbomRef === null) {
    // Recorded as a reason, and deliberately NOT in the required set: an SBOM
    // is evidence about contents, not proof of safety.
    reasons.push("no SBOM evidence (recorded; an SBOM is evidence, not a guarantee)");
  }
  if (missing.length > 0 || distinct.length < requiredDistinctRoles) {
    return { cleared: false, missing, reasons };
  }
  return { cleared: true, distinctSigningRoles: distinct, deploymentAuthority: "not-sentinel" };
}

/** §26: dependency advisories are MAPPED to affected components, never
 * auto-installed. The output is a work list for humans, not an action. */
export interface AdvisoryMatch {
  readonly advisoryRef: string;
  readonly affectedArtifactRefs: readonly string[];
  readonly action: "report-only";
  readonly autoInstalled: false;
}

export function mapAdvisory(
  advisoryRef: string,
  affectedComponent: string,
  artifacts: readonly { artifactRef: string; components: readonly string[] }[],
): AdvisoryMatch {
  return {
    advisoryRef,
    affectedArtifactRefs: artifacts.filter((a) => a.components.includes(affectedComponent)).map((a) => a.artifactRef).sort(),
    action: "report-only",
    autoInstalled: false,
  };
}
