// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  buildOrganization,
  createFaultInjector,
  createRandom,
  judge,
  organizationKindSchema,
  simulationGrantsAuthority,
  submitResult,
  type AdversaryAttempt,
  type FaultEvidence,
  type Invariant,
  type LabEvidencePort,
} from "../lab.js";

const VERSIONS = { "neural-fabric": "0.23.0", "simulation-lab": "0.23.0" };

const applied = (over: Partial<FaultEvidence> = {}): FaultEvidence => ({
  fault: "NODE_LOSS",
  target: "n1",
  applied: true,
  proof: "Node n1 removed.",
  failureToApply: null,
  ...over,
});

const invariant = (over: Partial<Invariant> = {}): Invariant => ({
  invariantId: "inv-local-continuity",
  statement: "Local work continues while the Collective is unreachable.",
  holds: true,
  observation: "12 of 12 local probes still routed.",
  ...over,
});

const refused = (over: Partial<AdversaryAttempt> = {}): AdversaryAttempt => ({
  move: "DIRECT_CROSS_INSTANCE_BYPASS",
  refused: true,
  refusedBy: "zone rules",
  detail: "A local-to-local route across instances was refused structurally.",
  ...over,
});

describe("determinism, because a simulation you cannot repeat is an anecdote", () => {
  it("produces identical sequences for identical seeds, and different ones otherwise", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const c = createRandom(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual([c(), c(), c()]);
  });

  it("builds the same organization from the same seed", () => {
    expect(buildOrganization("MANY_INSTANCES_COLLECTIVE_OUTAGE", 7)).toEqual(
      buildOrganization("MANY_INSTANCES_COLLECTIVE_OUTAGE", 7),
    );
  });
});

describe("the eight synthetic organizations", () => {
  it("builds all eight, each with instances, capabilities and a stated purpose", () => {
    for (const kind of organizationKindSchema.options) {
      const org = buildOrganization(kind, 1);
      expect(org.instanceIds.length).toBeGreaterThan(0);
      expect(org.capabilities.length).toBeGreaterThan(0);
      expect(org.notes.length).toBeGreaterThan(40);
    }
  });

  it("models sensitivity as a shape, never as real data", () => {
    const org = buildOrganization("HIGH_SENSITIVITY_SYNTHETIC", 1);
    expect(org.highSensitivity).toBe(true);
    expect(org.notes).toContain("entirely fabricated");
  });

  it("gives the interconnect-only pair two instances that must use a gateway", () => {
    const org = buildOrganization("TWO_ORGS_INTERCONNECT_ONLY", 1);
    expect(org.instanceIds).toHaveLength(2);
    expect(org.notes).toContain("must be refused");
  });

  it("scales the collective-outage fixture to two hundred instances", () => {
    expect(buildOrganization("MANY_INSTANCES_COLLECTIVE_OUTAGE", 1).instanceIds).toHaveLength(200);
  });
});

describe("fault injection returns evidence, not a promise", () => {
  const world = () => ({
    nodes: new Set(["n1", "n2"]),
    providers: new Set(["durable-log"]),
    collectiveReachable: true,
    partitions: new Set<string>(),
  });

  it("proves a node was actually removed", () => {
    const w = world();
    const evidence = createFaultInjector(w).inject("NODE_LOSS", "n1");
    expect(evidence.applied).toBe(true);
    expect(evidence.proof).toContain("removed");
    expect(w.nodes.has("n1")).toBe(false);
  });

  it("reports honestly when the target was never there — the rename trap", () => {
    const evidence = createFaultInjector(world()).inject("NODE_LOSS", "n-typo");
    expect(evidence.applied).toBe(false);
    expect(evidence.failureToApply).toContain("renamed");
  });

  it("reports a no-op when the fault was already true", () => {
    const w = { ...world(), collectiveReachable: false };
    const evidence = createFaultInjector(w).inject("COLLECTIVE_OUTAGE", "collective");
    expect(evidence.applied).toBe(false);
    expect(evidence.failureToApply).toContain("already");
  });

  it("treats declared flow-level conditions as applied", () => {
    const evidence = createFaultInjector(world()).inject("CLOCK_SKEW", "edge-1");
    expect(evidence.applied).toBe(true);
  });
});

describe("the oracle refuses to call an undamaged system a pass", () => {
  it("returns INCONCLUSIVE when an intended fault did not occur", () => {
    const result = judge({
      scenarioId: "s-1",
      seed: 1,
      faultEvidence: [applied({ applied: false, proof: "", failureToApply: "node absent" })],
      adversaryAttempts: [],
      invariants: [invariant()],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.inconclusiveReason).toContain("did not occur");
    expect(result.explanation).toContain("permanently green");
  });

  it("does not let a holding invariant rescue an uninjected fault", () => {
    const result = judge({
      scenarioId: "s-1",
      seed: 1,
      faultEvidence: [applied(), applied({ target: "n-missing", applied: false, proof: "", failureToApply: "absent" })],
      adversaryAttempts: [refused()],
      invariants: [invariant({ holds: true })],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("INCONCLUSIVE");
  });

  it("FAILS when an adversary move was not refused, whatever the invariants say", () => {
    const result = judge({
      scenarioId: "s-2",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [refused({ move: "TRANSITIVE_TRUST_RELAY", refused: false, refusedBy: null, detail: "relay accepted" })],
      invariants: [invariant({ holds: true })],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.explanation).toContain("defence being tested did not hold");
  });

  it("FAILS when an invariant broke under a fault that really happened", () => {
    const result = judge({
      scenarioId: "s-3",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [refused()],
      invariants: [invariant({ holds: false, observation: "3 of 12 local probes routed." })],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.explanation).toContain("3 of 12");
  });

  it("returns INCONCLUSIVE when a scenario asserts nothing at all", () => {
    const result = judge({
      scenarioId: "s-4",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [refused()],
      invariants: [],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.explanation).toContain("reports green forever");
  });

  it("PASSES only when the faults landed, the adversary was refused and the invariants held", () => {
    const result = judge({
      scenarioId: "s-5",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [refused()],
      invariants: [invariant()],
      componentVersions: VERSIONS,
    });
    expect(result.outcome).toBe("PASS");
    expect(result.explanation).toContain("not a decision");
  });

  it("records the component versions the verdict applies to", () => {
    const result = judge({
      scenarioId: "s-6",
      seed: 9,
      faultEvidence: [applied()],
      adversaryAttempts: [],
      invariants: [invariant()],
      componentVersions: VERSIONS,
    });
    expect(result.componentVersions["neural-fabric"]).toBe("0.23.0");
    expect(result.seed).toBe(9);
  });
});

describe("simulation is evidence, not authority", () => {
  it("says so in the type and in the claim", () => {
    const result = judge({
      scenarioId: "s-7",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [],
      invariants: [invariant()],
      componentVersions: VERSIONS,
    });
    expect(result.isAuthorization).toBe(false);
    expect(simulationGrantsAuthority()).toBe(false);
  });

  it("does not let a failing evidence sink change the verdict", () => {
    const result = judge({
      scenarioId: "s-8",
      seed: 1,
      faultEvidence: [applied()],
      adversaryAttempts: [],
      invariants: [invariant()],
      componentVersions: VERSIONS,
    });
    const broken: LabEvidencePort = {
      submit() {
        throw new Error("Foundry unreachable");
      },
    };
    expect(submitResult(broken, result).submitted).toBe(false);
    expect(result.outcome).toBe("PASS");
  });
});
