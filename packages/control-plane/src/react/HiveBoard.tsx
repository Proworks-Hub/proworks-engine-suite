// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ReactNode } from "react";

import type { EngineHealth } from "../core/health.js";
import type { HiveLayout, HiveNode } from "../core/topology.js";
import { useInFlightPackets } from "./activity.js";
import { useMotion } from "./motion.js";
import { resolvePalette } from "./palette.js";

// ─────────────────────────────────────────────────────────────────────────────
// The hive.
//
// The architecture diagram and the live trace, collapsed into one picture. It
// is worth having only because it cannot go stale: the nodes are the manifests,
// the edges are the declared event mappings, and the packets are real events.
// There is no separate drawing to keep in step, which is the thing every
// architecture diagram eventually fails at.
//
// This component positions and draws. It computes nothing — `computeHiveLayout`
// did that, headlessly and under test.
// ─────────────────────────────────────────────────────────────────────────────

export interface HiveBoardProps {
  layout: HiveLayout;
  /** engineId → health, for colour and state. */
  health: Readonly<Record<string, EngineHealth | undefined>>;
  /** Rendered inside each node: the engine's scene, its name, its numbers. */
  renderNode(node: HiveNode, health: EngineHealth | undefined): ReactNode;
  onSelect?(engineId: string): void;
  /** Node size as a fraction of the board's shorter side. */
  nodeScale?: number;
  className?: string;
}

/** Board coordinate space. Unit layout coordinates map into this. */
const VIEW = 1000;
const PADDING = 0.78;

function toBoard(value: number): number {
  return VIEW / 2 + value * (VIEW / 2) * PADDING;
}

export function HiveBoard({
  layout,
  health,
  renderNode,
  onSelect,
  nodeScale = 0.26,
  className,
}: HiveBoardProps) {
  const motion = useMotion();
  const packets = useInFlightPackets();
  const nodeSize = VIEW * nodeScale;

  const positions = new Map(
    layout.nodes.map((node) => [node.engineId, { x: toBoard(node.x), y: toBoard(node.y) }]),
  );

  return (
    <div className={className} style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        width="100%"
        role="img"
        aria-label={`Engine hive: ${layout.nodes.length} engines, ${layout.edges.length} connections.`}
        style={{ display: "block", overflow: "visible" }}
      >
        {/* Edges first, so nodes sit on top of their own connections. */}
        {layout.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const palette = resolvePalette(health[edge.from]?.state ? "engine-blue" : "service-slate");
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={palette.dim}
              strokeWidth={2}
              strokeDasharray="6 10"
              opacity={0.6}
            >
              <title>{`${edge.from} → ${edge.to}: ${edge.eventTypes.join(", ")}`}</title>
            </line>
          );
        })}

        {/*
          Live packets. One per real event that named a destination, travelling
          the edge it actually used. The distance goes in as custom properties so
          a single keyframe serves every edge — generating a stylesheet per pair
          would grow with the square of the engine count.
        */}
        {!motion.reducedMotion &&
          packets.map((packet) => {
            const from = positions.get(packet.engineId);
            const to = packet.destination ? positions.get(packet.destination) : undefined;
            if (!from || !to) return null;
            return (
              <circle
                key={packet.key}
                cx={from.x}
                cy={from.y}
                r={7}
                fill={packet.effect === "alert" ? "#ff4d4d" : "#ffffff"}
                style={{
                  ["--pw-dx" as string]: `${to.x - from.x}px`,
                  ["--pw-dy" as string]: `${to.y - from.y}px`,
                  animation: "pw-packet 1.4s ease-in-out forwards",
                  animationPlayState: motion.paused ? "paused" : "running",
                }}
              />
            );
          })}
      </svg>

      {/*
        Nodes are HTML, positioned over the SVG, rather than foreignObject.
        foreignObject scaling is inconsistent across browsers and takes text
        rendering with it when it goes wrong — and these nodes carry the numbers
        an operator is actually reading.
      */}
      {layout.nodes.map((node) => {
        const position = positions.get(node.engineId)!;
        return (
          <div
            key={node.engineId}
            onClick={onSelect ? () => onSelect(node.engineId) : undefined}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
            onKeyDown={
              onSelect
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(node.engineId);
                    }
                  }
                : undefined
            }
            style={{
              position: "absolute",
              left: `${(position.x / VIEW) * 100}%`,
              top: `${(position.y / VIEW) * 100}%`,
              width: `${(nodeSize / VIEW) * 100}%`,
              transform: "translate(-50%, -50%)",
              cursor: onSelect ? "pointer" : undefined,
            }}
          >
            {renderNode(node, health[node.engineId])}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The hexagonal frame a hive node sits in.
 *
 * A clip path rather than a background image, so the engine's own colour drives
 * the border and nothing has to be re-exported when a palette changes.
 */
export function HiveCell({
  colorToken,
  children,
  attention = false,
}: {
  colorToken: string;
  children: ReactNode;
  attention?: boolean;
}) {
  const palette = resolvePalette(colorToken);
  return (
    <div
      style={{
        position: "relative",
        clipPath: "polygon(25% 2%, 75% 2%, 100% 50%, 75% 98%, 25% 98%, 0% 50%)",
        background: `linear-gradient(160deg, ${palette.dim} 0%, rgba(4,8,16,0.92) 70%)`,
        border: `1px solid ${palette.base}`,
        boxShadow: attention ? `0 0 22px ${palette.base}55` : `0 0 14px ${palette.base}22`,
        padding: "14% 12%",
      }}
    >
      {children}
    </div>
  );
}
