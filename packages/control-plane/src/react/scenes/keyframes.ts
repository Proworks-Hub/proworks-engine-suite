// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// The console's motion vocabulary.
//
// CSS keyframes rather than an animation library, and rather than JavaScript
// driving a requestAnimationFrame loop per card. Compositor-driven transforms
// and opacity keep running smoothly while the main thread is busy — and on this
// console the main thread is busy exactly when an operator most needs the
// picture to stay readable.
//
// It is also what makes pause honest: `animation-play-state: paused` freezes
// every scene in the same frame, with no state to reconcile afterwards.
//
// Everything here is deliberately small in amplitude. Living machinery, not an
// animated website — nothing travels far, nothing flashes, nothing competes
// with the numbers beside it.
// ─────────────────────────────────────────────────────────────────────────────

export const CONSOLE_KEYFRAMES = `
@keyframes pw-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes pw-spin-reverse { from { transform: rotate(360deg); } to { transform: rotate(0deg); } }

/* Breathing, not blinking. Opacity never reaches zero, so nothing appears to
   switch off — an element that vanishes reads as a failure. */
@keyframes pw-breathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }

@keyframes pw-scan-y { 0% { transform: translateY(-38px); } 100% { transform: translateY(38px); } }
@keyframes pw-scan-x { 0% { transform: translateX(-46px); } 100% { transform: translateX(46px); } }

/* Travel along a path, used for packets and for work moving down a line. */
@keyframes pw-travel { 0% { offset-distance: 0%; } 100% { offset-distance: 100%; } }

@keyframes pw-rise { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes pw-drift { 0% { transform: translateX(0); } 100% { transform: translateX(52px); } }

/* One activity pulse: appears, expands slightly, fades. Never repeats — a
   repeating pulse would outlive the event that caused it and start lying. */
@keyframes pw-pulse { 0% { opacity: 0.85; transform: scale(0.6); } 100% { opacity: 0; transform: scale(1.9); } }
@keyframes pw-flash { 0% { opacity: 0; } 25% { opacity: 0.9; } 100% { opacity: 0; } }
@keyframes pw-spark { 0% { opacity: 0; transform: scale(0.3); } 30% { opacity: 1; } 100% { opacity: 0; transform: scale(1.4); } }

/* A packet crossing the hive. The distance is passed in as custom properties
   so one keyframe serves every edge — the alternative is a generated stylesheet
   that grows with the square of the engine count. */
@keyframes pw-packet {
  0% { transform: translate(0, 0); opacity: 0; }
  12% { opacity: 0.95; }
  100% { transform: translate(var(--pw-dx, 0px), var(--pw-dy, 0px)); opacity: 0; }
}

/* The alert marker. Slow and even — an alert that strobes is an alert people
   switch off, and then it is not an alert. */
@keyframes pw-alert { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
`;

/** Injected once per document. Ten copies of the same keyframes help nobody. */
export const CONSOLE_STYLE_ELEMENT_ID = "proworks-console-keyframes";
