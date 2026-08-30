/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/core/costGraph.ts
 * Module:   cost-iq-engine / core
 * Purpose:  The structure of a cost — what is made of what — and the exact,
 *           order-independent rollup over it.
 */

import {
  type Decimal,
  type RoundingMode,
  add,
  compare,
  fromString,
  normalize,
  rescale,
  subtract,
  toString as decToString,
  ZERO,
} from "../domain/decimal.js";
import type { CostComponent, CostComponentKind } from "../domain/costModel.js";

// ─────────────────────────────────────────────────────────────────────────────
// A COST IS A SHAPE, NOT A LIST
//
// "£4,200" is an answer nobody can argue with, because there is nothing to
// argue about. The useful object is the structure underneath: this assembly
// is made of these parts, each made of material and operations, each priced by
// this basis. Every question worth asking — what drives this, what happens if
// steel moves, why is it more than last time, what is stale — is a query over
// that structure.
//
// So the graph is first-class, not a rendering aid. It is built once,
// validated, and then rolled up, explained and queried.
//
// CYCLES ARE A REAL RISK, NOT A THEORETICAL ONE
//
// A bill of materials that contains itself is a modelling mistake somebody
// makes routinely — usually a sub-assembly reused at two levels with one
// reference pointing the wrong way. Without detection the rollup recurses
// until the stack dies, and the error names a line of framework code rather
// than the loop.
//
// So cycles are detected before any arithmetic runs, and the error names the
// PATH: `assembly-a -> panel-b -> assembly-a`. That is the difference between
// a bug report and a fix.
//
// ORDER INDEPENDENCE IS A CORRECTNESS PROPERTY
//
// The same components in a different order must produce the same total, the
// same fingerprint and the same explanation. Not approximately — identically.
// Exact decimal addition is associative, so the total is safe; the fingerprint
// is only safe because the canonical form sorts. Anything that iterated an
// object's keys and hashed the result would produce estimates that differ by
// insertion order, which is a nightmare to diagnose because nothing looks
// wrong.
// ─────────────────────────────────────────────────────────────────────────────

/** One node in the structure of a cost. */
export interface CostGraphNode {
  readonly id: string;
  readonly kind: CostComponentKind;
  readonly label: string;
  /** Null at the root. */
  readonly parentId: string | null;
  /** The node's OWN amount, before children are added. */
  readonly ownAmount: Decimal;
  /** Whether this node's amount counts toward its parent. */
  readonly included: boolean;
  /** The basis that priced it, if any. */
  readonly basisId: string | null;
  readonly quantity: Decimal | null;
  readonly quantityUnit: string | null;
}

export interface CostGraph {
  readonly nodes: ReadonlyMap<string, CostGraphNode>;
  /** Child ids by parent id, in a stable order. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Nodes with no parent. */
  readonly roots: readonly string[];
}

export type GraphProblem =
  | { readonly kind: "CYCLE"; readonly path: readonly string[]; readonly message: string }
  | { readonly kind: "MISSING_PARENT"; readonly nodeId: string; readonly parentId: string; readonly message: string }
  | { readonly kind: "DUPLICATE_ID"; readonly nodeId: string; readonly message: string };

export type GraphBuildResult =
  | { readonly ok: true; readonly graph: CostGraph }
  | { readonly ok: false; readonly problems: readonly GraphProblem[] };

/**
 * Builds a graph from components, or reports every structural problem at once.
 *
 * ALL problems, not the first. Fixing a bill of materials one error per run is
 * miserable, and the errors are usually related — one bad reference often
 * produces a missing parent and a cycle together.
 */
export function buildCostGraph(components: readonly CostComponent[]): GraphBuildResult {
  const problems: GraphProblem[] = [];
  const nodes = new Map<string, CostGraphNode>();

  for (const c of components) {
    if (nodes.has(c.componentId)) {
      problems.push({
        kind: "DUPLICATE_ID",
        nodeId: c.componentId,
        message: `Two components share the id ${c.componentId}. Ids identify nodes in the graph, so a duplicate makes the structure ambiguous.`,
      });
      continue;
    }
    nodes.set(c.componentId, {
      id: c.componentId,
      kind: c.kind,
      label: c.label,
      parentId: c.parentId ?? null,
      ownAmount: fromString(c.amount),
      included: c.included,
      basisId: c.basisId ?? null,
      quantity: c.quantity === undefined ? null : fromString(c.quantity),
      quantityUnit: c.quantityUnit ?? null,
    });
  }

  for (const node of nodes.values()) {
    if (node.parentId !== null && !nodes.has(node.parentId)) {
      problems.push({
        kind: "MISSING_PARENT",
        nodeId: node.id,
        parentId: node.parentId,
        message: `Component ${node.id} names parent ${node.parentId}, which is not in this estimate. A node whose parent is absent cannot be rolled up into anything.`,
      });
    }
  }

  // Children sorted by id so traversal order is a property of the data rather
  // than of the order components happened to arrive in.
  const childrenOf = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (node.parentId === null || !nodes.has(node.parentId)) continue;
    const siblings = childrenOf.get(node.parentId) ?? [];
    siblings.push(node.id);
    childrenOf.set(node.parentId, siblings);
  }
  for (const siblings of childrenOf.values()) siblings.sort();

  const cycles = findCycles(nodes);
  problems.push(...cycles);

  if (problems.length > 0) return { ok: false, problems };

  const roots = [...nodes.values()]
    .filter((n) => n.parentId === null)
    .map((n) => n.id)
    .sort();

  return {
    ok: true,
    graph: {
      nodes,
      childrenOf: childrenOf as ReadonlyMap<string, readonly string[]>,
      roots,
    },
  };
}

/**
 * Every cycle, each named as the path that closes it.
 *
 * Walks parent links rather than child links — a cycle in a parent chain is
 * the same cycle, and following parents means each node is visited once from
 * its own perspective, which makes the reported path start where a reader
 * would look.
 */
function findCycles(nodes: ReadonlyMap<string, CostGraphNode>): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const state = new Map<string, "visiting" | "done">();
  const reported = new Set<string>();

  for (const start of [...nodes.keys()].sort()) {
    if (state.get(start) === "done") continue;

    const path: string[] = [];
    const onPath = new Set<string>();
    let current: string | null = start;

    while (current !== null) {
      if (onPath.has(current)) {
        // The loop is the tail of the path from the repeat onward, closed by
        // repeating the node it returns to. `a -> b -> a` reads as a loop; a
        // bare `a, b` does not.
        const from = path.indexOf(current);
        const loop = [...path.slice(from), current];
        const signature = [...loop].sort().join("|");
        if (!reported.has(signature)) {
          reported.add(signature);
          problems.push({
            kind: "CYCLE",
            path: loop,
            message: `Cost structure contains a cycle: ${loop.join(" -> ")}. A component cannot be part of itself, directly or through its ancestors.`,
          });
        }
        break;
      }
      if (state.get(current) === "done") break;

      onPath.add(current);
      path.push(current);
      const node: CostGraphNode | undefined = nodes.get(current);
      current = node?.parentId ?? null;
      if (current !== null && !nodes.has(current)) break;
    }

    for (const id of path) state.set(id, "done");
  }

  return problems;
}

/** A node's own amount plus everything included beneath it. */
export interface RolledNode {
  readonly id: string;
  readonly ownAmount: Decimal;
  readonly rolledAmount: Decimal;
  readonly descendantCount: number;
}

export interface RollupResult {
  readonly byNode: ReadonlyMap<string, RolledNode>;
  /** The sum across roots. The estimate's total. */
  readonly total: Decimal;
}

/**
 * Sums the graph bottom-up, exactly.
 *
 * ITERATIVE, NOT RECURSIVE. A deep bill of materials — and 100,000 nodes is a
 * requirement, not a hypothetical — would overflow the stack, and a stack
 * overflow in a cost engine surfaces as a crash with no indication that the
 * data was merely deep.
 *
 * Excluded nodes contribute nothing AND neither do their children. A memo
 * subtree is memo all the way down; including its children while excluding its
 * head would produce a total made of pieces that do not correspond to it.
 */
export function rollup(graph: CostGraph): RollupResult {
  const order = topologicalOrder(graph);
  const byNode = new Map<string, RolledNode>();

  // Deepest first, so every child is already computed when its parent is
  // reached and no node is visited twice.
  for (const id of order.deepestFirst) {
    const node = graph.nodes.get(id)!;
    const children = graph.childrenOf.get(id) ?? [];

    let rolled = node.ownAmount;
    let descendants = 0;
    for (const childId of children) {
      const child = byNode.get(childId)!;
      const childNode = graph.nodes.get(childId)!;
      descendants += child.descendantCount + 1;
      if (childNode.included) rolled = add(rolled, child.rolledAmount);
    }

    byNode.set(id, {
      id,
      ownAmount: node.ownAmount,
      rolledAmount: rolled,
      descendantCount: descendants,
    });
  }

  let total = ZERO;
  for (const rootId of graph.roots) {
    const root = graph.nodes.get(rootId)!;
    if (root.included) total = add(total, byNode.get(rootId)!.rolledAmount);
  }

  return { byNode, total };
}

/**
 * Node ids ordered so children always precede parents.
 *
 * Computed by depth from the roots. Ties are broken by id, so the order is a
 * property of the data and two runs over the same graph agree exactly — which
 * is what makes the rollup and every explanation reproducible.
 */
export function topologicalOrder(graph: CostGraph): {
  readonly deepestFirst: readonly string[];
  readonly depthOf: ReadonlyMap<string, number>;
} {
  const depthOf = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = graph.roots.map((id) => ({ id, depth: 0 }));

  // A read cursor rather than `shift()`. `Array.shift` re-indexes the whole
  // array, so a breadth-first walk using it is quadratic — with 100,000
  // siblings under one parent that measured 16 seconds, which is the
  // difference between a benchmark that passes and one that means something.
  let head = 0;
  while (head < queue.length) {
    const { id, depth } = queue[head]!;
    head += 1;
    const existing = depthOf.get(id);
    if (existing !== undefined && existing >= depth) continue;
    depthOf.set(id, depth);
    for (const child of graph.childrenOf.get(id) ?? []) {
      queue.push({ id: child, depth: depth + 1 });
    }
  }

  // Any node the walk never reached is unreachable from a root — possible
  // when a subtree's head was excluded from the roots list. Given a depth so
  // it still rolls up rather than vanishing silently.
  for (const id of graph.nodes.keys()) {
    if (!depthOf.has(id)) depthOf.set(id, 0);
  }

  // Deepest first; ties broken by id.
  //
  // The id tie-break is DEFENCE IN DEPTH and is currently unreachable: roots
  // are sorted and children are sorted, so the walk already visits in a
  // deterministic order and equal depths already arrive in id order. A
  // mutation removing it survives the test suite, which is recorded here
  // rather than papered over with a test that only exists to kill it.
  //
  // It stays because it makes the ordering guarantee local. Without it, this
  // function's determinism depends on two invariants maintained elsewhere in
  // the file, and a later change to either would break it silently.
  const deepestFirst = [...depthOf.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);

  return { deepestFirst, depthOf };
}

/**
 * The gap between a stated total and what the graph actually adds up to.
 *
 * Zero is the invariant. A non-zero result means the estimate cannot be
 * explained, because every explanation is ultimately "these pieces make that
 * number" — and if they do not, the explanation is fiction.
 */
export function reconciliationGap(graph: CostGraph, statedTotal: Decimal): Decimal {
  return subtract(statedTotal, rollup(graph).total);
}

/** Whether the graph reconciles within a tolerance the caller states. */
export function reconciles(graph: CostGraph, statedTotal: Decimal, tolerance: Decimal): boolean {
  const gap = reconciliationGap(graph, statedTotal);
  const magnitude = compare(gap, ZERO) < 0 ? subtract(ZERO, gap) : gap;
  return compare(magnitude, tolerance) <= 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// FINGERPRINTING
//
// A fingerprint answers "is this the same calculation" without comparing every
// number. It is what makes replay checkable: recompute an old estimate with
// its recorded method version, and the fingerprint must match.
//
// WHY THE CANONICAL FORM IS SEPARATE FROM THE HASH
//
// The hard part, and the part that determines correctness, is the canonical
// form: a total ordering over the inputs such that two runs that should agree
// produce byte-identical text. Sorting, normalising decimals so `12.30` and
// `12.3` are one value, and never iterating an object's own key order.
//
// The hash is the easy part, and it is the part this package must not
// implement. The constitution forbids home-grown cryptography, and the
// portability guard forbids `node:crypto`. Implementing SHA-256 here would
// violate the first to satisfy the second.
//
// So hashing is a PORT. The engine produces the canonical string; a host binds
// a real hash. The built-in default is explicitly NOT cryptographic and says
// so in its name, so nothing can mistake it for a security boundary — it is an
// identity check over data nobody is attacking.
// ─────────────────────────────────────────────────────────────────────────────

export interface HashPort {
  /** A stable digest of `text`. Must be deterministic across processes. */
  digest(text: string): string;
}

/**
 * A non-cryptographic 128-bit fingerprint, for identity only.
 *
 * Two independent FNV-1a streams over the same bytes with different offsets,
 * concatenated. Deterministic, dependency-free, and adequate for "did this
 * calculation change" — which is the only question asked of it.
 *
 * NOT SUITABLE where an adversary chooses the input. If a fingerprint ever
 * becomes a security boundary, bind a real hash through `HashPort` instead of
 * strengthening this.
 */
export const nonCryptographicHash: HashPort = Object.freeze({
  digest(text: string): string {
    // BigInt rather than 32-bit integer maths, so the mixing is exact and
    // identical on every engine rather than depending on how a runtime
    // optimises integer overflow.
    const MASK = (1n << 64n) - 1n;
    const PRIME = 1099511628211n;
    let a = 14695981039346656037n;
    let b = 14695981039346656037n ^ 0x9e3779b97f4a7c15n;

    for (let i = 0; i < text.length; i += 1) {
      const code = BigInt(text.charCodeAt(i));
      a = ((a ^ code) * PRIME) & MASK;
      b = ((b ^ (code + 0x9e37n)) * PRIME) & MASK;
    }
    return `fnv128:${a.toString(16).padStart(16, "0")}${b.toString(16).padStart(16, "0")}`;
  },
});

/**
 * The canonical text a fingerprint is taken over.
 *
 * Exported because it is the testable part. A disagreement between two
 * fingerprints is diagnosed by diffing these strings, and a test that pins the
 * canonical form catches an ordering bug that a hash comparison would only
 * report as "different".
 */
export function canonicalGraphForm(graph: CostGraph): string {
  // Sorted by id. NEVER by insertion order: an estimate whose fingerprint
  // depended on the order components arrived in would differ between two runs
  // that computed the same thing, and nothing would look wrong.
  const ids = [...graph.nodes.keys()].sort();
  const lines = ids.map((id) => {
    const n = graph.nodes.get(id)!;
    return [
      `id=${n.id}`,
      `kind=${n.kind}`,
      `parent=${n.parentId ?? ""}`,
      // Normalised, so 12.30 and 12.3 are one value. Without this a
      // fingerprint would change when nothing about the money did.
      `own=${decToString(normalize(n.ownAmount))}`,
      `included=${n.included ? "1" : "0"}`,
      `basis=${n.basisId ?? ""}`,
      `qty=${n.quantity === null ? "" : decToString(normalize(n.quantity))}`,
      `unit=${n.quantityUnit ?? ""}`,
    ].join(";");
  });
  return lines.join("\n");
}

/** Everything a fingerprint must cover: the inputs, the policy and the method. */
export interface FingerprintInput {
  readonly graph: CostGraph;
  /** Canonical policy text. Supplied by the caller, which owns policy shape. */
  readonly policyCanonical: string;
  readonly methodId: string;
  readonly methodVersion: string;
}

/**
 * The fingerprint for a calculation.
 *
 * Covers INPUTS, POLICY AND METHOD — deliberately not the result. Hashing the
 * result would make this a checksum; hashing what produced it makes it an
 * identity, so two runs that ought to agree can be shown to, and a run that
 * disagrees points at which input moved.
 */
export function fingerprint(input: FingerprintInput, hash: HashPort = nonCryptographicHash): string {
  const text = [
    `method=${input.methodId}@${input.methodVersion}`,
    `policy=${input.policyCanonical}`,
    "graph:",
    canonicalGraphForm(input.graph),
  ].join("\n");
  return hash.digest(text);
}

/** Rolled amounts brought to the policy's precision, for presentation. */
export function quantizeRollup(
  result: RollupResult,
  scale: number,
  mode: RoundingMode,
): ReadonlyMap<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const [id, node] of result.byNode) {
    out.set(id, rescale(node.rolledAmount, scale, mode));
  }
  return out;
}
