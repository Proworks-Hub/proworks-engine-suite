// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { useEffect } from "react";

import { describeEngineState, type EngineHealth, type EngineState } from "../core/health.js";
import { STATE_COLOR } from "./palette.js";
import { useMotion } from "./motion.js";
import { CONSOLE_KEYFRAMES, CONSOLE_STYLE_ELEMENT_ID } from "./scenes/keyframes.js";

// ─────────────────────────────────────────────────────────────────────────────
// The console's shared pieces: the stylesheet, the status badge, the pause
// control.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Injects the keyframes once per document.
 *
 * Rendered near the root of the console. Idempotent by id, so mounting it twice
 * — which happens in development with strict mode, and in a test — does not
 * leave two copies fighting.
 */
export function ConsoleStyles() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(CONSOLE_STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = CONSOLE_STYLE_ELEMENT_ID;
    style.textContent = CONSOLE_KEYFRAMES;
    document.head.appendChild(style);
  }, []);
  return null;
}

export interface EngineStatusBadgeProps {
  state: EngineState;
  /** Shown on hover and to a screen reader: the numbers behind the state. */
  reason?: string;
  compact?: boolean;
}

/**
 * The status, said three ways at once.
 *
 * Colour, icon and words — never colour alone (§8). The dot is the least
 * important of the three and is the only one an operator with a colour vision
 * deficiency cannot use, so the label is not optional and is never truncated to
 * make room.
 */
export function EngineStatusBadge({ state, reason, compact = false }: EngineStatusBadgeProps) {
  const descriptor = describeEngineState(state);
  const color = STATE_COLOR[state] ?? STATE_COLOR.unknown;

  return (
    <span
      role="status"
      title={reason}
      aria-label={reason ? `${descriptor.label}. ${reason}` : descriptor.label}
      data-state={state}
      data-icon={descriptor.icon}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: compact ? 10 : 11,
        letterSpacing: 0.4,
        textTransform: "uppercase",
        color,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          // A ring rather than a fill for the states that demand attention, so
          // there is a shape difference and not only a colour difference.
          boxShadow: descriptor.demandsAttention ? `0 0 0 2px ${color}40` : undefined,
          flexShrink: 0,
        }}
      />
      {descriptor.label}
    </span>
  );
}

export interface MotionToggleProps {
  className?: string;
}

/**
 * Pause.
 *
 * §9 requires this to stop nonessential motion immediately, and it does: the
 * provider clears every pulse in flight as well as freezing the idle loops.
 *
 * It stays visible and enabled under reduced motion, saying so, rather than
 * disappearing. A control that vanishes leaves an operator hunting for it.
 */
export function MotionToggle({ className }: MotionToggleProps) {
  const motion = useMotion();

  return (
    <button
      type="button"
      className={className}
      onClick={motion.togglePaused}
      aria-pressed={motion.paused}
      title={
        motion.reducedMotion
          ? "Your system asks for reduced motion, so animation is already off."
          : motion.paused
            ? "Resume visualizations"
            : "Pause visualizations"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: "transparent",
        border: "1px solid currentColor",
        borderRadius: 4,
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: 11,
        padding: "3px 8px",
        opacity: motion.reducedMotion ? 0.6 : 1,
      }}
    >
      <span aria-hidden="true">{motion.paused || motion.reducedMotion ? "▶" : "❚❚"}</span>
      {motion.reducedMotion ? "Motion reduced" : motion.paused ? "Paused" : "Live"}
    </button>
  );
}

export interface FleetSummaryLineProps {
  healths: readonly EngineHealth[];
  summary: { worst: EngineState; label: string; online: number; total: number };
}

/** The line at the top. States the worst thing it knows, never an average. */
export function FleetSummaryLine({ summary }: FleetSummaryLineProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <EngineStatusBadge state={summary.worst} />
      <span style={{ fontSize: 12, opacity: 0.75 }}>{summary.label}</span>
      <span style={{ fontSize: 12, opacity: 0.55 }}>
        {summary.online} / {summary.total} online
      </span>
    </div>
  );
}
