// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { DependencyClass } from "@proworks-hub/hive-runtime";

import type { PackageFacts } from "../chambers/conformance.js";

// ─────────────────────────────────────────────────────────────────────────────
// DependencyAssuranceIQ.
//
// The dependency graph, and the four things that go wrong in one.
//
// The distinction this module exists to keep is between a dependency that is
// DECLARED and one that is REAL. A package that imports something it never
// declared still depends on it — it is simply a dependency nobody can plan
// around, nobody sees in a diagram, and nobody removes deliberately. So the
// graph is built from what is declared, and undeclared imports are reported as
// their own category rather than folded into the graph as though they were
// legitimate.
// ─────────────────────────────────────────────────────────────────────────────

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly dependencyClass: DependencyClass;
}

export interface DependencyGraph {
  readonly nodes: readonly string[];
  readonly edges: readonly DependencyEdge[];
}

/**
 * Builds the graph from declared runtime dependencies.
 *
 * External packages (anything outside the workspace) become nodes too, and
 * that is deliberate: `zod` is a real dependency with a real blast radius, and
 * a graph that showed only internal edges would make the suite look more
 * self-contained than it is.
 */
export function buildDependencyGraph(packages: readonly PackageFacts[]): DependencyGraph {
  const nodes = new Set<string>();
  const edges: DependencyEdge[] = [];
  for (const pkg of packages) {
    nodes.add(pkg.packageName);
    const declared = new Map(
      (pkg.participant?.collaboration.requires ?? []).map((d) => [d.dependencyId, d.dependencyClass]),
    );
    for (const dep of pkg.dependencies) {
      nodes.add(dep);
      // PROVIDER is the honest default for an undeclared external dependency:
      // it says "replaceable bridge to something outside", which is true of an
      // npm package, without asserting the REQUIRED coupling that would be a
      // stronger claim than the evidence supports.
      edges.push({ from: pkg.packageName, to: dep, dependencyClass: declared.get(dep) ?? "PROVIDER" });
    }
  }
  return {
    nodes: [...nodes].sort(),
    edges: edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to)),
  };
}

/**
 * Every dependency cycle, as the actual ring of packages.
 *
 * Returns the ring rather than a boolean because "there is a cycle somewhere"
 * is not actionable. Iterative rather than recursive: a workspace can grow
 * past a comfortable stack depth, and an assurance tool that crashes on a
 * large repository is an assurance tool that gets switched off.
 */
export function findCycles(graph: DependencyGraph): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const onPath = new Set<string>();

  for (const start of graph.nodes) {
    if (seen.has(start)) continue;
    const stack: { node: string; path: string[]; index: number }[] = [
      { node: start, path: [start], index: 0 },
    ];
    onPath.add(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = adjacency.get(frame.node) ?? [];

      if (frame.index >= children.length) {
        onPath.delete(frame.node);
        seen.add(frame.node);
        stack.pop();
        continue;
      }

      const child = children[frame.index]!;
      frame.index += 1;

      if (onPath.has(child)) {
        // Report from the point the ring closes, so the cycle printed is the
        // cycle, not the walk that happened to reach it.
        const at = frame.path.indexOf(child);
        if (at !== -1) cycles.push([...frame.path.slice(at), child]);
        continue;
      }
      if (seen.has(child)) continue;

      onPath.add(child);
      stack.push({ node: child, path: [...frame.path, child], index: 0 });
    }
  }

  return cycles.sort((a, b) => a.join(">").localeCompare(b.join(">")));
}

export interface DependencyViolation {
  readonly kind:
    | "UNDECLARED_REQUIRED"
    | "DECLARED_BUT_ABSENT"
    | "CYCLE"
    | "FORBIDDEN_DIRECTION";
  readonly subject: string;
  readonly detail: string;
}

/**
 * Compares what a package declares against what it actually depends on.
 *
 * Both directions are violations, and they are different problems:
 *
 *   UNDECLARED_REQUIRED  It depends on something its collaboration contract
 *                        never mentions. Nobody planning a failure knows to
 *                        plan for that one.
 *   DECLARED_BUT_ABSENT  It promises a relationship it does not have. Usually
 *                        a dependency that was removed while the contract was
 *                        left behind — harmless today and misleading forever.
 */
export function findDependencyViolations(
  packages: readonly PackageFacts[],
  forbidden: readonly { readonly from: string; readonly to: string }[] = [],
): readonly DependencyViolation[] {
  const out: DependencyViolation[] = [];

  for (const pkg of packages) {
    const contract = pkg.participant?.collaboration.requires;
    if (!contract) continue; // Not adopted; scope is the register's business.

    const declared = new Set(contract.map((d) => d.dependencyId));
    const runtimeDeclared = new Set(
      contract.filter((d) => d.dependencyClass !== "DEVELOPMENT").map((d) => d.dependencyId),
    );

    for (const dep of pkg.dependencies) {
      if (!declared.has(dep)) {
        out.push({
          kind: "UNDECLARED_REQUIRED",
          subject: pkg.packageName,
          detail: `depends on ${dep}, which its collaboration contract does not mention`,
        });
      }
    }
    for (const id of runtimeDeclared) {
      if (!pkg.dependencies.includes(id)) {
        out.push({
          kind: "DECLARED_BUT_ABSENT",
          subject: pkg.packageName,
          detail: `declares a runtime dependency on ${id} that the package does not have`,
        });
      }
    }
  }

  for (const pkg of packages) {
    for (const rule of forbidden) {
      if (pkg.packageName.includes(rule.from) && pkg.dependencies.some((d) => d.includes(rule.to))) {
        out.push({
          kind: "FORBIDDEN_DIRECTION",
          subject: pkg.packageName,
          detail: `${rule.from} must not depend on ${rule.to}`,
        });
      }
    }
  }

  for (const cycle of findCycles(buildDependencyGraph(packages))) {
    out.push({ kind: "CYCLE", subject: cycle[0] ?? "", detail: cycle.join(" → ") });
  }

  return out;
}
