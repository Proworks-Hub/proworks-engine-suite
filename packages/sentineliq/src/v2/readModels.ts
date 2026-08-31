// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ChamberState, ConditionLevel } from "./chambers.js";
import type { ThreatDetection } from "./detection.js";
import type { ExposureGraph } from "./exposure.js";
import type { SecurityIncident } from "./incident.js";
import type { CollectionResult, SensorCoverage } from "./providers.js";

// ─────────────────────────────────────────────────────────────────────────────
// SOC read models — directive §21 (DEC-028 increment 3).
//
// "Do not build all UI now. Create clean read models/contracts first."
//
// These are PROJECTIONS: pure functions from state Sentinel already holds to
// shapes a workspace can render. No storage, no UI, no framework.
//
// THE RULE EVERY VIEW OBEYS: a view never presents a figure more confident
// than its evidence. Where coverage is partial, the view says so IN THE
// FIELD NAME (`atLeast…`, `…Unknown`), not in a footnote a renderer can
// drop — the same discipline as FinancialRiskIQ's contributedExposure. A
// dashboard that renders "0 threats" over a broken sensor feed is the exact
// failure this whole program exists to prevent, so "0" and "we could not
// look" are different types here, not different values.
// ─────────────────────────────────────────────────────────────────────────────

/** The one shared honesty field. Every view carries it. */
export interface ViewBasis {
  readonly complete: boolean;
  /** Named gaps, never a percentage. */
  readonly gaps: readonly string[];
  readonly statement: string;
}

function basisFrom(coverage: SensorCoverage, collection: CollectionResult | null): ViewBasis {
  const gaps = [
    ...coverage.unboundKinds.map((k) => `sensor kind unbound: ${k}`),
    ...coverage.unclaimedObservationTypes.map((t) => `no provider claims: ${t}`),
    ...(collection?.gaps.map((g) => `${g.providerRef} ${g.degraded ? "degraded" : "unavailable"}: ${g.reason}`) ?? []),
  ];
  const complete = gaps.length === 0;
  return {
    complete,
    gaps,
    statement: complete
      ? "every declared sensor answered; this view is over a complete observation set"
      : `this view is over an INCOMPLETE observation set — ${gaps.length} named gap(s); counts are lower bounds and an absence of findings is not an absence of activity`,
  };
}

// ── SECURITY OVERVIEW ───────────────────────────────────────────────────────

export interface SecurityOverviewView {
  readonly conditionLevel: ConditionLevel;
  readonly chambers: readonly ChamberState[];
  readonly openIncidentCount: number;
  readonly atLeastActiveDetections: number;
  readonly highestOpenSeverity: string | null;
  readonly basis: ViewBasis;
}

export function securityOverview(input: {
  readonly conditionLevel: ConditionLevel;
  readonly chambers: readonly ChamberState[];
  readonly incidents: readonly SecurityIncident[];
  readonly detections: readonly ThreatDetection[];
  readonly coverage: SensorCoverage;
  readonly collection: CollectionResult | null;
}): SecurityOverviewView {
  const open = input.incidents.filter((i) => i.status !== "closed" && i.status !== "closed-false-positive");
  const order = ["informational", "low", "moderate", "high", "catastrophic"];
  const highest = open.reduce<string | null>(
    (acc, i) => (acc === null || order.indexOf(i.severity) > order.indexOf(acc) ? i.severity : acc),
    null,
  );
  return {
    conditionLevel: input.conditionLevel,
    chambers: input.chambers,
    openIncidentCount: open.length,
    // `atLeast` in the NAME: over a partial view this is a floor, and the
    // renderer cannot drop the qualification because it is the field.
    atLeastActiveDetections: input.detections.length,
    highestOpenSeverity: highest,
    basis: basisFrom(input.coverage, input.collection),
  };
}

// ── ACTIVE INCIDENTS ────────────────────────────────────────────────────────

export interface IncidentRow {
  readonly incidentId: string;
  readonly status: string;
  readonly severity: string;
  readonly confidence: string;
  readonly affectedSubjectCount: number;
  readonly deterministicallySupported: boolean;
  /** What this incident may request — surfaced so an operator sees the
   * ceiling before proposing an action that would be refused. */
  readonly maxRequestableRung: string;
  readonly openedAt: string;
  readonly containmentInForce: boolean;
}

export function activeIncidents(
  incidents: readonly SecurityIncident[],
  maxRung: (incident: SecurityIncident) => string,
): readonly IncidentRow[] {
  const order = ["informational", "low", "moderate", "high", "catastrophic"];
  return incidents
    .filter((i) => i.status !== "closed" && i.status !== "closed-false-positive")
    .map((i) => ({
      incidentId: i.incidentId,
      status: i.status,
      severity: i.severity,
      confidence: i.confidence,
      affectedSubjectCount: i.affectedSubjectRefs.length,
      deterministicallySupported: i.deterministicallySupported,
      maxRequestableRung: maxRung(i),
      openedAt: i.openedAt,
      containmentInForce: i.containmentActionIds.length > 0,
    }))
    .sort((a, b) => {
      const bySeverity = order.indexOf(b.severity) - order.indexOf(a.severity);
      return bySeverity !== 0 ? bySeverity : a.openedAt < b.openedAt ? -1 : 1;
    });
}

// ── THREAT ACTIVITY ─────────────────────────────────────────────────────────

export interface ThreatActivityView {
  readonly byMethod: Readonly<Record<string, number>>;
  readonly byTechnique: Readonly<Record<string, number>>;
  /** Detections that cannot gate — shown SEPARATELY so an operator never
   * reads an advisory pile as an actionable one. */
  readonly nonGatingCount: number;
  readonly atLeastTotal: number;
  readonly basis: ViewBasis;
}

export function threatActivity(
  detections: readonly ThreatDetection[],
  coverage: SensorCoverage,
  collection: CollectionResult | null,
): ThreatActivityView {
  const byMethod: Record<string, number> = {};
  const byTechnique: Record<string, number> = {};
  for (const d of detections) {
    byMethod[d.method] = (byMethod[d.method] ?? 0) + 1;
    for (const t of d.attackTechniqueRefs) byTechnique[t] = (byTechnique[t] ?? 0) + 1;
  }
  return {
    byMethod,
    byTechnique,
    nonGatingCount: detections.filter((d) => !d.gateEligible).length,
    atLeastTotal: detections.length,
    basis: basisFrom(coverage, collection),
  };
}

// ── ATTACK SURFACE ──────────────────────────────────────────────────────────

export interface AttackSurfaceView {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly byNodeKind: Readonly<Record<string, number>>;
  readonly graphComplete: boolean;
  readonly unprojectedSources: readonly string[];
  readonly statement: string;
}

export function attackSurface(graph: ExposureGraph): AttackSurfaceView {
  const byNodeKind: Record<string, number> = {};
  for (const n of graph.nodes) byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;
  const complete = graph.unprojectedSources.length === 0;
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    byNodeKind,
    graphComplete: complete,
    unprojectedSources: graph.unprojectedSources,
    statement: complete
      ? "graph projected from every declared source"
      : `graph INCOMPLETE — ${graph.unprojectedSources.join(", ")} unprojected; reachability answers over it are lower bounds`,
  };
}

// ── SENSOR / HOST SECURITY COVERAGE ─────────────────────────────────────────

export interface CoverageView {
  readonly boundSensorKinds: readonly string[];
  readonly unboundSensorKinds: readonly string[];
  readonly blindSpots: readonly string[];
  /** Deliberately absent: any single coverage percentage. The peer session's
   * fleet-health denominator bug is the same failure in another module. */
  readonly statement: string;
}

export function coverageView(coverage: SensorCoverage): CoverageView {
  return {
    boundSensorKinds: coverage.boundKinds,
    unboundSensorKinds: coverage.unboundKinds,
    blindSpots: coverage.unclaimedObservationTypes,
    statement: coverage.coverageStatement,
  };
}

// ── AI SECURITY ─────────────────────────────────────────────────────────────

export interface AiSecurityView {
  readonly atLeastEnvelopeExcursions: number;
  readonly atLeastInjectionAttempts: number;
  readonly aiProposedDetections: number;
  /** Always zero by construction; rendered so the property is VISIBLE rather
   * than merely true. A non-zero value here is a defect in this engine. */
  readonly aiGatedActions: 0;
  readonly basis: ViewBasis;
}

export function aiSecurity(
  detections: readonly ThreatDetection[],
  coverage: SensorCoverage,
  collection: CollectionResult | null,
): AiSecurityView {
  return {
    atLeastEnvelopeExcursions: detections.filter((d) => d.observationTypes.includes("ai-capability-outside-envelope")).length,
    atLeastInjectionAttempts: detections.filter((d) => d.observationTypes.includes("prompt-injection-attempted")).length,
    aiProposedDetections: detections.filter((d) => d.aiAssist !== null).length,
    aiGatedActions: 0,
    basis: basisFrom(coverage, collection),
  };
}

// ── FORENSICS / RECOVERY readiness ──────────────────────────────────────────

export interface RecoveryReadinessView {
  readonly incidentsAwaitingRecovery: number;
  readonly incidentsAwaitingAuthorityReview: number;
  /** Incidents closed without recovery evidence: structurally always zero,
   * because transitionIncident refuses. Rendered to make it checkable. */
  readonly closedWithoutRecoveryEvidence: number;
}

export function recoveryReadiness(incidents: readonly SecurityIncident[]): RecoveryReadinessView {
  return {
    incidentsAwaitingRecovery: incidents.filter((i) => i.status === "contained").length,
    incidentsAwaitingAuthorityReview: incidents.filter((i) => i.status === "recovering").length,
    closedWithoutRecoveryEvidence: incidents.filter((i) => i.status === "closed" && i.auditRefs.length === 0).length,
  };
}

/** The view catalogue (§21's fifteen). Names only — the ones without a
 * projection above are declared MISSING rather than silently absent, so the
 * SOC surface's own gaps are visible in the same way everything else is. */
export const SOC_VIEWS = [
  { view: "security-overview", projection: "securityOverview" },
  { view: "active-incidents", projection: "activeIncidents" },
  { view: "threat-activity", projection: "threatActivity" },
  { view: "attack-surface", projection: "attackSurface" },
  { view: "hive-security-posture", projection: null },
  { view: "instance-security", projection: null },
  { view: "ai-security", projection: "aiSecurity" },
  { view: "fabric-security", projection: null },
  { view: "identity-trust", projection: null },
  { view: "runtime-security", projection: null },
  { view: "supply-chain", projection: null },
  { view: "host-security", projection: "coverageView" },
  { view: "forensics", projection: null },
  { view: "recovery", projection: "recoveryReadiness" },
  { view: "compliance-evidence", projection: null },
] as const;
