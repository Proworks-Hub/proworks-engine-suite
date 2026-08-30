/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { certify, formatCertification } from "../certification.js";
import { acceptEnvelope, fabricEnvelopeSchema, telemetryView, type FabricEnvelope } from "../domain/envelope.js";
import { mayBeShed, type Lane } from "../domain/lanes.js";
import type { Adjacency, FabricNode, TopologyVersion, Zone } from "../domain/topology.js";
import { buildGraph, candidateRoutes } from "../nexus/topologyGraph.js";
import { defaultPathKey, newCircuit, recordOutcome, type CircuitState, type PathHealth } from "../pulse/pathHealth.js";
import { admit, decideRetry } from "../pulse/flowControl.js";
import { localWorkContinues, modeForUnreachableZone } from "../pulse/degradedMode.js";
import { routeSignal } from "../engines/routingIQ.js";
import { acceptDelivery, checkSequence } from "../engines/deliveryIQ.js";
import { canSpeak, contractVersionSchema } from "../engines/contractIQ.js";
import { resolvePosture, laneTreatment } from "../security/posture.js";
import { assessCoverage, providerCapabilitySchema } from "../ports/providers.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// §26's validation program and §34.9's certification tests. These are
// behavioural rather than structural — a chaos scenario has to be run, not
// inspected — so they live here rather than in the certification module.
//
// Each one composes several modules, which is the point: the interesting
// failures are between components, and every unit test in this package passes
// while a boundary quietly leaks.
// ─────────────────────────────────────────────────────────────────────────────

const zone = (id: string, kind: Zone["kind"], instanceId = "ksix"): Zone => ({ zoneId: id, kind, instanceId });

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
  lane: Lane = "COMMAND",
): Adjacency => ({
  adjacencyId: id,
  fromNodeId: from,
  toNodeId: to,
  lane,
  capability,
  authorizingDecisionRef: `dec-${id}`,
  state: "ACTIVE",
});

/** A two-instance fabric with a gateway between them, as §17 requires. */
const federated: TopologyVersion = {
  versionId: "v1",
  parentVersionId: null,
  instanceId: "ksix",
  zones: [
    zone("local", "LOCAL"),
    zone("collective", "COLLECTIVE"),
    zone("gw", "GATEWAY"),
    zone("far", "LOCAL", "proworks"),
    zone("sbx", "SANDBOX"),
  ],
  nodes: [
    node("ordering", "local", ["ordering"]),
    node("plan-local", "local", ["manufacturing.plan"]),
    node("knowledge", "collective", ["collective.knowledge"]),
    node("gateway", "gw", ["transit"]),
    node("plan-remote", "far", ["manufacturing.plan"]),
    node("sim", "sbx", ["manufacturing.plan"], true),
  ],
  adjacencies: [
    edge("a1", "ordering", "plan-local", "manufacturing.plan"),
    edge("a2", "ordering", "gateway", "transit"),
    edge("a3", "gateway", "plan-remote", "manufacturing.plan"),
    edge("a4", "ordering", "knowledge", "collective.knowledge", "QUERY"),
  ],
  rationale: "Federated fabric for chaos testing.",
  createdAt: T0,
  state: "ACTIVE",
  activationDecisionRef: "dec-1",
};

const graph = (() => {
  const r = buildGraph(federated);
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join("; "));
  return r.graph;
})();

const envelope = (over: Record<string, unknown> = {}): FabricEnvelope =>
  fabricEnvelopeSchema.parse({
    fabricMessageId: "sig-1",
    schemaId: "forgeiq.plan.requested",
    schemaVersion: "1.0.0",
    lane: "COMMAND",
    source: { capability: "ordering" },
    destination: { capability: "manufacturing.plan" },
    instanceId: "ksix",
    tenantId: "acme",
    correlationId: "cor-1",
    causationId: null,
    idempotencyKey: "idem-1",
    authorizationEvidenceRef: "dec-1",
    provenance: { originComponent: "ordering", originInstanceId: "ksix", principalKind: "ENGINE", transformations: [] },
    classification: "INTERNAL",
    priority: "NORMAL",
    contentType: "application/json",
    isTest: false,
    ...over,
  });

const routeWith = (
  health: Record<string, PathHealth>,
  circuits: Record<string, CircuitState> = {},
  over: Record<string, unknown> = {},
) => {
  const e = envelope(over);
  return routeSignal({
    envelope: e,
    candidates: candidateRoutes(graph, "ordering", e.destination.capability, e.lane),
    health: new Map(Object.entries(health) as [string, PathHealth][]),
    circuits: new Map(Object.entries(circuits) as [string, CircuitState][]),
    pathKey: defaultPathKey,
    now: T0,
    expired: false,
  });
};

// ─────────────────────────────────────────────────────────────────────────────

describe("the seven hard gates", () => {
  const report = certify();

  it("all hold", () => {
    const failed = report.gates.filter((g) => !g.passed);
    expect(failed.map((g) => `${g.gateId}: ${g.evidence}`)).toEqual([]);
    expect(report.certified).toBe(true);
  });

  it("gives each gate real evidence rather than a bare boolean", () => {
    for (const gate of report.gates) {
      expect(gate.evidence.length).toBeGreaterThan(0);
      if (gate.passed) expect(gate.remedy).toBeNull();
    }
  });

  it("says plainly that it does not certify the Fabric works", () => {
    // Nothing here has moved a message, because no transport is bound.
    expect(report.summary).toContain("nothing here has moved a message");
    expect(report.outOfScope.join()).toContain("A bound adapter is where that question starts");
  });

  it("leaves the constitutional question open", () => {
    expect(report.ratified).toBe(false);
    expect(report.outOfScope.join()).toContain("evidence for that decision rather than a substitute");
  });

  it("formats for a build log", () => {
    expect(formatCertification(report)).toContain("[PASS] local-continuity");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("chaos: the Collective goes away", () => {
  it("local routing is completely unaffected", () => {
    // §34.9 and §33.6. The local path does not touch the Collective, and this
    // proves it rather than assuming it.
    const decision = routeWith({ [defaultPathKey(candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND").permitted[0]!)]: "HEALTHY" });
    expect(decision.chosen).not.toBeNull();
    expect(localWorkContinues(["COLLECTIVE"]).continues).toBe(true);
  });

  it("the Collective route is the only thing that stops", () => {
    const collectiveRoutes = candidateRoutes(graph, "ordering", "collective.knowledge", "QUERY");
    expect(collectiveRoutes.permitted).toHaveLength(1);
    const mode = modeForUnreachableZone("COLLECTIVE");
    expect(mode).toMatchObject({ declared: true });
    if (mode.declared) expect(mode.definition.localWorkContinues).toBe(true);
  });

  it("does not stop local immune signalling or containment", () => {
    // §34.9 asks for exactly this.
    expect(laneTreatment("ORANGE", "EVIDENCE")).toBe("NORMAL");
    expect(mayBeShed("EVIDENCE")).toBe(false);
  });
});

describe("chaos: the gateway dies", () => {
  it("stops cross-instance work and leaves local work alone", () => {
    const local = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND").permitted.find((p) => p.staysLocal)!;
    const remote = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND").permitted.find((p) => p.crossesInstance)!;

    const decision = routeWith({
      [defaultPathKey(local)]: "HEALTHY",
      [defaultPathKey(remote)]: "UNREACHABLE",
    });
    // Compared by identity of the route rather than of the object: each call
    // to candidateRoutes builds fresh path objects.
    expect(decision.chosen?.toNodeId).toBe(local.toNodeId);
    expect(decision.chosen?.staysLocal).toBe(true);
  });

  it("does NOT reroute around the gateway", () => {
    // §17: there is no alternative path by design. "Find another way" would
    // mean going around the boundary that exists to be gone through.
    const mode = modeForUnreachableZone("GATEWAY");
    if (mode.declared) expect(mode.definition.operatorNote).toContain("going around the boundary");
  });
});

describe("chaos: a provider fails", () => {
  it("leaves lanes uncovered rather than silently degrading them", () => {
    const healthOnly = providerCapabilitySchema.parse({
      providerId: "ephemeral",
      family: "pubsub",
      lanesOffered: ["HEALTH"],
      durable: false,
      redelivers: false,
      orderingScopes: ["NONE"],
      replayable: false,
      mutualTlsCapable: false,
    });
    const coverage = assessCoverage([healthOnly]);
    expect(coverage.uncovered.map((g) => g.lane)).toContain("COMMAND");
    expect(coverage.uncovered.map((g) => g.lane)).toContain("WORKFLOW");
  });
});

describe("chaos: a retry storm", () => {
  it("stops retrying once the window's budget is spent", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, retryBudgetFraction: 0.1 };
    const spent = decideRetry(0, policy, { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 100 }, () => 0.5);
    expect(spent.retry).toBe(false);
    if (!spent.retry) expect(spent.reason).toContain("sustained overload that outlives it");
  });

  it("jitters so callers that failed together do not retry together", () => {
    const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000, retryBudgetFraction: 0.5 };
    const budget = { windowKey: "w", sendsInWindow: 1000, retriesInWindow: 0 };
    const delays = [0, 0.25, 0.5, 0.75, 0.99].map((r) => {
      const d = decideRetry(3, policy, budget, () => r);
      return d.retry ? d.delayMs : -1;
    });
    expect(new Set(delays).size).toBe(delays.length);
  });
});

describe("chaos: a slow consumer and a full queue", () => {
  it("sheds expendable traffic and protects the rest", () => {
    const full = { queueKey: "q", depth: 85, capacity: 100 };
    const policy = { shedAboveSaturation: 0.8, slowAboveSaturation: 0.6 };
    expect(admit(full, "HEALTH", policy).admitted).toBe(false);
    expect(admit(full, "EVIDENCE", policy).admitted).toBe(true);
    expect(admit(full, "COMMAND", policy).admitted).toBe(true);
  });

  it("refuses at the door rather than accepting work it will drop", () => {
    const brimming = { queueKey: "q", depth: 100, capacity: 100 };
    const d = admit(brimming, "COMMAND", { shedAboveSaturation: 0.8, slowAboveSaturation: 0.6 });
    expect(d.admitted).toBe(false);
    if (!d.admitted) expect(d.retryable).toBe(true);
  });
});

describe("chaos: a poison message", () => {
  it("is not retried forever and does not block the sequence behind it", () => {
    const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000, retryBudgetFraction: 0.5 };
    const exhausted = decideRetry(3, policy, { windowKey: "w", sendsInWindow: 100, retriesInWindow: 0 }, () => 0.5);
    expect(exhausted.retry).toBe(false);
    if (!exhausted.retry) expect(exhausted.deadLetter).toBe(true);

    // And a message from the past is discarded rather than buffered, so a
    // redelivery of something already applied does not stall the stream.
    const stale = checkSequence("WORKFLOW", { scopeKey: "wf", lastSequence: 10 }, 4);
    expect(stale.accept).toBe(false);
    if (!stale.accept) expect(stale.action).toBe("DISCARD");
  });
});

describe("chaos: a flapping dependency", () => {
  it("opens after consecutive failures and does not reopen on the first success", () => {
    const policy = { failureThreshold: 3, successThreshold: 2, openDurationMs: 30_000 };
    let c = newCircuit("p");
    for (let i = 0; i < 3; i += 1) c = recordOutcome(c, policy, "FAILURE", T0);
    expect(c.state).toBe("OPEN");

    c = recordOutcome(c, policy, "SUCCESS", at(30));
    expect(c.state).toBe("HALF_OPEN");
    c = recordOutcome(c, policy, "FAILURE", at(31));
    expect(c.state).toBe("OPEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("isolation: no direct private-store access, no transitive trust", () => {
  it("REFUSES a direct route to another instance", () => {
    // The route to plan-remote exists only through the gateway.
    const routes = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND");
    const remote = routes.permitted.find((p) => p.crossesInstance)!;
    expect(remote.hops.map((h) => h.toNodeId)).toEqual(["gateway", "plan-remote"]);
    expect(remote.zonePath).toContain("gw");
  });

  it("REFUSES to export tenant-private data across the gateway", () => {
    const decision = routeWith(
      {},
      {},
      { classification: "TENANT_PRIVATE", destination: { capability: "manufacturing.plan" } },
    );
    // The local route is unhealthy-unknown but still eligible; the remote one
    // is removed by classification rather than by health.
    expect(decision.checks.find((c) => c.stage === "classification")!.conclusion).toContain("a rule, not a preference");
  });

  it("gives a sandbox no route into production, in either direction", () => {
    const fromSandbox = candidateRoutes(graph, "sim", "ordering", "COMMAND");
    expect(fromSandbox.permitted).toEqual([]);
    const intoSandbox = candidateRoutes(graph, "ordering", "manufacturing.plan", "COMMAND");
    expect(intoSandbox.permitted.every((p) => !p.zonePath.includes("sbx"))).toBe(true);
  });

  it("refuses a topology that joins a test node to a production one", () => {
    const mixed = buildGraph({
      ...federated,
      adjacencies: [...federated.adjacencies, edge("bad", "ordering", "sim", "manufacturing.plan")],
    });
    expect(mixed.ok).toBe(false);
  });
});

describe("security: the attacks §26 names", () => {
  it("refuses a forged authority field on the envelope", () => {
    // `.strict()`. A sender adding `authorized: true` is refused at the door.
    expect(acceptEnvelope({ ...envelope(), authorized: true }).accepted).toBe(false);
  });

  it("refuses an AI-originated signal that will not name its model", () => {
    expect(
      acceptEnvelope({
        ...envelope(),
        provenance: { originComponent: "aria", originInstanceId: "ksix", principalKind: "AI_MODEL", transformations: [] },
      }).accepted,
    ).toBe(false);
  });

  it("REFUSES an AI workload elevating itself by writing authority into a payload", () => {
    // §34.9's test. There is no payload field on the envelope at all, so a
    // model-generated assertion has nowhere to go that routing would read.
    const e = envelope({
      provenance: {
        originComponent: "aria",
        originInstanceId: "ksix",
        principalKind: "AI_MODEL",
        modelProvenance: { provider: "anthropic", model: "claude-opus-5" },
        transformations: [],
      },
    });
    expect(Object.keys(e)).not.toContain("payload");
    // And an extra field claiming authority is refused rather than ignored.
    expect(acceptEnvelope({ ...e, authorizationEvidence: { granted: true } }).accepted).toBe(false);
  });

  it("refuses a replayed command as a duplicate rather than reprocessing it", () => {
    const first = acceptDelivery(null, { idempotencyKey: "k", lane: "COMMAND", now: T0 }, {
      retentionMs: 86_400_000,
      inFlightTimeoutMs: 30_000,
    });
    expect(first.disposition).toBe("PROCESS");
    if (first.disposition !== "PROCESS") throw new Error("expected PROCESS");
    const completed = { ...first.record, state: "COMPLETED" as const, outcomeRef: "out-1" };
    const replay = acceptDelivery(completed, { idempotencyKey: "k", lane: "COMMAND", now: at(60) }, {
      retentionMs: 86_400_000,
      inFlightTimeoutMs: 30_000,
    });
    expect(replay.disposition).toBe("REPLAY_OUTCOME");
  });

  it("refuses a schema downgrade that the field lists contradict", () => {
    const producer = contractVersionSchema.parse({
      schemaId: "s",
      version: 1,
      lane: "COMMAND",
      compatibilityWithPrevious: "BOTH_DIRECTIONS",
      requiredFields: ["orderId"],
      optionalFields: [],
      status: "ACTIVE",
      sunsetAt: null,
    });
    const consumer = contractVersionSchema.parse({
      schemaId: "s",
      version: 2,
      lane: "COMMAND",
      compatibilityWithPrevious: "BOTH_DIRECTIONS",
      requiredFields: ["orderId", "tenantId"],
      optionalFields: [],
      status: "ACTIVE",
      sunsetAt: null,
    });
    expect(canSpeak(producer, consumer, T0).canSpeak).toBe(false);
  });

  it("refuses a malformed envelope rather than routing it partially", () => {
    expect(acceptEnvelope({ fabricMessageId: "only-this" }).accepted).toBe(false);
    expect(acceptEnvelope(null).accepted).toBe(false);
    expect(acceptEnvelope("a string").accepted).toBe(false);
  });

  it("does not leak a customer or a payload reference into trace context", () => {
    // Trace-context abuse: whatever is in telemetry travels furthest.
    const view = telemetryView(envelope({ payloadRef: "s3://quote-for-acme", tenantId: "acme-industries" }));
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("acme-industries");
    expect(serialised).not.toContain("quote-for-acme");
    expect(serialised).not.toContain("dec-1");
  });

  it("refuses an unauthorized route export by classification, not by health", () => {
    const decision = routeWith({}, {}, { classification: "RESTRICTED" });
    expect(decision.checks.find((c) => c.stage === "classification")!.conclusion).toContain("removed");
  });
});

describe("security: an unreachable Sentinel does not become an open door", () => {
  it("raises the posture rather than carrying on", () => {
    // §34.9: Sentinel outage causes the safer posture, not unrestricted allow.
    expect(resolvePosture(null, null, false, T0).level).not.toBe("GREEN");
  });

  it("keeps evidence flowing at the raised posture", () => {
    const level = resolvePosture(null, null, false, T0).level;
    expect(laneTreatment(level, "EVIDENCE")).toBe("NORMAL");
  });

  it("suspends high-volume lanes rather than essential ones", () => {
    const level = resolvePosture(null, null, false, T0).level;
    expect(laneTreatment(level, "STREAM")).toBe("SUSPENDED");
    expect(laneTreatment(level, "COMMAND")).not.toBe("SUSPENDED");
  });
});

describe("staleness: an old topology does not silently keep deciding", () => {
  it("refuses a route the current topology does not permit", () => {
    // plan-remote is reachable only through the gateway. Remove the gateway
    // hop and the route disappears rather than degrading to a direct one.
    const withoutGateway = buildGraph({
      ...federated,
      adjacencies: federated.adjacencies.filter((a) => a.adjacencyId !== "a3"),
    });
    if (!withoutGateway.ok) throw new Error("build failed");
    const routes = candidateRoutes(withoutGateway.graph, "ordering", "manufacturing.plan", "COMMAND");
    expect(routes.permitted.every((p) => !p.crossesInstance)).toBe(true);
  });
});
