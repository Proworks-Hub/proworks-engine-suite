// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineRegistry } from "./registry.js";
import type { EngineManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The hive.
//
// Engines arranged around the orchestrator, with packets travelling the edges
// between them as work actually moves. It is the architecture diagram and the
// live trace view collapsed into one thing, which is the point: a static
// diagram goes stale the week after it is drawn, and this one cannot, because
// it IS the manifests and the edges ARE the event mappings.
//
// Positions are COMPUTED, never authored. Hand-placed coordinates are how a
// ninth engine turns into a layout ticket — and then someone puts it in the
// gap that looked empty rather than where it belongs.
//
// Unit coordinates, -1..1, origin at the centre. The renderer scales them. This
// file does no drawing and imports nothing that can, so the layout is testable
// without a browser.
// ─────────────────────────────────────────────────────────────────────────────

export interface HiveNode {
  readonly engineId: string;
  readonly manifest: EngineManifest;
  /** -1..1, origin centre, y increasing downwards to match screen space. */
  readonly x: number;
  readonly y: number;
  /** Radians from the centre. Handy for orienting a label outwards. */
  readonly angle: number;
  readonly isCore: boolean;
}

export interface HiveEdge {
  readonly from: string;
  readonly to: string;
  /**
   * The event types that travel it.
   *
   * Kept so clicking an edge answers "what actually flows here?" from the
   * manifests, rather than from somebody's memory of the architecture.
   */
  readonly eventTypes: readonly string[];
}

export interface HiveLayout {
  readonly core?: HiveNode;
  readonly ring: readonly HiveNode[];
  readonly nodes: readonly HiveNode[];
  readonly edges: readonly HiveEdge[];
  /** Edges whose destination is not in the registry, with the id that is missing. */
  readonly danglingEdges: readonly HiveEdge[];
}

export interface HiveLayoutOptions {
  /** Ring distance from centre, 0..1. */
  radius?: number;
  /**
   * Where the first ring node sits, in radians. Defaults to straight up, so the
   * arrangement is stable and reproducible rather than depending on however the
   * manifests happened to be ordered in a file.
   */
  startAngle?: number;
}

/**
 * Places the engines and derives what connects them.
 *
 * Even angular spacing rather than a strict hex ring: a hex ring holds exactly
 * six, and there are seven engines around Prime today. A layout that only works
 * for six is a layout that breaks on the next engine, which is the failure this
 * whole file exists to avoid.
 *
 * Only `kind: "engine"` is placed. Services and the intelligence layer have
 * their own sections; putting them in the hive would make the picture disagree
 * with the count beside it.
 */
export function computeHiveLayout(
  registry: EngineRegistry,
  options: HiveLayoutOptions = {},
): HiveLayout {
  const radius = options.radius ?? 1;
  const startAngle = options.startAngle ?? -Math.PI / 2;

  const engines = registry.engines;
  const coreManifest = engines.find((m) => m.hivePlacement === "core");
  const ringManifests = engines.filter((m) => m !== coreManifest);

  const core: HiveNode | undefined = coreManifest
    ? { engineId: coreManifest.id, manifest: coreManifest, x: 0, y: 0, angle: 0, isCore: true }
    : undefined;

  const ring: HiveNode[] = ringManifests.map((manifest, index) => {
    const angle = startAngle + (index * 2 * Math.PI) / Math.max(1, ringManifests.length);
    return {
      engineId: manifest.id,
      manifest,
      x: round(Math.cos(angle) * radius),
      y: round(Math.sin(angle) * radius),
      angle,
      isCore: false,
    };
  });

  const nodes = core ? [core, ...ring] : ring;
  const present = new Set(nodes.map((n) => n.engineId));

  // Edges come from the manifests' own event mappings. Nothing is drawn that
  // is not backed by an event somebody declared, so the diagram cannot claim a
  // connection the system does not have.
  const collected = new Map<string, Set<string>>();
  for (const manifest of registry.all) {
    for (const mapping of manifest.eventMappings) {
      if (!mapping.to || mapping.to === manifest.id) continue;
      const key = `${manifest.id}→${mapping.to}`;
      const types = collected.get(key) ?? new Set<string>();
      types.add(mapping.eventType);
      collected.set(key, types);
    }
  }

  const edges: HiveEdge[] = [];
  const danglingEdges: HiveEdge[] = [];
  for (const [key, types] of collected) {
    const [from, to] = key.split("→") as [string, string];
    const edge: HiveEdge = { from, to, eventTypes: [...types].sort() };
    // A mapping pointing at an engine that is not registered is a real
    // condition, not a bug to hide: it happens when one engine is deployed and
    // another is not. Surfaced separately so the picture stays honest.
    if (present.has(from) && present.has(to)) edges.push(edge);
    else danglingEdges.push(edge);
  }

  edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  danglingEdges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));

  return { core, ring, nodes, edges, danglingEdges };
}

function round(value: number): number {
  // Three decimals is well under a pixel at any plausible size, and it keeps
  // the layout comparable in a test without matching floating-point noise.
  return Math.round(value * 1000) / 1000;
}

/**
 * Where a packet should travel for one visualization event.
 *
 * Returns null when either end is not on the hive — a packet drawn to nowhere
 * is worse than no packet, because it implies a connection that does not exist.
 */
export function packetPath(
  layout: HiveLayout,
  from: string,
  to: string | undefined,
): { fromNode: HiveNode; toNode: HiveNode } | null {
  if (!to) return null;
  const fromNode = layout.nodes.find((n) => n.engineId === from);
  const toNode = layout.nodes.find((n) => n.engineId === to);
  if (!fromNode || !toNode || fromNode === toNode) return null;
  return { fromNode, toNode };
}
