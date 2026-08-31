// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { CoreDomain, HiveLayer } from "@proworks-hub/contracts";

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
  /** The band this sits in, from the manifest. Never chosen by the layout. */
  readonly layer: HiveLayer;
  /** Which Core it belongs to, for the capability plane. Null elsewhere. */
  readonly coreDomain: CoreDomain | null;
  /** @deprecated superseded by `layer === "prime"`. Kept so consumers at
   *  ^0.14.0 keep working while CC-ADR-004 is undecided. */
  readonly isCore: boolean;
}

/**
 * One concentric band of the hive.
 *
 * Exposed so a renderer can label and ring the bands without recomputing which
 * layer sits where — and so it cannot disagree with the layout about it.
 */
export interface HiveBand {
  readonly layer: HiveLayer;
  readonly radius: number;
  readonly nodes: readonly HiveNode[];
}

/**
 * What kind of relationship an edge asserts.
 *
 * Closed, because the projection schema is closed and an open vocabulary lets
 * an implementer invent a seventh type to fit a screen.
 *
 * Five of these are structurally underivable from event flow, which is why they
 * exist as separate types rather than as one edge with a label. AUTHORITY is
 * the sharpest case: Governance authorizing an engine is a call the ENGINE
 * makes outward, so deriving authority from event direction would draw the
 * arrow backwards and the console would assert who decides for whom on the
 * basis of who sends messages to whom.
 */
export const relationshipTypeSchema = z.enum([
  /** A signal actually flows. */
  "DATA",
  /** Build-time: this package needs that one. */
  "DEPENDENCY",
  /** That component decides for this one. Points authority → subject. */
  "AUTHORITY",
  /** That component watches this one and may report on it. */
  "OBSERVATION",
  /** A governed cross-instance relationship. Directional, never composed. */
  "INTERCONNECT",
  /** A proposed improvement path. */
  "EVOLUTION",
]);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

/**
 * Where an edge came from. An edge with no source is not constructed.
 *
 * Named rather than boolean so an operator clicking an edge is told what
 * evidence produced it, and so an edge can never be traced back to "the layout
 * thought this looked right".
 */
export const edgeSourceSchema = z.enum([
  "manifest.eventMappings",
  "package.dependencies",
  "governance.policies",
  "sentinel.subjects",
  "interconnect.grants",
  "foundry.packets",
]);
export type EdgeSource = z.infer<typeof edgeSourceSchema>;

/**
 * The one source permitted to produce each type.
 *
 * A single map rather than a check at each call site: the rule that an edge
 * needs a declared source only holds if there is one place that says which
 * source, and it is enforced on the way in.
 */
export const RELATIONSHIP_SOURCE: Readonly<Record<RelationshipType, EdgeSource>> = {
  DATA: "manifest.eventMappings",
  DEPENDENCY: "package.dependencies",
  AUTHORITY: "governance.policies",
  OBSERVATION: "sentinel.subjects",
  INTERCONNECT: "interconnect.grants",
  EVOLUTION: "foundry.packets",
};

/**
 * A relationship the host has read out of a real source and is handing over.
 *
 * The control plane derives DATA edges itself, because the manifests are right
 * here. It cannot derive the other five: they live in Governance policy
 * records, Sentinel subject registrations, Interconnect grants and Foundry
 * packets, none of which the console may reach into. So they arrive already
 * read, with the source named, and the console draws only what arrives.
 */
export const declaredRelationshipSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    relationshipType: relationshipTypeSchema,
    derivedFrom: edgeSourceSchema,
    /** True only where the source reports live activity. Never inferred. */
    active: z.boolean().default(false),
  })
  .strict()
  .refine((r) => RELATIONSHIP_SOURCE[r.relationshipType] === r.derivedFrom, {
    message: "relationship type does not match the source that may produce it",
    path: ["derivedFrom"],
  });
export type DeclaredRelationship = z.infer<typeof declaredRelationshipSchema>;

export interface HiveEdge {
  readonly from: string;
  readonly to: string;
  readonly relationshipType: RelationshipType;
  /**
   * The event types that travel it.
   *
   * Kept so clicking an edge answers "what actually flows here?" from the
   * manifests, rather than from somebody's memory of the architecture. Empty
   * for every type but DATA, which is the only one events produce.
   */
  readonly eventTypes: readonly string[];
  /** Which read model produced this. There is no edge without one. */
  readonly derivedFrom: EdgeSource;
  /** True only where the source reports live activity. Never inferred. */
  readonly active: boolean;
}

export interface HiveLayout {
  /** Prime, at the origin. Absent when no manifest claims the layer. */
  readonly prime?: HiveNode;
  /** The occupied bands, innermost first. Empty bands are not represented. */
  readonly bands: readonly HiveBand[];
  /** @deprecated alias for `prime`. */
  readonly core?: HiveNode;
  /** @deprecated every non-prime node, flattened. Use `bands`. */
  readonly ring: readonly HiveNode[];
  readonly nodes: readonly HiveNode[];
  readonly edges: readonly HiveEdge[];
  /** Edges whose destination is not in the registry, with the id that is missing. */
  readonly danglingEdges: readonly HiveEdge[];
  /**
   * Relationship types with no read model bound in this deployment.
   *
   * The console must render these as empty views that SAY they are unbound.
   * "No authority read model is bound yet" is honest; an empty AUTHORITY view
   * that looks like every other empty view says the Hive has no authority
   * relationships, which is false and is the more dangerous of the two.
   */
  readonly unboundRelationshipTypes: readonly RelationshipType[];
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
  /**
   * Whether the platform services join the ring.
   *
   * Off by default, and the default is the architectural position: tracking is
   * a projection over what the engines publish, and notifications is a delivery
   * policy. Neither owns a domain, and neither was made an engine.
   *
   * The option exists because the brand board draws tracking in the hive, and
   * that is a reasonable thing to want — the hive is a picture of the system,
   * and those services are part of the system. What it must not do is change
   * the count: `registry.engines` stays eight either way, so a service can
   * appear in the picture without being promoted in the architecture.
   */
  includeServices?: boolean;
  /**
   * Relationships the host has read from sources the console cannot reach.
   *
   * Absent means those types are unbound, not that the relationships do not
   * exist — reported through `unboundRelationshipTypes` so the difference
   * survives to the screen.
   */
  relationships?: readonly DeclaredRelationship[];
}

/**
 * Places the engines and derives what connects them.
 *
 * Even angular spacing rather than a strict hex ring: a hex ring holds exactly
 * six, and there are seven engines around Prime today. A layout that only works
 * for six is a layout that breaks on the next engine, which is the failure this
 * whole file exists to avoid.
 *
 * Only `kind: "engine"` is placed unless `includeServices` says otherwise. The
 * intelligence layer is never placed: it is not a node in the flow, it is the
 * thing several nodes call, and drawing it as a peer would misdescribe that to
 * everyone who learns the system from this screen.
 */
export function computeHiveLayout(
  registry: EngineRegistry,
  options: HiveLayoutOptions = {},
): HiveLayout {
  const radius = options.radius ?? 1;
  const startAngle = options.startAngle ?? -Math.PI / 2;

  const placed = options.includeServices
    ? [...registry.engines, ...registry.services]
    : registry.engines;

  const primeManifest = placed.find((m) => m.layer === "prime");
  const prime: HiveNode | undefined = primeManifest
    ? {
        engineId: primeManifest.id,
        manifest: primeManifest,
        x: 0,
        y: 0,
        angle: 0,
        layer: "prime",
        coreDomain: null,
        isCore: true,
      }
    : undefined;

  // Only the bands that actually hold something get a radius. An empty ring
  // drawn for a layer nothing occupies reads as "these are missing" rather
  // than "these do not exist here", and the console has no way to tell the
  // viewer which it meant.
  const occupied = BAND_ORDER.map((layer) => ({
    layer,
    manifests: placed.filter((m) => m !== primeManifest && m.layer === layer).sort(byCoreThenId),
  })).filter((b) => b.manifests.length > 0);

  const bands: HiveBand[] = occupied.map((band, bandIndex) => {
    // Distributed across the OCCUPIED bands, so the outermost always lands on
    // `radius`. With one occupied band this is exactly the single ring the
    // hive has drawn all along — the nesting appears only once there is
    // something to nest.
    const bandRadius = round((radius * (bandIndex + 1)) / occupied.length);
    const nodes = band.manifests.map((manifest, index) => {
      const angle = startAngle + (index * 2 * Math.PI) / band.manifests.length;
      return {
        engineId: manifest.id,
        manifest,
        x: round(Math.cos(angle) * bandRadius),
        y: round(Math.sin(angle) * bandRadius),
        angle,
        layer: band.layer,
        coreDomain: manifest.coreDomain,
        isCore: false,
      } satisfies HiveNode;
    });
    return { layer: band.layer, radius: bandRadius, nodes };
  });

  const ring = bands.flatMap((b) => b.nodes);
  const nodes = prime ? [prime, ...ring] : ring;
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
  const file = (edge: HiveEdge): void => {
    // A relationship pointing at an engine that is not registered is a real
    // condition, not a bug to hide: it happens when one engine is deployed and
    // another is not. Surfaced separately so the picture stays honest.
    if (present.has(edge.from) && present.has(edge.to)) edges.push(edge);
    else danglingEdges.push(edge);
  };

  for (const [key, types] of collected) {
    const [from, to] = key.split("→") as [string, string];
    file({
      from,
      to,
      relationshipType: "DATA",
      eventTypes: [...types].sort(),
      derivedFrom: "manifest.eventMappings",
      // A declared mapping says a route exists, not that anything travelled it.
      // Liveness belongs to telemetry, and inferring it here is how a diagram
      // starts showing motion nobody produced.
      active: false,
    });
  }

  // The other five types are drawn only from what the host read out of a real
  // source. Nothing here derives them, so there is no path by which the console
  // can produce an authority relationship Governance never recorded.
  for (const relationship of options.relationships ?? []) {
    file({
      from: relationship.from,
      to: relationship.to,
      relationshipType: relationship.relationshipType,
      eventTypes: [],
      derivedFrom: relationship.derivedFrom,
      active: relationship.active,
    });
  }

  const bound = new Set<RelationshipType>(["DATA"]);
  for (const r of options.relationships ?? []) bound.add(r.relationshipType);
  const unboundRelationshipTypes = relationshipTypeSchema.options.filter((t) => !bound.has(t));

  const order = (e: HiveEdge): string => `${e.relationshipType}:${e.from}→${e.to}`;
  edges.sort((a, b) => order(a).localeCompare(order(b)));
  danglingEdges.sort((a, b) => order(a).localeCompare(order(b)));

  return {
    prime,
    core: prime,
    bands,
    ring,
    nodes,
    edges,
    danglingEdges,
    unboundRelationshipTypes,
  };
}

/**
 * The bands, innermost first. Prime is the origin, not a band.
 *
 * The ordering is distance from Prime in the WORK hierarchy: the Cores sit
 * closest, their Specialized engines outside them, industry packs outside those
 * because a pack composes what the layers beneath it provide.
 *
 * `platform` and `constitutional` are outside that hierarchy entirely — one is
 * infrastructure beneath every engine, the other acts upon the whole system —
 * and a concentric diagram has no way to draw "beneath" or "upon" except as
 * further out. `plane` is outermost because an unclassified component is the
 * one thing that has no place in the structure at all, and should look like it.
 */
const BAND_ORDER: readonly HiveLayer[] = [
  "core",
  "specialized",
  "industry",
  "platform",
  "constitutional",
  "plane",
];

/**
 * Orders a band so same-Core engines land next to each other.
 *
 * Angular adjacency is the one thing the layout can say about the Core
 * relationship without asserting more than the manifests declare. Aligning each
 * group precisely under its Core would look better and would start encoding a
 * hierarchy the band structure already carries.
 *
 * Sorting also delivers what this file has always claimed: an arrangement that
 * is "stable and reproducible rather than depending on however the manifests
 * happened to be ordered in a file." The previous version indexed into the
 * array, so file order moved the engines.
 */
function byCoreThenId(a: EngineManifest, b: EngineManifest): number {
  const core = (a.coreDomain ?? "").localeCompare(b.coreDomain ?? "");
  return core !== 0 ? core : a.id.localeCompare(b.id);
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
