// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { SubjectKind } from "./securityConventions.js";

// ─────────────────────────────────────────────────────────────────────────────
// The exposure / attack-surface graph — directive §16 (DEC-028 increment 2).
//
// The question the graph exists to answer: "If this subject is compromised,
// what can it reach?"
//
// THE ASYMMETRY THAT MAKES IT HONEST, and it is the same shape as
// FinancialRiskIQ's coverage determinacy and TaxIQ's nexus rule:
//
//     REACHABILITY IS MONOTONE IN THE EDGE SET.
//     Adding edges can only ADD reachable nodes; it can never remove one.
//     Therefore, over an incomplete graph:
//       · "X can reach Y"      is PROVABLE       (a witnessed path is a path)
//       · "X cannot reach Y"   is NOT PROVABLE   (the missing edge may be it)
//
// So `reachableFrom` returns a LOWER BOUND and says so in the type, and
// `canReach` answers yes / unknown — never no — while the graph declares
// itself incomplete. A blast-radius estimate from a partial graph that reads
// as an upper bound is exactly how an incident gets under-scoped.
//
// The graph is a PROJECTION of references (§16: "Do not copy private domain
// stores. Use references/projections"). Every node is a ref plus a kind; no
// node carries domain content, credentials, or payloads.
// ─────────────────────────────────────────────────────────────────────────────

export const EDGE_KINDS = [
  "can-call",
  "can-reach",
  "can-administer",
  "depends-on",
  "routes-to",
  "trusts",
  "contains",
  "deployed-on",
  "authenticated-by",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface ExposureNode {
  readonly ref: string;
  readonly kind: SubjectKind;
  /** Where this projection came from — Fabric topology, a charter, a
   * manifest. Never the private store itself. */
  readonly projectedFrom: string;
}

export interface ExposureEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly projectedFrom: string;
  /** Edges that only exist under a condition (a granted capability, an
   * unexpired trust) carry it, so a reachability answer can say WHY. */
  readonly conditionRef?: string;
}

export interface ExposureGraph {
  readonly nodes: readonly ExposureNode[];
  readonly edges: readonly ExposureEdge[];
  /** Sources that could not be projected. A graph missing a source is
   * incomplete, and every answer over it is qualified. */
  readonly unprojectedSources: readonly string[];
  readonly asOf: string;
}

export const graphIsComplete = (graph: ExposureGraph): boolean => graph.unprojectedSources.length === 0;

/** A witnessed path: the actual edges traversed, so a reachability claim can
 * be checked rather than believed. */
export interface ReachPath {
  readonly to: string;
  readonly hops: readonly ExposureEdge[];
}

export interface ReachabilityResult {
  readonly origin: string;
  /** LOWER BOUND, always. The name is the rule. */
  readonly atLeastReachable: readonly ReachPath[];
  /** True when the graph declared no unprojected sources — only then is the
   * set also an upper bound. */
  readonly boundIsTight: boolean;
  readonly unprojectedSources: readonly string[];
  readonly statement: string;
}

/**
 * Breadth-first closure over the edge set. Traversal follows only edges the
 * graph actually declares — an edge kind the projection could not establish
 * is a missing edge, and missing edges are why the answer is a lower bound.
 */
export function reachableFrom(
  graph: ExposureGraph,
  originRef: string,
  options?: { readonly traverseKinds?: readonly EdgeKind[]; readonly maxHops?: number },
): ReachabilityResult {
  const kinds = options?.traverseKinds ?? EDGE_KINDS;
  const maxHops = options?.maxHops ?? Number.MAX_SAFE_INTEGER;
  const byFrom = new Map<string, ExposureEdge[]>();
  for (const edge of graph.edges) {
    if (!kinds.includes(edge.kind)) continue;
    const list = byFrom.get(edge.from) ?? [];
    list.push(edge);
    byFrom.set(edge.from, list);
  }
  const seen = new Set<string>([originRef]);
  const paths: ReachPath[] = [];
  let frontier: { ref: string; hops: ExposureEdge[] }[] = [{ ref: originRef, hops: [] }];
  while (frontier.length > 0) {
    const next: { ref: string; hops: ExposureEdge[] }[] = [];
    for (const node of frontier) {
      if (node.hops.length >= maxHops) continue;
      for (const edge of byFrom.get(node.ref) ?? []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        const hops = [...node.hops, edge];
        paths.push({ to: edge.to, hops });
        next.push({ ref: edge.to, hops });
      }
    }
    frontier = next;
  }
  const complete = graphIsComplete(graph);
  return {
    origin: originRef,
    atLeastReachable: paths.sort((a, b) => (a.to < b.to ? -1 : 1)),
    boundIsTight: complete,
    unprojectedSources: graph.unprojectedSources,
    statement: complete
      ? `${paths.length} node(s) reachable from ${originRef}; the graph declares no unprojected sources, so this set is exact.`
      : `AT LEAST ${paths.length} node(s) reachable from ${originRef}. ${graph.unprojectedSources.length} source(s) unprojected (${graph.unprojectedSources.join(", ")}), so the true set may be larger. This is a lower bound and may not be read as a blast-radius ceiling.`,
  };
}

/** Yes / unknown — never no. Over an incomplete graph, the absence of a
 * witnessed path is the absence of evidence, and answering "no" would be the
 * single most dangerous output this module could produce. */
export type ReachVerdict =
  | { readonly verdict: "reachable"; readonly path: ReachPath }
  | { readonly verdict: "no-path-witnessed"; readonly qualification: string; readonly graphComplete: boolean };

export function canReach(graph: ExposureGraph, originRef: string, targetRef: string): ReachVerdict {
  const result = reachableFrom(graph, originRef);
  const hit = result.atLeastReachable.find((p) => p.to === targetRef);
  if (hit !== undefined) return { verdict: "reachable", path: hit };
  return {
    verdict: "no-path-witnessed",
    graphComplete: result.boundIsTight,
    qualification: result.boundIsTight
      ? "No path in a graph that declares itself complete. Still bounded by what the projection can see."
      : `No path witnessed, and the graph is INCOMPLETE (${graph.unprojectedSources.join(", ")}). This is not a finding of unreachability.`,
  };
}

// ── Blast radius ────────────────────────────────────────────────────────────

export interface BlastRadius {
  readonly originRef: string;
  /** Counts by node kind, over the lower-bound set. */
  readonly atLeastByKind: Readonly<Record<string, number>>;
  readonly atLeastTotal: number;
  /** The highest-privilege reachable nodes: administrable targets and
   * identities, which are what turns a foothold into an incident. */
  readonly administrableTargets: readonly string[];
  readonly reachableIdentities: readonly string[];
  readonly boundIsTight: boolean;
  readonly statement: string;
}

export function blastRadius(graph: ExposureGraph, originRef: string): BlastRadius {
  const reach = reachableFrom(graph, originRef);
  const nodeByRef = new Map(graph.nodes.map((n) => [n.ref, n]));
  const byKind: Record<string, number> = {};
  const identities: string[] = [];
  for (const path of reach.atLeastReachable) {
    const node = nodeByRef.get(path.to);
    const kind = node?.kind ?? "external-system";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (kind === "identity" || kind === "operator") identities.push(path.to);
  }
  const administrable = reach.atLeastReachable
    .filter((p) => p.hops[p.hops.length - 1]?.kind === "can-administer")
    .map((p) => p.to);
  return {
    originRef,
    atLeastByKind: byKind,
    atLeastTotal: reach.atLeastReachable.length,
    administrableTargets: [...new Set(administrable)].sort(),
    reachableIdentities: [...new Set(identities)].sort(),
    boundIsTight: reach.boundIsTight,
    statement: reach.statement,
  };
}

// ── Choke points ────────────────────────────────────────────────────────────

/**
 * Which single node, if segmented, removes the most reachability — the
 * containment planner's input (§22: least-destructive sufficient response).
 * Computed by re-running the closure with each candidate removed, so the
 * answer is measured rather than heuristic.
 *
 * Over an incomplete graph the ranking is itself provisional, and the result
 * says so: a choke point that looks total may be bypassed by an edge the
 * projection never saw.
 */
export function chokePoints(
  graph: ExposureGraph,
  originRef: string,
  candidates: readonly string[],
): readonly { readonly nodeRef: string; readonly removesAtLeast: number; readonly provisional: boolean }[] {
  const baseline = reachableFrom(graph, originRef).atLeastReachable.length;
  return candidates
    .map((nodeRef) => {
      const pruned: ExposureGraph = {
        ...graph,
        nodes: graph.nodes.filter((n) => n.ref !== nodeRef),
        edges: graph.edges.filter((e) => e.from !== nodeRef && e.to !== nodeRef),
      };
      const after = reachableFrom(pruned, originRef).atLeastReachable.length;
      return { nodeRef, removesAtLeast: baseline - after, provisional: !graphIsComplete(graph) };
    })
    .sort((a, b) => (b.removesAtLeast !== a.removesAtLeast ? b.removesAtLeast - a.removesAtLeast : a.nodeRef < b.nodeRef ? -1 : 1));
}

// ── Projection ──────────────────────────────────────────────────────────────

export interface ProjectionSource {
  readonly sourceRef: string;
  readonly nodes: readonly ExposureNode[];
  readonly edges: readonly ExposureEdge[];
}

/**
 * Build a graph from projections. A source that could not be read is recorded
 * in `unprojectedSources` — never silently omitted, because an omitted source
 * makes an incomplete graph look complete, and every reachability answer
 * downstream would then carry a bound it has not earned.
 */
export function projectGraph(
  available: readonly ProjectionSource[],
  unavailableSourceRefs: readonly string[],
  asOf: string,
): ExposureGraph {
  const nodes = new Map<string, ExposureNode>();
  const edges: ExposureEdge[] = [];
  for (const source of available) {
    for (const node of source.nodes) nodes.set(node.ref, node);
    edges.push(...source.edges);
  }
  // An edge whose endpoints were never projected as nodes is a dangling
  // reference: the node is kept as an external-system placeholder rather than
  // dropped, because dropping it would hide reachability.
  for (const edge of edges) {
    for (const ref of [edge.from, edge.to]) {
      if (!nodes.has(ref)) {
        nodes.set(ref, { ref, kind: "external-system", projectedFrom: `${edge.projectedFrom} (dangling endpoint)` });
      }
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => (a.ref < b.ref ? -1 : 1)),
    edges,
    unprojectedSources: [...unavailableSourceRefs].sort(),
    asOf,
  };
}
