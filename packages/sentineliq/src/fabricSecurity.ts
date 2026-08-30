// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

/*
 * File:    packages/sentineliq/src/fabricSecurity.ts
 * Module:  sentineliq
 * Purpose: Watching the Fabric's adapters without becoming part of the Fabric.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// SENTINEL DOES NOT BECOME A ROUTER
//
// The addendum ends with that line and it is the constraint the whole file is
// built around. The obvious way to protect a message path is to put yourself
// in it — inspect every message, block the bad ones. That design fails twice:
// Sentinel becomes a availability dependency of every conversation in the
// Hive, and its independence evaporates, because a component inside the path
// is observing its own effects.
//
// So nothing here moves, blocks or delays a message. Sentinel receives
// minimized findings the Fabric emits, evaluates them against its own model,
// and REQUESTS containment through Governance. The request is a
// recommendation with evidence attached; the enforcement is somebody else's
// decision and somebody else's code.
//
// THE FOUR THINGS A COMPROMISED ADAPTER MUST NEVER MANAGE
//
// The addendum names them: write control-plane topology, widen its own
// manifest, access arbitrary secrets, suppress independent evidence, bypass
// Interconnect. Each is expressed below as a containment invariant with a
// detector, because "must never" without a detector is a hope.
//
// The last one is the subtle one. An adapter that can stop evidence reaching
// Sentinel has defeated Sentinel completely, and it does not need to break
// anything else to do it. That is why evidence silence is itself a finding
// (`detectEvidenceSuppression`) rather than an absence nobody notices.
// ─────────────────────────────────────────────────────────────────────────────

/** Fabric-specific threat classes Sentinel watches for. */
export const fabricThreatKindSchema = z.enum([
  "ADAPTER_INTEGRITY_MISMATCH",
  "ADAPTER_CAPABILITY_DRIFT",
  "ROUTE_PLAN_TAMPER",
  "TOPOLOGY_TAMPER",
  "PROTOCOL_DOWNGRADE",
  "CROSS_TENANT_MAPPING_ANOMALY",
  "MALICIOUS_TRACE_CONTEXT",
  "RETRY_AMPLIFICATION",
  "EDGE_IDENTITY_ABUSE",
  "SUPPLY_CHAIN_ADVISORY",
  "SANDBOX_ESCAPE_INDICATOR",
  "EVIDENCE_SUPPRESSION",
]);
export type FabricThreatKind = z.infer<typeof fabricThreatKindSchema>;

/** What Sentinel may ask for. None of these is applied by Sentinel. */
export const containmentRequestKindSchema = z.enum([
  /** Stop using this adapter; fall back to another that serves the pattern. */
  "QUARANTINE_ADAPTER",
  /** Suspend a specific route while it is investigated. */
  "SUSPEND_ROUTE",
  /** Suspend a cross-instance relationship. */
  "SUSPEND_INTERCONNECT_GRANT",
  /** Raise the security posture, which tightens everything downstream. */
  "RAISE_POSTURE",
  /** Nothing automated; a human should look. */
  "INVESTIGATE_ONLY",
]);
export type ContainmentRequestKind = z.infer<typeof containmentRequestKindSchema>;

export const fabricFindingSchema = z
  .object({
    findingId: z.string().min(1),
    threat: fabricThreatKindSchema,
    severity: z.enum(["informational", "low", "medium", "high", "critical"]),
    confidence: z.enum(["suspected", "probable", "confirmed"]),
    /** What the finding is about: an adapter, a route, a grant, a tenant pair. */
    subjectId: z.string().min(1),
    subjectKind: z.enum(["adapter", "route", "topology", "grant", "trace", "edge_client", "mapping"]),
    /** References to Fabric evidence. Never the evidence content itself. */
    evidenceRefs: z.array(z.string().min(1)).min(1).max(32),
    summary: z.string().min(1),
    /** What Sentinel would like done. A request, never an action. */
    requestedContainment: containmentRequestKindSchema,
    /** Why this containment and not a stronger one. */
    containmentRationale: z.string().min(1),
    observedAt: z.string().min(1),
    isTest: z.boolean(),
  })
  .strict();
export type FabricFinding = z.infer<typeof fabricFindingSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Detectors. Each takes observations and returns findings; none takes an
// action, and none can — there is no port here through which one could.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdapterObservation {
  readonly adapterId: string;
  readonly version: string;
  /** Digest recorded when the adapter was admitted. */
  readonly admittedDigest: string;
  /** Digest observed on the running artifact now. */
  readonly runningDigest: string;
  /** Capabilities the admission covered. */
  readonly admittedCapabilities: readonly string[];
  /** Capabilities the running manifest claims now. */
  readonly claimedCapabilities: readonly string[];
  /** Advisories published against this version since admission. */
  readonly newAdvisories: readonly string[];
  readonly observedAt: string;
  readonly isTest: boolean;
}

/**
 * Integrity and drift, checked against what was ADMITTED rather than against
 * what the adapter currently says about itself.
 *
 * Comparing an adapter to its own current manifest would always agree — a
 * compromised adapter updates its manifest first. The admission record is the
 * only fixed point, which is why it is the baseline here.
 */
export function detectAdapterAnomalies(observation: AdapterObservation): readonly FabricFinding[] {
  const findings: FabricFinding[] = [];
  const base = {
    subjectId: `${observation.adapterId}@${observation.version}`,
    subjectKind: "adapter" as const,
    observedAt: observation.observedAt,
    isTest: observation.isTest,
  };

  if (observation.runningDigest !== observation.admittedDigest) {
    findings.push({
      ...base,
      findingId: `f-integrity-${observation.adapterId}`,
      threat: "ADAPTER_INTEGRITY_MISMATCH",
      severity: "critical",
      confidence: "confirmed",
      evidenceRefs: [`digest:admitted=${observation.admittedDigest}`, `digest:running=${observation.runningDigest}`],
      summary: `The running artifact does not match the one admitted. Admission covered ${observation.admittedDigest}; ${observation.runningDigest} is executing. Whatever the explanation, the approval on record is not an approval of this code.`,
      requestedContainment: "QUARANTINE_ADAPTER",
      containmentRationale:
        "Quarantine rather than investigate-only: an integrity mismatch is either a compromise or a deployment that bypassed admission, and both mean unreviewed code is currently in the message path.",
    });
  }

  const admitted = new Set(observation.admittedCapabilities);
  const drift = observation.claimedCapabilities.filter((c) => !admitted.has(c));
  if (drift.length > 0) {
    findings.push({
      ...base,
      findingId: `f-drift-${observation.adapterId}`,
      threat: "ADAPTER_CAPABILITY_DRIFT",
      severity: "high",
      confidence: "confirmed",
      evidenceRefs: [`capabilities:admitted=${observation.admittedCapabilities.join("|")}`, `capabilities:claimed=${observation.claimedCapabilities.join("|")}`],
      summary: `The adapter now claims ${drift.join(", ")}, which its admission did not cover. Capability acquired between reviews is capability nobody granted.`,
      requestedContainment: "QUARANTINE_ADAPTER",
      containmentRationale:
        "The drift may be an honest packaging mistake, but the safe order is to stop using the wider claim and then find out — the reverse order runs unreviewed capability while the question is answered.",
    });
  }

  if (observation.newAdvisories.length > 0) {
    findings.push({
      ...base,
      findingId: `f-advisory-${observation.adapterId}`,
      threat: "SUPPLY_CHAIN_ADVISORY",
      severity: "medium",
      confidence: "confirmed",
      evidenceRefs: observation.newAdvisories.map((a) => `advisory:${a}`),
      summary: `${observation.newAdvisories.length} advisory/advisories published against this version since admission: ${observation.newAdvisories.join(", ")}.`,
      requestedContainment: "INVESTIGATE_ONLY",
      containmentRationale:
        "An advisory is not automatically exploitable in this deployment, and quarantining every adapter on every CVE would train operators to ignore Sentinel. A human decides whether this one reaches us.",
    });
  }

  return findings;
}

export interface TraceObservation {
  readonly boundary: "INGRESS" | "EGRESS";
  /** Trace context keys seen crossing the boundary. */
  readonly contextKeys: readonly string[];
  readonly sourceInstanceId: string;
  readonly observedAt: string;
  readonly isTest: boolean;
}

/** Keys that must never arrive from outside. Mirrors the Fabric's allowlist. */
const TRACE_ALLOWED_INBOUND: readonly string[] = Object.freeze(["traceparent", "tracestate"]);

/**
 * Malicious trace context, judged independently of the Fabric.
 *
 * The Fabric's pipeline already sanitizes. Sentinel checks anyway, and that
 * duplication is the design: independent verification means verifying with
 * your own eyes, not confirming that the component under observation says it
 * did its job.
 */
export function detectTraceInjection(observation: TraceObservation): readonly FabricFinding[] {
  if (observation.boundary !== "INGRESS") return [];
  const unexpected = observation.contextKeys.filter((k) => !TRACE_ALLOWED_INBOUND.includes(k.trim().toLowerCase()));
  if (unexpected.length === 0) return [];

  return [
    {
      findingId: `f-trace-${observation.sourceInstanceId}`,
      threat: "MALICIOUS_TRACE_CONTEXT",
      severity: unexpected.some((k) => k.trim().toLowerCase() === "baggage") ? "high" : "medium",
      confidence: "confirmed",
      subjectId: observation.sourceInstanceId,
      subjectKind: "trace",
      evidenceRefs: [`trace-keys:${unexpected.join("|")}`],
      summary: `Inbound trace context carried ${unexpected.join(", ")}, which the allowlist does not include. Baggage is a key-value store the sender controls, and an internal consumer that trusts trace context will trust whatever was written there.`,
      requestedContainment: "INVESTIGATE_ONLY",
      containmentRationale:
        "The pipeline should already have stripped these. Their arrival at the observation point means either a sanitize stage is missing from a plan or an adapter is not honouring it — both are configuration findings rather than grounds to suspend traffic.",
      observedAt: observation.observedAt,
      isTest: observation.isTest,
    },
  ];
}

export interface RetryObservation {
  readonly routeId: string;
  readonly attemptsInWindow: number;
  readonly distinctMessagesInWindow: number;
  readonly windowSeconds: number;
  readonly observedAt: string;
  readonly isTest: boolean;
}

/**
 * Retry amplification: many attempts, few distinct messages.
 *
 * The ratio is the signal, not the volume. A busy route with a million
 * attempts across a million messages is healthy; ten thousand attempts across
 * three messages is a retry storm pointed at whatever is downstream, and the
 * component generating it usually believes it is being resilient.
 */
export function detectRetryAmplification(
  observation: RetryObservation,
  amplificationThreshold = 10,
): readonly FabricFinding[] {
  if (observation.distinctMessagesInWindow === 0) return [];
  const ratio = observation.attemptsInWindow / observation.distinctMessagesInWindow;
  if (ratio < amplificationThreshold) return [];

  return [
    {
      findingId: `f-retry-${observation.routeId}`,
      threat: "RETRY_AMPLIFICATION",
      severity: ratio >= amplificationThreshold * 5 ? "high" : "medium",
      confidence: "probable",
      subjectId: observation.routeId,
      subjectKind: "route",
      evidenceRefs: [`retry-ratio:${ratio.toFixed(1)}`, `window:${observation.windowSeconds}s`],
      summary: `${observation.attemptsInWindow} attempts across ${observation.distinctMessagesInWindow} distinct message(s) in ${observation.windowSeconds}s — a ratio of ${ratio.toFixed(1)}. Retry budgets exist to bound exactly this, so either one is missing or one is being ignored.`,
      requestedContainment: "SUSPEND_ROUTE",
      containmentRationale:
        "Amplification harms the destination more than the source and grows until something breaks. Suspending the route is reversible; the downstream outage it prevents may not be.",
      observedAt: observation.observedAt,
      isTest: observation.isTest,
    },
  ];
}

export interface MappingObservation {
  readonly mappingContractId: string;
  /** Tenant the data came from. */
  readonly sourceTenantId: string;
  /** Tenant the mapped result was delivered to. */
  readonly destinationTenantId: string;
  readonly classification: string;
  readonly observedAt: string;
  readonly isTest: boolean;
}

/**
 * Cross-tenant mapping: private data of one tenant reaching another.
 *
 * Almost always a mistake rather than an attack — a mapping contract reused
 * for a second tenant, a test fixture left wired to production. It is
 * critical anyway, because the consequence does not care about the intent.
 */
export function detectCrossTenantMapping(observation: MappingObservation): readonly FabricFinding[] {
  if (observation.sourceTenantId === observation.destinationTenantId) return [];
  if (observation.classification === "PUBLIC") return [];

  return [
    {
      findingId: `f-crosstenant-${observation.mappingContractId}`,
      threat: "CROSS_TENANT_MAPPING_ANOMALY",
      severity: "critical",
      confidence: "confirmed",
      subjectId: observation.mappingContractId,
      subjectKind: "mapping",
      // Tenant ids are the finding, so they are named here — this record goes
      // to Sentinel inside one instance, not into cross-instance knowledge.
      evidenceRefs: [`tenants:${observation.sourceTenantId}->${observation.destinationTenantId}`, `classification:${observation.classification}`],
      summary: `A mapping carried ${observation.classification} data from tenant ${observation.sourceTenantId} to ${observation.destinationTenantId}. Whether or not it was intended, one tenant's data is now in another's system.`,
      requestedContainment: "SUSPEND_ROUTE",
      containmentRationale:
        "Stop the flow first. A cross-tenant leak gets worse every second it continues, and unlike most findings it cannot be undone by deciding later that it was fine.",
      observedAt: observation.observedAt,
      isTest: observation.isTest,
    },
  ];
}

export interface EvidenceFlowObservation {
  readonly adapterId: string;
  /** Failures the Fabric's own counters recorded. */
  readonly failuresObserved: number;
  /** Evidence records that actually reached Sentinel. */
  readonly evidenceReceived: number;
  readonly windowSeconds: number;
  readonly observedAt: string;
  readonly isTest: boolean;
}

/**
 * Silence where evidence should be.
 *
 * An adapter that can suppress evidence has defeated every other detector in
 * this file without triggering any of them. Absence is not usually alarming,
 * which is exactly why it needs a detector of its own — nobody investigates a
 * quiet dashboard.
 */
export function detectEvidenceSuppression(observation: EvidenceFlowObservation): readonly FabricFinding[] {
  if (observation.failuresObserved === 0) return [];
  if (observation.evidenceReceived >= observation.failuresObserved) return [];

  const missing = observation.failuresObserved - observation.evidenceReceived;
  return [
    {
      findingId: `f-suppression-${observation.adapterId}`,
      threat: "EVIDENCE_SUPPRESSION",
      severity: observation.evidenceReceived === 0 ? "critical" : "high",
      confidence: observation.evidenceReceived === 0 ? "probable" : "suspected",
      subjectId: observation.adapterId,
      subjectKind: "adapter",
      evidenceRefs: [`failures:${observation.failuresObserved}`, `evidence:${observation.evidenceReceived}`, `window:${observation.windowSeconds}s`],
      summary: `${observation.failuresObserved} failure(s) were counted and ${observation.evidenceReceived} evidence record(s) arrived — ${missing} missing. Evidence loss can be an outage in the sink, and it can also be an adapter that has learned it is being watched.`,
      requestedContainment: observation.evidenceReceived === 0 ? "QUARANTINE_ADAPTER" : "INVESTIGATE_ONLY",
      containmentRationale:
        observation.evidenceReceived === 0
          ? "Total silence while failures accumulate is the signature of suppression rather than of a lossy sink, and an unwatchable component in the message path cannot be left there while the question is settled."
          : "Partial loss is more often a sink problem than an adversary. A human should compare against the sink's own health before anything is quarantined.",
      observedAt: observation.observedAt,
      isTest: observation.isTest,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Containment invariants — the addendum's "must never" list, with detectors.
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel observes and requests. It never moves a message. */
export function sentinelRoutesTraffic(): false {
  return false;
}

/** Sentinel requests containment; Governance grants or refuses it. */
export function sentinelAppliesContainment(): false {
  return false;
}

/** Security IQ owns crypto and trust roots. Sentinel holds no key material. */
export function sentinelHoldsTrustRoot(): false {
  return false;
}

/**
 * The five things a compromised adapter must never achieve, each paired with
 * what actually prevents it. Exported so certification can assert the list
 * rather than a reviewer remembering it.
 */
export const ADAPTER_CONTAINMENT_INVARIANTS: readonly { readonly invariant: string; readonly enforcedBy: string }[] =
  Object.freeze([
    {
      invariant: "A compromised adapter cannot write control-plane topology.",
      enforcedBy:
        "The adapter manifest schema refuses requiresControlPlaneWrite outright, and topology activation needs a verified signature plus a governance decision that no adapter can produce.",
    },
    {
      invariant: "A compromised adapter cannot widen its own manifest.",
      enforcedBy:
        "Admission is version- and digest-specific; describeWidening surfaces additions across versions, and detectAdapterAnomalies compares the running artifact against the ADMITTED record rather than against the adapter's current self-description.",
    },
    {
      invariant: "A compromised adapter cannot reach arbitrary secrets.",
      enforcedBy:
        "The Fabric holds no key material; signing and verification go through Security IQ ports, and the manifest must declare every privilege it needs.",
    },
    {
      invariant: "A compromised adapter cannot suppress independent evidence.",
      enforcedBy: "detectEvidenceSuppression treats silence during known failures as a finding in its own right.",
    },
    {
      invariant: "A compromised adapter cannot bypass Interconnect.",
      enforcedBy:
        "Cross-instance is a single pattern that terminates at a gateway; the planner has no branch producing a direct cross-instance path, and zone rules refuse one structurally.",
    },
  ]);
