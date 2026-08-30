/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, toString } from "../../domain/decimal.js";
import type { CostComponent } from "../../domain/costModel.js";
import {
  buildCostGraph,
  canonicalGraphForm,
  fingerprint,
  nonCryptographicHash,
  reconciles,
  reconciliationGap,
  rollup,
  topologicalOrder,
} from "../costGraph.js";

// ─────────────────────────────────────────────────────────────────────────────
// The structure a cost has, and the two properties that make it trustworthy:
// it adds up, and it does so identically however the pieces arrived.
// ─────────────────────────────────────────────────────────────────────────────

const component = (over: Partial<CostComponent> & { componentId: string; amount: string }): CostComponent =>
  ({
    kind: "MATERIAL",
    label: over.componentId,
    currency: "GBP",
    included: true,
    notes: [],
    basisId: "b1",
    ...over,
  }) as CostComponent;

const build = (components: readonly CostComponent[]) => {
  const result = buildCostGraph(components);
  if (!result.ok) throw new Error(`build failed: ${result.problems.map((p) => p.message).join("; ")}`);
  return result.graph;
};

describe("a cost rolls up exactly", () => {
  it("sums a flat list", () => {
    const graph = build([
      component({ componentId: "a", amount: "10.01" }),
      component({ componentId: "b", amount: "20.02" }),
      component({ componentId: "c", amount: "0.97" }),
    ]);
    expect(toString(rollup(graph).total)).toBe("31.00");
  });

  it("sums a nested assembly bottom-up", () => {
    const graph = build([
      component({ componentId: "assembly", amount: "5.00" }),
      component({ componentId: "panel", amount: "10.00", parentId: "assembly" }),
      component({ componentId: "steel", amount: "7.50", parentId: "panel" }),
      component({ componentId: "cut", amount: "2.50", parentId: "panel", kind: "MACHINE" }),
    ]);
    const result = rollup(graph);
    // panel = 10 + 7.50 + 2.50 = 20; assembly = 5 + 20 = 25.
    expect(toString(result.byNode.get("panel")!.rolledAmount)).toBe("20.00");
    expect(toString(result.total)).toBe("25.00");
  });

  it("keeps a thousand pennies exact through the graph", () => {
    // The failure v1 has: a thousand float additions do not make ten pounds.
    const components = Array.from({ length: 1000 }, (_, i) =>
      component({ componentId: `c${i}`, amount: "0.01" }),
    );
    expect(toString(rollup(build(components)).total)).toBe("10.00");
  });

  it("excludes a memo node AND its children", () => {
    // A memo subtree is memo all the way down. Including its children while
    // excluding its head would build a total from pieces that do not
    // correspond to it.
    const graph = build([
      component({ componentId: "real", amount: "10.00" }),
      component({ componentId: "comparison", amount: "999.00", included: false }),
      component({ componentId: "under-memo", amount: "500.00", parentId: "comparison" }),
    ]);
    expect(toString(rollup(graph).total)).toBe("10.00");
  });

  it("excludes a memo child from an INCLUDED parent", () => {
    // The case the earlier memo test missed: there the excluded node was a
    // root, so the root filter caught it and the child rule was never
    // exercised. A comparison figure sitting inside a real assembly is the
    // shape that actually occurs — and adding it would silently inflate the
    // parent.
    const graph = build([
      component({ componentId: "assembly", amount: "10.00" }),
      component({ componentId: "part", amount: "5.00", parentId: "assembly" }),
      component({ componentId: "should-cost-comparison", amount: "999.00", parentId: "assembly", included: false }),
    ]);
    expect(toString(rollup(graph).byNode.get("assembly")!.rolledAmount)).toBe("15.00");
    expect(toString(rollup(graph).total)).toBe("15.00");
  });

  it("counts descendants for every node", () => {
    const graph = build([
      component({ componentId: "root", amount: "0" }),
      component({ componentId: "x", amount: "1", parentId: "root" }),
      component({ componentId: "y", amount: "1", parentId: "x" }),
    ]);
    expect(rollup(graph).byNode.get("root")!.descendantCount).toBe(2);
    expect(rollup(graph).byNode.get("x")!.descendantCount).toBe(1);
    expect(rollup(graph).byNode.get("y")!.descendantCount).toBe(0);
  });
});

describe("order does not change the answer", () => {
  const components = [
    component({ componentId: "assembly", amount: "5.00" }),
    component({ componentId: "panel", amount: "10.00", parentId: "assembly" }),
    component({ componentId: "steel", amount: "7.53", parentId: "panel" }),
    component({ componentId: "cut", amount: "2.47", parentId: "panel", kind: "MACHINE" }),
    component({ componentId: "weld", amount: "3.33", parentId: "assembly", kind: "LABOR" }),
  ];

  it("produces the same total whatever order components arrive in", () => {
    // Exact decimal addition is associative, so this is guaranteed — but it is
    // guaranteed only because the arithmetic is exact. In floating point the
    // same components in a different order genuinely do produce a different
    // total.
    const forward = toString(rollup(build(components)).total);
    const reversed = toString(rollup(build([...components].reverse())).total);
    const shuffled = toString(rollup(build([components[2]!, components[4]!, components[0]!, components[3]!, components[1]!])).total);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("produces the same CANONICAL FORM whatever order components arrive in", () => {
    // The property the fingerprint depends on. An estimate whose fingerprint
    // varied by insertion order would differ between two runs that computed
    // the same thing, and nothing would look wrong.
    const forward = canonicalGraphForm(build(components));
    const reversed = canonicalGraphForm(build([...components].reverse()));
    expect(reversed).toBe(forward);
  });

  it("produces the same FINGERPRINT whatever order components arrive in", () => {
    const input = { policyCanonical: "p", methodId: "DIRECT_JOB", methodVersion: "1.0.0" };
    const forward = fingerprint({ ...input, graph: build(components) });
    const reversed = fingerprint({ ...input, graph: build([...components].reverse()) });
    expect(reversed).toBe(forward);
  });

  it("orders children deterministically regardless of arrival", () => {
    const forward = build(components).childrenOf.get("assembly");
    const reversed = build([...components].reverse()).childrenOf.get("assembly");
    expect(reversed).toEqual(forward);
  });
});

describe("cycles are caught before any arithmetic", () => {
  it("names the path that closes the loop", () => {
    // `a -> b -> a` is a fix. A stack overflow naming a line of framework code
    // is a bug report.
    const result = buildCostGraph([
      component({ componentId: "a", amount: "1", parentId: "b" }),
      component({ componentId: "b", amount: "1", parentId: "a" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cycle = result.problems.find((p) => p.kind === "CYCLE");
    expect(cycle).toBeDefined();
    expect(cycle!.message).toContain("->");
    expect(cycle!.message).toContain("cannot be part of itself");
  });

  it("catches a node that is its own parent", () => {
    const result = buildCostGraph([component({ componentId: "a", amount: "1", parentId: "a" })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.kind === "CYCLE")).toBe(true);
  });

  it("catches a long cycle", () => {
    const result = buildCostGraph([
      component({ componentId: "a", amount: "1", parentId: "d" }),
      component({ componentId: "b", amount: "1", parentId: "a" }),
      component({ componentId: "c", amount: "1", parentId: "b" }),
      component({ componentId: "d", amount: "1", parentId: "c" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cycle = result.problems.find((p) => p.kind === "CYCLE");
    expect(cycle!.path.length).toBeGreaterThanOrEqual(4);
  });

  it("reports one cycle once, not once per member", () => {
    const result = buildCostGraph([
      component({ componentId: "a", amount: "1", parentId: "b" }),
      component({ componentId: "b", amount: "1", parentId: "a" }),
    ]);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems.filter((p) => p.kind === "CYCLE")).toHaveLength(1);
  });
});

describe("structural problems are reported all at once", () => {
  it("reports every problem rather than the first", () => {
    // Fixing a bill of materials one error per run is miserable, and the
    // errors are usually related.
    const result = buildCostGraph([
      component({ componentId: "dup", amount: "1" }),
      component({ componentId: "dup", amount: "2" }),
      component({ componentId: "orphan", amount: "1", parentId: "nowhere" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((p) => p.kind === "DUPLICATE_ID")).toBe(true);
    expect(result.problems.some((p) => p.kind === "MISSING_PARENT")).toBe(true);
  });

  it("explains a missing parent in terms of what it breaks", () => {
    const result = buildCostGraph([component({ componentId: "orphan", amount: "1", parentId: "nowhere" })]);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]!.message).toContain("cannot be rolled up");
  });
});

describe("reconciliation is the invariant", () => {
  const graph = build([
    component({ componentId: "a", amount: "10.00" }),
    component({ componentId: "b", amount: "20.00" }),
  ]);

  it("reports zero when the parts make the total", () => {
    expect(toString(reconciliationGap(graph, fromString("30.00")))).toBe("0.00");
  });

  it("reports the gap rather than a boolean", () => {
    // So a caller can tell a rounding artefact from a fault.
    expect(toString(reconciliationGap(graph, fromString("30.01")))).toBe("0.01");
    expect(toString(reconciliationGap(graph, fromString("29.99")))).toBe("-0.01");
  });

  it("accepts a tolerance in either direction", () => {
    expect(reconciles(graph, fromString("30.01"), fromString("0.01"))).toBe(true);
    expect(reconciles(graph, fromString("29.99"), fromString("0.01"))).toBe(true);
    expect(reconciles(graph, fromString("30.02"), fromString("0.01"))).toBe(false);
  });
});

describe("the fingerprint identifies the calculation, not the answer", () => {
  const graph = build([component({ componentId: "a", amount: "10.00" })]);
  const base = { graph, policyCanonical: "round=HALF_EVEN", methodId: "DIRECT_JOB", methodVersion: "1.0.0" };

  it("is stable across runs", () => {
    expect(fingerprint(base)).toBe(fingerprint(base));
  });

  it("changes when the method version changes", () => {
    // A formula change that alters results must change the fingerprint, or an
    // old estimate could be replayed against new maths and appear to agree.
    expect(fingerprint({ ...base, methodVersion: "1.0.1" })).not.toBe(fingerprint(base));
  });

  it("changes when the policy changes", () => {
    expect(fingerprint({ ...base, policyCanonical: "round=HALF_UP" })).not.toBe(fingerprint(base));
  });

  it("changes when an input changes", () => {
    const other = build([component({ componentId: "a", amount: "10.01" })]);
    expect(fingerprint({ ...base, graph: other })).not.toBe(fingerprint(base));
  });

  it("does NOT change when an amount is written to different precision", () => {
    // 12.30 and 12.3 are the same money. A fingerprint that changed here would
    // report a difference where none exists.
    const a = build([component({ componentId: "x", amount: "12.30" })]);
    const b = build([component({ componentId: "x", amount: "12.3" })]);
    expect(fingerprint({ ...base, graph: b })).toBe(fingerprint({ ...base, graph: a }));
  });

  it("accepts a host-supplied hash", () => {
    // Hashing is a port: the constitution forbids home-grown cryptography and
    // portability forbids node:crypto, so the engine owns the canonical form
    // and a host binds a real digest.
    const host = { digest: (t: string) => `host:${t.length}` };
    expect(fingerprint(base, host)).toMatch(/^host:\d+$/);
  });

  it("labels the built-in hash as non-cryptographic in its own output", () => {
    // So nothing can mistake it for a security boundary.
    expect(nonCryptographicHash.digest("x")).toMatch(/^fnv128:/);
  });

  it("produces different digests for different text", () => {
    const digests = new Set(["", "a", "b", "ab", "ba", "aa"].map((t) => nonCryptographicHash.digest(t)));
    expect(digests.size).toBe(6);
  });
});

describe("scale", () => {
  it("handles a 100,000-node graph without recursing", () => {
    // The directive's benchmark. A recursive rollup would overflow the stack,
    // and the crash would name framework code rather than say the data was
    // deep.
    const components: CostComponent[] = [component({ componentId: "root", amount: "0" })];
    for (let i = 0; i < 100_000; i += 1) {
      components.push(component({ componentId: `n${i}`, amount: "0.01", parentId: "root" }));
    }
    const started = Date.now();
    const graph = build(components);
    const result = rollup(graph);
    const elapsed = Date.now() - started;

    expect(toString(result.total)).toBe("1000.00");
    expect(graph.nodes.size).toBe(100_001);
    // Generous: this asserts the algorithm is not accidentally quadratic, not
    // that any particular machine is fast.
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it("handles a deep chain without recursing", () => {
    // 10,000 levels. A recursive implementation dies somewhere around here.
    const components: CostComponent[] = [component({ componentId: "n0", amount: "0.01" })];
    for (let i = 1; i < 10_000; i += 1) {
      components.push(component({ componentId: `n${i}`, amount: "0.01", parentId: `n${i - 1}` }));
    }
    const result = rollup(build(components));
    expect(toString(result.total)).toBe("100.00");
  }, 60_000);
});

describe("topological order is a property of the data", () => {
  it("puts children before parents", () => {
    const graph = build([
      component({ componentId: "root", amount: "1" }),
      component({ componentId: "mid", amount: "1", parentId: "root" }),
      component({ componentId: "leaf", amount: "1", parentId: "mid" }),
    ]);
    const { deepestFirst } = topologicalOrder(graph);
    expect(deepestFirst.indexOf("leaf")).toBeLessThan(deepestFirst.indexOf("mid"));
    expect(deepestFirst.indexOf("mid")).toBeLessThan(deepestFirst.indexOf("root"));
  });

  it("breaks ties by id, so two runs agree exactly", () => {
    const components = [
      component({ componentId: "root", amount: "1" }),
      component({ componentId: "b", amount: "1", parentId: "root" }),
      component({ componentId: "a", amount: "1", parentId: "root" }),
    ];
    const forward = topologicalOrder(build(components)).deepestFirst;
    const reversed = topologicalOrder(build([...components].reverse())).deepestFirst;
    expect(reversed).toEqual(forward);
  });
});
