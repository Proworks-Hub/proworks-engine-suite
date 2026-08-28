// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { motionStyle } from "../motion.js";
import { activityLevel, idleDuration, type EngineSceneProps } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// The intelligence layer, the services, and the scene for an engine this build
// has never heard of.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared brain.
 *
 * A node network rather than an anatomical brain: what it does is connect
 * things, and the picture should say that rather than illustrate a metaphor.
 * Signals travel between nodes when a model is actually called.
 */
export function IntelligenceCoreScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const nodes: Array<[number, number]> = [
    [100, 34], [72, 46], [128, 46], [58, 66], [142, 66],
    [78, 84], [122, 84], [100, 60], [100, 96],
  ];
  const links: Array<[number, number]> = [
    [0, 1], [0, 2], [1, 3], [2, 4], [1, 7], [2, 7],
    [3, 5], [4, 6], [5, 7], [6, 7], [5, 8], [6, 8],
  ];

  return (
    <g>
      {links.map(([from, to], i) => {
        const a = nodes[from]!;
        const b = nodes[to]!;
        return (
          <line
            key={i}
            x1={a[0]}
            y1={a[1]}
            x2={b[0]}
            y2={b[1]}
            stroke="var(--engine-base)"
            strokeWidth={0.9}
            opacity={0.25 + level * 0.35}
            style={motionStyle(
              props.motion,
              `pw-breathe ${idleDuration(props.idle, 4 + (i % 5) * 0.8)} ease-in-out infinite`,
            )}
          />
        );
      })}

      {nodes.map(([x, y], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={i === 7 ? 5 : 2.6}
          fill={i === 7 ? "var(--engine-bright)" : "var(--engine-base)"}
          opacity={0.55 + level * 0.4}
          style={motionStyle(
            props.motion,
            `pw-breathe ${idleDuration(props.idle, 3 + (i % 4) * 0.7)} ease-in-out infinite`,
          )}
        />
      ))}

      {!props.motion.reducedMotion &&
        props.activity.pulses.slice(0, 5).map((pulse, i) => {
          const node = nodes[i % nodes.length]!;
          return (
            <circle
              key={pulse.key}
              cx={node[0]}
              cy={node[1]}
              r={6}
              fill="none"
              stroke={pulse.effect === "alert" ? "var(--engine-status)" : "var(--engine-bright)"}
              strokeWidth={1.2}
              style={{
                transformOrigin: `${node[0]}px ${node[1]}px`,
                ...motionStyle(props.motion, "pw-pulse 1.2s ease-out forwards"),
              }}
            />
          );
        })}
    </g>
  );
}

/**
 * A platform service.
 *
 * Deliberately plainer than an engine. Tracking and notifications support the
 * engines rather than owning a domain, and giving them the same visual weight
 * would undo a distinction that was made on purpose.
 */
export function ServiceStripScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const bars = [0, 1, 2, 3, 4, 5];

  return (
    <g>
      <line x1={44} y1={60} x2={156} y2={60} stroke="var(--engine-dim)" strokeWidth={2} />
      {bars.map((i) => (
        <rect
          key={i}
          x={50 + i * 18}
          y={52}
          width={10}
          height={16}
          fill="var(--engine-base)"
          opacity={0.3 + level * 0.4}
          style={motionStyle(
            props.motion,
            `pw-breathe ${idleDuration(props.idle, 3.2 + i * 0.4)} ease-in-out infinite`,
          )}
        />
      ))}
    </g>
  );
}

/**
 * An engine this build has never seen.
 *
 * It renders, and it looks deliberately unfinished. A future engine appearing
 * as a blank space would read as a rendering bug and get investigated as one;
 * a plain hexagon with the engine's own colour says "this is real, the console
 * simply does not have artwork for it yet" — which is exactly true, and is the
 * point of the manifest being data.
 */
export function GenericScene(props: EngineSceneProps) {
  const level = activityLevel(props);
  const points = Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    return `${100 + Math.cos(angle) * 34},${60 + Math.sin(angle) * 34}`;
  }).join(" ");

  return (
    <g>
      <polygon
        points={points}
        fill="var(--engine-dim)"
        stroke="var(--engine-base)"
        strokeWidth={1.4}
        strokeDasharray="6 4"
        opacity={0.5 + level * 0.4}
        style={{
          transformOrigin: "100px 60px",
          ...motionStyle(props.motion, `pw-breathe ${idleDuration(props.idle, 5)} ease-in-out infinite`),
        }}
      />
      <text
        x={100}
        y={64}
        textAnchor="middle"
        fontSize={9}
        fill="var(--engine-bright)"
        opacity={0.8}
      >
        {props.manifest.name}
      </text>
    </g>
  );
}
