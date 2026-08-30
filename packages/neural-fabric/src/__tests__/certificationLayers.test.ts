/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  certifyLayers,
  formatLayeredCertification,
  ROUTE_LOOKUP_P95_TARGET_MS,
  type LayerEvidence,
  type PerformanceMeasurement,
} from "../certificationLayers.js";
import { referenceSecurityPorts } from "../ports/securityPorts.js";
import { createSubjectBus } from "../providers/subjectBusProvider.js";
import { createDurableLog } from "../providers/durableLogProvider.js";
import { runScenarios } from "../twin/executableTwin.js";
import type { GatewayConfig } from "../interconnect/gateway.js";
import type { TopologyVersion } from "../domain/topology.js";

// ─────────────────────────────────────────────────────────────────────────────
// The layered certification is itself certified: gates must pass on real
// receipts, FAIL on their absence, and fail HONESTLY when a measurement
// misses its target. The last of those is the important one — a
// certification that cannot fail certifies nothing, and this suite proves
// the layers can.
// ─────────────────────────────────────────────────────────────────────────────

const T0 = "2026-08-30T10:00:00.000Z";

const topology: TopologyVersion = {
  versionId: "v-cert",
  parentVersionId: null,
  instanceId: "ksix",
  zones: [{ zoneId: "local", kind: "LOCAL", instanceId: "ksix" }],
  nodes: [
    { nodeId: "a", kind: "ENGINE", zoneId: "local", capabilities: ["orders"], workloadIdentityRef: "spiffe://ksix/a", isTest: true },
    { nodeId: "b", kind: "ENGINE", zoneId: "local", capabilities: ["planning"], workloadIdentityRef: "spiffe://ksix/b", isTest: true },
    { nodeId: "c", kind: "ENGINE", zoneId: "local", capabilities: ["planning"], workloadIdentityRef: "spiffe://ksix/c", isTest: true },
  ],
  adjacencies: [
    { adjacencyId: "ab", fromNodeId: "a", toNodeId: "b", lane: "EVENT", capability: "planning", authorizingDecisionRef: "dec-ab", state: "ACTIVE" },
    { adjacencyId: "ac", fromNodeId: "a", toNodeId: "c", lane: "EVENT", capability: "planning", authorizingDecisionRef: "dec-ac", state: "ACTIVE" },
  ],
  rationale: "Certification fixture.",
  createdAt: T0,
  state: "ACTIVE",
  activationDecisionRef: "dec-cert",
};

const gateway: GatewayConfig = {
  localInstanceId: "ksix",
  grants: [
    {
      grantId: "g-1",
      fromInstanceId: "peer-b",
      toInstanceId: "ksix",
      capabilities: ["certification"],
      lanes: ["EVENT"],
      authorizingDecisionRef: "dec-g1",
      notAfter: "2027-01-01T00:00:00.000Z",
      revoked: false,
    },
  ],
  instanceIdentity: {
    verify: async () => ({
      outcome: "VERIFIED",
      validUntil: "2027-01-01T00:00:00.000Z",
      detail: { instanceId: "peer-b", trustDomain: "hive" },
    }),
  },
  seenMessageIds: new Set(),
  knownTenants: new Set(["certification"]),
};

/** Real receipts: twin scenarios actually run against the kernel. */
const resilienceRuns = () =>
  runScenarios(
    [
      {
        scenarioId: "s-node-loss",
        fault: "NODE_LOSS",
        target: "b",
        criticalCapabilities: ["planning"],
        probes: [{ fromNodeId: "a", capability: "planning", lane: "EVENT" }],
      },
      {
        scenarioId: "s-route-removal",
        fault: "ROUTE_REMOVAL",
        target: "ab",
        criticalCapabilities: ["planning"],
        probes: [{ fromNodeId: "a", capability: "planning", lane: "EVENT" }],
      },
    ],
    { topology, zoneKinds: new Map([["local", "LOCAL"]]), now: T0 },
  );

const passingMeasurements: readonly PerformanceMeasurement[] = [
  { logicalNodes: 1_000, graphBuildMs: 8.3, routeLookupP50Ms: 0.07, routeLookupP95Ms: 0.25, routeLookupP99Ms: 0.44, cached: false },
  { logicalNodes: 10_000, graphBuildMs: 13.5, routeLookupP50Ms: 1.15, routeLookupP95Ms: 2.32, routeLookupP99Ms: 3.5, cached: false },
];

/** The honest 100k figure, which MISSES the §25 target uncached. */
const missingMeasurement: PerformanceMeasurement = {
  logicalNodes: 100_000,
  graphBuildMs: 165.6,
  routeLookupP50Ms: 37.98,
  routeLookupP95Ms: 88.16,
  routeLookupP99Ms: 112.13,
  cached: false,
};

const evidence = (over: Partial<LayerEvidence> = {}): LayerEvidence => ({
  boundProviders: [createSubjectBus().capability, createDurableLog(4).capability],
  securityPorts: referenceSecurityPorts({ issued: [], revoked: new Map(), grants: [] }),
  gateway,
  resilienceRuns: resilienceRuns(),
  performanceRuns: passingMeasurements,
  now: T0,
  ...over,
});

describe("layered certification: with real receipts", () => {
  it("kernel, provider, runtime, security, cross-instance and resilience layers hold", async () => {
    const report = await certifyLayers(evidence());
    const byLayer = new Map(report.layers.map((l) => [l.layer, l]));
    expect(byLayer.get("KERNEL")!.passed).toBe(true);
    expect(byLayer.get("PROVIDER")!.passed).toBe(true);
    expect(byLayer.get("RUNTIME")!.passed).toBe(true);
    expect(byLayer.get("SECURITY_INTEGRATION")!.passed).toBe(true);
    expect(byLayer.get("CROSS_INSTANCE")!.passed).toBe(true);
    expect(byLayer.get("RESILIENCE")!.passed).toBe(true);
  });

  it("passes performance only while every measured size meets the target", async () => {
    const good = await certifyLayers(evidence());
    expect(good.layers.find((l) => l.layer === "PERFORMANCE")!.passed).toBe(true);
    expect(good.certified).toBe(true);
  });

  it("the honest 100k measurement FAILS the performance gate rather than moving the target", async () => {
    const report = await certifyLayers(evidence({ performanceRuns: [...passingMeasurements, missingMeasurement] }));
    const perf = report.layers.find((l) => l.layer === "PERFORMANCE")!;
    expect(perf.passed).toBe(false);
    const gate = perf.gates.find((g) => g.gateId === "route-lookup-p95")!;
    expect(gate.evidence).toContain("100000");
    expect(gate.remedy).toContain("cache");
    expect(report.certified).toBe(false);
    expect(report.summary).toContain("PERFORMANCE");
    expect(missingMeasurement.routeLookupP95Ms).toBeGreaterThan(ROUTE_LOOKUP_P95_TARGET_MS);
  });
});

describe("layered certification: layers fail on an empty ledger", () => {
  it("no providers bound → the provider layer fails with a remedy", async () => {
    const report = await certifyLayers(evidence({ boundProviders: [] }));
    const layer = report.layers.find((l) => l.layer === "PROVIDER")!;
    expect(layer.passed).toBe(false);
    expect(layer.gates.find((g) => g.gateId === "providers-bound")!.remedy).toContain("Bind at least one provider");
  });

  it("no chaos runs → the resilience layer fails: a scenario has to be run, not inspected", async () => {
    const report = await certifyLayers(evidence({ resilienceRuns: [] }));
    const layer = report.layers.find((l) => l.layer === "RESILIENCE")!;
    expect(layer.passed).toBe(false);
    expect(layer.gates.find((g) => g.gateId === "scenarios-were-run")!.passed).toBe(false);
  });

  it("no benchmarks → the performance layer fails: never claim a target until measured", async () => {
    const report = await certifyLayers(evidence({ performanceRuns: [] }));
    const layer = report.layers.find((l) => l.layer === "PERFORMANCE")!;
    expect(layer.passed).toBe(false);
    expect(layer.gates.find((g) => g.gateId === "benchmarks-were-run")!.remedy).toContain("scale program");
  });
});

describe("layered certification: the live checks are live", () => {
  it("a gateway that admits a forged relay fails the cross-instance layer", async () => {
    // A negligent verifier that verifies the FORGED origin — the ingress
    // check's refusal must not have been an accident of the fixture.
    const negligent: GatewayConfig = {
      ...gateway,
      instanceIdentity: {
        verify: async () => ({
          outcome: "VERIFIED",
          validUntil: "2027-01-01T00:00:00.000Z",
          detail: { instanceId: "instance-that-did-not-present", trustDomain: "hive" },
        }),
      },
      grants: [
        {
          grantId: "g-neg",
          fromInstanceId: "instance-that-did-not-present",
          toInstanceId: "ksix",
          capabilities: ["certification"],
          lanes: ["EVENT"],
          authorizingDecisionRef: "dec-neg",
          notAfter: "2027-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    };
    const report = await certifyLayers(evidence({ gateway: negligent }));
    const layer = report.layers.find((l) => l.layer === "CROSS_INSTANCE")!;
    // With the presenter verified AS the claimed origin the relay probe no
    // longer relays, so ingress passes it — and the layer honestly reports
    // that the live refusal was NOT demonstrated.
    expect(layer.gates.find((g) => g.gateId === "relay-refused-live")!.passed).toBe(false);
  });

  it("a resilience run that breached isolation fails the layer by name", async () => {
    const breached = [{ ...resilienceRuns()[0]!, isolationHeld: false }];
    const report = await certifyLayers(evidence({ resilienceRuns: breached }));
    const gate = report.layers.find((l) => l.layer === "RESILIENCE")!.gates.find((g) => g.gateId === "isolation-held-everywhere")!;
    expect(gate.passed).toBe(false);
    expect(gate.evidence).toContain("s-node-loss");
  });
});

describe("layered certification: a provider with no lawful lane fails by name", () => {
  it("a capability sheet mayCarry refuses on every offered lane fails binding-law-applied", async () => {
    // EVIDENCE demands durability, redelivery and mutual TLS; this sheet has
    // none of them, so every offered lane is refused at binding.
    const dead = {
      providerId: "dead-letter",
      family: "in-memory",
      lanesOffered: ["EVIDENCE" as const],
      durable: false,
      redelivers: false,
      orderingScopes: ["NONE" as const],
      replayable: false,
      mutualTlsCapable: false,
    };
    const report = await certifyLayers(evidence({ boundProviders: [dead] }));
    const gate = report.layers.find((l) => l.layer === "PROVIDER")!.gates.find((g) => g.gateId === "binding-law-applied")!;
    expect(gate.passed).toBe(false);
    expect(gate.evidence).toContain("dead-letter");
    expect(gate.remedy).toContain("no lawful lane");
  });
});

describe("layered certification: the report is words, not a score", () => {
  it("formats with evidence and remedies, and contains no percentage", async () => {
    const report = await certifyLayers(evidence({ performanceRuns: [...passingMeasurements, missingMeasurement] }));
    const text = formatLayeredCertification(report);
    expect(text).toContain("REMEDY");
    expect(text).toContain("PERFORMANCE — FAIL");
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/\d+\s*\/\s*100/);
  });
});
