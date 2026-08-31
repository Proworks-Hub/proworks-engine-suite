// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Confidence, Severity } from "../finding.js";
import type { ConditionLevel } from "./chambers.js";
import type { ThreatDetection } from "./detection.js";
import type { BlastRadius } from "./exposure.js";

// ─────────────────────────────────────────────────────────────────────────────
// IncidentIQ — directive §20 (DEC-028 increment 3).
//
// "Many observations/findings may belong to one incident." Correlation is
// what turns a stream of detections into a thing a person can work.
//
// THE RULES THIS FILE ENFORCES:
//
// 1. CORRELATION IS EVIDENCE-LINKED, NOT INFERRED. Detections join an
//    incident on a WITNESSED relationship — the same subject, a subject the
//    exposure graph shows reachable from another member, or a shared
//    correlationId. "These happened around the same time" is not a link, and
//    a time-only join is what produces incidents nobody can act on.
//
// 2. SEVERITY RISES, IT DOES NOT FALL. An incident is at least as severe as
//    its worst member. Downgrading requires a human decision with a reason —
//    an incident that quietly de-escalated itself is how a real one gets
//    closed at 3am.
//
// 3. AN INCIDENT'S CONFIDENCE IS ITS WEAKEST GATE-ELIGIBLE MEMBER'S. An
//    incident built only from non-gating (AI-proposed, lossy) detections is
//    marked `deterministicallySupported: false`, and no containment above the
//    challenge rung may be requested from it.
//
// 4. STATE MOVES FORWARD THROUGH THE IMMUNE PROTOCOL. Closing requires the
//    review step — §21.6's tenth step, "verify no defensive action silently
//    expanded Sentinel authority", is not an optional epilogue.
// ─────────────────────────────────────────────────────────────────────────────

export const INCIDENT_STATUSES = [
  "open", // detected, not yet independently verified
  "verified", // Guard-side verification passed
  "contained", // a containment action is in force
  "recovering", // rebuild/rotation/re-attestation under way
  "closed", // recovered AND reviewed
  "closed-false-positive", // a human declared it; becomes a benchmark scenario
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export interface HumanDecision {
  readonly decidedBy: string; // human.
  readonly decision: string;
  readonly reason: string;
  readonly at: string;
  readonly governanceDecisionRef?: string;
}

export interface SecurityIncident {
  readonly incidentId: string;
  readonly status: IncidentStatus;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** The condition level this incident argues for — a REQUEST, never a set. */
  readonly requestedConditionLevel: ConditionLevel | null;
  readonly affectedSubjectRefs: readonly string[];
  readonly detectionIds: readonly string[];
  readonly observationIds: readonly string[];
  /** Ordered, append-only. */
  readonly timeline: readonly { at: string; entry: string; actor: string }[];
  readonly blastRadius: BlastRadius | null;
  readonly containmentActionIds: readonly string[];
  readonly humanDecisions: readonly HumanDecision[];
  readonly governanceDecisionRefs: readonly string[];
  readonly auditRefs: readonly string[];
  /** False when every member detection is non-gating (AI-proposed or lossy). */
  readonly deterministicallySupported: boolean;
  readonly openedAt: string;
  readonly lastUpdatedAt: string;
}

const SEVERITY_ORDER: readonly Severity[] = ["informational", "low", "moderate", "high", "catastrophic"];
const CONFIDENCE_ORDER: Record<Confidence, number> = { suspected: 0, probable: 1, confirmed: 2 };

/** The witnessed relationships that justify joining two detections. Time
 * proximity is deliberately absent. */
export type CorrelationBasis =
  | { readonly kind: "same-subject"; readonly subjectRef: string }
  | { readonly kind: "shared-correlation-id"; readonly correlationId: string }
  | { readonly kind: "graph-reachable"; readonly fromRef: string; readonly toRef: string; readonly hops: number };

export interface CorrelationInput {
  readonly detection: ThreatDetection;
  /** Subjects the exposure graph shows this detection's subject can reach.
   * Supplied — Sentinel does not re-derive the graph here. */
  readonly reachableSubjectRefs?: readonly string[];
  readonly correlationId?: string;
}

export interface CorrelationResult {
  readonly groups: readonly {
    readonly members: readonly ThreatDetection[];
    readonly bases: readonly CorrelationBasis[];
  }[];
  /** Detections that joined nothing. Never silently merged into the nearest
   * group — an unlinked detection is its own single-member incident. */
  readonly unlinked: readonly ThreatDetection[];
}

/**
 * Union-find over WITNESSED relationships only. Two detections join when they
 * share a subject, share an explicit correlation id, or when one's subject is
 * reachable from the other's according to a supplied graph projection.
 */
export function correlateDetections(inputs: readonly CorrelationInput[]): CorrelationResult {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const input of inputs) parent.set(input.detection.detectionId, input.detection.detectionId);

  const bases = new Map<string, CorrelationBasis[]>();
  const noteBasis = (id: string, basis: CorrelationBasis): void => {
    const list = bases.get(id) ?? [];
    list.push(basis);
    bases.set(id, list);
  };

  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const a = inputs[i]!;
      const b = inputs[j]!;
      if (a.detection.subjectRef === b.detection.subjectRef) {
        union(a.detection.detectionId, b.detection.detectionId);
        noteBasis(find(a.detection.detectionId), { kind: "same-subject", subjectRef: a.detection.subjectRef });
        continue;
      }
      if (a.correlationId !== undefined && a.correlationId === b.correlationId) {
        union(a.detection.detectionId, b.detection.detectionId);
        noteBasis(find(a.detection.detectionId), { kind: "shared-correlation-id", correlationId: a.correlationId });
        continue;
      }
      const aReachesB = a.reachableSubjectRefs?.includes(b.detection.subjectRef) === true;
      const bReachesA = b.reachableSubjectRefs?.includes(a.detection.subjectRef) === true;
      if (aReachesB || bReachesA) {
        union(a.detection.detectionId, b.detection.detectionId);
        noteBasis(find(a.detection.detectionId), {
          kind: "graph-reachable",
          fromRef: aReachesB ? a.detection.subjectRef : b.detection.subjectRef,
          toRef: aReachesB ? b.detection.subjectRef : a.detection.subjectRef,
          hops: 1,
        });
      }
    }
  }

  const byRoot = new Map<string, ThreatDetection[]>();
  for (const input of inputs) {
    const root = find(input.detection.detectionId);
    const list = byRoot.get(root) ?? [];
    list.push(input.detection);
    byRoot.set(root, list);
  }
  const groups: { members: ThreatDetection[]; bases: CorrelationBasis[] }[] = [];
  const unlinked: ThreatDetection[] = [];
  for (const [root, members] of byRoot) {
    if (members.length === 1) unlinked.push(members[0]!);
    else groups.push({ members: members.sort((a, b) => (a.detectionId < b.detectionId ? -1 : 1)), bases: bases.get(root) ?? [] });
  }
  return {
    groups: groups.sort((a, b) => (a.members[0]!.detectionId < b.members[0]!.detectionId ? -1 : 1)),
    unlinked: unlinked.sort((a, b) => (a.detectionId < b.detectionId ? -1 : 1)),
  };
}

/** Open an incident from correlated detections. Severity is the worst
 * member's; confidence is the weakest's; deterministic support is true only
 * if at least one member could gate. */
export function openIncident(input: {
  readonly incidentId: string;
  readonly detections: readonly ThreatDetection[];
  readonly openedAt: string;
  readonly requestedConditionLevel?: ConditionLevel;
  readonly blastRadius?: BlastRadius;
}): SecurityIncident {
  const severity = input.detections.reduce<Severity>(
    (acc, d) => (SEVERITY_ORDER.indexOf(d.severity) > SEVERITY_ORDER.indexOf(acc) ? d.severity : acc),
    "informational",
  );
  const confidence = input.detections.reduce<Confidence>(
    (acc, d) => (CONFIDENCE_ORDER[d.confidence] < CONFIDENCE_ORDER[acc] ? d.confidence : acc),
    "confirmed",
  );
  return {
    incidentId: input.incidentId,
    status: "open",
    severity,
    confidence,
    requestedConditionLevel: input.requestedConditionLevel ?? null,
    affectedSubjectRefs: [...new Set(input.detections.map((d) => d.subjectRef))].sort(),
    detectionIds: input.detections.map((d) => d.detectionId).sort(),
    observationIds: [...new Set(input.detections.flatMap((d) => d.observationIds))].sort(),
    timeline: [{ at: input.openedAt, entry: `incident opened from ${input.detections.length} detection(s)`, actor: "sentinel.shield" }],
    blastRadius: input.blastRadius ?? null,
    containmentActionIds: [],
    humanDecisions: [],
    governanceDecisionRefs: [],
    auditRefs: [],
    deterministicallySupported: input.detections.some((d) => d.gateEligible),
    openedAt: input.openedAt,
    lastUpdatedAt: input.openedAt,
  };
}

export type IncidentUpdateOutcome =
  | { readonly ok: true; readonly incident: SecurityIncident }
  | { readonly ok: false; readonly reason: string };

/** Adding a detection can only RAISE severity. An incident that quietly
 * de-escalated itself is how a real one gets closed at three in the morning. */
export function addDetection(incident: SecurityIncident, detection: ThreatDetection, at: string): SecurityIncident {
  const severity =
    SEVERITY_ORDER.indexOf(detection.severity) > SEVERITY_ORDER.indexOf(incident.severity) ? detection.severity : incident.severity;
  const confidence =
    CONFIDENCE_ORDER[detection.confidence] < CONFIDENCE_ORDER[incident.confidence] ? detection.confidence : incident.confidence;
  return {
    ...incident,
    severity,
    confidence,
    affectedSubjectRefs: [...new Set([...incident.affectedSubjectRefs, detection.subjectRef])].sort(),
    detectionIds: [...new Set([...incident.detectionIds, detection.detectionId])].sort(),
    observationIds: [...new Set([...incident.observationIds, ...detection.observationIds])].sort(),
    timeline: [...incident.timeline, { at, entry: `detection ${detection.detectionId} joined`, actor: "sentinel.shield" }],
    deterministicallySupported: incident.deterministicallySupported || detection.gateEligible,
    lastUpdatedAt: at,
  };
}

/** Lowering severity requires a HUMAN with a reason. There is no automatic
 * path, and Sentinel cannot take one. */
export function downgradeSeverity(
  incident: SecurityIncident,
  to: Severity,
  decision: HumanDecision,
): IncidentUpdateOutcome {
  if (SEVERITY_ORDER.indexOf(to) >= SEVERITY_ORDER.indexOf(incident.severity)) {
    return { ok: false, reason: "downgradeSeverity only lowers; raising happens automatically as evidence arrives." };
  }
  if (!decision.decidedBy.startsWith("human.") || decision.reason.trim() === "") {
    return { ok: false, reason: "Lowering an incident's severity needs a named human and a reason; there is no automatic de-escalation." };
  }
  return {
    ok: true,
    incident: {
      ...incident,
      severity: to,
      humanDecisions: [...incident.humanDecisions, decision],
      timeline: [...incident.timeline, { at: decision.at, entry: `severity lowered to ${to}: ${decision.reason}`, actor: decision.decidedBy }],
      lastUpdatedAt: decision.at,
    },
  };
}

const FORWARD: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  open: ["verified", "closed-false-positive"],
  verified: ["contained", "recovering", "closed-false-positive"],
  contained: ["recovering", "closed-false-positive"],
  recovering: ["closed", "closed-false-positive"],
  closed: [],
  "closed-false-positive": [],
};

/**
 * Status moves forward only, and closing has requirements: recovery evidence
 * AND the review that verifies no defensive action silently expanded
 * Sentinel's authority (§21.6 step 10).
 */
export function transitionIncident(
  incident: SecurityIncident,
  to: IncidentStatus,
  at: string,
  options?: {
    readonly verifiedByChamber?: "shield" | "guard";
    readonly recoveryEvidenceRefs?: readonly string[];
    readonly authorityReviewCompleted?: boolean;
    readonly humanDecision?: HumanDecision;
  },
): IncidentUpdateOutcome {
  if (!FORWARD[incident.status].includes(to)) {
    return { ok: false, reason: `Incident status moves forward only: ${incident.status} -> ${to} is not permitted.` };
  }
  if (to === "verified" && options?.verifiedByChamber !== "guard") {
    return { ok: false, reason: "Verification is independent: Guard validates a Shield detection, not Shield itself." };
  }
  if (to === "closed") {
    if ((options?.recoveryEvidenceRefs ?? []).length === 0) {
      return { ok: false, reason: "Closing requires recovery evidence; an incident does not close because time passed." };
    }
    if (options?.authorityReviewCompleted !== true) {
      return {
        ok: false,
        reason: "Closing requires the authority review (§21.6 step 10): verify no defensive action silently expanded Sentinel authority.",
      };
    }
  }
  if (to === "closed-false-positive") {
    const decision = options?.humanDecision;
    if (decision === undefined || !decision.decidedBy.startsWith("human.")) {
      return { ok: false, reason: "A false positive is declared by a human; Sentinel does not clear its own findings." };
    }
  }
  return {
    ok: true,
    incident: {
      ...incident,
      status: to,
      ...(options?.humanDecision !== undefined ? { humanDecisions: [...incident.humanDecisions, options.humanDecision] } : {}),
      ...(options?.recoveryEvidenceRefs !== undefined ? { auditRefs: [...incident.auditRefs, ...options.recoveryEvidenceRefs] } : {}),
      timeline: [...incident.timeline, { at, entry: `status ${incident.status} -> ${to}`, actor: options?.humanDecision?.decidedBy ?? "sentinel.guard" }],
      lastUpdatedAt: at,
    },
  };
}

/**
 * The containment ceiling an incident may request. An incident with no
 * deterministic support cannot request more than a challenge — a model's
 * read of the evidence does not quarantine a workload.
 */
export function maxRequestableRung(incident: SecurityIncident): "observe" | "challenge" | "throttle" | "segment" | "quarantine" | "revoke" {
  if (!incident.deterministicallySupported) return "challenge";
  if (incident.confidence === "suspected") return "throttle";
  if (incident.confidence === "probable") return "segment";
  return "revoke";
}
