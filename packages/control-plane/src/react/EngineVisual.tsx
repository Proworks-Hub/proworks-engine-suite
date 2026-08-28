// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { useId } from "react";

import { describeEngineState, type EngineState } from "../core/health.js";
import type { EngineManifest } from "../core/manifest.js";
import { useEngineActivity } from "./activity.js";
import { useMotion } from "./motion.js";
import { paletteVars } from "./palette.js";
import { SCENE_HEIGHT, SCENE_WIDTH, resolveScene } from "./scenes/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// One engine, drawn.
//
// Everything it needs comes from the manifest and from live telemetry. It takes
// no engine-specific props, contains no per-engine branching, and has never
// heard of ForgeIQ — so a ninth engine renders the moment its manifest exists.
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineVisualProps {
  manifest: EngineManifest;
  state: EngineState;
  /** The numbers behind the state, for the accessible description. */
  reason?: string;
  /** Rendered size. The scene's own geometry is fixed and scales with it. */
  height?: number;
  className?: string;
}

export function EngineVisual({
  manifest,
  state,
  reason,
  height = 120,
  className,
}: EngineVisualProps) {
  const motion = useMotion();
  const activity = useEngineActivity(manifest.id);
  const descriptor = describeEngineState(state);
  const Scene = resolveScene(manifest.visualizationType);

  // SVG ids are document-global. Without a per-instance prefix, eight cards each
  // defining `#glow` all resolve to whichever rendered last, and seven engines
  // silently borrow the eighth's gradient.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");

  const description = [
    `${manifest.name}: ${descriptor.label}.`,
    reason,
    activity.recentCount > 0
      ? `${activity.recentCount} events in the last few seconds.`
      : "No recent activity.",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      style={{
        ...paletteVars(manifest.colorToken, state),
        height,
        width: "100%",
        // The colour drains with the state rather than turning red. The red
        // marker and the word "Failed" already say what is wrong; a card that
        // changes hue is one an operator has to re-learn mid-incident.
        opacity: 0.35 + Number(paletteVars(manifest.colorToken, state)["--engine-intensity"]) * 0.65,
        transition: motion.reducedMotion ? undefined : "opacity 600ms ease",
      }}
    >
      <svg
        viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={description}
        data-engine={manifest.id}
        data-state={state}
        data-scene={manifest.visualizationType}
      >
        <Scene
          manifest={manifest}
          state={state}
          activity={activity}
          motion={motion}
          uid={uid}
          idle={descriptor.motion}
        />

        {/*
          The attention marker. A shape as well as a colour, and it pulses
          slowly rather than strobing — an alert that strobes is an alert people
          switch off, and then it is not an alert.
        */}
        {descriptor.demandsAttention && (
          <g aria-hidden="true">
            <circle
              cx={SCENE_WIDTH - 12}
              cy={12}
              r={5}
              fill="var(--engine-status)"
              style={
                motion.reducedMotion
                  ? undefined
                  : {
                      animation: "pw-alert 2.4s ease-in-out infinite",
                      animationPlayState: motion.paused ? "paused" : "running",
                    }
              }
            />
            <circle cx={SCENE_WIDTH - 12} cy={12} r={8} fill="none" stroke="var(--engine-status)" strokeWidth={1} opacity={0.5} />
          </g>
        )}
      </svg>
    </div>
  );
}
