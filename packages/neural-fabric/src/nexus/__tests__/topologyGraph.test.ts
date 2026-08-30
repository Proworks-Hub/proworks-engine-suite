/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { Adjacency, FabricNode, TopologyVersion, Zone } from "../../domain/topology.js";
import { transitionAllowed, zoneLossStopsLocalWork, zonesMayRelate } from "../../domain/topology.js";
import { blastRadius, buildGraph, candidateRoutes, diffTopology } from "../topologyGraph.js";

// ─────────────────────────────────────────────────────────────────────────────
// Default deny, sandboxes that cannot reach out, and a diff that separates the
// changes that widen from the changes that only take away.
// ─────────────────────────────────────────────────────────────────────────────

const zone = (id: string, kind: Zone["kind"], instanceId = "ksix"): Zone => ({
  zoneId: id,
  kind,
  instanceId,
});

const node = (id: string, zoneId: string, capabilities: string[], isTest = false): FabricNode => ({
  nodeId: id,
  kind: "ENGINE",
  zoneId,
  capabilities,
  workloadIdentityRef: `spiffe://ksix/${id}`,
  isTest,
});

const edge = (
  id: string,
  from: string,
  to: string,
  capability: string,
  lane: Adjacency["lane"] = "COMMAND",
  state: Adjacency["state"] = "ACTIVE",
): Adjacency => ({
  adjacencyId: id,
  fromNodeId: from,
  toNodeId: to,
  lane,
  capability,
  authorizingDecisionRef: `dec-${id}`,
  state,
});

const version = (over: Partial<TopologyVersion> = {}): TopologyVersion => ({
  versionId: "v1",
  parentVersionId: null,
  instanceId: "ksix",
  zones: [zone("local", "LOCAL"), zone("gw", "GATEWAY")],
  nodes: [
    node("ordering", "local", ["ordering"]),
    node("plan-a", "local", ["manufacturing.plan"]),
    node("plan-b", "local", ["manufacturing.plan"]),
  ],
  adjacencies: [edge("a1", "ordering", "plan-a", "manufacturing.plan")],
  rationale: "Initial topology.",
  createdAt: "2026-08-30T00:00:00.000Z",
  state: "ACTIVE",
  activationDecisionRef: "dec-activate-1",
  ...over,
});

const build = (v: TopologyVersion) => {
  const r = buildGraph(v);
  if (!r.ok) throw new Error(`build failed: ${r.problems.map((p) => p.message).join("; ")}`);
  return r.graph;
};

describe("the graph refuses a topology it cannot make sense of", () => {
  it("builds a valid topology", () => {
    const r = buildGraph(version());
    expect(r.ok).toBe(true);
  });

  it("refuses a node in a zone that does not exist", () => {
    const r = buildGraph(version({ nodes: [node("stray", "nowhere", ["x"])] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.message).toContain("no zone has no isolation boundary");
  });

  it("refuses an adjacency to a node that does not exist", () => {
    const r = buildGraph(version({ adjacencies: [edge("a1", "ordering", "ghost", "x")] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.kind).toBe("UNKNOWN_NODE");
  });

  it("REFUSES an adjacency granting a capability the target does not provide", () => {
    // The edge would grant access to nothing and read in a review as though it
    // granted access to something.
    const r = buildGraph(version({ adjacencies: [edge("a1", "ordering", "plan-a", "not.provided")] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.message).toContain("reads in a review as though it grants access");
  });

  it("REFUSES an adjacency joining a test node to a production one", () => {
    const r = buildGraph(
      version({
        nodes: [node("ordering", "local", ["ordering"]), node("plan-a", "local", ["manufacturing.plan"], true)],
        adjacencies: [edge("a1", "ordering", "plan-a", "manufacturing.plan")],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.message).toContain("production data reaching a test is a leak");
  });

  it("REFUSES an adjacency whose zones may not relate", () => {
    // zonesMayRelate is checked in isolation elsewhere. This proves buildGraph
    // actually consults it — a topology is where the rule has to bind.
    const r = buildGraph(
      version({
        zones: [zone("local", "LOCAL"), zone("sbx", "SANDBOX")],
        nodes: [node("ordering", "local", ["ordering"]), node("sim", "sbx", ["manufacturing.plan"])],
        adjacencies: [edge("a1", "ordering", "sim", "manufacturing.plan")],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems[0]!.kind).toBe("ZONE_RELATION_FORBIDDEN");
      expect(r.problems[0]!.message).toContain("how test data becomes real data");
    }
  });

  it("REFUSES a cross-instance adjacency that skips a gateway, when building", () => {
    const r = buildGraph(
      version({
        zones: [zone("local", "LOCAL"), zone("far", "LOCAL", "proworks")],
        nodes: [node("ordering", "local", ["ordering"]), node("remote", "far", ["manufacturing.plan"])],
        adjacencies: [edge("a1", "ordering", "remote", "manufacturing.plan")],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.message).toContain("shared private-store access with extra steps");
  });

  it("reports EVERY problem, not just the first", () => {
    // Four mistakes should be fixed in one pass.
    const r = buildGraph(
      version({
        nodes: [node("a", "nowhere", ["x"]), node("b", "elsewhere", ["y"])],
        adjacencies: [edge("a1", "ghost", "phantom", "z")],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses duplicate ids rather than letting iteration order decide", () => {
    const r = buildGraph(version({ zones: [zone("local", "LOCAL"), zone("local", "REGIONAL")] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]!.kind).toBe("DUPLICATE_ID");
  });

  it("warns about an admitted but unreachable node", () => {
    const r = buildGraph(version());
    if (r.ok) expect(r.warnings.join()).toContain("plan-b");
  });

  it("indexes only ACTIVE adjacencies, keeping retired ones as history", () => {
    const graph = build(
      version({
        adjacencies: [
          edge("a1", "ordering", "plan-a", "manufacturing.plan"),
          edge("a2", "ordering", "plan-b", "manufacturing.plan", "COMMAND", "RETIRED"),
        ],
      }),
    );
    expect(graph.outgoing.get("ordering")).toHaveLength(1);
  });
});

describe("default deny: an adjacency has to exist", () => {
  it("permits a route where an adjacency was created", () => {
    const routes = candidateRoutes(build(version()), "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.permitted).toHaveLength(1);
    expect(routes.permitted[0]!.toNodeId).toBe("plan-a");
  });

  it("REFUSES a provider with no adjacency, and says default-deny", () => {
    // plan-b provides the capability and nobody connected it.
    const routes = candidateRoutes(build(version()), "ordering", "manufacturing.plan", "COMMAND");
    const refused = routes.rejected.find((r) => r.toNodeId === "plan-b")!;
    expect(refused.reason).toContain("Default-deny");
  });

  it("refuses a lane nobody granted, even to a node it can reach", () => {
    // Ordering may command manufacturing. That is not permission to subscribe
    // to its evidence.
    const routes = candidateRoutes(build(version()), "ordering", "manufacturing.plan", "EVIDENCE");
    expect(routes.permitted).toEqual([]);
  });

  it("says so when nothing provides the capability at all", () => {
    const routes = candidateRoutes(build(version()), "ordering", "nobody.provides.this", "COMMAND");
    expect(routes.note).toContain("No route exists to be permitted or refused");
  });

  it("says so when the sender is not in the topology", () => {
    const routes = candidateRoutes(build(version()), "stranger", "manufacturing.plan", "COMMAND");
    expect(routes.note).toContain("the sender does not exist here");
  });

  it("refuses to route a node to itself", () => {
    const graph = build(
      version({
        nodes: [node("both", "local", ["ordering", "manufacturing.plan"])],
        adjacencies: [],
      }),
    );
    const routes = candidateRoutes(graph, "both", "manufacturing.plan", "COMMAND");
    expect(routes.rejected[0]!.reason).toContain("does not route to itself");
  });

  it("REFUSES to address a capability the FINAL hop does not name", () => {
    // The node is reachable — on a different capability. Reachability is not
    // entitlement, and an edge granting "transit" must not also grant the
    // thing sitting behind it.
    const graph = build(
      version({
        nodes: [node("ordering", "local", ["ordering"]), node("worker", "local", ["transit", "payroll.run"])],
        adjacencies: [edge("a1", "ordering", "worker", "transit")],
      }),
    );
    expect(candidateRoutes(graph, "ordering", "transit", "COMMAND").permitted).toHaveLength(1);
    const payroll = candidateRoutes(graph, "ordering", "payroll.run", "COMMAND");
    expect(payroll.permitted).toEqual([]);
    expect(payroll.rejected[0]!.reason).toContain("Default-deny");
  });

  it("NEVER reads health or scores a path", () => {
    // Nexus generates candidates; RoutingIQ chooses. Collapsing them would let
    // a routing optimisation quietly widen what is reachable.
    const routes = candidateRoutes(build(version()), "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.note).toContain("choosing among them is RoutingIQ's");
    expect(Object.keys(routes.permitted[0]!)).not.toContain("score");
  });

  it("finds a path through a gateway hop", () => {
    const graph = build(
      version({
        zones: [zone("local", "LOCAL"), zone("gw", "GATEWAY")],
        nodes: [
          node("ordering", "local", ["ordering"]),
          node("gateway", "gw", ["transit"]),
          node("remote", "gw", ["manufacturing.plan"]),
        ],
        adjacencies: [
          edge("a1", "ordering", "gateway", "transit"),
          edge("a2", "gateway", "remote", "manufacturing.plan"),
        ],
      }),
    );
    const routes = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.permitted).toHaveLength(1);
    expect(routes.permitted[0]!.hops.map((h) => h.adjacencyId)).toEqual(["a1", "a2"]);
    // It began in a local zone and did not stay there. "Contains a local zone"
    // is not the same question as "never left one".
    expect(routes.permitted[0]!.zonePath).toEqual(["local", "gw"]);
    expect(routes.permitted[0]!.staysLocal).toBe(false);
  });

  it("stops at the hop limit rather than searching an unbounded graph", () => {
    const graph = build(
      version({
        nodes: [
          node("n0", "local", ["start"]),
          node("n1", "local", ["t"]),
          node("n2", "local", ["t"]),
          node("n3", "local", ["target"]),
        ],
        adjacencies: [
          edge("a1", "n0", "n1", "t"),
          edge("a2", "n1", "n2", "t"),
          edge("a3", "n2", "n3", "target"),
        ],
      }),
    );
    expect(candidateRoutes(graph, "n0", "target", "COMMAND", 3).permitted).toHaveLength(1);
    expect(candidateRoutes(graph, "n0", "target", "COMMAND", 2).permitted).toEqual([]);
  });

  it("terminates on a cycle instead of looping forever", () => {
    const graph = build(
      version({
        nodes: [node("a", "local", ["t"]), node("b", "local", ["t"])],
        adjacencies: [edge("a1", "a", "b", "t"), edge("a2", "b", "a", "t")],
      }),
    );
    expect(() => candidateRoutes(graph, "a", "nothing", "COMMAND", 10)).not.toThrow();
  });

  it("visits each node once, so a dense graph does not explode", () => {
    // The visited set is not decoration. Without it the search re-enters every
    // node by every path, and a fully connected fabric turns a bounded walk
    // into branching^maxHops. Ten nodes at eight hops is roughly 43 million
    // steps unguarded and about ninety guarded.
    const ids = Array.from({ length: 10 }, (_, i) => `n${i}`);
    // One node provides the goal and NO adjacency names it, so the search runs
    // the full bounded walk and finds nothing. Aiming at a capability nobody
    // provides would return before searching at all, which is how this test
    // passed while the guard was removed.
    const nodes = [...ids.map((id) => node(id, "local", ["mesh"])), node("goal", "local", ["goal.capability"])];
    const adjacencies = ids.flatMap((from) =>
      ids.filter((to) => to !== from).map((to) => edge(`e-${from}-${to}`, from, to, "mesh")),
    );
    const graph = build(version({ nodes, adjacencies }));

    const started = Date.now();
    const routes = candidateRoutes(graph, "n0", "goal.capability", "COMMAND", 8);
    const elapsed = Date.now() - started;

    expect(routes.permitted).toEqual([]);
    // Generous by two orders of magnitude. This asserts the algorithm is not
    // exponential, not that any particular machine is fast.
    expect(elapsed).toBeLessThan(2_000);
  }, 20_000);

  it("marks a path that stays inside one local zone", () => {
    const routes = candidateRoutes(build(version()), "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.permitted[0]!.staysLocal).toBe(true);
    expect(routes.permitted[0]!.crossesInstance).toBe(false);
  });

  it("marks a path that crosses an instance", () => {
    const graph = build(
      version({
        zones: [zone("local", "LOCAL"), zone("gw", "GATEWAY"), zone("far", "GATEWAY", "proworks")],
        nodes: [
          node("ordering", "local", ["ordering"]),
          node("gateway", "gw", ["transit"]),
          node("remote", "far", ["manufacturing.plan"]),
        ],
        adjacencies: [
          edge("a1", "ordering", "gateway", "transit"),
          edge("a2", "gateway", "remote", "manufacturing.plan"),
        ],
      }),
    );
    const routes = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.permitted[0]!.crossesInstance).toBe(true);
  });
});

describe("zones decide what may relate before any adjacency is considered", () => {
  it("REFUSES a sandbox reaching production", () => {
    const r = zonesMayRelate(zone("sbx", "SANDBOX"), zone("local", "LOCAL"));
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("every simulation a potential production incident");
  });

  it("REFUSES production reaching INTO a sandbox", () => {
    // The direction people forget. It is how test data becomes real data.
    const r = zonesMayRelate(zone("local", "LOCAL"), zone("sbx", "SANDBOX"));
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("how test data becomes real data");
  });

  it("permits two sandboxes in the same instance", () => {
    expect(zonesMayRelate(zone("s1", "SANDBOX"), zone("s2", "SANDBOX")).permitted).toBe(true);
  });

  it("refuses sandboxes in different instances", () => {
    expect(zonesMayRelate(zone("s1", "SANDBOX"), zone("s2", "SANDBOX", "other")).permitted).toBe(false);
  });

  it("REFUSES a cross-instance route that does not terminate at a gateway", () => {
    const r = zonesMayRelate(zone("local", "LOCAL"), zone("other-local", "LOCAL", "proworks"));
    expect(r.permitted).toBe(false);
    expect(r.reason).toContain("shared private-store access with extra steps");
  });

  it("permits a cross-instance route through a gateway", () => {
    expect(zonesMayRelate(zone("gw", "GATEWAY"), zone("far", "LOCAL", "proworks")).permitted).toBe(true);
  });

  it("says only the loss of a LOCAL zone stops local work", () => {
    // "Local first, Collective second", in one function.
    expect(zoneLossStopsLocalWork("LOCAL")).toBe(true);
    expect(zoneLossStopsLocalWork("COLLECTIVE")).toBe(false);
    expect(zoneLossStopsLocalWork("REGIONAL")).toBe(false);
  });
});

describe("a topology version is a proposal until something activates it", () => {
  it("allows the propose-simulate-approve-apply sequence", () => {
    expect(transitionAllowed("DRAFT", "SIMULATED").allowed).toBe(true);
    expect(transitionAllowed("SIMULATED", "APPROVED").allowed).toBe(true);
    expect(transitionAllowed("APPROVED", "ACTIVE").allowed).toBe(true);
  });

  it("REFUSES a draft becoming active directly", () => {
    const r = transitionAllowed("DRAFT", "ACTIVE");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("Approval is a separate act from creation");
  });

  it("REFUSES editing an active topology back to a draft", () => {
    // Traffic is flowing over it; changing it in place alters the rules under
    // signals already in flight.
    const r = transitionAllowed("ACTIVE", "DRAFT");
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toContain("signals already in flight");
  });

  it("REFUSES reviving history", () => {
    for (const state of ["SUPERSEDED", "ROLLED_BACK"] as const) {
      const r = transitionAllowed(state, "ACTIVE");
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toContain("rewrite what a past routing decision was made under");
    }
  });

  it("permits rollback from active", () => {
    expect(transitionAllowed("ACTIVE", "ROLLED_BACK").allowed).toBe(true);
    expect(transitionAllowed("ACTIVE", "SUPERSEDED").allowed).toBe(true);
  });

  it("permits sending an approved version back to draft", () => {
    expect(transitionAllowed("APPROVED", "DRAFT").allowed).toBe(true);
  });
});

describe("what fails if this disappears", () => {
  const graph = build(
    version({
      nodes: [
        node("ordering", "local", ["ordering"]),
        node("plan-a", "local", ["manufacturing.plan"]),
        node("plan-b", "local", ["manufacturing.plan"]),
        node("only", "local", ["irreplaceable"]),
      ],
      adjacencies: [
        edge("a1", "ordering", "plan-a", "manufacturing.plan"),
        edge("a2", "ordering", "plan-b", "manufacturing.plan"),
        edge("a3", "ordering", "only", "irreplaceable"),
      ],
    }),
  );

  it("separates a capability LOST from one merely degraded", () => {
    // An outage and a capacity problem are different, and treating them the
    // same makes every node look critical.
    expect(blastRadius(graph, "plan-a").capabilitiesLost).toEqual([]);
    expect(blastRadius(graph, "plan-a").capabilitiesDegraded).toEqual(["manufacturing.plan"]);
    expect(blastRadius(graph, "only").capabilitiesLost).toEqual(["irreplaceable"]);
  });

  it("names a single point of failure as one", () => {
    expect(blastRadius(graph, "only").note).toContain("single point of failure");
  });

  it("says a replaceable node removes capacity, not capability", () => {
    expect(blastRadius(graph, "plan-a").note).toContain("removes capacity but no capability");
  });

  it("lists who depends on it directly", () => {
    expect(blastRadius(graph, "plan-a").directlyAffected).toEqual(["ordering"]);
  });

  it("says nothing depends on a node that is not there", () => {
    expect(blastRadius(graph, "ghost").note).toContain("nothing depends on it here");
  });
});

describe("a diff separates what widens from what only takes away", () => {
  const before = version();
  const after = version({
    versionId: "v2",
    parentVersionId: "v1",
    adjacencies: [
      edge("a1", "ordering", "plan-a", "manufacturing.plan"),
      edge("a2", "ordering", "plan-b", "manufacturing.plan"),
    ],
  });

  it("flags a new adjacency as WIDENING", () => {
    const d = diffTopology(before, after);
    expect(d.adjacenciesAdded).toEqual(["a2"]);
    expect(d.wideningChanges).toHaveLength(1);
    expect(d.note).toContain("needs a governed decision behind it");
  });

  it("does not flag a retirement as widening", () => {
    const narrowed = version({
      versionId: "v2",
      adjacencies: [edge("a1", "ordering", "plan-a", "manufacturing.plan", "COMMAND", "RETIRED")],
    });
    const d = diffTopology(before, narrowed);
    expect(d.wideningChanges).toEqual([]);
    expect(d.note).toContain("Every difference removes, retires or quarantines");
  });

  it("FLAGS a quarantined edge returning to active as widening", () => {
    // The change most likely to be waved through as "just putting it back".
    const quarantined = version({
      adjacencies: [edge("a1", "ordering", "plan-a", "manufacturing.plan", "COMMAND", "QUARANTINED")],
    });
    const d = diffTopology(quarantined, before);
    expect(d.wideningChanges.join()).toContain("returns to ACTIVE");
  });

  it("reports node additions and removals", () => {
    const d = diffTopology(before, version({ versionId: "v2", nodes: [node("ordering", "local", ["ordering"])] }));
    expect(d.nodesRemoved).toEqual(["plan-a", "plan-b"]);
  });

  it("sorts additions, so two orderings of the same change read the same", () => {
    const twoAdded = version({
      versionId: "v2",
      adjacencies: [
        edge("z-last", "ordering", "plan-b", "manufacturing.plan"),
        edge("a1", "ordering", "plan-a", "manufacturing.plan"),
        edge("b-mid", "ordering", "plan-b", "manufacturing.plan"),
      ],
    });
    expect(diffTopology(before, twoAdded).adjacenciesAdded).toEqual(["b-mid", "z-last"]);
  });

  it("diffs identically however the versions are ordered internally", () => {
    // A diff that reorders itself is a diff people stop reading.
    const shuffled = version({
      versionId: "v2",
      parentVersionId: "v1",
      adjacencies: [
        edge("a2", "ordering", "plan-b", "manufacturing.plan"),
        edge("a1", "ordering", "plan-a", "manufacturing.plan"),
      ],
    });
    expect(diffTopology(before, shuffled)).toEqual(diffTopology(before, after));
  });
});

describe("candidateRoutes records the FIRST discovered path per provider", () => {
  it("a provider reachable directly and via a longer route gets the direct path", () => {
    // hub -> p directly (capability edge), and hub -> x -> p (transit then
    // capability). Breadth-first discovery must keep the one-hop path; a
    // later, longer discovery may not overwrite it.
    const built = buildGraph({
      versionId: "v-shortest",
      parentVersionId: null,
      instanceId: "ksix",
      zones: [{ zoneId: "local", kind: "LOCAL", instanceId: "ksix" }],
      nodes: [
        { nodeId: "hub", kind: "ENGINE", zoneId: "local", capabilities: ["hub"], workloadIdentityRef: "spiffe://ksix/hub", isTest: true },
        { nodeId: "x", kind: "ENGINE", zoneId: "local", capabilities: ["transit"], workloadIdentityRef: "spiffe://ksix/x", isTest: true },
        { nodeId: "p", kind: "ENGINE", zoneId: "local", capabilities: ["work"], workloadIdentityRef: "spiffe://ksix/p", isTest: true },
      ],
      adjacencies: [
        { adjacencyId: "direct", fromNodeId: "hub", toNodeId: "p", lane: "COMMAND", capability: "work", authorizingDecisionRef: "d1", state: "ACTIVE" },
        { adjacencyId: "via-x", fromNodeId: "hub", toNodeId: "x", lane: "COMMAND", capability: "transit", authorizingDecisionRef: "d2", state: "ACTIVE" },
        { adjacencyId: "x-p", fromNodeId: "x", toNodeId: "p", lane: "COMMAND", capability: "work", authorizingDecisionRef: "d3", state: "ACTIVE" },
      ],
      rationale: "Shortest-path fixture.",
      createdAt: "2026-08-30T10:00:00.000Z",
      state: "ACTIVE",
      activationDecisionRef: "dec",
    });
    if (!built.ok) throw new Error("fixture must build");

    const routes = candidateRoutes(built.graph, "hub", "work", "COMMAND");
    expect(routes.permitted).toHaveLength(1);
    expect(routes.permitted[0]!.hops.map((h) => h.adjacencyId)).toEqual(["direct"]);
  });
});
