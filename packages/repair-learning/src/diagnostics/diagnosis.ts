// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Evidence } from "../evidence/evidence.js";
import type { FailureSignature } from "../evidence/signature.js";
import type { CausalGraph, RootCauseCandidate } from "./causal.js";
import type { InvariantAssessment, InvariantClassifier } from "./invariants.js";

// ─────────────────────────────────────────────────────────────────────────────
// The diagnostic pipeline (directive §9).
//
// "Build diagnostics as a separate stage from repair... Do not collapse
// symptom == root cause. Example: WorkOrderIQ timeout may be a symptom. The
// root cause may be EventIQ unavailable, or contract version mismatch, or
// tenant context rejected upstream."
//
// SEPARATE STAGE MEANS SEPARATE INPUT
//
// This module cannot see a Scenario. It receives a signature, evidence, a
// causal graph and a classifier — and nothing that carries the corpus's
// `expectedDiagnosis`. That is enforced by the type, not by discipline: there
// is no parameter through which the expected answer could arrive.
//
// The consequence is that a test comparing actual to expected diagnosis is a
// real test. If the pipeline could see the expectation, agreement would prove
// nothing.
//
// WHAT MAKES A ROOT CAUSE SELECTABLE
//
// Three things, all of which can fail:
//   - the causal graph offers a candidate upstream of the symptom
//   - evidence supports it
//   - nothing contradicts it
//
// When they do not hold, the pipeline says so and sets `requiresHumanReview`.
// A diagnosis that always produces an answer is a diagnosis nobody should act
// on, because it has no way to express not knowing.
// ─────────────────────────────────────────────────────────────────────────────

export type DiagnosticConfidence = "suspected" | "probable" | "confirmed";

export interface RootCauseHypothesis {
  readonly hypothesisId: string;
  readonly statement: string;
  readonly componentId?: string;
  readonly confidence: DiagnosticConfidence;
  /** Evidence consistent with this hypothesis. */
  readonly supportingEvidence: readonly string[];
  /** Evidence that argues against it. Recorded, never discarded. */
  readonly contradictingEvidence: readonly string[];
  /** How the causal graph reaches the symptom from here. */
  readonly causalPath: readonly string[];
  readonly score: number;
}

export interface Diagnosis {
  readonly diagnosisId: string;
  readonly failureSignatureId: string;

  readonly symptoms: readonly string[];
  readonly candidateRootCauses: readonly RootCauseHypothesis[];
  /** Null when nothing could be selected honestly. */
  readonly selectedRootCause: RootCauseHypothesis | null;
  readonly confidence: DiagnosticConfidence | null;

  readonly affectedComponents: readonly string[];
  readonly causalChain: readonly string[];

  readonly supportingEvidence: readonly string[];
  readonly contradictingEvidence: readonly string[];

  /** From the classifier, from evidence. Never from a scenario annotation. */
  readonly violatedInvariants: readonly InvariantAssessment[];
  /** Invariants nothing could assess. Visible, because unchecked is not held. */
  readonly unassessedInvariants: readonly InvariantAssessment[];

  readonly recommendedRepairClasses: readonly string[];
  readonly requiresHumanReview: boolean;
  readonly reviewReason: string | null;
}

/**
 * Maps a violated invariant onto the repair classes that could address it.
 *
 * A RECOMMENDATION, not a decision. The candidate generator in Phase C may
 * ignore it, and a validator never accepts a candidate because its class was
 * recommended here.
 */
const INVARIANT_TO_REPAIR_CLASSES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "HIVE-INV-IDEMPOTENCY-001": ["IDEMPOTENCY", "EVENT_DELIVERY"],
  "HIVE-INV-TENANT-001": ["TENANT_ISOLATION", "AUTHORIZATION"],
  "HIVE-INV-AUTHORITY-001": ["AUTHORIZATION"],
  "HIVE-INV-CORRELATION-001": ["OBSERVABILITY", "EVENT_DELIVERY"],
  "HIVE-INV-PRIME-OWNERSHIP-001": ["OWNERSHIP_BOUNDARY", "ARCHITECTURE_REVIEW"],
  "HIVE-INV-OWNERSHIP-001": ["OWNERSHIP_BOUNDARY"],
  "HIVE-INV-NO-DUPLICATION-001": ["IDEMPOTENCY", "DATA_RECONCILIATION"],
  "HIVE-INV-VERSION-LINEAGE-001": ["CONTRACT_COMPATIBILITY", "SCHEMA_MIGRATION"],
  "HIVE-INV-RECOVERY-001": ["STATE_RECOVERY"],
  "HIVE-INV-FAILURE-ISOLATION-001": ["DEPENDENCY_FAILURE"],
  "HIVE-INV-DEGRADED-001": ["DEPENDENCY_FAILURE", "PROVIDER_FAILOVER"],
  "HIVE-INV-FINANCIAL-INTEGRITY-001": ["DATA_RECONCILIATION"],
  "HIVE-INV-DATA-MINIMIZATION-001": ["DATA_MINIMIZATION"],
  "HIVE-INV-PORTABILITY-001": ["DECOUPLING"],
  "HIVE-INV-CONSTITUTION-001": ["CONSTITUTIONAL_RECONCILIATION"],
  "HIVE-INV-CHARTER-001": ["CONSTITUTIONAL_RECONCILIATION", "ARCHITECTURE_REVIEW"],
});

const CONFIDENCE_FLOOR: Readonly<Record<DiagnosticConfidence, number>> = Object.freeze({
  suspected: 0,
  probable: 0.5,
  confirmed: 0.85,
});

function confidenceFor(score: number, contradictions: number): DiagnosticConfidence {
  // Any contradiction caps confidence at suspected. Evidence arguing against a
  // hypothesis is exactly the thing people discount when they have already
  // decided, so the cap is mechanical rather than a matter of judgement.
  if (contradictions > 0) return "suspected";
  if (score >= CONFIDENCE_FLOOR.confirmed) return "confirmed";
  if (score >= CONFIDENCE_FLOOR.probable) return "probable";
  return "suspected";
}

export interface DiagnoseInput {
  diagnosisId: string;
  signature: FailureSignature;
  evidence: readonly Evidence[];
  graph: CausalGraph;
  /** The node representing the observed symptom. */
  symptomNodeId: string;
  classifier: InvariantClassifier;
  /** Invariants to LOOK at. Questions, not answers. */
  invariantsToAssess: readonly string[];
  /**
   * Evidence ids that argue AGAINST a given hypothesis node.
   *
   * Supplied by the caller because contradiction is domain knowledge. Absent
   * means nobody looked for contradicting evidence — which is not the same as
   * there being none, and `requiresHumanReview` reflects that below.
   */
  contradictions?: Readonly<Record<string, readonly string[]>>;
}

export function diagnose(input: DiagnoseInput): Diagnosis {
  const assessments = input.classifier.assess(input.invariantsToAssess, input.evidence);
  const violated = assessments.filter((a) => a.verdict === "VIOLATED");
  const unassessed = assessments.filter((a) => a.verdict === "NOT_ASSESSED");

  const candidates: readonly RootCauseCandidate[] = input.graph.rootCauseCandidates(input.symptomNodeId);
  const contradictions = input.contradictions ?? {};

  const hypotheses: RootCauseHypothesis[] = candidates.map((candidate, index) => {
    const against = contradictions[candidate.nodeId] ?? [];
    const supporting = input.evidence
      .filter((e) => candidate.componentId === undefined || e.componentId === candidate.componentId)
      .map((e) => e.evidenceId);

    // Path confidence, penalised by contradictions and by having no supporting
    // evidence at all. A hypothesis nothing supports scores near zero even when
    // the graph likes it.
    const evidenceFactor = supporting.length === 0 ? 0.2 : 1;
    const contradictionPenalty = against.length === 0 ? 1 : 1 / (1 + against.length);
    const score = candidate.pathConfidence * evidenceFactor * contradictionPenalty;

    return {
      hypothesisId: `${input.diagnosisId}_h${index + 1}`,
      statement: candidate.label,
      ...(candidate.componentId === undefined ? {} : { componentId: candidate.componentId }),
      confidence: confidenceFor(score, against.length),
      supportingEvidence: supporting,
      contradictingEvidence: against,
      causalPath: candidate.pathToSymptom,
      score,
    };
  });

  const ranked = [...hypotheses].sort((a, b) => b.score - a.score);
  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;

  // ── Should this be acted on without a human? ──────────────────────────────
  //
  // Five reasons not to, each of which is a genuinely different situation and
  // deserves its own sentence rather than a single "low confidence" flag.
  let reviewReason: string | null = null;

  if (best === null) {
    reviewReason =
      "No root cause candidate. The causal graph has nothing upstream of the symptom, which usually means an edge is missing rather than that the symptom caused itself.";
  } else if (best.confidence === "suspected") {
    reviewReason = `The leading hypothesis is only suspected (score ${best.score.toFixed(2)}).`;
  } else if (runnerUp !== null && best.score - runnerUp.score < 0.15) {
    // Two hypotheses this close is a coin toss wearing a decimal point.
    reviewReason = `Two hypotheses are within ${(best.score - runnerUp.score).toFixed(2)}: "${best.statement}" and "${runnerUp.statement}". The evidence does not distinguish them.`;
  } else if (input.contradictions === undefined) {
    reviewReason =
      "No contradicting evidence was searched for. Absence of contradiction that nobody looked for is not confirmation.";
  } else if (unassessed.length > 0) {
    reviewReason = `${unassessed.length} invariant(s) could not be assessed: ${unassessed
      .map((a) => a.invariantId)
      .join(", ")}. A repair may restore function while leaving one of them broken.`;
  }

  const recommendedRepairClasses = [
    ...new Set(violated.flatMap((v) => INVARIANT_TO_REPAIR_CLASSES[v.invariantId] ?? [])),
  ].sort();

  const selected = best !== null && reviewReason === null ? best : null;

  return {
    diagnosisId: input.diagnosisId,
    failureSignatureId: input.signature.failureSignatureId,
    symptoms: [input.signature.primarySymptom, ...input.signature.secondarySymptoms],
    candidateRootCauses: ranked,
    selectedRootCause: selected,
    confidence: selected?.confidence ?? null,
    affectedComponents: input.signature.affectedComponents,
    causalChain: best?.causalPath ?? [],
    supportingEvidence: best?.supportingEvidence ?? [],
    contradictingEvidence: best?.contradictingEvidence ?? [],
    violatedInvariants: violated,
    unassessedInvariants: unassessed,
    recommendedRepairClasses,
    requiresHumanReview: reviewReason !== null,
    reviewReason,
  };
}

/**
 * Whether the symptom was mistaken for the cause.
 *
 * The §9 check, as a function: a diagnosis whose selected root cause IS the
 * primary symptom has explained nothing. Worth asserting rather than assuming,
 * because it is the most natural wrong answer a pipeline can produce and it
 * looks like success.
 */
export function symptomMistakenForCause(diagnosis: Diagnosis): boolean {
  if (!diagnosis.selectedRootCause) return false;
  const symptom = diagnosis.symptoms[0]?.trim().toLowerCase() ?? "";
  return diagnosis.selectedRootCause.statement.trim().toLowerCase() === symptom;
}
