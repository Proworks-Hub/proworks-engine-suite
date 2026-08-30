/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import type { Lane } from "../../domain/lanes.js";
import {
  admissionGrantsReachability,
  advance,
  nextStep,
  registryFindings,
  type AdmissionState,
  type CapabilityRecord,
  type StageEvidence,
} from "../topologyIQ.js";
import {
  consume,
  priorityBypassesLimits,
  schedule,
  shareOfCapacity,
  type BucketState,
  type QueuedSignal,
  type RateLimit,
} from "../flowIQ.js";
import {
  LANE_DEGRADATION,
  assessCoverage,
  mayCarry,
  providerCapabilitySchema,
  providerIsRequired,
  type ProviderCapability,
} from "../../ports/providers.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Admission is a sequence whose order is load-bearing, and reaching the end of
// it grants nothing.
// ─────────────────────────────────────────────────────────────────────────────

const state = (stage: AdmissionState["stage"]): AdmissionState => ({
  requestId: "req-1",
  stage,
  refusalReason: null,
  history: [],
});

const evidence = (over: Partial<StageEvidence> = {}): StageEvidence => ({
  identityVerified: true,
  contractsCompatible: true,
  topologyProposalRef: "prop-1",
  governanceDecisionRef: "dec-1",
  requiresGovernance: true,
  topologyVersionActive: true,
  ...over,
});

describe("admission tells a participant WHICH gate it is at", () => {
  it("blocks at identity before anything else is checked", () => {
    // Checking contracts first would tell an unauthenticated caller which
    // capabilities exist.
    const step = nextStep(state("REQUESTED"), evidence({ identityVerified: false }));
    expect("blocked" in step && step.blocked).toBe(true);
    if ("blocked" in step) {
      expect(step.needs).toContain("verified workload identity");
      expect(step.note).toContain("which capabilities exist");
    }
  });

  it("advances through the sequence in order", () => {
    expect(nextStep(state("REQUESTED"), evidence())).toMatchObject({ advanceTo: "IDENTIFIED" });
    expect(nextStep(state("IDENTIFIED"), evidence())).toMatchObject({ advanceTo: "CONTRACTS_VERIFIED" });
    expect(nextStep(state("CONTRACTS_VERIFIED"), evidence())).toMatchObject({ advanceTo: "TOPOLOGY_PROPOSED" });
    expect(nextStep(state("TOPOLOGY_PROPOSED"), evidence())).toMatchObject({ advanceTo: "GOVERNED" });
    expect(nextStep(state("GOVERNED"), evidence())).toMatchObject({ advanceTo: "ADMITTED" });
  });

  it("blocks on contracts before a topology attachment is proposed", () => {
    // So an incompatible participant never becomes a proposal somebody has to
    // review and refuse. The `blocked` assertion is unconditional: asserting
    // only inside a type guard passes vacuously when the gate is removed,
    // which is exactly how three of these tests checked nothing.
    const step = nextStep(state("IDENTIFIED"), evidence({ contractsCompatible: false }));
    expect("blocked" in step).toBe(true);
    if (!("blocked" in step)) throw new Error("should have blocked");
    expect(step.note).toContain("never becomes a proposal");
  });

  it("blocks until a topology attachment has actually been proposed", () => {
    const step = nextStep(state("CONTRACTS_VERIFIED"), evidence({ topologyProposalRef: null }));
    expect("blocked" in step).toBe(true);
    if (!("blocked" in step)) throw new Error("should have blocked");
    expect(step.needs).toContain("proposed topology attachment");
    expect(step.note).toContain("Nothing is active yet");
  });

  it("blocks on Governance before activation, so the proposal is not the decision", () => {
    const step = nextStep(state("TOPOLOGY_PROPOSED"), evidence({ governanceDecisionRef: null }));
    expect("blocked" in step && step.blocked).toBe(true);
    if ("blocked" in step) expect(step.note).toContain("the connection is the obvious next step");
  });

  it("skips the Governance gate when no decision was required", () => {
    const step = nextStep(state("TOPOLOGY_PROPOSED"), evidence({ requiresGovernance: false, governanceDecisionRef: null }));
    expect(step).toMatchObject({ advanceTo: "GOVERNED" });
    if ("advanceTo" in step) expect(step.note).toContain("already-approved structure");
  });

  it("blocks between approval and activation", () => {
    const step = nextStep(state("GOVERNED"), evidence({ topologyVersionActive: false }));
    expect("blocked" in step).toBe(true);
    if (!("blocked" in step)) throw new Error("should have blocked");
    expect(step.note).toContain("what makes rollback possible");
  });

  it("says ADMITTED is not reachability", () => {
    // "We admitted it" sounds like "it works now", and most systems behave
    // that way.
    const step = nextStep(state("ADMITTED"), evidence());
    expect("done" in step && step.done).toBe(true);
    if ("done" in step) expect(step.note).toContain("NOT the same as being able to reach anything");
    expect(admissionGrantsReachability()).toBe(false);
  });
});

describe("admission cannot skip a gate or run one twice", () => {
  it("advances one stage at a time", () => {
    const r = advance(state("REQUESTED"), "IDENTIFIED", T0, "verified");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.history).toHaveLength(1);
  });

  it("REFUSES to skip stages", () => {
    // Skipping is not a shortcut; it is the absence of a check.
    const r = advance(state("REQUESTED"), "ADMITTED", T0, "shortcut");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("without ever being identified");
  });

  it("REFUSES to move backwards", () => {
    const r = advance(state("GOVERNED"), "IDENTIFIED", T0, "again");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("quietly re-enter at an earlier one");
  });

  it("permits refusal from any stage and records the reason", () => {
    const r = advance(state("CONTRACTS_VERIFIED"), "REFUSED", T0, "schema mismatch on the COMMAND lane");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.refusalReason).toContain("schema mismatch");
  });

  it("treats a refusal as terminal", () => {
    const refused: AdmissionState = { ...state("REFUSED"), refusalReason: "no" };
    const retry = advance(refused, "IDENTIFIED", T0, "retry");
    expect(retry.ok).toBe(false);
    // The REASON matters. Without the terminal check the call still fails, by
    // accident, through the stage-ordering arithmetic — and the caller would be
    // told it was a sequencing problem rather than that the request is closed.
    if (!retry.ok) expect(retry.reason).toContain("Reapplying means a new request");
    const step = nextStep(refused, evidence());
    if ("blocked" in step) expect(step.note).toContain("the refusal stays in the record");
  });
});

describe("the registry answers what we have exactly one of", () => {
  const record = (over: Partial<CapabilityRecord> & Pick<CapabilityRecord, "capability">): CapabilityRecord => ({
    providerNodeIds: ["a", "b"],
    lanes: ["COMMAND"],
    zoneKinds: ["LOCAL"],
    ...over,
  });

  it("flags a single provider before it fails, not during", () => {
    const f = registryFindings([record({ capability: "costing", providerNodeIds: ["only"] })]);
    expect(f[0]!.kind).toBe("SINGLE_PROVIDER");
    expect(f[0]!.note).toContain("rather than at the moment it stops");
  });

  it("says nothing about a capability with two providers", () => {
    expect(registryFindings([record({ capability: "costing" })])).toEqual([]);
  });

  it("flags a capability nothing provides", () => {
    const f = registryFindings([record({ capability: "ghost", providerNodeIds: [] })]);
    expect(f[0]!.kind).toBe("NO_PROVIDER");
    expect(f[0]!.note).toContain("reads like a permission problem and is not one");
  });

  it("flags a capability that exists only in sandbox", () => {
    const f = registryFindings([record({ capability: "sim-only", zoneKinds: ["SANDBOX"] })]);
    expect(f[0]!.kind).toBe("SANDBOX_ONLY");
    expect(f[0]!.note).toContain("as an isolation refusal rather than as a missing capability");
  });

  it("flags a capability split across a gateway, where the remote side is least tested", () => {
    const f = registryFindings([record({ capability: "split", zoneKinds: ["LOCAL", "GATEWAY"] })]);
    expect(f.some((x) => x.kind === "SPLIT_ACROSS_INSTANCES")).toBe(true);
    expect(f.find((x) => x.kind === "SPLIT_ACROSS_INSTANCES")!.note).toContain(
      "least tested exactly when it matters most",
    );
  });

  it("reports findings in a stable order", () => {
    const records = [record({ capability: "z", providerNodeIds: ["one"] }), record({ capability: "a", providerNodeIds: [] })];
    expect(registryFindings(records).map((f) => f.capability)).toEqual(["a", "z"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const limit: RateLimit = { scopeKey: "tenant:acme", refillPerSecond: 10, burstCapacity: 20 };

describe("limits are per scope, so one tenant's bad day is not everyone's", () => {
  it("allows within the burst allowance", () => {
    const d = consume(limit, null, 5, T0);
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.remaining).toBe(15);
  });

  it("refuses over the allowance and says when to retry", () => {
    const empty: BucketState = { scopeKey: limit.scopeKey, tokens: 0, lastRefillAt: T0 };
    const d = consume(limit, empty, 5, T0);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.retryAfterMs).toBe(500);
      expect(d.note).toContain("nobody else is being throttled for it");
    }
  });

  it("refills continuously, so there is no window boundary to exploit", () => {
    // A fixed window lets a caller send its whole quota either side of the
    // boundary and double the rate across it.
    const empty: BucketState = { scopeKey: limit.scopeKey, tokens: 0, lastRefillAt: T0 };
    const d = consume(limit, empty, 5, at(500));
    expect(d.allowed).toBe(true);
  });

  it("caps refill at the burst capacity", () => {
    const empty: BucketState = { scopeKey: limit.scopeKey, tokens: 0, lastRefillAt: T0 };
    const d = consume(limit, empty, 1, at(600_000));
    if (d.allowed) expect(d.remaining).toBe(19);
  });

  it("treats a zero limit as a closed door, not as unlimited", () => {
    // The opposite reading is how a misconfiguration becomes an outage in the
    // wrong direction.
    const d = consume({ ...limit, refillPerSecond: 0 }, null, 1, T0);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.note).toContain("closed door");
  });

  it("never lets priority past a limit", () => {
    // An emergency that could spend an unlimited allowance is a denial of
    // service with a good reason attached.
    expect(priorityBypassesLimits()).toBe(false);
  });
});

describe("scheduling serves priority, then age", () => {
  const signal = (over: Partial<QueuedSignal> & Pick<QueuedSignal, "signalId">): QueuedSignal => ({
    scopeKey: "tenant:a",
    lane: "COMMAND" as Lane,
    priority: "NORMAL",
    enqueuedAt: T0,
    ...over,
  });

  it("serves higher priority first", () => {
    const r = schedule(
      [signal({ signalId: "normal" }), signal({ signalId: "urgent", priority: "EMERGENCY" })],
      100,
    );
    expect(r.order[0]!.signalId).toBe("urgent");
  });

  it("serves the OLDEST first within a priority", () => {
    // Without age, a steady stream of higher-priority work starves everything
    // below it and the starved work is invisible because it is still queued.
    const r = schedule(
      [signal({ signalId: "new", enqueuedAt: at(1000) }), signal({ signalId: "old", enqueuedAt: T0 })],
      100,
    );
    expect(r.order.map((s) => s.signalId)).toEqual(["old", "new"]);
  });

  it("HOLDS BACK a scope that would occupy the whole queue", () => {
    // Behaving entirely within its rights, and still everyone else's outage.
    const hog = Array.from({ length: 5 }, (_, i) => signal({ signalId: `hog-${i}`, scopeKey: "tenant:loud", enqueuedAt: at(i) }));
    const quiet = signal({ signalId: "quiet", scopeKey: "tenant:quiet", enqueuedAt: at(100) });
    const r = schedule([...hog, quiet], 2);
    expect(r.deprioritisedScopes).toContain("tenant:loud");
    expect(r.order.map((s) => s.signalId)).toContain("quiet");
    expect(r.note).toContain("still everyone else's outage");
  });

  it("keeps every signal, holding rather than dropping", () => {
    const hog = Array.from({ length: 5 }, (_, i) => signal({ signalId: `hog-${i}`, scopeKey: "tenant:loud", enqueuedAt: at(i) }));
    expect(schedule(hog, 2).order).toHaveLength(5);
  });

  it("explains the fairness rule when nothing was held", () => {
    expect(schedule([signal({ signalId: "a" })], 100).note).toContain("still queued rather than failed");
  });
});

describe("capacity share is visible before anything is refused", () => {
  it("names a scope taking more than half", () => {
    const r = shareOfCapacity(new Map([["a", 800], ["b", 100], ["c", 100]]));
    expect(r.dominant).toBe("a");
    expect(r.note).toContain("a spike and a trend look identical at the moment of refusal");
  });

  it("does not name a dominant scope when capacity is spread", () => {
    expect(shareOfCapacity(new Map([["a", 100], ["b", 100], ["c", 100]])).dominant).toBeNull();
  });

  it("does not call a single scope dominant when it is the only one", () => {
    expect(shareOfCapacity(new Map([["a", 100]])).dominant).toBeNull();
  });

  it("does not report no usage as healthy", () => {
    expect(shareOfCapacity(new Map()).note).toContain("nothing has been measured");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const provider = (over: Partial<ProviderCapability> = {}): ProviderCapability =>
  providerCapabilitySchema.parse({
    providerId: "durable-queue",
    family: "quorum-queue",
    lanesOffered: ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"],
    durable: true,
    redelivers: true,
    orderingScopes: ["NONE", "PER_KEY", "PER_PAIR", "PER_PARTITION", "STRICT_SEQUENCE"],
    replayable: true,
    mutualTlsCapable: true,
    ...over,
  });

describe("a capability claim is checked, not trusted", () => {
  it("permits a fully capable provider on every lane", () => {
    for (const lane of ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"] as Lane[]) {
      expect(mayCarry(provider(), lane).permitted).toBe(true);
    }
  });

  it("REFUSES a non-durable provider on the workflow lane", () => {
    // The discovery would be a restart during which every workflow vanished.
    const v = mayCarry(provider({ durable: false }), "WORKFLOW");
    expect(v.permitted).toBe(false);
    if (!v.permitted) expect(v.problems.map((p) => p.consequence).join()).toContain("every workflow disappeared");
  });

  it("REFUSES a provider that cannot redeliver on an at-least-once lane", () => {
    const v = mayCarry(provider({ redelivers: false }), "COMMAND");
    expect(v.permitted).toBe(false);
    if (!v.permitted) {
      expect(v.problems.map((p) => p.consequence).join()).toContain("the receiver saw nothing");
    }
  });

  it("REFUSES a provider without the ordering the lane needs", () => {
    const v = mayCarry(provider({ orderingScopes: ["NONE"] }), "WORKFLOW");
    expect(v.permitted).toBe(false);
    if (!v.permitted) {
      expect(v.problems.map((p) => p.consequence).join()).toContain("looks like a logic bug");
    }
  });

  it("REFUSES a provider that cannot authenticate both ends on a consequential lane", () => {
    const v = mayCarry(provider({ mutualTlsCapable: false }), "COMMAND");
    expect(v.permitted).toBe(false);
    if (!v.permitted) {
      expect(v.problems.map((p) => p.consequence).join()).toContain("cannot vouch for either end");
    }
  });

  it("reports EVERY unmet requirement at once", () => {
    const v = mayCarry(provider({ durable: false, redelivers: false, replayable: false }), "STREAM");
    expect(v.permitted).toBe(false);
    if (!v.permitted) expect(v.problems.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses a lane the provider never offered", () => {
    const v = mayCarry(provider({ lanesOffered: ["HEALTH"] }), "COMMAND");
    expect(v.permitted).toBe(false);
    if (!v.permitted) expect(v.problems[0]!.consequence).toContain("never claimed it could carry it");
  });

  it("permits a health-only provider on the health lane", () => {
    const ephemeral = provider({
      providerId: "fast-pubsub",
      lanesOffered: ["HEALTH", "QUERY"],
      durable: false,
      redelivers: false,
      orderingScopes: ["NONE"],
      replayable: false,
    });
    expect(mayCarry(ephemeral, "HEALTH").permitted).toBe(true);
    expect(mayCarry(ephemeral, "QUERY").permitted).toBe(true);
  });
});

describe("no provider is constitutionally required", () => {
  it("says so as an assertable claim", () => {
    // The pressure to depend on one provider's distinctive feature arrives as
    // an optimisation and is visible as a dependency only afterwards.
    expect(providerIsRequired()).toBe(false);
  });

  it("declares a degraded behaviour for EVERY lane, in advance", () => {
    for (const lane of Object.keys(LANE_DEGRADATION) as Lane[]) {
      expect(LANE_DEGRADATION[lane].rationale.length).toBeGreaterThan(0);
    }
  });

  it("drops only health traffic", () => {
    const dropping = (Object.keys(LANE_DEGRADATION) as Lane[]).filter((l) => LANE_DEGRADATION[l].behaviour === "DROP");
    expect(dropping).toEqual(["HEALTH"]);
  });

  it("halts the workflow lane rather than repeating side effects", () => {
    expect(LANE_DEGRADATION.WORKFLOW.behaviour).toBe("HALT");
    expect(LANE_DEGRADATION.WORKFLOW.rationale).toContain("duplicate real-world actions");
  });

  it("keeps accepted commands while refusing new ones", () => {
    expect(LANE_DEGRADATION.COMMAND.behaviour).toBe("REFUSE_NEW_ACCEPT_INFLIGHT");
    expect(LANE_DEGRADATION.COMMAND.rationale).toContain("breaking an existing promise is worse");
  });

  it("never drops evidence", () => {
    expect(LANE_DEGRADATION.EVIDENCE.behaviour).not.toBe("DROP");
    expect(LANE_DEGRADATION.EVIDENCE.rationale).toContain("worse than an action not taken");
  });

  it("reports a lane with no capable provider", () => {
    const healthOnly = provider({ lanesOffered: ["HEALTH"], durable: false, redelivers: false, orderingScopes: ["NONE"], replayable: false });
    const c = assessCoverage([healthOnly]);
    expect(c.uncovered.map((g) => g.lane)).toContain("COMMAND");
    expect(c.note).toContain("no capable provider at all");
  });

  it("reports a lane depending on a single provider as a fact, not a fault", () => {
    const c = assessCoverage([provider()]);
    expect(c.uncovered).toEqual([]);
    expect(c.singleProvider.length).toBeGreaterThan(0);
    expect(c.note).toContain("a fact rather than a fault");
  });

  it("confirms full redundancy when two providers can carry everything", () => {
    const c = assessCoverage([provider(), provider({ providerId: "second" })]);
    expect(c.singleProvider).toEqual([]);
    expect(c.note).toContain("No single transport failure removes a lane");
  });
});
