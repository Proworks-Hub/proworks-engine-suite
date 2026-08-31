// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Confidence, Severity } from "../finding.js";
import { buildObservation, type ObservationAdmission } from "./observation.js";
import type { ObservationType } from "./securityConventions.js";

// ─────────────────────────────────────────────────────────────────────────────
// Hive-native sensors — directive §13 (DEC-028): "Before third-party
// integrations, wire Sentinel into the Hive itself."
//
// These are PURE TRANSLATORS. Each takes a fact another Hive component
// already produces — a Governance refusal, a Fabric route failure, a trust
// degradation, an integrity mismatch, an AI capability request outside an
// envelope — and expresses it in the canonical observation vocabulary.
//
// WHAT THEY DELIBERATELY ARE NOT:
//   · not subscribers — nothing here reaches into another component's store
//     or bus; the host calls these with facts it already holds (§18: no
//     component bypasses the handshake by touching another's private store)
//   · not judges — severity/confidence come from the CALLER, because the
//     component that owns the fact knows how sure it is; a translator that
//     invents confidence is manufacturing evidence
//   · not emitters — they return an admission result; the caller decides
//     what to do with a refusal
//
// Every translator returns ObservationAdmission, so a fact that would carry
// secret material is refused here rather than entering the plane.
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeSensorContext {
  readonly instanceRef: string;
  readonly observedAt: string;
  readonly receivedAt: string;
  readonly observationId: string;
  readonly correlationId?: string;
}

function native(
  context: NativeSensorContext,
  provider: string,
  adapterRef: string,
  observationType: ObservationType,
  subject: { kind: Parameters<typeof buildObservation>[0]["subject"]["kind"]; ref: string; label?: string },
  severity: Severity,
  confidence: Confidence,
  attributes: Readonly<Record<string, string>>,
  evidenceRefs: Parameters<typeof buildObservation>[0]["evidenceRefs"],
  attackTechniqueRef?: string,
): ObservationAdmission {
  return buildObservation({
    observationId: context.observationId,
    observedAt: context.observedAt,
    receivedAt: context.receivedAt,
    source: { sensorKind: "hive-native", provider, instanceRef: context.instanceRef },
    subject,
    observationType,
    severity,
    confidence,
    evidenceRefs,
    ...(context.correlationId !== undefined ? { correlationId: context.correlationId } : {}),
    dataClassification: "internal",
    // Hive-internal security facts stay in the Instance until a generalizer
    // and an explicit authorization say otherwise (§10, telemetry.ts gate).
    privacyScope: "instance-local",
    // These come from inside the Hive, from components with their own
    // integrity story — but the SENSOR is not separately attested, and
    // claiming it is would be the false-validator move.
    sourceAttested: false,
    attributes,
    adapterRef,
    ...(attackTechniqueRef !== undefined ? { attackTechniqueRef } : {}),
  });
}

/** A Governance decision that refused — the single most constitutionally
 * meaningful signal the Hive produces, because repeated refusals against one
 * subject is what an authority probe looks like from the inside. */
export function observeGovernanceRefusal(
  context: NativeSensorContext,
  input: {
    readonly subjectRef: string;
    readonly capabilityRequested: string;
    readonly refusalReason: string;
    readonly severity: Severity;
    readonly confidence: Confidence;
    readonly auditLocator: string;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.governance-engine",
    "adapter.governance.refusal@1.0.0",
    "governance-decision-refused",
    { kind: "capability", ref: input.capabilityRequested, label: input.subjectRef },
    input.severity,
    input.confidence,
    { subjectRef: input.subjectRef, refusalReason: input.refusalReason },
    [{ holder: "audit-iq", locator: input.auditLocator }],
  );
}

/** A Fabric route denied or failed. Denied is a policy event; failed is a
 * health event that can also be an attack signature — the caller says which,
 * because Fabric knows and Sentinel would be guessing. */
export function observeFabricRoute(
  context: NativeSensorContext,
  input: {
    readonly routeRef: string;
    readonly outcome: "denied" | "failed";
    readonly reason: string;
    readonly severity: Severity;
    readonly confidence: Confidence;
    readonly evidenceLocator: string;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.neural-fabric",
    "adapter.fabric.route@1.0.0",
    input.outcome === "denied" ? "fabric-route-denied" : "fabric-route-failed",
    { kind: "fabric-route", ref: input.routeRef },
    input.severity,
    input.confidence,
    { reason: input.reason },
    [{ holder: "fabric", locator: input.evidenceLocator }],
  );
}

/** Trust evidence going stale or failing — the Guard-side signal that gates
 * protected operations (§17, verifyTrustFreshness). */
export function observeTrustDegradation(
  context: NativeSensorContext,
  input: {
    readonly workloadRef: string;
    readonly reason: string;
    readonly severity: Severity;
    readonly confidence: Confidence;
    readonly evidenceLocator: string;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.security-iq",
    "adapter.trust.degradation@1.0.0",
    "trust-evidence-degraded",
    { kind: "workload", ref: input.workloadRef },
    input.severity,
    input.confidence,
    { reason: input.reason },
    [{ holder: "external", locator: input.evidenceLocator }],
  );
}

/** An integrity baseline mismatch — Guard's tamper evidence, including
 * Sentinel's own binaries and configuration (§27 self-defense). */
export function observeIntegrityMismatch(
  context: NativeSensorContext,
  input: {
    readonly artifactRef: string;
    readonly expectedDigest: string;
    readonly observedDigest: string;
    readonly isSentinelSelf: boolean;
    readonly severity: Severity;
    readonly confidence: Confidence;
  },
): ObservationAdmission {
  return native(
    context,
    input.isSentinelSelf ? "hive.sentineliq.self" : "hive.foundry-evolutioniq",
    "adapter.integrity.baseline@1.0.0",
    input.isSentinelSelf ? "sentinel-self-integrity-mismatch" : "integrity-baseline-mismatch",
    { kind: "artifact", ref: input.artifactRef },
    input.severity,
    input.confidence,
    { expectedDigest: input.expectedDigest, observedDigest: input.observedDigest },
    [],
  );
}

/** An AuditIQ chain verification failure. AuditIQ remains the authoritative
 * ledger — Sentinel observes that its chain did not verify, and does not
 * duplicate or repair it (§24: no parallel AuditIQ). */
export function observeAuditChainFailure(
  context: NativeSensorContext,
  input: {
    readonly ledgerRef: string;
    readonly brokenAtSequence: string;
    readonly severity: Severity;
    readonly evidenceLocator: string;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.auditiq",
    "adapter.audit.chain@1.0.0",
    "audit-chain-verification-failed",
    { kind: "data-store", ref: input.ledgerRef },
    input.severity,
    // A broken chain does not say WHO broke it; "probable" is the ceiling an
    // integrity failure alone can support.
    "probable",
    { brokenAtSequence: input.brokenAtSequence },
    [{ holder: "audit-iq", locator: input.evidenceLocator }],
  );
}

/** An AI agent asking for something outside its declared envelope (§28).
 * ARIA, internal agents and external connectors all route through here. */
export function observeAiEnvelopeExcursion(
  context: NativeSensorContext,
  input: {
    readonly agentRef: string;
    readonly capabilityRequested: string;
    readonly violation: string;
    readonly severity: Severity;
    readonly confidence: Confidence;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.model-runtime",
    "adapter.ai.envelope@1.0.0",
    "ai-capability-outside-envelope",
    { kind: "ai-agent", ref: input.agentRef },
    input.severity,
    input.confidence,
    { capabilityRequested: input.capabilityRequested, violation: input.violation },
    [],
  );
}

/** A prompt-injection attempt detected by the structural screen (§29). The
 * detected directives are NOT copied into the observation — they are the
 * attacker's text, and inlining it is how an injection reaches a second
 * reader. Only the count and the screening verdict travel. */
export function observePromptInjection(
  context: NativeSensorContext,
  input: {
    readonly agentRef: string;
    readonly inertDirectiveCount: number;
    readonly severity: Severity;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.model-runtime",
    "adapter.ai.injection@1.0.0",
    "prompt-injection-attempted",
    { kind: "ai-agent", ref: input.agentRef },
    input.severity,
    "confirmed", // the screen is deterministic: it either matched or it did not
    { inertDirectiveCount: String(input.inertDirectiveCount), directivesInlined: "false" },
    [],
  );
}

/** A cross-tenant access attempt — the isolation signal (§21.12 gate). */
export function observeCrossTenantAttempt(
  context: NativeSensorContext,
  input: {
    readonly subjectRef: string;
    readonly fromTenant: string;
    readonly towardTenant: string;
    readonly severity: Severity;
    readonly confidence: Confidence;
    readonly evidenceLocator: string;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.neural-fabric",
    "adapter.fabric.tenancy@1.0.0",
    "cross-tenant-access-attempted",
    { kind: "identity", ref: input.subjectRef },
    input.severity,
    input.confidence,
    { fromTenant: input.fromTenant, towardTenant: input.towardTenant },
    [{ holder: "fabric", locator: input.evidenceLocator }],
  );
}

/** Break-glass use (§21.7) — always observed, always high severity, because
 * the whole point of break-glass is that its use is visible afterwards. */
export function observeBreakGlassUse(
  context: NativeSensorContext,
  input: { readonly operatorRef: string; readonly reason: string; readonly recordRef: string },
): ObservationAdmission {
  return native(
    context,
    "hive.sentineliq",
    "adapter.operator.breakglass@1.0.0",
    "break-glass-used",
    { kind: "operator", ref: input.operatorRef },
    "high",
    "confirmed",
    { reason: input.reason, recordRef: input.recordRef },
    [{ holder: "audit-iq", locator: input.recordRef }],
  );
}

/** Chamber health transitions (§27) — Sentinel observing itself. */
export function observeChamberHealthChange(
  context: NativeSensorContext,
  input: {
    readonly chamber: "shield" | "guard";
    readonly from: string;
    readonly to: string;
    readonly severity: Severity;
  },
): ObservationAdmission {
  return native(
    context,
    "hive.sentineliq.self",
    "adapter.sentinel.chamber@1.0.0",
    "sentinel-chamber-health-changed",
    { kind: "engine", ref: `sentineliq.${input.chamber}` },
    input.severity,
    "confirmed",
    { from: input.from, to: input.to },
    [],
  );
}

/** The catalogue of native producers, so coverage (§12) can be computed over
 * what the Hive itself can see without any third-party sensor bound. */
export const HIVE_NATIVE_OBSERVATION_TYPES: readonly ObservationType[] = [
  "governance-decision-refused",
  "fabric-route-denied",
  "fabric-route-failed",
  "trust-evidence-degraded",
  "integrity-baseline-mismatch",
  "sentinel-self-integrity-mismatch",
  "audit-chain-verification-failed",
  "ai-capability-outside-envelope",
  "prompt-injection-attempted",
  "cross-tenant-access-attempted",
  "break-glass-used",
  "sentinel-chamber-health-changed",
];
