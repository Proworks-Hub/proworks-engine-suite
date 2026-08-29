// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// A lightweight causal graph (directive §10).
//
// "Do not claim mathematical causality automatically. Use confidence and
// provenance. The causal graph exists to help Foundry distinguish root causes
// from downstream symptoms."
//
// So every edge carries a confidence and a reason, and `CAUSED` is not the
// default — `PRECEDED` is. The distinction between "A happened before B" and
// "A caused B" is the entire difference between a timeline and a diagnosis, and
// a graph that promotes the first to the second on its own will confidently
// blame whatever logged first.
//
// ROOT CAUSE IS A GRAPH PROPERTY, NOT A GUESS
//
// A root cause candidate is a node with no incoming CAUSED or DEPENDS_ON edge
// that reaches the symptom. That is a structural definition rather than a
// heuristic, which means it can be wrong for structural reasons a reader can
// see — usually a missing edge, which is a better failure than an opaque score.
// ─────────────────────────────────────────────────────────────────────────────

export const causalNodeKindSchema = z.enum([
  "component",
  "event",
  "state_transition",
  "dependency",
  "error",
  "governance_decision",
  "sentinel_action",
  "repair_action",
]);
export type CausalNodeKind = z.infer<typeof causalNodeKindSchema>;

export const causalEdgeKindSchema = z.enum([
  /** A genuine causal claim. Needs the highest bar. */
  "CAUSED",
  /** Ordering only. The default, and not a causal claim. */
  "PRECEDED",
  "DEPENDS_ON",
  "BLOCKED",
  "RETRIED",
  "RECOVERED_BY",
  "INVALIDATED",
]);
export type CausalEdgeKind = z.infer<typeof causalEdgeKindSchema>;

export const causalNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    kind: causalNodeKindSchema,
    label: z.string().min(1),
    componentId: z.string().min(1).optional(),
    /** Evidence this node was derived from. A node with none is an assumption. */
    evidenceIds: z.array(z.string().min(1)).default([]),
    at: z.string().min(1).optional(),
  })
  .strict();
export type CausalNode = z.infer<typeof causalNodeSchema>;

export const causalEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: causalEdgeKindSchema,
    /** How sure. Required — an unqualified causal claim is the thing §10 forbids. */
    confidence: z.enum(["suspected", "probable", "confirmed"]),
    /** Why this edge exists. Where it came from. */
    provenance: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((e) => e.kind !== "CAUSED" || e.evidenceIds.length > 0, {
    message:
      "A CAUSED edge must reference evidence. An unevidenced causal claim is an opinion with an arrow drawn on it; use PRECEDED if all you know is the order.",
    path: ["evidenceIds"],
  })
  .refine((e) => e.from !== e.to, {
    message: "A node cannot cause itself.",
    path: ["to"],
  });
export type CausalEdge = z.infer<typeof causalEdgeSchema>;

export interface RootCauseCandidate {
  readonly nodeId: string;
  readonly label: string;
  readonly componentId?: string;
  /** The path from this node to the symptom. */
  readonly pathToSymptom: readonly string[];
  /** Product of edge confidences along the path, as a coarse score. */
  readonly pathConfidence: number;
  /** How many causal hops away the symptom is. */
  readonly depth: number;
}

export interface CausalGraph {
  addNode(node: unknown): { added: true } | { added: false; reason: string };
  addEdge(edge: unknown): { added: true } | { added: false; reason: string };
  nodes(): readonly CausalNode[];
  edges(): readonly CausalEdge[];
  /**
   * Nodes that could be the root cause of a symptom.
   *
   * Walks BACKWARDS from the symptom along CAUSED, DEPENDS_ON and BLOCKED
   * edges — the ones that carry explanatory weight — and returns the nodes
   * with nothing further upstream. PRECEDED is deliberately excluded: ordering
   * is not explanation, and including it would make whatever logged first the
   * root cause of everything.
   */
  rootCauseCandidates(symptomNodeId: string): readonly RootCauseCandidate[];
  /** True when the node is downstream of something else. */
  isDownstream(nodeId: string): boolean;
}

const EXPLANATORY: ReadonlySet<CausalEdgeKind> = new Set(["CAUSED", "DEPENDS_ON", "BLOCKED"]);

const CONFIDENCE_WEIGHT: Readonly<Record<CausalEdge["confidence"], number>> = Object.freeze({
  suspected: 0.4,
  probable: 0.7,
  confirmed: 1,
});

export function createCausalGraph(): CausalGraph {
  const nodes = new Map<string, CausalNode>();
  const edges: CausalEdge[] = [];

  const explanatoryInto = (nodeId: string) =>
    edges.filter((e) => e.to === nodeId && EXPLANATORY.has(e.kind));

  return {
    addNode(input) {
      const parsed = causalNodeSchema.safeParse(input);
      if (!parsed.success) {
        return { added: false, reason: `Not a valid node: ${JSON.stringify(parsed.error.flatten())}` };
      }
      if (nodes.has(parsed.data.nodeId)) {
        return { added: false, reason: `Node ${parsed.data.nodeId} already exists.` };
      }
      nodes.set(parsed.data.nodeId, parsed.data);
      return { added: true };
    },

    addEdge(input) {
      const parsed = causalEdgeSchema.safeParse(input);
      if (!parsed.success) {
        return { added: false, reason: `Not a valid edge: ${JSON.stringify(parsed.error.flatten())}` };
      }
      for (const end of [parsed.data.from, parsed.data.to]) {
        if (!nodes.has(end)) {
          return { added: false, reason: `Edge references unknown node ${end}.` };
        }
      }
      edges.push(parsed.data);
      return { added: true };
    },

    nodes: () => [...nodes.values()],
    edges: () => [...edges],

    rootCauseCandidates(symptomNodeId) {
      if (!nodes.has(symptomNodeId)) return [];

      const found: RootCauseCandidate[] = [];

      // Depth-first backwards. `visiting` guards cycles — a causal graph with a
      // cycle is a modelling error, and looping forever is a worse way to
      // report it than simply not walking round twice.
      const walk = (
        nodeId: string,
        path: readonly string[],
        confidence: number,
        visiting: ReadonlySet<string>,
      ): void => {
        if (visiting.has(nodeId)) return;

        const incoming = explanatoryInto(nodeId);
        if (incoming.length === 0) {
          // Nothing explains this node, so it is where the explanation stops.
          if (path.length > 1) {
            const node = nodes.get(nodeId)!;
            found.push({
              nodeId,
              label: node.label,
              ...(node.componentId === undefined ? {} : { componentId: node.componentId }),
              pathToSymptom: [...path].reverse(),
              pathConfidence: confidence,
              depth: path.length - 1,
            });
          }
          return;
        }

        const nextVisiting = new Set([...visiting, nodeId]);
        for (const edge of incoming) {
          walk(edge.from, [...path, edge.from], confidence * CONFIDENCE_WEIGHT[edge.confidence], nextVisiting);
        }
      };

      walk(symptomNodeId, [symptomNodeId], 1, new Set());

      // Most confident first; deeper wins a tie, because a deeper cause
      // explains more of the chain.
      return found.sort((a, b) => b.pathConfidence - a.pathConfidence || b.depth - a.depth);
    },

    isDownstream(nodeId) {
      return explanatoryInto(nodeId).length > 0;
    },
  };
}
