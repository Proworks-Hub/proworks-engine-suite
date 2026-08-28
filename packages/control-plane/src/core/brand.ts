// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineKind, EngineManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// ProWorks Hive — Engine Center.
//
// The naming, the colour system above the engine hues, and the typography, in
// one place. Not because a product name is hard to type, but because it appears
// in a page title, a favicon tooltip, a nav header, a notification, a boot
// screen and a document footer — and the version where it is typed in six
// places is the version where two of them still say something else a year later.
//
// The board's own closing rule governs everything here:
//
//     "The Hive aesthetic must always represent the real ProWorks architecture.
//      Never sacrifice architectural truth for a cooler graphic."
//
// Which is a design constraint with teeth, and the reason two of the decisions
// below went the way they did.
// ─────────────────────────────────────────────────────────────────────────────

export const BRAND = {
  /** The full name. Launch screens, documents, the browser title. */
  full: "ProWorks Hive",
  /** The tier line beneath it. Never used alone. */
  tier: "Engine Center",
  /** Together, for a page title or a document header. */
  signature: "ProWorks Hive · Engine Center",
  /** Nav headers and tight spaces, where the tier line is implied by context. */
  short: "Hive",
  tagline: "The engines behind ProWorks. Working as one.",
  /** The dashboard's own name in the sidebar. */
  overviewLabel: "Hive Overview",
} as const;

/**
 * How much science fiction is allowed.
 *
 * Written down as a number because it is the constraint most likely to erode:
 * every individual embellishment is defensible, and the tenth one turns a tool
 * into a toy. When a change makes the console more impressive without making it
 * more informative, this is the thing it is failing.
 */
export const AESTHETIC_BUDGET = {
  scienceFiction: 0.175,
  operationalExcellence: 0.825,
  statement: "Serious tools for serious builders.",
} as const;

// ── The colour system above the engine hues ──────────────────────────────────

/**
 * Two blues, deliberately.
 *
 * `brand-primary` is ProWorks and the Hive itself — the logo, the nav, the
 * chrome. `engine-blue` is Prime, one engine among nine.
 *
 * Collapsing them would be the easy mistake and a costly one: the whole point
 * of giving each engine a colour is that a colour identifies an engine, and a
 * blue that sometimes means "the product" and sometimes means "Prime" identifies
 * nothing. They are close enough to belong to one family and far enough apart to
 * separate on a screen.
 */
export const BRAND_COLORS = {
  /** ProWorks / Hive. Chrome, logo, selected nav, primary actions. */
  primary: "#2f7fe0",
  primaryBright: "#7fc0ff",
  primaryDim: "#0b2440",

  /** The console's ground. Dark and neutral so nine hues can coexist on it. */
  background: "#05070c",
  surface: "#0a0f18",
  surfaceRaised: "#0f1622",
  border: "#1b2534",
  /** The faint technical grid behind the hive. */
  grid: "#101826",

  text: "#e6edf7",
  textMuted: "#8fa0b8",
  textFaint: "#5b6b82",
} as const;

/**
 * Typography: industrial, technical, precise.
 *
 * All-caps with wide tracking for labels and headings — it is what makes the
 * interface read as instrumentation rather than as a web app. Deliberately NOT
 * applied to body copy or to anything long: all-caps is meaningfully slower to
 * read, and an error message is not a place to spend that.
 */
export const TYPOGRAPHY = {
  /** Headings, engine names, metric labels. */
  display: {
    fontFamily: '"Eurostile", "Rajdhani", "Chakra Petch", "Segoe UI", system-ui, sans-serif',
    textTransform: "uppercase" as const,
    letterSpacing: "0.14em",
    fontWeight: 600,
  },
  /** Numbers. Tabular, so a digit changing does not shift the ones beside it. */
  metric: {
    fontFamily: '"IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace',
    fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: "0.02em",
  },
  /** Reasons, diagnostics, anything a person has to actually read. */
  body: {
    fontFamily: '"Inter", "Segoe UI", system-ui, sans-serif',
    letterSpacing: "0",
    lineHeight: 1.55,
  },
} as const;

/** The CSS custom properties the console root sets once. */
export function brandVars(): Record<string, string> {
  return {
    "--hive-primary": BRAND_COLORS.primary,
    "--hive-primary-bright": BRAND_COLORS.primaryBright,
    "--hive-primary-dim": BRAND_COLORS.primaryDim,
    "--hive-bg": BRAND_COLORS.background,
    "--hive-surface": BRAND_COLORS.surface,
    "--hive-surface-raised": BRAND_COLORS.surfaceRaised,
    "--hive-border": BRAND_COLORS.border,
    "--hive-grid": BRAND_COLORS.grid,
    "--hive-text": BRAND_COLORS.text,
    "--hive-text-muted": BRAND_COLORS.textMuted,
    "--hive-text-faint": BRAND_COLORS.textFaint,
  };
}

// ── Naming things in the interface ───────────────────────────────────────────

/**
 * The word after the name, derived from what the thing actually is.
 *
 * Derived rather than stored, and that is the point. The board's sidebar reads
 * "Tracking Engine" — but tracking was deliberately built as a projection over
 * what the engines publish, not as an engine, and the same was decided for
 * notifications. A stored label would let the interface quietly say otherwise;
 * deriving it from `kind` means the interface cannot contradict the
 * architecture without someone changing the architecture first.
 *
 * That is the board's closing rule applied to a noun.
 */
export function kindNoun(kind: EngineKind): string {
  switch (kind) {
    case "engine":
      return "Engine";
    case "service":
      return "Service";
    case "intelligence":
      return "Intelligence";
  }
}

/** What the sidebar and the card header show: "ForgeIQ Engine", "Tracking Service". */
export function navLabel(manifest: EngineManifest): string {
  // The intelligence layer's name already reads as what it is; appending the
  // noun would produce "AI / Intelligence Intelligence".
  if (manifest.kind === "intelligence") return manifest.name;
  return `${manifest.name} ${kindNoun(manifest.kind)}`;
}

/** The line beneath it: what this thing is for, in three or four words. */
export function navSubtitle(manifest: EngineManifest): string {
  return manifest.description;
}
