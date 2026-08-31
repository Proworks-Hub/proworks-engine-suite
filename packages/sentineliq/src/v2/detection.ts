// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Confidence, Severity } from "../finding.js";
import type { SecurityObservation } from "./observation.js";
import type { ObservationType } from "./securityConventions.js";

// ─────────────────────────────────────────────────────────────────────────────
// ThreatIQ detection methods — directive §15 (DEC-028 increment 2).
//
// Detection runs OVER the observation plane; it never reaches for a source
// itself. Six evidence methods ship here: deterministic rules, sequence
// detection, IOC matching, behavioural baseline deviation, identity/rate
// anomaly, and cross-source correlation.
//
// THE THREE RULES THAT MAKE A DETECTION HONEST:
//
// 1. A DETECTION OVER AN INCOMPLETE OBSERVATION SET IS QUALIFIED. Coverage
//    travels with the finding. A rule that did not see the runtime sensor
//    cannot say "no persistence observed" — it says what it looked at.
//
// 2. A BASELINE BELOW ITS DECLARED MINIMUM IS INDETERMINATE, NEVER "NORMAL".
//    An anomaly score from four observations is not an anomaly score. This is
//    the same rule FinancialControlsIQ applies to precision intervals and
//    ForecastIQ to MASE denominators, for the same reason.
//
// 3. AI ASSISTS, AI DOES NOT GATE (§15, §28). A finding whose evidence is
//    solely ai-candidate cannot reach a deterministic gate: `gateEligible` is
//    computed, not passed in, and it is false whenever the deterministic
//    evidence set is empty.
//
// Every finding answers the directive's ten questions: what, which subject,
// when, evidence, confidence, severity, why it matters, ATT&CK mapping,
// recommended response, and the AUTHORITY REQUIRED — which the finding names
// and never grants.
// ─────────────────────────────────────────────────────────────────────────────

export const DETECTION_METHODS = [
  "deterministic-rule",
  "sequence",
  "ioc-match",
  "behavioural-baseline",
  "rate-anomaly",
  "cross-source-correlation",
] as const;
export type DetectionMethod = (typeof DETECTION_METHODS)[number];

/** What the detector actually looked at. Carried on every finding, because a
 * conclusion drawn over a partial view is a different claim from the same
 * conclusion drawn over a complete one. */
export interface DetectionCoverage {
  readonly observationsConsidered: number;
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Named sensor gaps from the collection that fed this run. */
  readonly sensorGaps: readonly string[];
  readonly complete: boolean;
}

/** The response a finding RECOMMENDS, and the authority that response needs.
 * Recommending is not authorizing: the rung and the authority are separate
 * fields precisely so nobody can read one as the other. */
export interface RecommendedResponse {
  readonly rung: "observe" | "challenge" | "throttle" | "segment" | "quarantine" | "revoke" | "recover" | "escalate";
  readonly authorityRequired: "none" | "chartered-containment" | "governance" | "human-operator";
  readonly rationale: string;
}

export interface ThreatDetection {
  readonly detectionId: string;
  readonly method: DetectionMethod;
  /** WHAT happened, in the canonical vocabulary. */
  readonly observationTypes: readonly ObservationType[];
  /** WHICH SUBJECT. */
  readonly subjectRef: string;
  readonly subjectKind: string;
  /** WHEN — the window the evidence spans, from the observations themselves. */
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  /** EVIDENCE — observation ids, never copied payloads. */
  readonly observationIds: readonly string[];
  readonly confidence: Confidence;
  readonly severity: Severity;
  /** WHY IT MATTERS, in the detector's own words. */
  readonly why: string;
  readonly attackTechniqueRefs: readonly string[];
  readonly recommendedResponse: RecommendedResponse;
  readonly coverage: DetectionCoverage;
  /** True only when at least one piece of DETERMINISTIC evidence supports the
   * detection. Computed here; never supplied. */
  readonly gateEligible: boolean;
  /** Present when a model contributed. Advisory, and labelled. */
  readonly aiAssist: { readonly modelRef: string; readonly contribution: string } | null;
}

function windowOf(observations: readonly SecurityObservation[]): { first: string; last: string } {
  const sorted = [...observations].map((o) => o.observedAt).sort();
  return { first: sorted[0] ?? "", last: sorted[sorted.length - 1] ?? "" };
}

function highestSeverity(observations: readonly SecurityObservation[]): Severity {
  const order: readonly Severity[] = ["informational", "low", "moderate", "high", "catastrophic"];
  return observations.reduce<Severity>(
    (acc, o) => (order.indexOf(o.severity) > order.indexOf(acc) ? o.severity : acc),
    "informational",
  );
}

function weakestConfidence(observations: readonly SecurityObservation[]): Confidence {
  const rank: Record<Confidence, number> = { suspected: 0, probable: 1, confirmed: 2 };
  return observations.reduce<Confidence>((acc, o) => (rank[o.confidence] < rank[acc] ? o.confidence : acc), "confirmed");
}

/** Deterministic evidence is any observation NOT sourced from a model, and
 * not marked lossy by its adapter. A guessed field cannot carry a gate. */
function deterministicEvidence(observations: readonly SecurityObservation[]): readonly SecurityObservation[] {
  return observations.filter((o) => !o.normalization.lossy && o.source.sensorKind !== "ai-activity");
}

function assemble(input: {
  detectionId: string;
  method: DetectionMethod;
  matched: readonly SecurityObservation[];
  subjectRef: string;
  subjectKind: string;
  why: string;
  response: RecommendedResponse;
  coverage: DetectionCoverage;
  severityOverride?: Severity;
  confidenceCeiling?: Confidence;
  aiAssist?: { modelRef: string; contribution: string };
}): ThreatDetection {
  const window = windowOf(input.matched);
  const rank: Record<Confidence, number> = { suspected: 0, probable: 1, confirmed: 2 };
  const base = weakestConfidence(input.matched);
  const confidence =
    input.confidenceCeiling !== undefined && rank[base] > rank[input.confidenceCeiling] ? input.confidenceCeiling : base;
  return {
    detectionId: input.detectionId,
    method: input.method,
    observationTypes: [...new Set(input.matched.map((o) => o.observationType))].sort(),
    subjectRef: input.subjectRef,
    subjectKind: input.subjectKind,
    firstObservedAt: window.first,
    lastObservedAt: window.last,
    observationIds: input.matched.map((o) => o.observationId),
    confidence,
    severity: input.severityOverride ?? highestSeverity(input.matched),
    why: input.why,
    attackTechniqueRefs: [...new Set(input.matched.map((o) => o.attackTechniqueRef).filter((t): t is string => t !== undefined))].sort(),
    recommendedResponse: input.response,
    coverage: input.coverage,
    gateEligible: deterministicEvidence(input.matched).length > 0,
    aiAssist: input.aiAssist ?? null,
  };
}

// ── 1 · deterministic rules ─────────────────────────────────────────────────

export interface DeterministicRule {
  readonly ruleId: string;
  readonly matchTypes: readonly ObservationType[];
  /** Minimum matching observations before the rule fires. */
  readonly threshold: number;
  readonly why: string;
  readonly response: RecommendedResponse;
  readonly severityOverride?: Severity;
}

export function runDeterministicRule(
  rule: DeterministicRule,
  observations: readonly SecurityObservation[],
  subjectRef: string,
  coverage: DetectionCoverage,
): ThreatDetection | null {
  const matched = observations.filter((o) => o.subject.ref === subjectRef && rule.matchTypes.includes(o.observationType));
  if (matched.length < rule.threshold) return null;
  return assemble({
    detectionId: `${rule.ruleId}:${subjectRef}`,
    method: "deterministic-rule",
    matched,
    subjectRef,
    subjectKind: matched[0]!.subject.kind,
    why: rule.why,
    response: rule.response,
    coverage,
    ...(rule.severityOverride !== undefined ? { severityOverride: rule.severityOverride } : {}),
  });
}

// ── 2 · sequence detection ──────────────────────────────────────────────────

export interface SequencePattern {
  readonly patternId: string;
  /** Ordered stages. The sequence fires only when each stage is observed
   * after the previous one, on the same subject. */
  readonly stages: readonly ObservationType[];
  readonly maxSpanSeconds: number;
  readonly why: string;
  readonly response: RecommendedResponse;
  readonly severityOverride?: Severity;
}

/**
 * A sequence is stronger evidence than its parts — a login failure is noise;
 * a login failure followed by a privilege escalation followed by an
 * unexpected egress is a story. The ORDER is required: matching the same set
 * in any order would fire on unrelated activity and is the most common way a
 * sequence rule becomes a noise generator.
 */
export function runSequence(
  pattern: SequencePattern,
  observations: readonly SecurityObservation[],
  subjectRef: string,
  coverage: DetectionCoverage,
): ThreatDetection | null {
  const forSubject = [...observations]
    .filter((o) => o.subject.ref === subjectRef)
    .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
  const matched: SecurityObservation[] = [];
  let stageIndex = 0;
  for (const observation of forSubject) {
    if (stageIndex >= pattern.stages.length) break;
    if (observation.observationType === pattern.stages[stageIndex]) {
      matched.push(observation);
      stageIndex += 1;
    }
  }
  if (stageIndex < pattern.stages.length) return null;
  const spanSeconds = (Date.parse(matched[matched.length - 1]!.observedAt) - Date.parse(matched[0]!.observedAt)) / 1000;
  if (Number.isNaN(spanSeconds) || spanSeconds > pattern.maxSpanSeconds) return null;
  return assemble({
    detectionId: `${pattern.patternId}:${subjectRef}`,
    method: "sequence",
    matched,
    subjectRef,
    subjectKind: matched[0]!.subject.kind,
    why: pattern.why,
    response: pattern.response,
    coverage,
    ...(pattern.severityOverride !== undefined ? { severityOverride: pattern.severityOverride } : {}),
  });
}

// ── 3 · IOC matching ────────────────────────────────────────────────────────

export interface IocSet {
  readonly setId: string;
  readonly version: string;
  /** attribute name -> forbidden values. Matching is EXACT: fuzzy IOC
   * matching produces confident false positives, and a wrong IOC hit gets a
   * legitimate workload quarantined. */
  readonly indicators: Readonly<Record<string, readonly string[]>>;
  readonly why: string;
  readonly response: RecommendedResponse;
}

export function runIocMatch(
  set: IocSet,
  observations: readonly SecurityObservation[],
  coverage: DetectionCoverage,
): readonly ThreatDetection[] {
  const hits = new Map<string, SecurityObservation[]>();
  for (const observation of observations) {
    for (const [attribute, values] of Object.entries(set.indicators)) {
      const actual = observation.attributes[attribute];
      if (actual !== undefined && values.includes(actual)) {
        const list = hits.get(observation.subject.ref) ?? [];
        list.push(observation);
        hits.set(observation.subject.ref, list);
        break;
      }
    }
  }
  return [...hits.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([subjectRef, matched]) =>
      assemble({
        detectionId: `${set.setId}@${set.version}:${subjectRef}`,
        method: "ioc-match",
        matched,
        subjectRef,
        subjectKind: matched[0]!.subject.kind,
        why: `${set.why} (IOC set ${set.setId}@${set.version})`,
        response: set.response,
        coverage,
      }),
    );
}

// ── 4 · behavioural baseline ────────────────────────────────────────────────

export interface Baseline {
  readonly baselineId: string;
  readonly subjectRef: string;
  readonly observationType: ObservationType;
  /** Counts per window from the declared history. */
  readonly historicalCounts: readonly number[];
  readonly windowRef: string;
  /** Below this many observed windows, no verdict is available. */
  readonly minimumWindows: number;
  /** Deviation multiple that constitutes an anomaly, declared not derived. */
  readonly deviationMultipleTimes100: number;
}

export type BaselineVerdict =
  | { readonly state: "within-baseline"; readonly observed: number; readonly expected: number }
  | { readonly state: "deviation"; readonly observed: number; readonly expected: number; readonly detection: ThreatDetection }
  | {
      /** Never "normal": an anomaly score from too little history is not an
       * anomaly score, and reporting it as within-baseline is the
       * unknown-presented-as-healthy failure. */
      readonly state: "indeterminate";
      readonly reason: string;
    };

export function runBaseline(
  baseline: Baseline,
  observations: readonly SecurityObservation[],
  coverage: DetectionCoverage,
  response: RecommendedResponse,
): BaselineVerdict {
  if (baseline.historicalCounts.length < baseline.minimumWindows) {
    return {
      state: "indeterminate",
      reason: `${baseline.historicalCounts.length} historical windows; ${baseline.minimumWindows} required. A deviation score below the declared minimum is not a score.`,
    };
  }
  if (!coverage.complete) {
    return {
      state: "indeterminate",
      reason: `Sensor gaps in this window (${coverage.sensorGaps.join(", ")}): an observed count over a partial view understates, so a "within baseline" verdict cannot be supported.`,
    };
  }
  const matched = observations.filter(
    (o) => o.subject.ref === baseline.subjectRef && o.observationType === baseline.observationType,
  );
  const observed = matched.length;
  const expected = Math.round(baseline.historicalCounts.reduce((a, c) => a + c, 0) / baseline.historicalCounts.length);
  const threshold = Math.ceil((expected * baseline.deviationMultipleTimes100) / 100);
  if (observed <= threshold) return { state: "within-baseline", observed, expected };
  return {
    state: "deviation",
    observed,
    expected,
    detection: assemble({
      detectionId: `${baseline.baselineId}:${baseline.subjectRef}`,
      method: "behavioural-baseline",
      matched,
      subjectRef: baseline.subjectRef,
      subjectKind: matched[0]?.subject.kind ?? "workload",
      why: `${observed} observations of ${baseline.observationType} against a baseline expectation of ${expected} over ${baseline.windowRef} (threshold ${threshold}).`,
      response,
      coverage,
      // A statistical deviation is evidence of ODDNESS, not of intent. Its
      // confidence ceiling is "probable" no matter how large the deviation.
      confidenceCeiling: "probable",
    }),
  };
}

// ── 5 · rate anomaly (identity / capability probing) ────────────────────────

export function runRateAnomaly(
  observations: readonly SecurityObservation[],
  observationType: ObservationType,
  perSubjectThreshold: number,
  coverage: DetectionCoverage,
  response: RecommendedResponse,
): readonly ThreatDetection[] {
  const bySubject = new Map<string, SecurityObservation[]>();
  for (const o of observations) {
    if (o.observationType !== observationType) continue;
    const list = bySubject.get(o.subject.ref) ?? [];
    list.push(o);
    bySubject.set(o.subject.ref, list);
  }
  return [...bySubject.entries()]
    .filter(([, list]) => list.length >= perSubjectThreshold)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([subjectRef, matched]) =>
      assemble({
        detectionId: `rate:${observationType}:${subjectRef}`,
        method: "rate-anomaly",
        matched,
        subjectRef,
        subjectKind: matched[0]!.subject.kind,
        why: `${matched.length} ${observationType} observations against a declared threshold of ${perSubjectThreshold}. Repeated refusal against one subject is what an authority probe looks like from the inside.`,
        response,
        coverage,
        confidenceCeiling: "probable",
      }),
    );
}

// ── 6 · cross-source correlation ────────────────────────────────────────────

/**
 * Correlation across INDEPENDENT sources is the strongest evidence this layer
 * produces — and it is still capped. Two sensors agreeing raises confidence
 * to probable; "confirmed" requires Guard-side verification (the immune
 * protocol's verify step), never volume. This mirrors the V2 fusion rule.
 */
export function correlateAcrossSources(
  detections: readonly ThreatDetection[],
  minimumDistinctMethods: number,
): readonly {
  readonly subjectRef: string;
  readonly methods: readonly DetectionMethod[];
  readonly detectionIds: readonly string[];
  readonly correlatedConfidence: Confidence;
  readonly gateEligible: boolean;
}[] {
  const bySubject = new Map<string, ThreatDetection[]>();
  for (const d of detections) {
    const list = bySubject.get(d.subjectRef) ?? [];
    list.push(d);
    bySubject.set(d.subjectRef, list);
  }
  return [...bySubject.entries()]
    .map(([subjectRef, list]) => ({
      subjectRef,
      methods: [...new Set(list.map((d) => d.method))].sort(),
      detectionIds: list.map((d) => d.detectionId).sort(),
      list,
    }))
    .filter((row) => row.methods.length >= minimumDistinctMethods)
    .map((row) => ({
      subjectRef: row.subjectRef,
      methods: row.methods,
      detectionIds: row.detectionIds,
      correlatedConfidence: "probable" as Confidence,
      // Correlation cannot manufacture a gate: if no member had deterministic
      // evidence, the correlation has none either.
      gateEligible: row.list.some((d) => d.gateEligible),
    }));
}

/**
 * The AI boundary, enforced (§15/§28): a model may propose a detection, and
 * the proposal is returned as a NON-gate-eligible finding with its model
 * labelled. There is no parameter that makes it gate-eligible, because the
 * flag is computed from deterministic evidence and a model proposal carries
 * none.
 */
export function admitAiProposedDetection(input: {
  readonly detectionId: string;
  readonly subjectRef: string;
  readonly subjectKind: string;
  readonly why: string;
  readonly modelRef: string;
  readonly supportingObservations: readonly SecurityObservation[];
  readonly coverage: DetectionCoverage;
  readonly response: RecommendedResponse;
}): ThreatDetection {
  const detection = assemble({
    detectionId: input.detectionId,
    method: "cross-source-correlation",
    matched: input.supportingObservations,
    subjectRef: input.subjectRef,
    subjectKind: input.subjectKind,
    why: input.why,
    response: input.response,
    coverage: input.coverage,
    // A model's read of the evidence is a hypothesis, whatever the evidence.
    confidenceCeiling: "suspected",
    aiAssist: { modelRef: input.modelRef, contribution: "proposed-detection" },
  });
  // Explicit: an AI-proposed detection never gates, even when the
  // observations it cites are deterministic — the INFERENCE is the model's.
  return { ...detection, gateEligible: false };
}
