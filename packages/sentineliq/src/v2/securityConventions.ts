// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Hive Security Semantic Conventions — directive §11 (DEC-028).
//
// The philosophy is OpenTelemetry's and the vocabulary is entirely ours:
// different producers should describe equivalent concepts consistently, so a
// consumer can correlate across sources without knowing which producer spoke.
// Without this, correlation degenerates into per-source special-casing — which
// is how a detection surface silently loses coverage the day a provider
// renames a field.
//
// THE RULE THAT IS GUARDED: no vendor name is ever part of the canonical
// vocabulary. A canonical name that says "crowdstrike" or "splunk" makes the
// Hive's security model a hostage of one supplier's product decisions, and
// makes provider-neutrality (directive §8/§12) a slogan rather than a
// property. Vendor identity belongs in the ADAPTER's provider field, where it
// is data about the source, not part of the meaning.
// ─────────────────────────────────────────────────────────────────────────────

/** Bumped when a name's MEANING changes. Adding a name is additive; changing
 * what an existing name denotes requires a version. */
export const SECURITY_CONVENTIONS_VERSION = "1.0.0";

/**
 * The canonical subject vocabulary — WHAT a security observation can be about.
 * Every subject is a reference plus a kind; never a domain object (Sentinel
 * watching a work order does not make Sentinel a holder of work orders).
 */
export const SUBJECT_KINDS = [
  "identity", // a principal: human, service, workload
  "workload", // a running unit: engine instance, container, process group
  "process", // an OS process
  "network-flow", // a connection or flow
  "fabric-route", // a Neural Fabric lane/route
  "ai-agent", // ARIA, an internal agent, an external model connector, a bot
  "capability", // a named capability being requested or exercised
  "instance", // a Hive Instance
  "artifact", // a build output, package, image
  "build", // a build/release run
  "operator", // a human operator session
  "engine", // a Hive engine
  "data-store", // a store or dataset reference
  "secret-ref", // a REFERENCE to a secret; never the secret
  "host-environment", // the host system a Hive Instance runs in
  "external-system", // a third-party system at the edge
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * The canonical observation vocabulary — WHAT KIND of thing was observed.
 * Deliberately behaviour-shaped, not product-shaped: "process-executed", not
 * "edr-alert". A product's alert becomes one of these at the adapter.
 */
export const OBSERVATION_TYPES = [
  // identity / trust
  "authentication-succeeded",
  "authentication-failed",
  "authorization-denied",
  "privilege-escalated",
  "trust-evidence-degraded",
  "credential-rotated",
  "credential-expired",
  // runtime
  "process-executed",
  "unexpected-binary-observed",
  "persistence-mechanism-observed",
  "filesystem-modified-unexpectedly",
  "container-escape-indicator",
  "ransomware-like-file-behavior",
  // network / fabric
  "connection-established",
  "unexpected-egress",
  "lateral-movement-indicator",
  "fabric-route-denied",
  "fabric-route-failed",
  "segmentation-violation-attempted",
  // data
  "sensitive-data-access",
  "exfiltration-indicator",
  "cross-tenant-access-attempted",
  // supply chain
  "artifact-signature-invalid",
  "artifact-provenance-missing",
  "dependency-advisory-matched",
  // AI
  "ai-capability-requested",
  "ai-capability-outside-envelope",
  "prompt-injection-attempted",
  "model-or-provider-changed",
  "agent-behavior-drift",
  // constitutional / governance
  "governance-decision-refused",
  "policy-enforcement-gap-observed",
  "charter-boundary-exceeded",
  "integrity-baseline-mismatch",
  "audit-chain-verification-failed",
  // operator
  "operator-session-anomaly",
  "break-glass-used",
  // sentinel self
  "sentinel-self-integrity-mismatch",
  "sentinel-chamber-health-changed",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

/** Coarse grouping for routing and read models. */
export const OBSERVATION_CATEGORIES = [
  "identity-and-trust",
  "runtime",
  "network-and-fabric",
  "data-protection",
  "supply-chain",
  "ai-activity",
  "constitutional",
  "operator",
  "sentinel-self",
] as const;
export type ObservationCategory = (typeof OBSERVATION_CATEGORIES)[number];

/** Which category an observation type belongs to. A total function: adding a
 * type without a category is a compile error, so the map cannot drift. */
export const CATEGORY_OF: Readonly<Record<ObservationType, ObservationCategory>> = {
  "authentication-succeeded": "identity-and-trust",
  "authentication-failed": "identity-and-trust",
  "authorization-denied": "identity-and-trust",
  "privilege-escalated": "identity-and-trust",
  "trust-evidence-degraded": "identity-and-trust",
  "credential-rotated": "identity-and-trust",
  "credential-expired": "identity-and-trust",
  "process-executed": "runtime",
  "unexpected-binary-observed": "runtime",
  "persistence-mechanism-observed": "runtime",
  "filesystem-modified-unexpectedly": "runtime",
  "container-escape-indicator": "runtime",
  "ransomware-like-file-behavior": "runtime",
  "connection-established": "network-and-fabric",
  "unexpected-egress": "network-and-fabric",
  "lateral-movement-indicator": "network-and-fabric",
  "fabric-route-denied": "network-and-fabric",
  "fabric-route-failed": "network-and-fabric",
  "segmentation-violation-attempted": "network-and-fabric",
  "sensitive-data-access": "data-protection",
  "exfiltration-indicator": "data-protection",
  "cross-tenant-access-attempted": "data-protection",
  "artifact-signature-invalid": "supply-chain",
  "artifact-provenance-missing": "supply-chain",
  "dependency-advisory-matched": "supply-chain",
  "ai-capability-requested": "ai-activity",
  "ai-capability-outside-envelope": "ai-activity",
  "prompt-injection-attempted": "ai-activity",
  "model-or-provider-changed": "ai-activity",
  "agent-behavior-drift": "ai-activity",
  "governance-decision-refused": "constitutional",
  "policy-enforcement-gap-observed": "constitutional",
  "charter-boundary-exceeded": "constitutional",
  "integrity-baseline-mismatch": "constitutional",
  "audit-chain-verification-failed": "constitutional",
  "operator-session-anomaly": "operator",
  "break-glass-used": "operator",
  "sentinel-self-integrity-mismatch": "sentinel-self",
  "sentinel-chamber-health-changed": "sentinel-self",
};

/** Which chamber an observation category primarily serves. Cross-coverage
 * still lets either chamber read anything; this is routing, not a wall. */
export const PRIMARY_CHAMBER_OF: Readonly<Record<ObservationCategory, "shield" | "guard">> = {
  "identity-and-trust": "guard",
  runtime: "shield",
  "network-and-fabric": "shield",
  "data-protection": "shield",
  "supply-chain": "guard",
  "ai-activity": "shield",
  constitutional: "guard",
  operator: "guard",
  "sentinel-self": "guard",
};

/**
 * Data classification and privacy scope — directive §10. These drive what may
 * leave the Instance, and they are REQUIRED on every observation, because a
 * record whose sensitivity is unstated gets treated as the least sensitive
 * thing by whoever routes it next.
 */
export const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "protected-health", "regulated"] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export const PRIVACY_SCOPES = [
  "instance-local", // never leaves the Instance
  "tenant-local", // may cross Instances within one tenant, if authorized
  "collective-eligible", // MAY be generalized for the Collective — eligibility, not permission
] as const;
export type PrivacyScope = (typeof PRIVACY_SCOPES)[number];

/**
 * The vendor-name guard, as data rather than as a comment. Adapter code names
 * its provider in the SOURCE field; the canonical vocabulary above must stay
 * free of these tokens, and a test asserts it over this file's exported names.
 */
export const FORBIDDEN_VENDOR_TOKENS: readonly string[] = [
  "crowdstrike",
  "splunk",
  "sentinelone",
  "defender",
  "qradar",
  "wazuh",
  "falco",
  "osquery",
  "datadog",
  "paloalto",
  "fortinet",
  "okta",
  "azure",
  "aws",
  "gcp",
];

/** Every canonical name this module publishes, for the guard test to sweep. */
export function canonicalVocabulary(): readonly string[] {
  return [...SUBJECT_KINDS, ...OBSERVATION_TYPES, ...OBSERVATION_CATEGORIES, ...DATA_CLASSIFICATIONS, ...PRIVACY_SCOPES];
}
