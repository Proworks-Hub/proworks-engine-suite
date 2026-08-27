// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// Which tone changes are worth learning from.
//
// This was inside a React hook, tangled up with a `setTimeout`. The timer is
// genuinely host plumbing — a browser concern about when a slider stops moving.
// The DECISION is not: which fields are learnable, what counts as a change, and
// what has already been recorded is domain knowledge, and every host that ever
// wires an editor to VisionIQ needs the same answers.
//
// Splitting them makes the substantive half testable without jsdom, which
// matters here because the jsdom-based tests in the host repo are already the
// ones that fail.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tone parameters an operator's correction teaches something about.
 *
 * Deliberately not "every numeric field". A change to a field the engine never
 * reasons about is a preference, and folding preferences into learning data
 * dilutes the signal from fields where the engine is genuinely being corrected.
 */
export const LEARNABLE_TONE_FIELDS = [
  "brightness",
  "contrast",
  "gamma",
  "shadowLift",
  "highlightCompression",
  "sharpen",
  "denoise",
  "threshold",
] as const;

export type LearnableToneField = (typeof LEARNABLE_TONE_FIELDS)[number];

/** A partial tone config — only the learnable fields are read. */
export type ToneValues = Partial<Record<LearnableToneField, number>>;

export interface ToneFieldCorrection {
  readonly field: LearnableToneField;
  /** What the engine proposed for this machine and material. */
  readonly recommended: number;
  /** What the human settled on. */
  readonly applied: number;
}

/**
 * Works out which fields a human actually corrected.
 *
 * Three things are deliberately NOT corrections:
 *
 * **Unchanged.** The engine was right. Useful to know, but this function is
 * for disagreements — recording agreement as a zero-delta correction would
 * drag every median toward zero and make a real pattern look like noise.
 *
 * **Already recorded at this value.** A settle can fire more than once for one
 * decision — a re-render, a second timer, a component remounting. Counting the
 * same choice twice would let one operator's single decision outvote several
 * other people's.
 *
 * **Missing or non-numeric on either side.** Nothing to compare. A field the
 * engine never proposed is a preference, not a correction, and treating it as
 * one teaches that the engine was wrong about something it never said.
 *
 * An operator who moves a value, lets it settle, then moves it again IS
 * recorded twice — the second is a genuine second decision, and the dedupe is
 * on the value, not on the field.
 */
export function diffToneFields(
  proposed: ToneValues | undefined,
  current: ToneValues | undefined,
  alreadyRecorded: ToneValues = {},
): ToneFieldCorrection[] {
  if (!proposed || !current) return [];

  const corrections: ToneFieldCorrection[] = [];

  for (const field of LEARNABLE_TONE_FIELDS) {
    const recommended = proposed[field];
    const applied = current[field];

    if (typeof recommended !== "number" || typeof applied !== "number") continue;
    if (!Number.isFinite(recommended) || !Number.isFinite(applied)) continue;
    if (recommended === applied) continue;
    if (alreadyRecorded[field] === applied) continue;

    corrections.push({ field, recommended, applied });
  }

  return corrections;
}

/** The action name a correction is recorded under. */
export function toneActionFor(field: LearnableToneField): string {
  return `tone.${field}`;
}

/**
 * Folds corrections into the record of what has been captured.
 *
 * Returns a new object rather than mutating, so a caller holding the previous
 * state in a ref cannot accidentally mark something recorded before the write
 * that records it has succeeded.
 */
export function withRecorded(
  alreadyRecorded: ToneValues,
  corrections: ReadonlyArray<ToneFieldCorrection>,
): ToneValues {
  const next: ToneValues = { ...alreadyRecorded };
  for (const correction of corrections) next[correction.field] = correction.applied;
  return next;
}
