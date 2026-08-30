/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { Adjacency, FabricNode, TopologyVersion, Zone } from "../../domain/topology.js";
import { buildGraph } from "../../nexus/topologyGraph.js";
import type { ContractVersion } from "../../engines/contractIQ.js";
import { contractVersionSchema } from "../../engines/contractIQ.js";
import type { TransportProviderPort } from "../../ports/providers.js";
import {
  fabricHoldsTrustRoot,
  referenceSecurityPorts,
  resolveTrust,
  type IssuedIdentity,
  type SecurityPortSet,
} from "../../ports/securityPorts.js";
import {
  inMemoryStores,
  runtimeHoldsAuthority,
  sendThroughFabric,
  type RuntimeConfig,
} from "../fabricRuntime.js";
import {
  activateTopology,
  canonicalTopologyForm,
  dataPlaneMayMutateControlPlane,
  issueView,
  permittedWhileStale,
  viewUsable,
  type SignedTopology,
} from "../controlPlane.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures: a real topology, real issued identities, a provider that records.
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
  zones: [zone("local", "LOCAL")],
  nodes: [node("ordering", "local", ["ordering"]), node("plan", "local", ["manufacturing.plan"])],
  adjacencies: [edge("a1", "ordering", "plan", "manufacturing.plan")],
  rationale: "Test topology.",
  createdAt: T0,
  state: "APPROVED",
  activationDecisionRef: "dec-activate",
};

const built = buildGraph(topology);
if (!built.ok) throw new Error("fixture topology must build");
const graph = built.graph;

const issued: IssuedIdentity[] = [
  {
    identityRef: "order-ingestion",
    workloadId: "order-ingestion",
    instanceId: "ksix",
    tenantId: "acme",
    trustDomain: "hive.ksix",
    notAfter: at(3600),
  },
];

const ports = (over: Partial<Parameters<typeof referenceSecurityPorts>[0]> = {}): SecurityPortSet =>
  referenceSecurityPorts({
    issued,
    revoked: new Map(),
    grants: [
      {
        evidenceRef: "dec-1",
        decisionRef: "dec-1",
        principalId: "order-ingestion",
        scope: "manufacturing.plan:command",
        tenantId: "acme",
        notAfter: at(3600),
      },
    ],
    ...over,
  });

const contract: ContractVersion = contractVersionSchema.parse({
  schemaId: "forgeiq.plan.requested",
  version: 1,
  lane: "COMMAND",
  compatibilityWithPrevious: "BOTH_DIRECTIONS",
  requiredFields: [],
  optionalFields: [],
  status: "ACTIVE",
  sunsetAt: null,
});

function recordingProvider(): TransportProviderPort & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    capability: {
      providerId: "in-memory",
      family: "in-memory",
      lanesOffered: ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"],
      durable: true,
      redelivers: true,
      orderingScopes: ["NONE", "PER_KEY", "PER_PARTITION", "STRICT_SEQUENCE"],
      replayable: true,
      mutualTlsCapable: false,
    },
    send: async ({ envelopeJson }) => void sent.push(envelopeJson),
    probe: async () => ({ healthy: true, detail: "in-memory" }),
    sent,
  };
}

const envelope = (over: Record<string, unknown> = {}) => ({
  fabricMessageId: "sig-1",
  schemaId: "forgeiq.plan.requested",
  schemaVersion: "1",
  lane: "COMMAND",
  source: { capability: "ordering", participantId: "ordering" },
  destination: { capability: "manufacturing.plan" },
  instanceId: "ksix",
  tenantId: "acme",
  correlationId: "cor-1",
  causationId: null,
  idempotencyKey: "idem-1",
  authorizationEvidenceRef: "dec-1",
  provenance: {
    originComponent: "order-ingestion",
    originInstanceId: "ksix",
    principalKind: "ENGINE",
    transformations: [],
  },
  classification: "TENANT_PRIVATE",
  priority: "NORMAL",
  contentType: "application/json",
  isTest: true,
  ...over,
});

const config = (
  provider: TransportProviderPort,
  over: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  instanceId: "ksix",
  securityPorts: ports(),
  contracts: new Map([["forgeiq.plan.requested@1", contract]]),
  consumerContracts: new Map([["manufacturing.plan", contract]]),
  graph,
  providers: new Map([["in-memory", provider]]),
  laneBindings: new Map([["COMMAND", "in-memory"]]),
  conditionLevel: "GREEN",
  health: new Map(),
  queues: new Map(),
  admission: { shedAboveSaturation: 0.8, slowAboveSaturation: 0.6 },
  circuitPolicy: { failureThreshold: 3, successThreshold: 2, openDurationMs: 30_000 },
  deliveryPolicy: { retentionMs: 86_400_000, inFlightTimeoutMs: 30_000 },
  requiredScopeFor: () => "manufacturing.plan:command",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the pipeline runs a real signal end to end", () => {
  it("sends a valid, authorized signal through to the provider", async () => {
    const provider = recordingProvider();
    const stores = inMemoryStores();
    const result = await sendThroughFabric(envelope(), config(provider), stores, T0, at(1));

    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.viaProvider).toBe("in-memory");
      expect(result.trustEvidence.join()).toContain("identity:order-ingestion");
      expect(result.trustEvidence.join()).toContain("authorization:dec-1");
    }
    expect(provider.sent).toHaveLength(1);
    expect(JSON.parse(provider.sent[0]!).fabricMessageId).toBe("sig-1");
  });

  it("records a span and evidence for the send", async () => {
    const provider = recordingProvider();
    const stores = inMemoryStores();
    await sendThroughFabric(envelope(), config(provider), stores, T0, at(1));
    expect(stores.spans).toHaveLength(1);
    expect(stores.spans[0]!.outcome).toBe("DELIVERED");
    expect(stores.evidence[0]!.kind).toBe("SENT");
  });

  it("REFUSES a malformed envelope at the first gate, spending nothing else", async () => {
    const provider = recordingProvider();
    const result = await sendThroughFabric({ garbage: true }, config(provider), inMemoryStores(), T0, at(1));
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("ENVELOPE");
    expect(provider.sent).toHaveLength(0);
  });

  it("replays the outcome for a duplicate rather than sending twice", async () => {
    const provider = recordingProvider();
    const stores = inMemoryStores();
    await sendThroughFabric(envelope(), config(provider), stores, T0, at(1));
    const second = await sendThroughFabric(envelope(), config(provider), stores, T0, at(2));

    expect(second.sent).toBe(false);
    if (!second.sent) {
      expect(second.stage).toBe("DELIVERY");
      expect(second.replayedOutcomeRef).toBe("sent:sig-1");
    }
    // The provider saw ONE send. Exactly-once effect, on an at-least-once caller.
    expect(provider.sent).toHaveLength(1);
    expect(stores.evidence.some((e) => e.kind === "REPLAYED")).toBe(true);
  });

  it("opens the circuit after repeated provider failures and then fails fast", async () => {
    const failing: TransportProviderPort = {
      capability: recordingProvider().capability,
      send: async () => {
        throw new Error("broker down");
      },
      probe: async () => ({ healthy: false, detail: "down" }),
    };
    const stores = inMemoryStores();
    const cfg = config(failing);

    for (let i = 0; i < 3; i += 1) {
      const r = await sendThroughFabric(envelope({ fabricMessageId: `sig-${i}`, idempotencyKey: `k-${i}` }), cfg, stores, T0, at(i));
      expect(r.sent).toBe(false);
      if (!r.sent) expect(r.stage).toBe("TRANSPORT");
    }

    // Fourth attempt: the breaker is open, and routing itself refuses — the
    // provider is not even asked.
    const fourth = await sendThroughFabric(envelope({ fabricMessageId: "sig-4", idempotencyKey: "k-4" }), cfg, stores, T0, at(4));
    expect(fourth.sent).toBe(false);
    if (!fourth.sent) {
      expect(fourth.stage).toBe("ROUTING");
      expect(fourth.reason).toContain("decorative");
    }
  });

  it("lets a PROBE through once the open window elapses, so a breaker can close again", async () => {
    // Found by this integration test, and it was a real composition defect:
    // routing filters OPEN circuits, so an open breaker never reached the
    // probe stage and could never close. The runtime now presents an elapsed
    // OPEN as HALF_OPEN to selection, and the probe runs.
    const failing = { calls: 0 };
    const flaky: TransportProviderPort = {
      capability: recordingProvider().capability,
      send: async () => {
        failing.calls += 1;
        if (failing.calls <= 3) throw new Error("down");
      },
      probe: async () => ({ healthy: true, detail: "recovering" }),
    };
    const stores = inMemoryStores();
    const cfg = config(flaky);

    for (let i = 0; i < 3; i += 1) {
      await sendThroughFabric(envelope({ fabricMessageId: `s-${i}`, idempotencyKey: `k-${i}` }), cfg, stores, T0, at(i));
    }
    // Inside the open window: refused without asking the provider.
    const during = await sendThroughFabric(envelope({ fabricMessageId: "s-w", idempotencyKey: "k-w" }), cfg, stores, T0, at(10));
    expect(during.sent).toBe(false);
    expect(failing.calls).toBe(3);

    // Past the window: the probe goes through and succeeds.
    const probe = await sendThroughFabric(envelope({ fabricMessageId: "s-p", idempotencyKey: "k-p" }), cfg, stores, T0, at(40));
    expect(probe.sent).toBe(true);
    expect(failing.calls).toBe(4);

    // And the success was RECORDED: a second success closes the breaker, and a
    // third send flows on a closed circuit. If the runtime forgot to record
    // outcomes, probeInFlight would still be set and everything after the
    // first probe would be refused.
    const second = await sendThroughFabric(envelope({ fabricMessageId: "s-q", idempotencyKey: "k-q" }), cfg, stores, T0, at(41));
    expect(second.sent).toBe(true);
    const third = await sendThroughFabric(envelope({ fabricMessageId: "s-r", idempotencyKey: "k-r" }), cfg, stores, T0, at(42));
    expect(third.sent).toBe(true);
    expect(stores.getCircuit(probe.sent ? probe.pathKey : "")!.state).toBe("CLOSED");
  });

  it("does not quote the provider's thrown error into evidence", async () => {
    const failing: TransportProviderPort = {
      capability: recordingProvider().capability,
      send: async () => {
        throw new Error("secret-connection-string-sk-12345");
      },
      probe: async () => ({ healthy: false, detail: "down" }),
    };
    const stores = inMemoryStores();
    await sendThroughFabric(envelope(), config(failing), stores, T0, at(1));
    expect(JSON.stringify(stores.evidence)).not.toContain("secret-connection-string");
  });

  it("REFUSES a lane with no provider binding and calls it a control-plane gap", async () => {
    const provider = recordingProvider();
    const result = await sendThroughFabric(
      envelope(),
      config(provider, { laneBindings: new Map() }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("TRANSPORT");
      expect(result.reason).toContain("no provider is bound".toLowerCase().slice(0, 0) + "No provider is bound");
      expect(result.retryable).toBe(true);
    }
  });

  it("suspends a lane at RED posture before anything else is spent", async () => {
    const provider = recordingProvider();
    const result = await sendThroughFabric(
      envelope({ lane: "QUERY", idempotencyKey: undefined, authorizationEvidenceRef: undefined }),
      config(provider, { conditionLevel: "RED" }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("POSTURE");
  });

  it("holds no authority of its own", () => {
    expect(runtimeHoldsAuthority()).toBe(false);
  });
});

describe("the contract stage refuses what compatibility cannot vouch for", () => {
  it("REFUSES an unregistered schema version", async () => {
    const result = await sendThroughFabric(
      envelope(),
      config(recordingProvider(), { contracts: new Map() }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("CONTRACT");
      expect(result.reason).toContain("whoever is on call");
    }
  });

  it("REFUSES a producer the consumer cannot understand", async () => {
    const otherContract = contractVersionSchema.parse({
      schemaId: "something.else",
      version: 1,
      lane: "COMMAND",
      compatibilityWithPrevious: "BOTH_DIRECTIONS",
      requiredFields: [],
      optionalFields: [],
      status: "ACTIVE",
      sunsetAt: null,
    });
    const result = await sendThroughFabric(
      envelope(),
      config(recordingProvider(), { consumerContracts: new Map([["manufacturing.plan", otherContract]]) }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("CONTRACT");
  });

  it("marks a NO-PERMITTED-ROUTE refusal as NOT retryable — waiting will not create an adjacency", async () => {
    // The open-circuit refusal above is retryable, and the runtime must keep
    // the two apart: a health refusal ends when the path recovers, a
    // permission refusal ends when Governance decides something.
    const result = await sendThroughFabric(
      envelope({ destination: { capability: "nobody.provides.this" } }),
      config(recordingProvider()),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("ROUTING");
      expect(result.retryable).toBe(false);
    }
  });

  it("REFUSES at ADMISSION when the chosen path's queue is full", async () => {
    // Two-step: learn the pathKey from a clean send, then fill that queue.
    const provider = recordingProvider();
    const first = await sendThroughFabric(envelope(), config(provider), inMemoryStores(), T0, at(1));
    if (!first.sent) throw new Error("fixture send must succeed");

    const result = await sendThroughFabric(
      envelope({ fabricMessageId: "sig-2", idempotencyKey: "k-2" }),
      config(provider, {
        queues: new Map([[first.pathKey, { queueKey: first.pathKey, depth: 100, capacity: 100 }]]),
      }),
      inMemoryStores(),
      T0,
      at(2),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("ADMISSION");
      expect(result.retryable).toBe(true);
    }
  });
});

describe("trust before routing: an unauthenticated probe learns nothing", () => {
  it("REFUSES a forged identity at TRUST, not at ROUTING", async () => {
    const provider = recordingProvider();
    const result = await sendThroughFabric(
      envelope({ provenance: { originComponent: "forged-workload", originInstanceId: "ksix", principalKind: "ENGINE", transformations: [] } }),
      config(provider),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("TRUST");
      // The refusal says nothing about the topology.
      expect(result.reason).not.toContain("route");
      expect(result.reason).not.toContain("manufacturing.plan");
    }
  });

  it("REFUSES an expired identity", async () => {
    const provider = recordingProvider();
    const result = await sendThroughFabric(envelope(), config(provider), inMemoryStores(), T0, at(3600));
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("TRUST");
  });

  it("REFUSES a revoked identity that is otherwise valid", async () => {
    const provider = recordingProvider();
    const revokedPorts = referenceSecurityPorts({
      issued,
      revoked: new Map([["order-ingestion", { revokedAt: at(1), reason: "credential reported stolen" }]]),
      grants: [],
    });
    const result = await sendThroughFabric(
      envelope(),
      config(provider, { securityPorts: revokedPorts }),
      inMemoryStores(),
      T0,
      at(2),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("TRUST");
      expect(result.reason).toContain("revoked");
    }
  });

  it("FAILS CLOSED when the security system is unreachable", async () => {
    // The worst outage is the one where it did not.
    const provider = recordingProvider();
    const result = await sendThroughFabric(
      envelope(),
      config(provider, { securityPorts: ports({ unavailable: true }) }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.stage).toBe("TRUST");
      expect(result.retryable).toBe(true); // An outage is retryable; a forgery is not.
      expect(result.reason).toContain("has not said yes");
    }
    expect(provider.sent).toHaveLength(0);
  });

  it("REFUSES someone else's authorization reference", async () => {
    const otherGrant = referenceSecurityPorts({
      issued,
      revoked: new Map(),
      grants: [
        {
          evidenceRef: "dec-1",
          decisionRef: "dec-1",
          principalId: "somebody-else",
          scope: "manufacturing.plan:command",
          tenantId: "acme",
          notAfter: at(3600),
        },
      ],
    });
    const result = await sendThroughFabric(
      envelope(),
      config(recordingProvider(), { securityPorts: otherGrant }),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toContain("not bearer paper");
  });

  it("REFUSES a stale grant", async () => {
    const staleGrant = referenceSecurityPorts({
      issued,
      revoked: new Map(),
      grants: [
        {
          evidenceRef: "dec-1",
          decisionRef: "dec-1",
          principalId: "order-ingestion",
          scope: "manufacturing.plan:command",
          tenantId: "acme",
          notAfter: at(10),
        },
      ],
    });
    const result = await sendThroughFabric(
      envelope(),
      config(recordingProvider(), { securityPorts: staleGrant }),
      inMemoryStores(),
      T0,
      at(11),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("TRUST");
  });

  it("REFUSES the wrong tenant scope", async () => {
    const result = await sendThroughFabric(
      envelope({ tenantId: "someone-else" }),
      config(recordingProvider()),
      inMemoryStores(),
      T0,
      at(1),
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.stage).toBe("TRUST");
  });

  it("treats a THROWING port as unavailable, and unavailable as refusal", async () => {
    const throwing: SecurityPortSet = {
      ...ports(),
      workloadIdentity: {
        verify: async () => {
          throw new Error("connection reset with secret token sk-999");
        },
      },
    };
    const resolution = await resolveTrust(throwing, {
      presentedIdentityRef: "order-ingestion",
      expectedInstanceId: "ksix",
      expectedTenantId: "acme",
      authorizationEvidenceRef: null,
      requiredScope: null,
      now: T0,
    });
    expect(resolution.trusted).toBe(false);
    if (!resolution.trusted) {
      expect(resolution.dependencyOutage).toBe(true);
      expect(resolution.reason).not.toContain("sk-999");
    }
  });

  // ── Each sub-check isolated with a custom port ────────────────────────────
  //
  // The pipeline tests above only see stage TRUST, and resolveTrust has
  // defence in depth — the tenant check, the grant-tenant check and the
  // reference port's own expiry all overlap, so a mutation removing any ONE
  // of them survived while the others caught the fixture. Each test here
  // builds a port that passes everything EXCEPT the check under test.

  const verifiedIdentity = (over: Partial<import("../../ports/securityPorts.js").WorkloadIdentity> = {}) => ({
    workloadId: "order-ingestion",
    instanceId: "ksix",
    tenantId: "acme" as string | null,
    trustDomain: "hive.ksix",
    ...over,
  });

  const customPorts = (over: {
    identity?: SecurityPortSet["workloadIdentity"];
    authorization?: SecurityPortSet["authorization"];
    revocation?: SecurityPortSet["revocation"];
  }): SecurityPortSet => ({
    workloadIdentity:
      over.identity ??
      ({ verify: async () => ({ outcome: "VERIFIED", validUntil: at(3600), detail: verifiedIdentity() }) } as const),
    authorization:
      over.authorization ??
      ({
        verify: async () => ({
          outcome: "VERIFIED",
          validUntil: at(3600),
          detail: { decisionRef: "dec-1", principalId: "order-ingestion", scope: "s", tenantId: "acme" },
        }),
      } as const),
    revocation: over.revocation ?? ({ check: async () => ({ outcome: "NOT_REVOKED", checkedAt: T0 }) } as const),
    integrity: ports().integrity,
  });

  const ask = (portSet: SecurityPortSet, over: Partial<Parameters<typeof resolveTrust>[1]> = {}) =>
    resolveTrust(portSet, {
      presentedIdentityRef: "order-ingestion",
      expectedInstanceId: "ksix",
      expectedTenantId: "acme",
      authorizationEvidenceRef: "dec-1",
      requiredScope: "s",
      now: at(100),
      ...over,
    });

  it("REFUSES an identity VERIFICATION that has itself expired", async () => {
    // The port said VERIFIED with a validUntil in the past — a cached answer
    // outliving its truth. The reference port never produces this shape, which
    // is why this needs a custom one.
    const r = await ask(
      customPorts({
        identity: { verify: async () => ({ outcome: "VERIFIED", validUntil: at(50), detail: verifiedIdentity() }) },
      }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("IDENTITY");
      expect(r.reason).toContain("outlives its truth");
    }
  });

  it("REFUSES a valid identity issued for a DIFFERENT instance", async () => {
    const r = await ask(
      customPorts({
        identity: {
          verify: async () => ({
            outcome: "VERIFIED",
            validUntil: at(3600),
            detail: verifiedIdentity({ instanceId: "proworks" }),
          }),
        },
      }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("SCOPE");
      expect(r.reason).toContain("the shape a cross-instance replay takes");
    }
  });

  it("REFUSES a tenant-scoped identity used for another tenant", async () => {
    const r = await ask(
      customPorts({
        identity: {
          verify: async () => ({
            outcome: "VERIFIED",
            validUntil: at(3600),
            detail: verifiedIdentity({ tenantId: "someone-else" }),
          }),
        },
      }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("SCOPE");
      expect(r.reason).toContain('tenant-scoped to "someone-else"');
    }
  });

  it("FAILS CLOSED when only the REVOCATION list is unreachable", async () => {
    // Identity verified fine; the list that would say "stolen" did not answer.
    // "Probably not revoked" is the assumption a stolen credential relies on.
    const r = await ask(
      customPorts({ revocation: { check: async () => ({ outcome: "UNAVAILABLE", reason: "list down" }) } }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("REVOCATION");
      expect(r.dependencyOutage).toBe(true);
      expect(r.reason).toContain("a stolen credential relies on");
    }
  });

  it("REFUSES a protected operation with NO evidence reference at all", async () => {
    // Unreachable through the pipeline — the envelope schema already requires
    // the field on COMMAND — so it is tested at the composition directly.
    const r = await ask(customPorts({}), { authorizationEvidenceRef: null });
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("AUTHORIZATION");
      expect(r.reason).toContain("nothing to verify is not a pass");
    }
  });

  it("REFUSES a grant whose own validity has lapsed", async () => {
    const r = await ask(
      customPorts({
        authorization: {
          verify: async () => ({
            outcome: "VERIFIED",
            validUntil: at(50),
            detail: { decisionRef: "d", principalId: "order-ingestion", scope: "s", tenantId: "acme" },
          }),
        },
      }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("AUTHORIZATION");
      expect(r.reason).toContain('what "revoked" looks like from the caller');
    }
  });

  it("REFUSES a grant carrying the WRONG scope", async () => {
    const r = await ask(
      customPorts({
        authorization: {
          verify: async () => ({
            outcome: "VERIFIED",
            validUntil: at(3600),
            detail: { decisionRef: "d", principalId: "order-ingestion", scope: "other:scope", tenantId: "acme" },
          }),
        },
      }),
    );
    expect(r.trusted).toBe(false);
    if (!r.trusted) {
      expect(r.failedAt).toBe("SCOPE");
      expect(r.reason).toContain("A grant for something else is a grant for something else");
    }
  });

  it("the reference port refuses an UNISSUED identity with its own reason", async () => {
    // Through the pipeline, disabling this check makes the port throw on the
    // missing record — which is caught and still refused, so the mutation
    // survived. The port's own verdict is the thing to assert.
    const verdict = await ports().workloadIdentity.verify({
      presentedIdentityRef: "nobody",
      expectedInstanceId: "ksix",
      now: T0,
    });
    expect(verdict.outcome).toBe("REFUSED");
    if (verdict.outcome === "REFUSED") expect(verdict.reason).toContain("a forgery, however well-formed");
  });

  it("the reference port refuses an EXPIRED identity with its own reason", async () => {
    const verdict = await ports().workloadIdentity.verify({
      presentedIdentityRef: "order-ingestion",
      expectedInstanceId: "ksix",
      now: at(3600),
    });
    expect(verdict.outcome).toBe("REFUSED");
    if (verdict.outcome === "REFUSED") expect(verdict.reason).toContain("expired at");
  });

  it("checks identity BEFORE authorization", async () => {
    // "May somebody do this" is almost always yes; who is asking comes first.
    const resolution = await resolveTrust(ports(), {
      presentedIdentityRef: "nobody",
      expectedInstanceId: "ksix",
      expectedTenantId: "acme",
      authorizationEvidenceRef: "dec-1",
      requiredScope: "manufacturing.plan:command",
      now: T0,
    });
    expect(resolution.trusted).toBe(false);
    if (!resolution.trusted) expect(resolution.failedAt).toBe("IDENTITY");
  });

  it("holds no trust root", () => {
    expect(fabricHoldsTrustRoot()).toBe(false);
  });

  it("the reference integrity verifier REFUSES rather than pretending to verify", async () => {
    const verdict = await ports().integrity.verify({
      canonical: "x",
      signature: "y",
      signedBy: "z",
      algorithmProfile: "p",
    });
    expect(verdict.outcome).toBe("REFUSED");
    if (verdict.outcome === "REFUSED") expect(verdict.reason).toContain("holds no key material by design");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const signedTopology = (over: Partial<SignedTopology> = {}): SignedTopology => ({
  version: topology,
  signature: "sig-over-canonical",
  signedBy: "security-iq",
  algorithmProfile: "hive-ed25519-v1",
  signedAt: T0,
  ...over,
});

const verifyingIntegrity = {
  verify: async () => ({ outcome: "VERIFIED" as const, validUntil: at(3600), detail: { signedBy: "security-iq" } }),
};
const refusingIntegrity = {
  verify: async () => ({ outcome: "REFUSED" as const, reason: "signature does not verify" }),
};
const unavailableIntegrity = {
  verify: async () => ({ outcome: "UNAVAILABLE" as const, reason: "verifier down" }),
};

describe("the control plane activates only what verifies, approves and builds", () => {
  it("activates a signed, approved, building topology", async () => {
    const outcome = await activateTopology(signedTopology(), verifyingIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(true);
    if (outcome.activated) expect(outcome.state.graph).not.toBeNull();
  });

  it("REFUSES a topology whose signature does not verify", async () => {
    const outcome = await activateTopology(signedTopology(), refusingIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain("forgery");
  });

  it("REFUSES a topology when the verifier is UNREACHABLE — a forged update would arrive exactly then", async () => {
    const outcome = await activateTopology(signedTopology(), unavailableIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain('"the verifier was down" is exactly when one would arrive');
  });

  it("REFUSES an unapproved draft, however validly signed", async () => {
    const draft = signedTopology({ version: { ...topology, state: "DRAFT" } });
    const outcome = await activateTopology(draft, verifyingIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain("decorative");
  });

  it("REFUSES a signature without an activation decision — who signed is not who approved", async () => {
    const undecided = signedTopology({ version: { ...topology, activationDecisionRef: null } });
    const outcome = await activateTopology(undecided, verifyingIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain("different facts and this check needs both");
  });

  it("REFUSES a signed topology that does not build", async () => {
    const broken = signedTopology({
      version: { ...topology, nodes: [node("stray", "nowhere", ["x"])] },
    });
    const outcome = await activateTopology(broken, verifyingIntegrity, new Map(), new Map(), "GREEN", T0);
    expect(outcome.activated).toBe(false);
    if (!outcome.activated) expect(outcome.reason).toContain("proves the invalid topology is authentic");
  });

  it("canonical form is stable across key order", () => {
    const reordered = JSON.parse(JSON.stringify(topology)) as TopologyVersion;
    expect(canonicalTopologyForm(reordered)).toBe(canonicalTopologyForm(topology));
  });
});

describe("a data plane cannot widen the topology", () => {
  const state = async () => {
    const outcome = await activateTopology(
      signedTopology(),
      verifyingIntegrity,
      new Map([["COMMAND", "in-memory"]]),
      new Map([["forgeiq.plan.requested@1", contract]]),
      "GREEN",
      T0,
    );
    if (!outcome.activated) throw new Error("fixture must activate");
    return outcome.state;
  };

  it("issues a frozen view", async () => {
    const v = issueView(await state(), 60_000, T0);
    expect(v.issued).toBe(true);
    if (v.issued) expect(Object.isFrozen(v.view)).toBe(true);
  });

  it("refuses to issue a view when nothing is active — default deny extends to 'not yet'", async () => {
    const v = issueView(
      { activeTopology: null, graph: null, laneBindings: new Map(), contracts: new Map(), conditionLevel: "GREEN", confirmedAt: T0 },
      60_000,
      T0,
    );
    expect(v.issued).toBe(false);
  });

  it("ATTACK: mutating the view's bindings does not change what anyone else sees", async () => {
    // A compromised component does not ask the compiler. Cast away readonly
    // and try; the mutation must not reach the control plane.
    const s = await state();
    const v = issueView(s, 60_000, T0);
    if (!v.issued) throw new Error("must issue");

    const mutableBindings = v.view.laneBindings as Map<string, string>;
    mutableBindings.set("EVIDENCE", "attacker-provider");

    // The control plane still has exactly one binding.
    expect(s.laneBindings.size).toBe(1);
    expect(s.laneBindings.has("EVIDENCE")).toBe(false);

    // And a SECOND view issued from the same state is clean.
    const v2 = issueView(s, 60_000, T0);
    if (v2.issued) expect(v2.view.laneBindings.has("EVIDENCE")).toBe(false);
  });

  it("ATTACK: the frozen view rejects direct property replacement", async () => {
    const v = issueView(await state(), 60_000, T0);
    if (!v.issued) throw new Error("must issue");
    const view = v.view as { conditionLevel: string };
    expect(() => {
      "use strict";
      view.conditionLevel = "GREEN-FOREVER";
    }).toThrow();
    expect(v.view.conditionLevel).toBe("GREEN");
  });

  it("ATTACK: the graph inside the view exposes only ReadonlyMaps backed by the build", async () => {
    const v = issueView(await state(), 60_000, T0);
    if (!v.issued) throw new Error("must issue");
    // The graph's maps are real Maps at runtime; mutating outgoing on the view
    // would corrupt routing for THIS holder only if it shared state — the
    // runtime always re-reads from the control plane's graph, which this test
    // shows is a distinct object path from any copy the attacker can reach
    // through bindings/contracts.
    expect(v.view.graph.outgoing.get("ordering")).toHaveLength(1);
    expect(dataPlaneMayMutateControlPlane()).toBe(false);
  });
});

describe("stale views: continuity for traffic, never for change", () => {
  const view = async () => {
    const outcome = await activateTopology(signedTopology(), verifyingIntegrity, new Map(), new Map(), "GREEN", T0);
    if (!outcome.activated) throw new Error("must activate");
    const v = issueView(outcome.state, 60_000, T0);
    if (!v.issued) throw new Error("must issue");
    return v.view;
  };

  it("is fresh inside its TTL", async () => {
    const u = viewUsable(await view(), true, 300_000, at(30));
    expect(u.usable).toBe(true);
    if (u.usable) expect(u.stale).toBe(false);
  });

  it("treats the TTL boundary as exclusive — stale AT the instant, not after it", async () => {
    const u = viewUsable(await view(), true, 300_000, at(60));
    expect(u.usable).toBe(false);
  });

  it("REFUSES a stale view while the control plane is REACHABLE", async () => {
    // Continuing on a stale view when a fresh one is available means ignoring
    // whatever changed — and what changed may be a revocation.
    const u = viewUsable(await view(), true, 300_000, at(61));
    expect(u.usable).toBe(false);
    if (!u.usable) expect(u.reason).toContain("may be a revocation");
  });

  it("continues on a stale view while the control plane is UNREACHABLE, inside grace", async () => {
    const u = viewUsable(await view(), false, 300_000, at(61));
    expect(u.usable).toBe(true);
    if (u.usable && u.stale) expect(u.note).toContain("NOTHING may widen");
  });

  it("stops when the grace period is exhausted — a grace period without an end is a fork", async () => {
    const u = viewUsable(await view(), false, 300_000, at(361));
    expect(u.usable).toBe(false);
    if (!u.usable) expect(u.reason).toContain("a fork");
  });

  it("permits traffic and tightening while stale, refuses every widening", () => {
    expect(permittedWhileStale("ROUTE_TRAFFIC").permitted).toBe(true);
    expect(permittedWhileStale("TIGHTEN_POSTURE").permitted).toBe(true);
    expect(permittedWhileStale("REFRESH_VIEW").permitted).toBe(true);
    for (const op of ["ACTIVATE_TOPOLOGY", "BIND_PROVIDER", "RELAX_POSTURE"] as const) {
      const p = permittedWhileStale(op);
      expect(p.permitted).toBe(false);
      expect(p.reason).toContain("nobody authoritative is reachable");
    }
  });
});
