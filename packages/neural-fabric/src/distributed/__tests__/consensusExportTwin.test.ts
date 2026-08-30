/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { TopologyVersion, Zone, FabricNode, Adjacency, ZoneKind } from "../../domain/topology.js";
import { contractVersionSchema, type ContractVersion } from "../../engines/contractIQ.js";
import { summariseSimulation } from "../../engines/fabricAdaptationIQ.js";
import {
  applyCommit,
  assessReplica,
  convergeHealth,
  mayDivergeDuringPartition,
  quorumSize,
  rollbackProposal,
  tally,
  vote,
  type ActivationProposal,
  type ReplicaSet,
  type ReplicaState,
  type ReplicaVote,
} from "../activationConsensus.js";
import {
  exportsAffectCompatibility,
  toAsyncApi,
  toCloudEventsBinding,
  toJsonSchema,
  toProtoDescriptor,
  toTypeScriptBinding,
} from "../../engines/contractExport.js";
import { applyFault, runScenario, runScenarios, twinMayActivate, type TwinScenario } from "../../twin/executableTwin.js";

const T0 = "2026-08-30T10:00:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────

const replicas: ReplicaSet = { replicaIds: ["r1", "r2", "r3", "r4", "r5"] };
const fresh = (id: string): ReplicaState => ({ replicaId: id, highestEpochSeen: 0, activeVersionId: null, activeEpoch: 0 });
const proposal = (over: Partial<ActivationProposal> = {}): ActivationProposal => ({
  topologyVersionId: "v2",
  epoch: 1,
  proposedBy: "r1",
  activationDecisionRef: "dec-1",
  ...over,
});

const grantAll = (p: ActivationProposal, ids: readonly string[]): { votes: ReplicaVote[]; states: ReplicaState[] } => {
  const votes: ReplicaVote[] = [];
  const states: ReplicaState[] = [];
  for (const id of ids) {
    const r = vote(fresh(id), p);
    votes.push(r.vote);
    states.push(r.newState);
  }
  return { votes, states };
};

describe("split-brain prevention is arithmetic", () => {
  it("quorum is a strict majority of the CONFIGURED set", () => {
    expect(quorumSize(replicas)).toBe(3);
    expect(quorumSize({ replicaIds: ["a", "b", "c"] })).toBe(2);
    expect(quorumSize({ replicaIds: ["a"] })).toBe(1);
  });

  it("commits with a quorum of granted votes", () => {
    const { votes } = grantAll(proposal(), ["r1", "r2", "r3"]);
    const outcome = tally(replicas, proposal(), votes);
    expect(outcome.committed).toBe(true);
  });

  it("REFUSES a minority, however unanimous among the reachable", () => {
    // The classic self-inflicted split brain: both partition sides see "all
    // replicas I can reach agree". The fixed denominator forbids it.
    const { votes } = grantAll(proposal(), ["r1", "r2"]);
    const outcome = tally(replicas, proposal(), votes);
    expect(outcome.committed).toBe(false);
    if (!outcome.committed) expect(outcome.reason).toContain("both sides of a partition");
  });

  it("a replica votes at most once per epoch, forever", () => {
    const first = vote(fresh("r1"), proposal());
    expect(first.vote.granted).toBe(true);
    // Same epoch again — from ANYONE — is refused by the promise.
    const second = vote(first.newState, proposal({ topologyVersionId: "v-rival" }));
    expect(second.vote.granted).toBe(false);
    expect(second.vote.reason).toContain("how two activations both believe they won");
  });

  it("TWO RIVAL PROPOSALS in one epoch cannot both commit", () => {
    // Each of five replicas votes once. Split 3/2 between rivals: only one can
    // reach quorum, and the arithmetic — not goodwill — is what prevents both.
    const a = proposal({ topologyVersionId: "v-a", proposedBy: "r1" });
    const b = proposal({ topologyVersionId: "v-b", proposedBy: "r5" });
    const aVotes = grantAll(a, ["r1", "r2", "r3"]).votes;
    const bVotes = grantAll(b, ["r4", "r5"]).votes;
    expect(tally(replicas, a, aVotes).committed).toBe(true);
    expect(tally(replicas, b, bVotes).committed).toBe(false);
  });

  it("does not let RIVAL-VERSION votes pad a proposal's tally", () => {
    // Same epoch, two versions, four grants total. Neither has a quorum, and
    // a tally that counted "any grant this epoch" would commit v-a on v-b's
    // votes — which is two proposals sharing one victory.
    const a = proposal({ topologyVersionId: "v-a" });
    const b = proposal({ topologyVersionId: "v-b" });
    const mixed = [...grantAll(a, ["r1", "r2"]).votes, ...grantAll(b, ["r3", "r4"]).votes];
    expect(tally(replicas, a, mixed).committed).toBe(false);
  });

  it("does not count REFUSED votes toward a quorum", () => {
    // A refusal is a vote against, and three of them are not three approvals.
    const p = proposal();
    const refused: ReplicaVote[] = ["r1", "r2", "r3"].map((id) => ({
      replicaId: id,
      epoch: 1,
      topologyVersionId: "v2",
      granted: false,
      reason: "promised a higher epoch",
    }));
    expect(tally(replicas, p, refused).committed).toBe(false);
  });

  it("ignores votes for a different epoch or version", () => {
    const wrongEpoch = grantAll(proposal({ epoch: 2 }), ["r1", "r2", "r3"]).votes;
    expect(tally(replicas, proposal({ epoch: 1 }), wrongEpoch).committed).toBe(false);
  });

  it("ignores votes from replicas outside the configured set", () => {
    // An attacker's vote or a misconfiguration; both are refused.
    const { votes } = grantAll(proposal(), ["r1", "r2"]);
    const forged: ReplicaVote = { replicaId: "intruder", epoch: 1, topologyVersionId: "v2", granted: true, reason: "" };
    expect(tally(replicas, proposal(), [...votes, forged]).committed).toBe(false);
  });

  it("counts a double-voting replica once", () => {
    const { votes } = grantAll(proposal(), ["r1", "r2"]);
    expect(tally(replicas, proposal(), [...votes, votes[0]!]).committed).toBe(false);
  });

  it("a higher epoch supersedes; a replica that promised it refuses the past", () => {
    const promised = vote(fresh("r1"), proposal({ epoch: 5 }));
    const late = vote(promised.newState, proposal({ epoch: 3 }));
    expect(late.vote.granted).toBe(false);
  });
});

describe("applying commitments and recovering replicas", () => {
  it("applies a commitment and advances the epoch", () => {
    const outcome = tally(replicas, proposal(), grantAll(proposal(), ["r1", "r2", "r3"]).votes);
    const applied = applyCommit(fresh("r1"), outcome);
    expect(applied.applied).toBe(true);
    expect(applied.newState.activeVersionId).toBe("v2");
    expect(applied.newState.activeEpoch).toBe(1);
  });

  it("REFUSES a late-arriving older commitment — a rollback nobody decided", () => {
    const state: ReplicaState = { replicaId: "r1", highestEpochSeen: 5, activeVersionId: "v5", activeEpoch: 5 };
    const old = tally(replicas, proposal({ epoch: 3, topologyVersionId: "v3" }), grantAll(proposal({ epoch: 3, topologyVersionId: "v3" }), ["r1", "r2", "r3"]).votes);
    const applied = applyCommit(state, old);
    expect(applied.applied).toBe(false);
    expect(applied.reason).toContain("a rollback nobody decided");
  });

  it("a deliberate rollback is an activation of the OLD version at a NEW epoch", () => {
    const rb = rollbackProposal("v1", 5, "operator", "dec-rollback");
    expect(rb.topologyVersionId).toBe("v1");
    expect(rb.epoch).toBe(6);
    // It goes through the same consensus as everything else.
    const outcome = tally(replicas, rb, grantAll(rb, ["r1", "r2", "r3"]).votes);
    expect(outcome.committed).toBe(true);
  });

  it("a BEHIND replica catches up and must not vote as current", () => {
    const behind: ReplicaState = { replicaId: "r4", highestEpochSeen: 2, activeVersionId: "v2", activeEpoch: 2 };
    const a = assessReplica(behind, 5, "v5");
    expect(a.status).toBe("BEHIND");
    if (a.status === "BEHIND") expect(a.note).toContain("must not vote as if current");
  });

  it("an AHEAD replica discards — its state describes a world that did not happen", () => {
    const ahead: ReplicaState = { replicaId: "r2", highestEpochSeen: 9, activeVersionId: "v9", activeEpoch: 9 };
    const a = assessReplica(ahead, 5, "v5");
    expect(a.status).toBe("AHEAD");
    if (a.status === "AHEAD") expect(a.note).toContain("does not negotiate");
  });

  it("a current replica is recognised as current", () => {
    const current: ReplicaState = { replicaId: "r1", highestEpochSeen: 5, activeVersionId: "v5", activeEpoch: 5 };
    expect(assessReplica(current, 5, "v5").status).toBe("CURRENT");
  });
});

describe("what may diverge during a partition, and what never may", () => {
  it("permission-bearing state moves only by quorum", () => {
    for (const kind of ["TOPOLOGY_ACTIVATION", "PROVIDER_BINDING", "UPGRADE_STATE", "GATEWAY_GRANT"] as const) {
      const v = mayDivergeDuringPartition(kind);
      expect(v.mayDiverge).toBe(false);
      expect(v.reason).toContain("two different security systems wearing one name");
    }
  });

  it("preference-bearing state may diverge and converge later", () => {
    for (const kind of ["PATH_HEALTH", "LATENCY", "SATURATION", "ROUTING_SCORE"] as const) {
      expect(mayDivergeDuringPartition(kind).mayDiverge).toBe(true);
    }
  });

  it("health converges by last observation per path after healing", () => {
    const a = new Map([
      ["p1", { health: "HEALTHY", observedAt: "2026-08-30T10:00:05.000Z" }],
      ["p2", { health: "DEGRADED", observedAt: "2026-08-30T10:00:01.000Z" }],
    ]);
    const b = new Map([
      ["p1", { health: "DEGRADED", observedAt: "2026-08-30T10:00:03.000Z" }],
      ["p2", { health: "HEALTHY", observedAt: "2026-08-30T10:00:09.000Z" }],
      ["p3", { health: "UNREACHABLE", observedAt: "2026-08-30T10:00:02.000Z" }],
    ]);
    const merged = convergeHealth(a, b);
    expect(merged.get("p1")!.health).toBe("HEALTHY"); // a's is newer
    expect(merged.get("p2")!.health).toBe("HEALTHY"); // b's is newer
    expect(merged.get("p3")!.health).toBe("UNREACHABLE"); // only b saw it
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const contract = (over: Partial<ContractVersion> = {}): ContractVersion =>
  contractVersionSchema.parse({
    schemaId: "forgeiq.plan.requested",
    version: 2,
    lane: "COMMAND",
    compatibilityWithPrevious: "BOTH_DIRECTIONS",
    requiredFields: ["orderId", "tenantId"],
    optionalFields: ["notes"],
    status: "ACTIVE",
    sunsetAt: null,
    ...over,
  });

describe("contracts exported into languages that are not TypeScript", () => {
  it("emits JSON Schema with the required list and closed properties", () => {
    const schema = toJsonSchema(contract());
    expect(schema["required"]).toEqual(["orderId", "tenantId"]);
    expect(schema["additionalProperties"]).toBe(false);
    expect((schema["properties"] as Record<string, unknown>)["notes"]).toBeDefined();
  });

  it("carries the LANE SEMANTICS a foreign consumer actually needs", () => {
    // The field list prevents a parse error; the semantics prevent a
    // double-charged customer.
    const schema = toJsonSchema(contract());
    expect(String(schema["description"])).toContain("MUST be idempotent");
  });

  it("states its per-field-type limitation instead of inventing types", () => {
    const schema = toJsonSchema(contract());
    const orderId = (schema["properties"] as Record<string, Record<string, unknown>>)["orderId"]!;
    expect(String(orderId["description"])).toContain("does not yet carry per-field types");
  });

  it("emits AsyncAPI with channels, operations and delivery semantics", () => {
    const doc = toAsyncApi([contract(), contract({ lane: "EVENT", version: 3 })], { title: "Hive Fabric", version: "1.0.0" });
    expect(doc["asyncapi"]).toBe("3.0.0");
    const operations = doc["operations"] as Record<string, Record<string, unknown>>;
    expect(String(operations["send.forgeiq.plan.requested.v2"]!["description"])).toContain("MUST be idempotent");
  });

  it("maps EVENT contracts to CloudEvents and keeps the tenant out of shared telemetry", () => {
    const binding = toCloudEventsBinding(contract({ lane: "EVENT" }));
    expect(binding.ok).toBe(true);
    if (binding.ok) {
      const ext = ((binding.binding["attributeMapping"] as Record<string, unknown>)["extensions"]) as Record<string, string>;
      expect(ext["hivetenant"]).toContain("NEVER into shared telemetry");
    }
  });

  it("REFUSES to wrap a command as a CloudEvent", () => {
    const binding = toCloudEventsBinding(contract({ lane: "COMMAND" }));
    expect(binding.ok).toBe(false);
    if (!binding.ok) expect(binding.reason).toContain('"please do this" as "this occurred"');
  });

  it("emits a proto descriptor for the synchronous lanes and refuses the rest", () => {
    const proto = toProtoDescriptor(contract());
    expect(proto.ok).toBe(true);
    if (proto.ok) {
      expect(proto.proto).toContain("message ForgeiqPlanRequested");
      expect(proto.proto).toContain("syntax = \"proto3\";");
      expect(proto.proto).toContain("enforced by the");
    }
    expect(toProtoDescriptor(contract({ lane: "STREAM" })).ok).toBe(false);
  });

  it("emits a TypeScript binding with optional fields marked optional", () => {
    const ts = toTypeScriptBinding(contract());
    expect(ts).toContain('readonly "orderId": unknown;');
    expect(ts).toContain('readonly "notes"?: unknown;');
  });

  it("exports NEVER affect what canSpeak decides", () => {
    expect(exportsAffectCompatibility()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const zone = (id: string, kind: Zone["kind"], instanceId = "ksix"): Zone => ({ zoneId: id, kind, instanceId });
const node = (id: string, zoneId: string, capabilities: string[]): FabricNode => ({
  nodeId: id,
  kind: "ENGINE",
  zoneId,
  capabilities,
  workloadIdentityRef: `spiffe://ksix/${id}`,
  isTest: true,
});
const edge = (id: string, from: string, to: string, capability: string): Adjacency => ({
  adjacencyId: id,
  fromNodeId: from,
  toNodeId: to,
  lane: "COMMAND",
  capability,
  authorizingDecisionRef: `dec-${id}`,
  state: "ACTIVE",
});

const topology: TopologyVersion = {
  versionId: "v1",
  parentVersionId: null,
  instanceId: "ksix",
  zones: [zone("local", "LOCAL"), zone("collective", "COLLECTIVE")],
  nodes: [
    node("ordering", "local", ["ordering"]),
    node("plan-a", "local", ["manufacturing.plan"]),
    node("plan-b", "local", ["manufacturing.plan"]),
    node("knowledge", "collective", ["collective.knowledge"]),
  ],
  adjacencies: [
    edge("a1", "ordering", "plan-a", "manufacturing.plan"),
    edge("a2", "ordering", "plan-b", "manufacturing.plan"),
    edge("a3", "ordering", "knowledge", "collective.knowledge"),
  ],
  rationale: "Twin fixture.",
  createdAt: T0,
  state: "ACTIVE",
  activationDecisionRef: "dec-1",
};

const zoneKinds = new Map<string, ZoneKind>([
  ["local", "LOCAL"],
  ["collective", "COLLECTIVE"],
]);

const scenario = (over: Partial<TwinScenario> = {}): TwinScenario => ({
  scenarioId: "s1",
  fault: "NODE_LOSS",
  target: "plan-a",
  criticalCapabilities: ["manufacturing.plan"],
  probes: [{ fromNodeId: "ordering", capability: "manufacturing.plan", lane: "COMMAND" }],
  ...over,
});

describe("the executable twin runs the fault against the real kernel", () => {
  it("survives losing one of two providers — the probe reroutes", () => {
    const result = runScenario(scenario(), { topology, zoneKinds, now: T0 });
    expect(result.capabilitiesLost).toEqual([]);
    expect(result.localWorkSurvived).toBe(true);
    expect(result.recoveredWithinBudget).toBe(true);
    expect(result.note).toContain("the twin supplied only the damage");
  });

  it("REPORTS a capability lost when its last provider dies", () => {
    const both = runScenarios(
      [scenario({ scenarioId: "kill-a", target: "plan-a" }), scenario({ scenarioId: "kill-b", target: "plan-b" })],
      { topology: { ...topology, nodes: topology.nodes.filter((n) => n.nodeId !== "plan-b"), adjacencies: topology.adjacencies.filter((a) => a.adjacencyId !== "a2") }, zoneKinds, now: T0 },
    );
    const killA = both.find((r) => r.scenarioId === "kill-a")!;
    expect(killA.capabilitiesLost).toEqual(["manufacturing.plan"]);
    expect(killA.recoveredWithinBudget).toBe(false);
    // The probe genuinely fails — a twin that counted probes without routing
    // them would report survival here.
    expect(killA.localWorkSurvived).toBe(false);
  });

  it("a lost capability fails the recovery budget even when every probe routes", () => {
    // The probe targets manufacturing.plan, which still has two providers.
    // The knowledge capability is gone. Recovery is not "the probes I happened
    // to send worked" — it is that AND nothing critical was lost.
    const result = runScenario(
      scenario({
        scenarioId: "lost-but-routing",
        fault: "NODE_LOSS",
        target: "knowledge",
        criticalCapabilities: ["collective.knowledge"],
        probes: [{ fromNodeId: "ordering", capability: "manufacturing.plan", lane: "COMMAND" }],
      }),
      { topology, zoneKinds, now: T0 },
    );
    expect(result.capabilitiesLost).toEqual(["collective.knowledge"]);
    expect(result.recoveredWithinBudget).toBe(false);
  });

  it("damage that WEDGES activation is reported as such, not as survivable", () => {
    // A topology that already fails to build: the control plane would refuse
    // this state, so the fault does not degrade service — it wedges activation.
    const broken: TopologyVersion = {
      ...topology,
      nodes: [...topology.nodes, node("stray", "no-such-zone", ["stray.cap"])],
    };
    const result = runScenario(scenario({ scenarioId: "wedge", fault: "LATENCY_SPIKE", target: "x" }), {
      topology: broken,
      zoneKinds,
      now: T0,
    });
    expect(result.localWorkSurvived).toBe(false);
    expect(result.recoveredWithinBudget).toBe(false);
    expect(result.note).toContain("wedges activation");
  });

  it("a zone fault SEVERS the zone's adjacencies — the roads are cut, the map remains", () => {
    const damaged = applyFault(topology, "COLLECTIVE_OUTAGE", "collective");
    expect(damaged.adjacencies.map((a) => a.adjacencyId)).toEqual(["a1", "a2"]);
    // The zone and its node are still declared — a partition does not edit
    // the map.
    expect(damaged.nodes.some((n) => n.nodeId === "knowledge")).toBe(true);
    expect(damaged.zones.some((z) => z.zoneId === "collective")).toBe(true);
  });

  it("a probe to the severed zone FAILS while local probes still route", () => {
    const result = runScenario(
      scenario({
        scenarioId: "col-probe",
        fault: "COLLECTIVE_OUTAGE",
        target: "collective",
        probes: [
          { fromNodeId: "ordering", capability: "manufacturing.plan", lane: "COMMAND" },
          { fromNodeId: "ordering", capability: "collective.knowledge", lane: "COMMAND" },
        ],
      }),
      { topology, zoneKinds, now: T0 },
    );
    // One of two probes routes: the collective one is genuinely gone, which is
    // what distinguishes real probing from counting.
    expect(result.note).toContain("1/2 probes still route");
  });

  it("a COLLECTIVE outage leaves local work running — the hard gate, executed", () => {
    const result = runScenario(
      scenario({ scenarioId: "col", fault: "COLLECTIVE_OUTAGE", target: "collective", criticalCapabilities: ["manufacturing.plan"] }),
      { topology, zoneKinds, now: T0 },
    );
    expect(result.localWorkSurvived).toBe(true);
    expect(result.note).toContain("local first");
  });

  it("severing the LOCAL zone is an outage, and the twin says so", () => {
    const result = runScenario(
      scenario({ scenarioId: "loc", fault: "REGIONAL_PARTITION", target: "local", probes: [] }),
      { topology, zoneKinds, now: T0 },
    );
    expect(result.localWorkSurvived).toBe(false);
  });

  it("ROUTE_REMOVAL cuts exactly the targeted edge", () => {
    const damaged = applyFault(topology, "ROUTE_REMOVAL", "a1");
    expect(damaged.adjacencies.map((a) => a.adjacencyId)).toEqual(["a2", "a3"]);
    // The original is untouched — the twin damages copies.
    expect(topology.adjacencies).toHaveLength(3);
  });

  it("CERTIFICATE_EXPIRY quarantines the node's edges rather than deleting them", () => {
    const damaged = applyFault(topology, "CERTIFICATE_EXPIRY", "plan-a");
    const touched = damaged.adjacencies.find((a) => a.adjacencyId === "a1")!;
    expect(touched.state).toBe("QUARANTINED");
    // Quarantined edges are not routable — the rebuilt graph drops them.
    const result = runScenario(scenario({ fault: "CERTIFICATE_EXPIRY", target: "plan-a" }), { topology, zoneKinds, now: T0 });
    expect(result.localWorkSurvived).toBe(true); // plan-b still answers
  });

  it("SCHEMA_INCOMPATIBILITY is judged by the real canSpeak", () => {
    const result = runScenario(
      scenario({ scenarioId: "schema", fault: "SCHEMA_INCOMPATIBILITY", target: "plan-a" }),
      {
        topology,
        zoneKinds,
        now: T0,
        producerContract: contract(),
        consumerContract: contract({ schemaId: "different.contract" }),
      },
    );
    expect(result.note).toContain("different contracts, not different versions of one");
  });

  it("feeds the existing summariser, whose verdict is typed as not-an-authorization", () => {
    const results = runScenarios(
      [scenario({ scenarioId: "a" }), scenario({ scenarioId: "b", target: "plan-b" })],
      { topology, zoneKinds, now: T0 },
    );
    const verdict = summariseSimulation(results);
    expect(verdict.isAuthorization).toBe(false);
    expect(verdict.wouldSurvive).toBe(true);
  });

  it("the twin can activate nothing", () => {
    expect(twinMayActivate()).toBe(false);
  });

  it("flow-level faults leave the topology untouched", () => {
    for (const fault of ["LATENCY_SPIKE", "MESSAGE_DUPLICATION", "CONGESTION", "PROVIDER_FAILURE"] as const) {
      expect(applyFault(topology, fault, "anything")).toEqual(topology);
    }
  });
});
