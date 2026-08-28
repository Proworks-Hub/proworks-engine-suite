// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineState } from "../core/health.js";

// ─────────────────────────────────────────────────────────────────────────────
// The console's colours.
//
// Each engine owns one hue and uses it inside its own card. The surrounding
// console stays dark and neutral — §10. Nine saturated colours competing across
// one screen is a toy, and the point of giving each engine an identity is that
// an operator recognises one at a glance, which stops working the moment
// everything is loud.
// ─────────────────────────────────────────────────────────────────────────────

export interface EnginePalette {
  /** The engine's colour at full strength. Lines, glow, the active state. */
  readonly base: string;
  /** For fills behind the artwork. */
  readonly dim: string;
  /** The brightest point of an activity pulse. */
  readonly bright: string;
}

/**
 * Colour tokens resolved.
 *
 * Kept as a table rather than in CSS so the resolution is testable and so an
 * unknown token has somewhere to fall back TO.
 */
export const ENGINE_PALETTE: Readonly<Record<string, EnginePalette>> = {
  "engine-blue": { base: "#3b9dff", dim: "#0d2b4d", bright: "#a8d8ff" },
  "engine-orange": { base: "#ff8a2b", dim: "#4a2609", bright: "#ffcb99" },
  "engine-green": { base: "#2ee07a", dim: "#0a3d22", bright: "#a5f5c8" },
  "engine-purple": { base: "#b26cff", dim: "#2f1550", bright: "#dfc2ff" },
  "engine-cyan": { base: "#2ee0d5", dim: "#0a3d3a", bright: "#a8f5f0" },
  "engine-magenta": { base: "#ff4fa3", dim: "#4d0f2e", bright: "#ffb3d6" },
  "engine-gold": { base: "#ffc233", dim: "#4a370a", bright: "#ffe6a8" },
  "engine-aqua": { base: "#33d6ff", dim: "#0a3a4a", bright: "#adecff" },
  "engine-violet": { base: "#8b5cf6", dim: "#231245", bright: "#cbb2ff" },
  "service-slate": { base: "#8b9bb4", dim: "#1c2431", bright: "#cdd6e3" },
};

/**
 * A colour that is deliberately visible and deliberately wrong-looking.
 *
 * An unresolved token must not render as transparent. An invisible engine looks
 * like an engine that is not there, which is the one thing a monitoring console
 * must never accidentally say. Grey says "somebody mistyped a token" — a
 * cosmetic bug, correctly reported as cosmetic.
 */
export const FALLBACK_PALETTE: EnginePalette = {
  base: "#6b7280",
  dim: "#20242c",
  bright: "#c3c8d0",
};

export function resolvePalette(colorToken: string): EnginePalette {
  return ENGINE_PALETTE[colorToken] ?? FALLBACK_PALETTE;
}

/**
 * How much of an engine's colour its current state earns.
 *
 * Failure drains the colour rather than turning it red: the red marker and the
 * words "Failed" are already doing that job, and a card that changes hue is a
 * card an operator has to re-learn. Draining reads as "this one has gone
 * quiet", which is what has happened.
 */
export const STATE_INTENSITY: Readonly<Record<EngineState, number>> = {
  operational: 1,
  busy: 1,
  warning: 0.8,
  degraded: 0.55,
  failed: 0.3,
  maintenance: 0.4,
  unknown: 0.3,
};

/** The status colour, which is about severity and never about the engine. */
export const STATE_COLOR: Readonly<Record<EngineState, string>> = {
  operational: "#2ee07a",
  busy: "#33d6ff",
  warning: "#ffc233",
  degraded: "#ff8a2b",
  failed: "#ff4d4d",
  maintenance: "#8b9bb4",
  unknown: "#8b9bb4",
};

/**
 * The CSS custom properties a card sets on itself.
 *
 * Set once on the container so the scene inside can be written in terms of
 * `var(--engine-base)` and stay ignorant of which engine it is drawing.
 */
export function paletteVars(
  colorToken: string,
  state: EngineState,
): Record<string, string> {
  const palette = resolvePalette(colorToken);
  return {
    "--engine-base": palette.base,
    "--engine-dim": palette.dim,
    "--engine-bright": palette.bright,
    "--engine-intensity": String(STATE_INTENSITY[state] ?? 0.3),
    "--engine-status": STATE_COLOR[state] ?? STATE_COLOR.unknown,
  };
}
