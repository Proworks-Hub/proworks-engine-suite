/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/nexus/topologyGraph.ts
 * Module:   neural-fabric / nexus
 * Purpose:  The graph Nexus keeps: what is reachable, what breaks, what changed.
 */

import type { Lane } from "../domain/lanes.js";
import type {
  Adjacency,
  FabricNode,
  TopologyVersion,
  Zone,
} from "../domain/topology.js";
import { zonesMayRelate } from "../domain/topology.js";

// ─────────────────────────────────────────────────────────────────────────────
// NEXUS GENERATES CANDIDATES. IT DOES NOT CHOOSE.
//
// The split is stated in §15 and it is the most important boundary in this
// package. Nexus answers "which paths is this signal PERMITTED to take?" and
// hands back a set. RoutingIQ answers "which of those, given health, locality
// and QoS?" and picks one.
//
// Collapsing them is tempting — Nexus has the graph, so it could just return
// the best path. The reason not to is that permission and preference decay at
// different rates and for different reasons. A permission changes when
// Governance decides something; a preference changes when a node gets slow.
// One function returning both would make a health blip look like a policy
// change in the logs, and would let a routing optimisation quietly widen what
// is reachable.
//
// So: this file never scores a path, and never reads health.
//
// EVERY PATH IS EXPLAINED, INCLUDING THE ONES REFUSED
//
// §12 requires route selection to be explainable: chosen path, viable
// alternatives, rejected paths, and the reason. The rejected set is the half
// people leave out, and it is the half an operator needs — "why did this not
// go the fast way" is only answerable if the fast way's rejection was recorded.
// ─────────────────────────────────────────────────────────────────────────────

export interface FabricGraph {
  readonly versionId: string;
  readonly instanceId: string;
  readonly zonesById: ReadonlyMap<string, Zone>;
  readonly nodesById: ReadonlyMap<string, FabricNode>;
  /** Outgoing active adjacencies, indexed by source node. */
  readonly outgoing: ReadonlyMap<string, readonly Adjacency[]>;
  /** Incoming active adjacencies, for blast radius. */
  readonly incoming: ReadonlyMap<string, readonly Adjacency[]>;
  /** Node ids that provide a capability. */
  readonly providersOf: ReadonlyMap<string, readonly string[]>;
}

export interface GraphProblem {
  readonly kind:
    | "UNKNOWN_ZONE"
    | "UNKNOWN_NODE"
    | "ZONE_RELATION_FORBIDDEN"
    | "CAPABILITY_NOT_PROVIDED"
    | "TEST_PRODUCTION_MIX"
    | "DUPLICATE_ID";
  readonly subject: string;
  readonly message: string;
}

export type GraphBuildResult =
  | { readonly ok: true; readonly graph: FabricGraph; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly problems: readonly GraphProblem[] };

/**
 * Builds the index Nexus answers questions from.
 *
 * Validates as it goes and returns EVERY problem rather than throwing on the
 * first. A topology with four mistakes should be fixed in one pass; discovering
 * them one build at a time is how people stop running the validation.
 */
export function buildGraph(version: TopologyVersion): GraphBuildResult {
  const problems: GraphProblem[] = [];
  const warnings: string[] = [];

  const zonesById = new Map<string, Zone>();
  for (const zone of version.zones) {
    if (zonesById.has(zone.zoneId)) {
      problems.push({
        kind: "DUPLICATE_ID",
        subject: zone.zoneId,
        message: `Two zones share the id "${zone.zoneId}". Which one an adjacency meant would depend on iteration order.`,
      });
      continue;
    }
    zonesById.set(zone.zoneId, zone);
  }

  const nodesById = new Map<string, FabricNode>();
  for (const node of version.nodes) {
    if (nodesById.has(node.nodeId)) {
      problems.push({
        kind: "DUPLICATE_ID",
        subject: node.nodeId,
        message: `Two nodes share the id "${node.nodeId}".`,
      });
      continue;
    }
    if (!zonesById.has(node.zoneId)) {
      problems.push({
        kind: "UNKNOWN_ZONE",
        subject: node.nodeId,
        message: `Node "${node.nodeId}" is in zone "${node.zoneId}", which this topology does not define. A node with no zone has no isolation boundary.`,
      });
      continue;
    }
    nodesById.set(node.nodeId, node);
  }

  const providersOf = new Map<string, string[]>();
  for (const node of nodesById.values()) {
    for (const capability of node.capabilities) {
      const list = providersOf.get(capability) ?? [];
      list.push(node.nodeId);
      providersOf.set(capability, list);
    }
  }
  // Sorted so candidate route sets come back in a stable order. An unstable
  // set makes two identical routing questions produce different explanations.
  for (const [capability, list] of providersOf) providersOf.set(capability, [...list].sort());

  const outgoing = new Map<string, Adjacency[]>();
  const incoming = new Map<string, Adjacency[]>();

  for (const adjacency of version.adjacencies) {
    const from = nodesById.get(adjacency.fromNodeId);
    const to = nodesById.get(adjacency.toNodeId);

    if (!from || !to) {
      problems.push({
        kind: "UNKNOWN_NODE",
        subject: adjacency.adjacencyId,
        message: `Adjacency "${adjacency.adjacencyId}" connects ${adjacency.fromNodeId} to ${adjacency.toNodeId}, and ${!from ? adjacency.fromNodeId : adjacency.toNodeId} is not a node in this topology.`,
      });
      continue;
    }

    if (!to.capabilities.includes(adjacency.capability)) {
      problems.push({
        kind: "CAPABILITY_NOT_PROVIDED",
        subject: adjacency.adjacencyId,
        message: `Adjacency "${adjacency.adjacencyId}" permits addressing "${adjacency.capability}" on ${to.nodeId}, which does not provide it. The edge would grant access to nothing, and reads in a review as though it grants access to something.`,
      });
      continue;
    }

    const fromZone = zonesById.get(from.zoneId)!;
    const toZone = zonesById.get(to.zoneId)!;
    const relation = zonesMayRelate(fromZone, toZone);
    if (!relation.permitted) {
      problems.push({
        kind: "ZONE_RELATION_FORBIDDEN",
        subject: adjacency.adjacencyId,
        message: `Adjacency "${adjacency.adjacencyId}" crosses from zone ${fromZone.zoneId} to ${toZone.zoneId}. ${relation.reason}`,
      });
      continue;
    }

    if (from.isTest !== to.isTest) {
      problems.push({
        kind: "TEST_PRODUCTION_MIX",
        subject: adjacency.adjacencyId,
        message: `Adjacency "${adjacency.adjacencyId}" connects a ${from.isTest ? "test" : "production"} node to a ${to.isTest ? "test" : "production"} one. Test data reaching production is a corruption; production data reaching a test is a leak.`,
      });
      continue;
    }

    if (adjacency.state !== "ACTIVE") {
      // Not a problem — a retired or quarantined edge is deliberate history.
      // It is simply not indexed as usable.
      continue;
    }

    const out = outgoing.get(adjacency.fromNodeId) ?? [];
    out.push(adjacency);
    outgoing.set(adjacency.fromNodeId, out);

    const inc = incoming.get(adjacency.toNodeId) ?? [];
    inc.push(adjacency);
    incoming.set(adjacency.toNodeId, inc);
  }

  if (problems.length > 0) return { ok: false, problems };

  for (const node of nodesById.values()) {
    if (!outgoing.has(node.nodeId) && !incoming.has(node.nodeId)) {
      warnings.push(
        `Node "${node.nodeId}" has no active adjacency in either direction. It is admitted and unreachable, which is a valid state and rarely an intended one.`,
      );
    }
  }

  for (const [key, map] of [
    ["outgoing", outgoing],
    ["incoming", incoming],
  ] as const) {
    void key;
    for (const [nodeId, list] of map) {
      map.set(nodeId, [...list].sort((a, b) => a.adjacencyId.localeCompare(b.adjacencyId)));
    }
  }

  return {
    ok: true,
    warnings,
    graph: {
      versionId: version.versionId,
      instanceId: version.instanceId,
      zonesById,
      nodesById,
      outgoing,
      incoming,
      providersOf,
    },
  };
}

export interface CandidatePath {
  /** The adjacencies traversed, in order. */
  readonly hops: readonly Adjacency[];
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly lane: Lane;
  /** Every zone the path passes through, in order. */
  readonly zonePath: readonly string[];
  /** True when the path leaves the originating instance. */
  readonly crossesInstance: boolean;
  /** True when the path is entirely within one local zone. */
  readonly staysLocal: boolean;
}

export interface RejectedPath {
  readonly toNodeId: string;
  readonly reason: string;
}

export interface CandidateRoutes {
  readonly capability: string;
  readonly lane: Lane;
  readonly permitted: readonly CandidatePath[];
  /**
   * Providers of the capability that this signal may NOT reach, and why.
   *
   * The half that gets left out. "Why did it not go the fast way" is only
   * answerable if the fast way's rejection was recorded at the time.
   */
  readonly rejected: readonly RejectedPath[];
  readonly note: string;
}

/**
 * Every path a signal is PERMITTED to take. Never the best one.
 *
 * `maxHops` is required and bounded — an unbounded path search over a graph
 * with cycles does not terminate, and a fabric with millions of participants
 * is exactly where somebody discovers that. Two hops covers direct delivery
 * and delivery through one gateway, which is what §17 actually permits.
 */
export function candidateRoutes(
  graph: FabricGraph,
  fromNodeId: string,
  capability: string,
  lane: Lane,
  maxHops = 3,
): CandidateRoutes {
  const rejected: RejectedPath[] = [];
  const permitted: CandidatePath[] = [];

  const origin = graph.nodesById.get(fromNodeId);
  if (!origin) {
    return {
      capability,
      lane,
      permitted: [],
      rejected: [],
      note: `"${fromNodeId}" is not a node in this topology, so it has no routes. This is not a permission failure — the sender does not exist here.`,
    };
  }

  const providers = graph.providersOf.get(capability) ?? [];
  if (providers.length === 0) {
    return {
      capability,
      lane,
      permitted: [],
      rejected: [],
      note: `Nothing in this topology provides "${capability}". No route exists to be permitted or refused.`,
    };
  }

  // Breadth-first, bounded. Sorted frontier so the result does not depend on
  // insertion order — two identical questions must produce identical answers.
  for (const targetId of providers) {
    if (targetId === fromNodeId) {
      rejected.push({
        toNodeId: targetId,
        reason: "A node does not route to itself through the Fabric; call it directly.",
      });
      continue;
    }

    const path = findPath(graph, fromNodeId, targetId, capability, lane, maxHops);
    if (path === null) {
      rejected.push({
        toNodeId: targetId,
        reason: `No active adjacency permits ${fromNodeId} to reach ${targetId} on the ${lane} lane for "${capability}" within ${maxHops} hops. Default-deny: an adjacency has to exist, and none does.`,
      });
      continue;
    }
    permitted.push(path);
  }

  return {
    capability,
    lane,
    permitted,
    rejected,
    note:
      permitted.length === 0
        ? `No permitted route from ${fromNodeId} to "${capability}" on the ${lane} lane. ${rejected.length} provider${rejected.length === 1 ? " was" : "s were"} considered and refused; the reasons are the actionable part.`
        : `${permitted.length} permitted route${permitted.length === 1 ? "" : "s"}. This is the set a signal MAY take — choosing among them is RoutingIQ's, using health and locality this function deliberately does not read.`,
  };
}

function findPath(
  graph: FabricGraph,
  fromNodeId: string,
  targetId: string,
  capability: string,
  lane: Lane,
  maxHops: number,
): CandidatePath | null {
  interface Step {
    readonly nodeId: string;
    readonly hops: readonly Adjacency[];
  }
  const queue: Step[] = [{ nodeId: fromNodeId, hops: [] }];
  const seen = new Set<string>([fromNodeId]);
  let cursor = 0;

  while (cursor < queue.length) {
    const step = queue[cursor]!;
    cursor += 1;
    if (step.hops.length >= maxHops) continue;

    for (const edge of graph.outgoing.get(step.nodeId) ?? []) {
      if (edge.lane !== lane) continue;

      const hops = [...step.hops, edge];

      // The final hop must permit the capability being addressed. Intermediate
      // hops are transit, and requiring them to name the capability would mean
      // every gateway had to be re-declared for every capability that passes
      // through it.
      if (edge.toNodeId === targetId && edge.capability === capability) {
        return describePath(graph, fromNodeId, targetId, lane, hops);
      }

      if (!seen.has(edge.toNodeId)) {
        seen.add(edge.toNodeId);
        queue.push({ nodeId: edge.toNodeId, hops });
      }
    }
  }
  return null;
}

function describePath(
  graph: FabricGraph,
  fromNodeId: string,
  toNodeId: string,
  lane: Lane,
  hops: readonly Adjacency[],
): CandidatePath {
  const zonePath: string[] = [];
  const origin = graph.nodesById.get(fromNodeId)!;
  zonePath.push(origin.zoneId);
  for (const hop of hops) {
    const node = graph.nodesById.get(hop.toNodeId)!;
    if (zonePath[zonePath.length - 1] !== node.zoneId) zonePath.push(node.zoneId);
  }

  const instances = new Set(zonePath.map((zoneId) => graph.zonesById.get(zoneId)!.instanceId));
  const kinds = new Set(zonePath.map((zoneId) => graph.zonesById.get(zoneId)!.kind));

  return {
    hops,
    fromNodeId,
    toNodeId,
    lane,
    zonePath,
    crossesInstance: instances.size > 1,
    staysLocal: zonePath.length === 1 && kinds.has("LOCAL"),
  };
}

export interface BlastRadius {
  readonly nodeId: string;
  /** Nodes that lose a route to something if this node disappears. */
  readonly directlyAffected: readonly string[];
  /** Capabilities that would have no provider left at all. */
  readonly capabilitiesLost: readonly string[];
  /** Capabilities that would still have another provider. */
  readonly capabilitiesDegraded: readonly string[];
  readonly note: string;
}

/**
 * What fails if this node disappears.
 *
 * §19 lists it as a question the Fabric must be able to answer, and it is the
 * one people most want before a deployment rather than after an outage. The
 * useful distinction is between a capability that is LOST and one that is
 * merely degraded — the first is an outage and the second is a capacity
 * problem, and treating them the same makes every node look critical.
 */
export function blastRadius(graph: FabricGraph, nodeId: string): BlastRadius {
  const node = graph.nodesById.get(nodeId);
  if (!node) {
    return {
      nodeId,
      directlyAffected: [],
      capabilitiesLost: [],
      capabilitiesDegraded: [],
      note: `"${nodeId}" is not in this topology, so nothing depends on it here.`,
    };
  }

  const directlyAffected = [
    ...new Set((graph.incoming.get(nodeId) ?? []).map((edge) => edge.fromNodeId)),
  ].sort();

  const lost: string[] = [];
  const degraded: string[] = [];
  for (const capability of [...node.capabilities].sort()) {
    const providers = graph.providersOf.get(capability) ?? [];
    if (providers.filter((id) => id !== nodeId).length === 0) lost.push(capability);
    else degraded.push(capability);
  }

  return {
    nodeId,
    directlyAffected,
    capabilitiesLost: lost,
    capabilitiesDegraded: degraded,
    note:
      lost.length === 0
        ? `Losing ${nodeId} removes capacity but no capability — every capability it provides has another provider. ${directlyAffected.length} node${directlyAffected.length === 1 ? "" : "s"} would reroute.`
        : `Losing ${nodeId} removes ${lost.length} capability with no other provider: ${lost.join(", ")}. This is a single point of failure, and ${directlyAffected.length} node${directlyAffected.length === 1 ? "" : "s"} depend${directlyAffected.length === 1 ? "s" : ""} on it directly.`,
  };
}

export interface TopologyDiff {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly nodesAdded: readonly string[];
  readonly nodesRemoved: readonly string[];
  readonly adjacenciesAdded: readonly string[];
  readonly adjacenciesRemoved: readonly string[];
  readonly adjacenciesStateChanged: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  /**
   * Changes that widen what can reach what.
   *
   * Separated because these are the ones that need governed approval (§27),
   * and a diff that lists them alongside a retirement makes the reviewer find
   * them. Widening is the direction that grants; narrowing only takes away.
   */
  readonly wideningChanges: readonly string[];
  readonly note: string;
}

/**
 * What changed between two topology versions.
 *
 * Sorted throughout, so the same pair of versions always diffs identically.
 * A diff that reorders itself is a diff people stop reading.
 */
export function diffTopology(from: TopologyVersion, to: TopologyVersion): TopologyDiff {
  const fromNodes = new Set(from.nodes.map((n) => n.nodeId));
  const toNodes = new Set(to.nodes.map((n) => n.nodeId));
  const fromAdj = new Map(from.adjacencies.map((a) => [a.adjacencyId, a]));
  const toAdj = new Map(to.adjacencies.map((a) => [a.adjacencyId, a]));

  const nodesAdded = [...toNodes].filter((id) => !fromNodes.has(id)).sort();
  const nodesRemoved = [...fromNodes].filter((id) => !toNodes.has(id)).sort();
  const adjacenciesAdded = [...toAdj.keys()].filter((id) => !fromAdj.has(id)).sort();
  const adjacenciesRemoved = [...fromAdj.keys()].filter((id) => !toAdj.has(id)).sort();

  const stateChanged: { id: string; from: string; to: string }[] = [];
  for (const id of [...toAdj.keys()].sort()) {
    const before = fromAdj.get(id);
    const after = toAdj.get(id)!;
    if (before && before.state !== after.state) {
      stateChanged.push({ id, from: before.state, to: after.state });
    }
  }

  const widening: string[] = [];
  for (const id of adjacenciesAdded) {
    const edge = toAdj.get(id)!;
    widening.push(
      `New adjacency ${id}: ${edge.fromNodeId} may now address "${edge.capability}" on ${edge.toNodeId} over the ${edge.lane} lane.`,
    );
  }
  for (const change of stateChanged) {
    if (change.to === "ACTIVE" && change.from !== "ACTIVE") {
      const edge = toAdj.get(change.id)!;
      widening.push(
        `Adjacency ${change.id} returns to ACTIVE from ${change.from}: ${edge.fromNodeId} may address "${edge.capability}" on ${edge.toNodeId} again.`,
      );
    }
  }

  return {
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    nodesAdded,
    nodesRemoved,
    adjacenciesAdded,
    adjacenciesRemoved,
    adjacenciesStateChanged: stateChanged,
    wideningChanges: widening,
    note:
      widening.length === 0
        ? "Nothing in this change widens what can reach what. Every difference removes, retires or quarantines."
        : `${widening.length} change${widening.length === 1 ? "" : "s"} WIDEN what can reach what, and each needs a governed decision behind it. Narrowing changes do not.`,
  };
}
