// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { AssetProvenance, ProvenanceStep } from "./provenance.js";
import { lastEngineStep } from "./provenance.js";

// ─────────────────────────────────────────────────────────────────────────────
// Learning from what actually happened on the floor.
//
// TWO RULES SHAPE EVERYTHING HERE.
//
// 1. NO CUSTOMER ARTWORK EVER LEAVES ITS TENANT. What is recorded is the
//    STRUCTURE of a correction — "operators raised contrast by 6 on black
//    slate at this machine class" — never the image it was applied to. A
//    system that learns by keeping customer files is one shop's artwork
//    sitting in another shop's model, and no amount of care at query time
//    fixes having stored it.
//
// 2. IT RECOMMENDS; IT DOES NOT REWRITE. Observations accumulate, a pattern is
//    proposed, and a human approves it. An engine that silently changed how it
//    prepares files would make every past job unexplainable — and the first
//    time it got a material wrong, nobody could tell why.
//
// The scope hierarchy exists so a lesson generalizes no further than the
// evidence supports. "Operators raise contrast on black slate" may be true
// everywhere; "on Laser 2" may be true only in one shop, because it is
// probably a fact about that machine's optics rather than about slate.
// ─────────────────────────────────────────────────────────────────────────────

export const FEEDBACK_KINDS = [
  "accepted_without_change",
  "customer_adjusted",
  "operator_adjusted",
  "external_edit_detected",
  "production_success",
  "production_failure",
  "reprint_required",
  "quality_pass",
  "quality_fail",
  "profile_adjusted",
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * How widely a lesson applies.
 *
 * Ordered from most general to most specific. A pattern found at a narrow
 * scope must not be applied at a broad one — that is how a quirk of one
 * machine becomes a rule for every shop.
 */
export const LEARNING_SCOPES = [
  "process",
  "machine_class",
  "material",
  "machine_class_material",
  "organization",
  "machine",
] as const;
export type LearningScope = (typeof LEARNING_SCOPES)[number];

/**
 * The context a lesson is attached to.
 *
 * `organizationId` is present on every record and is what keeps tenants apart.
 * It is deliberately NOT optional: a record that forgot it would be a record
 * that could be aggregated across shops.
 */
export interface LearningContext {
  readonly organizationId: string;
  readonly process?: string;
  readonly machineClass?: string;
  readonly machineId?: string;
  readonly materialId?: string;
  readonly productionProfileId?: string;
}

/**
 * One observation. Structure only — never pixels, never customer content.
 *
 * `recommended` and `applied` are the engine's value and the human's, so a
 * delta can be computed without keeping either image.
 */
export interface FeedbackObservation {
  readonly observationId: string;
  readonly kind: FeedbackKind;
  readonly context: LearningContext;
  /** The action corrected — `tone.contrast`, `crop.box`, `background.removed`. */
  readonly action?: string;
  readonly recommended?: number;
  readonly applied?: number;
  /** Present for non-numeric corrections. */
  readonly recommendedLabel?: string;
  readonly appliedLabel?: string;
  readonly at: string;
}

/**
 * Refuses anything that would carry customer content into a learning record.
 *
 * A denylist rather than an allowlist would be the wrong way round here: the
 * fields are few and known, so anything unrecognised is refused. That fails
 * towards keeping data out, which is the only direction worth failing in.
 */
const OBSERVATION_FIELDS = new Set([
  "observationId", "kind", "context", "action",
  "recommended", "applied", "recommendedLabel", "appliedLabel", "at",
]);

export function assertObservationIsSafe(observation: Record<string, unknown>): void {
  const unexpected = Object.keys(observation).filter((k) => !OBSERVATION_FIELDS.has(k));
  if (unexpected.length > 0) {
    throw new Error(
      `learning observation carries unexpected fields (${unexpected.join(", ")}); ` +
        `observations record the structure of a correction, never the artwork it was applied to`,
    );
  }
  const context = observation["context"] as LearningContext | undefined;
  if (!context?.organizationId) {
    throw new Error(
      "learning observation has no organizationId; a record without one could be aggregated across shops",
    );
  }
}

/**
 * Derives an observation from what a human did after the engine ran.
 *
 * Returns `undefined` when the engine never proposed anything for that action —
 * an operator setting a value the engine never suggested is a preference, not
 * a correction, and treating it as evidence the engine was wrong would teach
 * the wrong lesson.
 */
export function observeCorrection(
  provenance: AssetProvenance,
  correction: ProvenanceStep,
  context: LearningContext,
  observationId: string,
): FeedbackObservation | undefined {
  const proposed = lastEngineStep(provenance, correction.action);
  if (!proposed) return undefined;

  const kind: FeedbackKind =
    correction.actor.kind === "customer"
      ? "customer_adjusted"
      : correction.actor.kind === "external"
        ? "external_edit_detected"
        : "operator_adjusted";

  const before = proposed.parameters?.["value"];
  const after = correction.parameters?.["value"];

  return {
    observationId,
    kind,
    context,
    action: correction.action,
    ...(typeof before === "number" ? { recommended: before } : {}),
    ...(typeof after === "number" ? { applied: after } : {}),
    ...(typeof before === "string" ? { recommendedLabel: before } : {}),
    ...(typeof after === "string" ? { appliedLabel: after } : {}),
    at: correction.at,
  };
}

export interface SuggestedAdjustment {
  readonly action: string;
  readonly scope: LearningScope;
  readonly context: LearningContext;
  /** Median of the observed deltas. */
  readonly suggestedDelta: number;
  readonly sampleSize: number;
  readonly agreementRatio: number;
  /** For the approval prompt: "39 of 43 jobs raised contrast". */
  readonly summary: string;
}

/** Below this, a pattern is noise. */
export const MINIMUM_SAMPLE_SIZE = 12;
/** Below this, operators disagree with each other, not with the engine. */
export const MINIMUM_AGREEMENT = 0.7;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/**
 * Proposes a profile change from accumulated observations.
 *
 * PROPOSES. Nothing here applies anything — the return value is what a shop
 * admin is shown, with the evidence, so they can approve or ignore it.
 *
 * The median rather than the mean, because one operator who typed 90 instead
 * of 9 should not move a profile. The agreement ratio is the second guard: if
 * corrections point in both directions, the engine is not systematically wrong
 * and there is nothing to learn.
 */
export function suggestAdjustment(
  observations: ReadonlyArray<FeedbackObservation>,
  action: string,
  scope: LearningScope,
  context: LearningContext,
): SuggestedAdjustment | undefined {
  const relevant = observations.filter(
    (o) =>
      o.action === action &&
      o.context.organizationId === context.organizationId &&
      typeof o.recommended === "number" &&
      typeof o.applied === "number",
  );

  if (relevant.length < MINIMUM_SAMPLE_SIZE) return undefined;

  const deltas = relevant.map((o) => o.applied! - o.recommended!);
  const movedUp = deltas.filter((d) => d > 0).length;
  const movedDown = deltas.filter((d) => d < 0).length;
  const directional = Math.max(movedUp, movedDown);
  const agreement = directional / deltas.length;

  if (agreement < MINIMUM_AGREEMENT) return undefined;

  const suggested = median(deltas.filter((d) => (movedUp >= movedDown ? d > 0 : d < 0)));
  const direction = suggested > 0 ? "raised" : "lowered";

  return {
    action,
    scope,
    context,
    suggestedDelta: suggested,
    sampleSize: relevant.length,
    agreementRatio: agreement,
    summary:
      `Across ${relevant.length} jobs, operators ${direction} ${action} in ` +
      `${directional} of them. Suggested profile change: ${suggested > 0 ? "+" : ""}${suggested}.`,
  };
}
