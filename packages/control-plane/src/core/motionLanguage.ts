// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineState } from "./health.js";

// ─────────────────────────────────────────────────────────────────────────────
// Three ways an engine can move.
//
// The board defines a motion language of three states — idle, processing,
// warning/offline — while the health model has seven. Those are not in conflict;
// they are different questions, and keeping them separate is what stops each
// from corrupting the other.
//
//   HEALTH answers "what is true?" and needs seven, because `degraded` and
//   `unknown` demand different responses from an operator.
//
//   MOTION answers "how should this look?" and needs three, because a scene
//   with seven distinct animation vocabularies is a scene nobody can read at a
//   glance — and reading it at a glance is the entire reason it moves.
//
// So the mapping collapses, and the collapse is one-way. The scene never sees
// the health state; the badge beside it carries the precision.
// ─────────────────────────────────────────────────────────────────────────────

export type MotionLanguageState = "idle" | "processing" | "attention";

export interface MotionLanguageDescriptor {
  readonly state: MotionLanguageState;
  readonly label: string;
  /** What the scene is doing, in the board's own terms. */
  readonly behaviour: string;
}

export const MOTION_LANGUAGE: Readonly<Record<MotionLanguageState, MotionLanguageDescriptor>> = {
  idle: {
    state: "idle",
    label: "Idle",
    behaviour: "System healthy. Subtle breathing and data flow.",
  },
  processing: {
    state: "processing",
    label: "Processing",
    behaviour: "Active work. Engines processing and exchanging data.",
  },
  attention: {
    state: "attention",
    label: "Attention",
    behaviour: "Issue detected. The engine shows its status and its impact.",
  },
};

/**
 * Which vocabulary a health state draws in.
 *
 * `maintenance` maps to idle rather than attention, and that is the one worth
 * arguing about. An engine somebody deliberately took offline is not an issue
 * detected — dressing a planned outage in the same visual language as a failure
 * is how a team learns to ignore the failure language.
 *
 * `unknown` maps to attention, for the opposite reason. Not knowing is a
 * problem, and the only state that must never look calm is the one where the
 * console has no idea.
 */
export function motionLanguageFor(state: EngineState): MotionLanguageDescriptor {
  switch (state) {
    case "busy":
      return MOTION_LANGUAGE.processing;
    case "operational":
    case "maintenance":
      return MOTION_LANGUAGE.idle;
    case "warning":
    case "degraded":
    case "failed":
    case "unknown":
      return MOTION_LANGUAGE.attention;
  }
}
