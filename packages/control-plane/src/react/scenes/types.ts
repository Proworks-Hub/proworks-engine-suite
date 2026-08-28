// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ReactElement } from "react";

import type { EngineManifest } from "../../core/manifest.js";
import type { EngineState } from "../../core/health.js";
import type { EngineActivity } from "../activity.js";
import type { MotionState } from "../motion.js";

// ─────────────────────────────────────────────────────────────────────────────
// The seam between artwork and operations.
//
// A scene receives state and activity and draws. It reads no metrics, fetches
// nothing, decides nothing. That is what lets the artwork be replaced — with
// better SVG, with a rendered asset, eventually with WebGL — without touching a
// line of the operational logic beside it (§21).
//
// Every scene draws into the same 200×120 box and inherits its colour from the
// CSS custom properties the card sets. A scene that hard-codes a colour has
// stopped being interchangeable.
// ─────────────────────────────────────────────────────────────────────────────

export const SCENE_WIDTH = 200;
export const SCENE_HEIGHT = 120;

export interface EngineSceneProps {
  readonly manifest: EngineManifest;
  readonly state: EngineState;
  readonly activity: EngineActivity;
  readonly motion: MotionState;
  /**
   * Prefix for every id this scene defines.
   *
   * SVG ids are document-global, so eight cards each defining `#glow` end up
   * sharing whichever one rendered last — and seven engines quietly take on the
   * eighth's gradient. Every `<defs>` id must be built from this.
   */
  readonly uid: string;
  /**
   * Idle speed, 0..1, taken from the state descriptor.
   *
   * Failure slows towards stillness rather than flashing; a frantic card makes
   * an incident harder to read.
   */
  readonly idle: number;
}

export type EngineScene = (props: EngineSceneProps) => ReactElement;

/** Seconds for one idle cycle, given the state's motion budget. */
export function idleDuration(idle: number, baseSeconds: number): string {
  // Slower motion means a longer cycle. Guarded so an idle of 0 does not become
  // an infinite duration the browser has to reason about.
  const factor = Math.max(0.05, idle);
  return `${(baseSeconds / factor).toFixed(2)}s`;
}

/** How lit the scene should be: its state's floor, raised by live activity. */
export function activityLevel(props: EngineSceneProps): number {
  return Math.min(1, props.idle * 0.5 + props.activity.level * 0.5);
}
