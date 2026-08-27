// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// What happened to this asset, and who decided it.
//
// The chain a production file should be able to answer six months later:
//
//   source → VisionIQ prepared it → customer approved → operator adjusted →
//   this is what ran → quality said
//
// WHY THE ACTOR IS ON EVERY STEP. "Contrast +18" is not useful on its own. The
// same value means three different things depending on whether the engine
// proposed it, a customer chose it, or an operator overrode it on the floor —
// and only the third is evidence that the engine was wrong.
//
// WHAT IS DELIBERATELY NOT HERE: pixels. A provenance record references asset
// VERSIONS and describes transformations structurally. Storing image data in a
// history record makes the history unstorable, and it is also how one shop's
// customer artwork ends up somewhere it should never be.
// ─────────────────────────────────────────────────────────────────────────────

export type ProvenanceActorKind = "engine" | "customer" | "operator" | "admin" | "external";

export interface ProvenanceActor {
  readonly kind: ProvenanceActorKind;
  /** Absent for `engine` and usually for `external`. */
  readonly id?: string;
}

/**
 * One thing that happened, named structurally.
 *
 * `parameters` carries the values a transformation used — contrast, threshold,
 * crop box. Small, JSON, and comparable: the whole point is that a later
 * correction can be diffed against what was proposed.
 */
export interface ProvenanceStep {
  readonly stepId: string;
  readonly actor: ProvenanceActor;
  /** `background.removed`, `tone.threshold`, `crop.applied`, `vector.cleaned`. */
  readonly action: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** The asset version this step produced. */
  readonly producedVersion: number;
  readonly at: string;
  /** Why, when a human did it and said. */
  readonly note?: string;
}

export interface AssetProvenance {
  readonly assetId: string;
  readonly organizationId: string;
  /** Never overwritten. The customer's file as it arrived. */
  readonly sourceRef: string;
  readonly steps: ReadonlyArray<ProvenanceStep>;
}

export function appendStep(
  provenance: AssetProvenance,
  step: ProvenanceStep,
): AssetProvenance {
  return { ...provenance, steps: [...provenance.steps, step] };
}

/** The version the chain currently stands at. 0 when nothing has run. */
export function currentVersion(provenance: AssetProvenance): number {
  return provenance.steps.reduce((max, s) => Math.max(max, s.producedVersion), 0);
}

/**
 * What the engine last proposed for an action, if anything.
 *
 * The baseline a correction is measured against. Returns the LATEST engine
 * step rather than the first: when the engine has run twice, the operator was
 * looking at the second result.
 */
export function lastEngineStep(
  provenance: AssetProvenance,
  action: string,
): ProvenanceStep | undefined {
  for (let i = provenance.steps.length - 1; i >= 0; i -= 1) {
    const step = provenance.steps[i]!;
    if (step.actor.kind === "engine" && step.action === action) return step;
  }
  return undefined;
}

/**
 * Whether a human changed what the engine produced.
 *
 * The single most useful question in the record, because it is the difference
 * between "the engine was right" and "the engine was overridden" — and the
 * second is the one worth learning from.
 */
export function wasCorrectedByHuman(provenance: AssetProvenance): boolean {
  const lastEngine = provenance.steps.reduce(
    (idx, s, i) => (s.actor.kind === "engine" ? i : idx),
    -1,
  );
  if (lastEngine === -1) return false;
  return provenance.steps
    .slice(lastEngine + 1)
    .some((s) => s.actor.kind === "operator" || s.actor.kind === "external");
}

/**
 * A human-readable account of what happened.
 *
 * For the "what did VisionIQ change?" panel. Explainability is not decoration
 * here — an operator who cannot see what the engine did has no basis for
 * trusting it, and will re-do the work by hand.
 */
export function explain(provenance: AssetProvenance): string[] {
  return provenance.steps.map((step) => {
    const who =
      step.actor.kind === "engine"
        ? "VisionIQ"
        : step.actor.kind === "external"
          ? "External editor"
          : step.actor.kind[0]!.toUpperCase() + step.actor.kind.slice(1);
    const detail = step.note ? ` — ${step.note}` : "";
    return `${who}: ${step.action}${detail}`;
  });
}
