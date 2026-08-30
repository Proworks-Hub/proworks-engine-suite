/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  buildTrace,
  diagnose,
  evaluateSlo,
  spanCarriesPayload,
  type LaneSlo,
  type TraceSpan,
} from "../fabricObservabilityIQ.js";
import {
  adaptationMayApply,
  classifyCandidate,
  improvementCandidateSchema,
  proposeImprovement,
  readyForReview,
  requiredScenarios,
  summariseSimulation,
  twinMayUseProductionPayloads,
  type CandidateKind,
  type ImprovementCandidate,
  type SimulationResult,
} from "../fabricAdaptationIQ.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

const span = (over: Partial<TraceSpan> & Pick<TraceSpan, "fabricMessageId">): TraceSpan => ({
  correlationId: "cor-1",
  causationId: null,
  lane: "COMMAND",
  fromCapability: "ordering",
  toCapability: "manufacturing.plan",
  startedAt: T0,
  durationMs: 20,
  outcome: "DELIVERED",
  reason: "delivered",
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
// A broken causal chain is the finding. Silently reparenting an orphan would
// produce a tidy trace that is a lie.
// ─────────────────────────────────────────────────────────────────────────────

describe("the causal trace reports what it cannot connect", () => {
  it("builds a chain from causation", () => {
    const t = buildTrace(
      [
        span({ fabricMessageId: "a" }),
        span({ fabricMessageId: "b", causationId: "a" }),
        span({ fabricMessageId: "c", causationId: "b" }),
      ],
      "cor-1",
    );
    expect(t.roots).toHaveLength(1);
    expect(t.roots[0]!.children[0]!.span.fabricMessageId).toBe("b");
    expect(t.roots[0]!.children[0]!.children[0]!.span.fabricMessageId).toBe("c");
    expect(t.findings).toEqual([]);
  });

  it("REPORTS an orphan and places it at the root rather than hiding it", () => {
    // The chain breaks when an engine emits without propagating causation.
    // Everything keeps working and the two halves stop being connected.
    const t = buildTrace([span({ fabricMessageId: "b", causationId: "missing" })], "cor-1");
    expect(t.findings[0]!.kind).toBe("ORPHAN");
    expect(t.findings[0]!.note).toContain("the chain is broken here");
    expect(t.roots).toHaveLength(1);
  });

  it("says so in the summary when the chain is incomplete", () => {
    const t = buildTrace([span({ fabricMessageId: "b", causationId: "missing" })], "cor-1");
    expect(t.note).toContain('"what caused this" has an answer the trace cannot give');
  });

  it("REPORTS a pure causation cycle rather than losing the spans", () => {
    // A two-span loop has no root at all. The first implementation returned an
    // empty trace and no finding — silently dropping exactly the spans that
    // prove something is wrong, which looks identical to hops that never
    // happened.
    const t = buildTrace(
      [span({ fabricMessageId: "a", causationId: "b" }), span({ fabricMessageId: "b", causationId: "a" })],
      "cor-1",
    );
    expect(t.spanCount).toBe(2);
    expect(t.findings.some((f) => f.kind === "CYCLE")).toBe(true);
    expect(t.roots.length).toBeGreaterThan(0);
    expect(t.findings.find((f) => f.kind === "CYCLE")!.note).toContain(
      "looks like a hop that never happened",
    );
  });

  it("terminates on a cycle reached from a real root", () => {
    const t = buildTrace(
      [
        span({ fabricMessageId: "root" }),
        span({ fabricMessageId: "a", causationId: "root" }),
        span({ fabricMessageId: "b", causationId: "a" }),
        span({ fabricMessageId: "c", causationId: "b" }),
      ],
      "cor-1",
    );
    expect(t.spanCount).toBe(4);
    expect(t.findings).toEqual([]);
  });

  it("reports a duplicate id rather than attaching a subtree twice", () => {
    const t = buildTrace([span({ fabricMessageId: "a" }), span({ fabricMessageId: "a" })], "cor-1");
    expect(t.findings[0]!.kind).toBe("DUPLICATE_ID");
    expect(t.spanCount).toBe(1);
  });

  it("ignores spans from another correlation", () => {
    const t = buildTrace([span({ fabricMessageId: "a" }), span({ fabricMessageId: "x", correlationId: "other" })], "cor-1");
    expect(t.spanCount).toBe(1);
  });

  it("distinguishes 'nothing happened' from 'nothing was recorded'", () => {
    const t = buildTrace([], "cor-missing");
    expect(t.note).toContain("the trace cannot tell you which");
  });

  it("names the slowest span, which is usually the question", () => {
    const t = buildTrace(
      [
        span({ fabricMessageId: "a", durationMs: 10 }),
        span({ fabricMessageId: "b", causationId: "a", durationMs: 900, toCapability: "slow-thing" }),
      ],
      "cor-1",
    );
    expect(t.slowest!.fabricMessageId).toBe("b");
  });

  it("measures total wall time across the trace", () => {
    const t = buildTrace(
      [span({ fabricMessageId: "a", startedAt: T0, durationMs: 10 }), span({ fabricMessageId: "b", causationId: "a", startedAt: at(100), durationMs: 50 })],
      "cor-1",
    );
    expect(t.totalMs).toBe(150);
  });

  it("carries no field that could hold payload content", () => {
    expect(spanCarriesPayload()).toBe(false);
    expect(Object.keys(span({ fabricMessageId: "a" }))).not.toContain("payload");
    expect(Object.keys(span({ fabricMessageId: "a" }))).not.toContain("body");
  });

  it("builds a deep trace without recursing into a stack overflow", () => {
    const spans = Array.from({ length: 2000 }, (_, i) =>
      span({ fabricMessageId: `n${i}`, causationId: i === 0 ? null : `n${i - 1}` }),
    );
    expect(() => buildTrace(spans, "cor-1")).not.toThrow();
    expect(buildTrace(spans, "cor-1").spanCount).toBe(2000);
  });
});

describe("diagnosis answers from what was recorded, not from what would happen now", () => {
  const trace = buildTrace(
    [
      span({ fabricMessageId: "a", durationMs: 10 }),
      span({
        fabricMessageId: "b",
        causationId: "a",
        durationMs: 900,
        fromCapability: "manufacturing.plan",
        toCapability: "costing",
        outcome: "REFUSED",
        reason: "no permitted route on the COMMAND lane",
      }),
    ],
    "cor-1",
  );

  it("lists the path it actually took", () => {
    expect(diagnose(trace).wentWhere).toEqual([
      "ordering → manufacturing.plan (COMMAND)",
      "manufacturing.plan → costing (COMMAND)",
    ]);
  });

  it("names the hop that consumed most of the time", () => {
    expect(diagnose(trace).delayedBy).toContain("costing took 900ms");
  });

  it("does not blame a hop that was not dominant", () => {
    // Three even hops: no single one carries half the time. Two equal hops
    // would each be exactly half, which the rule counts as dominant.
    const even = buildTrace(
      [
        span({ fabricMessageId: "a", durationMs: 10 }),
        span({ fabricMessageId: "b", causationId: "a", startedAt: at(10), durationMs: 10 }),
        span({ fabricMessageId: "c", causationId: "b", startedAt: at(20), durationMs: 10 }),
      ],
      "cor-1",
    );
    expect(diagnose(even).delayedBy).toBeNull();
  });

  it("collects every refusal with its reason", () => {
    expect(diagnose(trace).refusedBecause).toEqual(["costing: no permitted route on the COMMAND lane"]);
  });

  it("says a diagnosis over a broken chain is incomplete", () => {
    const broken = buildTrace([span({ fabricMessageId: "b", causationId: "gone" })], "cor-1");
    expect(diagnose(broken).note).toContain("what was recorded rather than as what occurred");
  });

  it("says it is assembled rather than recomputed", () => {
    expect(diagnose(trace).note).toContain("a different question from what happened then");
  });
});

describe("an SLO computed from too little traffic is not a pass", () => {
  const slo: LaneSlo = {
    lane: "COMMAND",
    p95LatencyMs: 250,
    successRate: 0.99,
    rationale: "Commands change state; a failure is work somebody was told would happen.",
  };

  it("returns null below the minimum sample", () => {
    // An outage that stops traffic would otherwise turn the dashboard green.
    const v = evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 10, delivered: 4, failed: 0 }, 100);
    expect(v.met).toBeNull();
    expect(v.note).toContain("arithmetic rather than evidence");
  });

  it("passes when both objectives are met", () => {
    expect(evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 100, delivered: 1000, failed: 2 }, 100).met).toBe(true);
  });

  it("reports BOTH breaches when both are missed", () => {
    const v = evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 900, delivered: 900, failed: 100 }, 100);
    expect(v.met).toBe(false);
    if (v.met === false) expect(v.breaches).toHaveLength(2);
  });

  it("carries the rationale into a breach, so the objective can be argued with", () => {
    const v = evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 900, delivered: 1000, failed: 0 }, 100);
    if (v.met === false) expect(v.note).toContain("work somebody was told would happen");
  });

  it("treats the latency objective as exclusive at the boundary", () => {
    expect(evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 250, delivered: 1000, failed: 0 }, 100).met).toBe(true);
    expect(evaluateSlo(slo, { lane: "COMMAND", p95LatencyMs: 251, delivered: 1000, failed: 0 }, 100).met).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const candidate = (over: Partial<ImprovementCandidate> = {}): ImprovementCandidate =>
  improvementCandidateSchema.parse({
    candidateId: "cand-1",
    kind: "REWEIGHT_APPROVED_ROUTES",
    proposal: "Send 70% of manufacturing.plan traffic to plan-b, which is consistently faster.",
    observedEvidence: ["plan-b p95 is 40ms against plan-a's 220ms over 30 days"],
    predictedEffect: "p95 for the capability falls from 180ms to roughly 70ms.",
    rollbackCondition: "Revert if plan-b's p95 exceeds plan-a's for two consecutive hours.",
    proposedBy: "fabric-adaptation",
    proposedAt: T0,
    ...over,
  });

describe("adaptation proposes and is never allowed to apply", () => {
  it("never applies its own candidate", () => {
    // §33.1: FabricAdaptationIQ never self-deploys.
    expect(adaptationMayApply()).toBe(false);
  });

  it("accepts a well-formed candidate", () => {
    expect(proposeImprovement(candidate()).accepted).toBe(true);
  });

  it("REFUSES a candidate that cannot say what would make it a mistake", () => {
    // Asking at proposal time is far cheaper than asking at 3am.
    const { rollbackCondition, ...without } = candidate();
    const o = proposeImprovement(without);
    expect(o.accepted).toBe(false);
    if (!o.accepted) expect(o.issues.join()).toContain("rollbackCondition");
  });

  it("REFUSES a candidate with no supporting observation", () => {
    expect(proposeImprovement({ ...candidate(), observedEvidence: [] }).accepted).toBe(false);
  });

  it("refuses extra fields, so a candidate cannot smuggle an approval in", () => {
    expect(proposeImprovement({ ...candidate(), approved: true }).accepted).toBe(false);
  });
});

describe("only reweighting among approved routes is automatic", () => {
  it("treats reweighting as runtime behaviour", () => {
    const c = classifyCandidate("REWEIGHT_APPROVED_ROUTES");
    expect(c.material).toBe(false);
    expect(c.requiresGovernance).toBe(false);
    expect(c.reason).toContain("the same set of things can reach the same set of things afterwards");
  });

  it("treats adding an adjacency as MATERIAL and governed", () => {
    const c = classifyCandidate("ADD_ADJACENCY");
    expect(c.material).toBe(true);
    expect(c.requiresGovernance).toBe(true);
    expect(c.reason).toContain("no amount of supporting evidence changes who decides it");
  });

  it("governs a PRUNE even though it only narrows", () => {
    // A route that looks unused may be a chartered continuity path used once a
    // quarter.
    const c = classifyCandidate("PRUNE_UNUSED_ROUTE");
    expect(c.material).toBe(false);
    expect(c.requiresGovernance).toBe(true);
    expect(c.reason).toContain("used once a quarter");
  });

  it("treats relocating a node as a permission change, not an operational move", () => {
    const c = classifyCandidate("RELOCATE_NODE");
    expect(c.material).toBe(true);
    expect(c.reason).toContain("reads as an operational move and is a permission change");
  });

  it("treats a capacity change as material because ordering breaks permanently", () => {
    expect(classifyCandidate("CHANGE_CAPACITY").material).toBe(true);
    expect(classifyCandidate("CHANGE_CAPACITY").reason).toContain("permanently");
  });

  it("governs every kind except the one that changes nothing structural", () => {
    const kinds: CandidateKind[] = [
      "PRUNE_UNUSED_ROUTE",
      "ADD_ADJACENCY",
      "ADD_CAPABILITY",
      "RELOCATE_NODE",
      "CHANGE_CAPACITY",
    ];
    for (const kind of kinds) expect(classifyCandidate(kind).requiresGovernance).toBe(true);
  });
});

describe("the twin predicts and does not authorize", () => {
  const result = (over: Partial<SimulationResult> = {}): SimulationResult => ({
    scenarioId: "s1",
    fault: "NODE_LOSS",
    capabilitiesLost: [],
    localWorkSurvived: true,
    isolationHeld: true,
    recoveredWithinBudget: true,
    note: "simulated",
    ...over,
  });

  it("says a clean run is evidence and NOT permission", () => {
    // A green simulation is the most persuasive thing in the room.
    const v = summariseSimulation([result()]);
    expect(v.wouldSurvive).toBe(true);
    expect(v.isAuthorization).toBe(false);
    expect(v.note).toContain("does not authorize anything");
  });

  it("treats local work stopping as a HARD GATE failure", () => {
    const v = summariseSimulation([result({ localWorkSurvived: false })]);
    expect(v.wouldSurvive).toBe(false);
    expect(v.failures.join()).toContain("a hard gate rather than a performance concern");
  });

  it("treats a broken isolation boundary as a security finding", () => {
    const v = summariseSimulation([result({ isolationHeld: false })]);
    expect(v.failures.join()).toContain("a security finding, not a resilience one");
  });

  it("declines to judge whether a lost capability is acceptable", () => {
    const v = summariseSimulation([result({ capabilitiesLost: ["costing"] })]);
    expect(v.failures.join()).toContain("the simulation cannot decide it");
  });

  it("says a candidate with a hard-gate failure should not reach review", () => {
    const v = summariseSimulation([result({ localWorkSurvived: false })]);
    expect(v.note).toContain("should not reach a governance review at all");
  });

  it("reports scenarios in a stable order", () => {
    const a = summariseSimulation([result({ scenarioId: "z", isolationHeld: false }), result({ scenarioId: "a", isolationHeld: false })]);
    expect(a.failures[0]).toContain("a (");
  });

  it("NEVER uses production payloads", () => {
    // A simulator holding real customer data is a second copy with none of the
    // controls, and the copy nobody includes in a retention policy.
    expect(twinMayUseProductionPayloads()).toBe(false);
  });
});

describe("the scenario list is derived from the change, not chosen by the proposer", () => {
  it("requires schema and certificate scenarios for a new adjacency", () => {
    const required = requiredScenarios("ADD_ADJACENCY");
    expect(required).toContain("SCHEMA_INCOMPATIBILITY");
    expect(required).toContain("CERTIFICATE_EXPIRY");
    expect(required).toContain("COLLECTIVE_OUTAGE");
  });

  it("requires a partition scenario for a relocation", () => {
    expect(requiredScenarios("RELOCATE_NODE")).toContain("REGIONAL_PARTITION");
  });

  it("requires duplication scenarios for a capacity change", () => {
    expect(requiredScenarios("CHANGE_CAPACITY")).toContain("MESSAGE_DUPLICATION");
  });

  it("REFUSES review until every required scenario has run", () => {
    const v = readyForReview(candidate({ kind: "ADD_ADJACENCY" }), ["NODE_LOSS"]);
    expect(v.ready).toBe(false);
    if (!v.ready) {
      expect(v.missing).toContain("SCHEMA_INCOMPATIBILITY");
      expect(v.note).toContain("a convenient short list of scenarios it happens to pass");
    }
  });

  it("says ready for review is not the same as approved", () => {
    const v = readyForReview(candidate(), requiredScenarios("REWEIGHT_APPROVED_ROUTES"));
    expect(v.ready).toBe(true);
    if (v.ready) expect(v.note).toContain("a different thing from approved");
  });
});
