// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  admitAiProposedDetection,
  blastRadius,
  buildObservation,
  canReach,
  chokePoints,
  correlateAcrossSources,
  graphIsComplete,
  projectGraph,
  reachableFrom,
  runBaseline,
  runDeterministicRule,
  runIocMatch,
  runRateAnomaly,
  runSequence,
  type DetectionCoverage,
  type ExposureEdge,
  type ExposureNode,
  type ObservationType,
  type RecommendedResponse,
  type SecurityObservation,
} from "../index.js";

const complete: DetectionCoverage = {
  observationsConsidered: 10,
  windowStart: "2026-08-30T10:00:00Z",
  windowEnd: "2026-08-30T11:00:00Z",
  sensorGaps: [],
  complete: true,
};
const partial: DetectionCoverage = { ...complete, sensorGaps: ["runtime sensor unbound"], complete: false };

const response: RecommendedResponse = {
  rung: "challenge",
  authorityRequired: "chartered-containment",
  rationale: "verify the session before anything heavier",
};

let counter = 0;
function obs(input: {
  type: ObservationType;
  subjectRef: string;
  at: string;
  severity?: SecurityObservation["severity"];
  confidence?: SecurityObservation["confidence"];
  attributes?: Record<string, string>;
  lossy?: boolean;
  sensorKind?: string;
  technique?: string;
}): SecurityObservation {
  counter += 1;
  const admission = buildObservation({
    observationId: `obs-${counter}`,
    observedAt: input.at,
    receivedAt: input.at,
    source: { sensorKind: input.sensorKind ?? "hive-native", provider: "hive.test", instanceRef: "instance-a" },
    subject: { kind: "identity", ref: input.subjectRef },
    observationType: input.type,
    severity: input.severity ?? "moderate",
    confidence: input.confidence ?? "confirmed",
    dataClassification: "internal",
    privacyScope: "instance-local",
    sourceAttested: false,
    adapterRef: "adapter.test@1.0.0",
    ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
    ...(input.lossy !== undefined ? { lossy: input.lossy } : {}),
    ...(input.technique !== undefined ? { attackTechniqueRef: input.technique } : {}),
  });
  if (!admission.admitted) throw new Error(`fixture rejected: ${admission.detail}`);
  return admission.observation;
}

describe("§15 deterministic rules — threshold, evidence, named authority", () => {
  const rule = {
    ruleId: "rule.repeated-authz-denial",
    matchTypes: ["authorization-denied"] as const,
    threshold: 3,
    why: "repeated authorization denial against one subject is what an authority probe looks like",
    response,
  };
  it("fires only at the threshold, and carries evidence ids not payloads", () => {
    const two = [1, 2].map((i) => obs({ type: "authorization-denied", subjectRef: "svc-1", at: `2026-08-30T10:0${i}:00Z` }));
    expect(runDeterministicRule(rule, two, "svc-1", complete)).toBeNull();
    const three = [...two, obs({ type: "authorization-denied", subjectRef: "svc-1", at: "2026-08-30T10:03:00Z" })];
    const detection = runDeterministicRule(rule, three, "svc-1", complete);
    expect(detection).not.toBeNull();
    expect(detection!.observationIds).toHaveLength(3);
    expect(detection!.recommendedResponse.authorityRequired).toBe("chartered-containment");
    expect(detection!.gateEligible).toBe(true);
  });
  it("a finding RECOMMENDS a rung and NAMES the authority — it never grants one", () => {
    const three = [1, 2, 3].map((i) => obs({ type: "authorization-denied", subjectRef: "svc-1", at: `2026-08-30T10:0${i}:00Z` }));
    const detection = runDeterministicRule(rule, three, "svc-1", complete)!;
    expect(Object.keys(detection.recommendedResponse)).toEqual(["rung", "authorityRequired", "rationale"]);
    expect(JSON.stringify(detection)).not.toMatch(/"authorized"\s*:\s*true|"granted"/);
  });
  it("coverage travels with the finding — a conclusion over a partial view says so", () => {
    const three = [1, 2, 3].map((i) => obs({ type: "authorization-denied", subjectRef: "svc-1", at: `2026-08-30T10:0${i}:00Z` }));
    const detection = runDeterministicRule(rule, three, "svc-1", partial)!;
    expect(detection.coverage.complete).toBe(false);
    expect(detection.coverage.sensorGaps).toContain("runtime sensor unbound");
  });
  it("confidence is the WEAKEST member's, never the strongest", () => {
    const mixed = [
      obs({ type: "authorization-denied", subjectRef: "svc-2", at: "2026-08-30T10:01:00Z", confidence: "confirmed" }),
      obs({ type: "authorization-denied", subjectRef: "svc-2", at: "2026-08-30T10:02:00Z", confidence: "suspected" }),
      obs({ type: "authorization-denied", subjectRef: "svc-2", at: "2026-08-30T10:03:00Z", confidence: "confirmed" }),
    ];
    expect(runDeterministicRule(rule, mixed, "svc-2", complete)!.confidence).toBe("suspected");
  });
});

describe("§15 sequence detection — order is the evidence", () => {
  const pattern = {
    patternId: "seq.foothold-to-egress",
    stages: ["authentication-failed", "privilege-escalated", "unexpected-egress"] as const,
    maxSpanSeconds: 3_600,
    why: "a failure, then an escalation, then an egress is a story rather than three coincidences",
    response,
    severityOverride: "high" as const,
  };
  const inOrder = [
    obs({ type: "authentication-failed", subjectRef: "u-1", at: "2026-08-30T10:00:00Z" }),
    obs({ type: "privilege-escalated", subjectRef: "u-1", at: "2026-08-30T10:10:00Z" }),
    obs({ type: "unexpected-egress", subjectRef: "u-1", at: "2026-08-30T10:20:00Z" }),
  ];
  it("fires when the stages occur in order within the span", () => {
    const detection = runSequence(pattern, inOrder, "u-1", complete);
    expect(detection).not.toBeNull();
    expect(detection!.severity).toBe("high");
    expect(detection!.firstObservedAt).toBe("2026-08-30T10:00:00Z");
    expect(detection!.lastObservedAt).toBe("2026-08-30T10:20:00Z");
  });
  it("does NOT fire on the same set out of order — order-insensitive matching is a noise generator", () => {
    const reversed = [
      obs({ type: "unexpected-egress", subjectRef: "u-2", at: "2026-08-30T10:00:00Z" }),
      obs({ type: "privilege-escalated", subjectRef: "u-2", at: "2026-08-30T10:10:00Z" }),
      obs({ type: "authentication-failed", subjectRef: "u-2", at: "2026-08-30T10:20:00Z" }),
    ];
    expect(runSequence(pattern, reversed, "u-2", complete)).toBeNull();
  });
  it("does not fire beyond the declared span", () => {
    const slow = [
      obs({ type: "authentication-failed", subjectRef: "u-3", at: "2026-08-30T10:00:00Z" }),
      obs({ type: "privilege-escalated", subjectRef: "u-3", at: "2026-08-30T10:10:00Z" }),
      obs({ type: "unexpected-egress", subjectRef: "u-3", at: "2026-08-30T14:00:00Z" }),
    ];
    expect(runSequence(pattern, slow, "u-3", complete)).toBeNull();
  });
  it("collects ATT&CK references from the matched observations", () => {
    const tagged = [
      obs({ type: "authentication-failed", subjectRef: "u-4", at: "2026-08-30T10:00:00Z", technique: "T1110" }),
      obs({ type: "privilege-escalated", subjectRef: "u-4", at: "2026-08-30T10:05:00Z", technique: "T1068" }),
      obs({ type: "unexpected-egress", subjectRef: "u-4", at: "2026-08-30T10:09:00Z", technique: "T1041" }),
    ];
    expect(runSequence(pattern, tagged, "u-4", complete)!.attackTechniqueRefs).toEqual(["T1041", "T1068", "T1110"]);
  });
});

describe("§15 IOC matching — exact only", () => {
  const set = {
    setId: "ioc.known-bad-binaries",
    version: "2026.08",
    indicators: { binaryDigest: ["deadbeef"] },
    why: "binary digest on the known-bad list",
    response,
  };
  it("matches exactly and groups by subject", () => {
    const hits = runIocMatch(
      set,
      [
        obs({ type: "unexpected-binary-observed", subjectRef: "host-1", at: "2026-08-30T10:00:00Z", attributes: { binaryDigest: "deadbeef" } }),
        obs({ type: "unexpected-binary-observed", subjectRef: "host-2", at: "2026-08-30T10:00:00Z", attributes: { binaryDigest: "cafe" } }),
      ],
      complete,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.subjectRef).toBe("host-1");
  });
  it("does NOT match a near value — a wrong IOC hit quarantines a legitimate workload", () => {
    const hits = runIocMatch(
      set,
      [obs({ type: "unexpected-binary-observed", subjectRef: "host-3", at: "2026-08-30T10:00:00Z", attributes: { binaryDigest: "deadbeef00" } })],
      complete,
    );
    expect(hits).toHaveLength(0);
  });
});

describe("§15 behavioural baseline — below minimum is INDETERMINATE, never normal", () => {
  const baseline = {
    baselineId: "base.egress",
    subjectRef: "svc-9",
    observationType: "unexpected-egress" as const,
    historicalCounts: [2, 3, 2, 3, 2],
    windowRef: "1h",
    minimumWindows: 5,
    deviationMultipleTimes100: 300,
  };
  it("a deviation fires with confidence capped at probable — oddness is not intent", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      obs({ type: "unexpected-egress", subjectRef: "svc-9", at: `2026-08-30T10:${String(i).padStart(2, "0")}:00Z` }),
    );
    const verdict = runBaseline(baseline, many, complete, response);
    expect(verdict.state).toBe("deviation");
    if (verdict.state !== "deviation") return;
    expect(verdict.detection.confidence).toBe("probable");
    expect(verdict.detection.method).toBe("behavioural-baseline");
  });
  it("too little history is indeterminate, not within-baseline", () => {
    const verdict = runBaseline({ ...baseline, historicalCounts: [2, 3] }, [], complete, response);
    expect(verdict.state).toBe("indeterminate");
    if (verdict.state === "indeterminate") expect(verdict.reason).toContain("not a score");
  });
  it("GATE: an incomplete view cannot support a within-baseline verdict — an observed count over a partial view understates", () => {
    const verdict = runBaseline(baseline, [], partial, response);
    expect(verdict.state).toBe("indeterminate");
    if (verdict.state === "indeterminate") expect(verdict.reason).toContain("understates");
  });
  it("a normal count over a complete view is within-baseline", () => {
    const few = [obs({ type: "unexpected-egress", subjectRef: "svc-9", at: "2026-08-30T10:00:00Z" })];
    expect(runBaseline(baseline, few, complete, response).state).toBe("within-baseline");
  });
});

describe("§15 rate anomaly and correlation", () => {
  it("rate anomaly fires per subject at the declared threshold", () => {
    const observations = [
      ...Array.from({ length: 5 }, (_, i) => obs({ type: "governance-decision-refused", subjectRef: "agent-a", at: `2026-08-30T10:0${i}:00Z` })),
      obs({ type: "governance-decision-refused", subjectRef: "agent-b", at: "2026-08-30T10:00:00Z" }),
    ];
    const detections = runRateAnomaly(observations, "governance-decision-refused", 5, complete, response);
    expect(detections).toHaveLength(1);
    expect(detections[0]!.subjectRef).toBe("agent-a");
    expect(detections[0]!.confidence).toBe("probable");
  });
  it("correlation across distinct methods raises to probable and never to confirmed", () => {
    const three = [1, 2, 3].map((i) => obs({ type: "authorization-denied", subjectRef: "svc-x", at: `2026-08-30T10:0${i}:00Z` }));
    const ruleHit = runDeterministicRule(
      { ruleId: "r", matchTypes: ["authorization-denied"], threshold: 3, why: "w", response },
      three,
      "svc-x",
      complete,
    )!;
    const rateHit = runRateAnomaly(three, "authorization-denied", 3, complete, response)[0]!;
    const correlated = correlateAcrossSources([ruleHit, rateHit], 2);
    expect(correlated).toHaveLength(1);
    expect(correlated[0]!.correlatedConfidence).toBe("probable");
    expect(correlated[0]!.methods).toEqual(["deterministic-rule", "rate-anomaly"]);
    // One method alone does not correlate.
    expect(correlateAcrossSources([ruleHit], 2)).toHaveLength(0);
  });
});

describe("§15/§28 the AI boundary — assists, never gates", () => {
  it("GATE: an AI-proposed detection is never gate-eligible, even over deterministic observations", () => {
    const deterministic = [1, 2, 3].map((i) => obs({ type: "authorization-denied", subjectRef: "svc-ai", at: `2026-08-30T10:0${i}:00Z` }));
    const detection = admitAiProposedDetection({
      detectionId: "ai-1",
      subjectRef: "svc-ai",
      subjectKind: "identity",
      why: "the model believes this pattern resembles credential stuffing",
      modelRef: "model-x",
      supportingObservations: deterministic,
      coverage: complete,
      response,
    });
    expect(detection.gateEligible).toBe(false); // the INFERENCE is the model's
    expect(detection.confidence).toBe("suspected");
    expect(detection.aiAssist?.modelRef).toBe("model-x");
  });
  it("an observation from an AI sensor carries no deterministic weight", () => {
    const aiSourced = [1, 2, 3].map((i) =>
      obs({ type: "agent-behavior-drift", subjectRef: "agent-z", at: `2026-08-30T10:0${i}:00Z`, sensorKind: "ai-activity" }),
    );
    const detection = runDeterministicRule(
      { ruleId: "r2", matchTypes: ["agent-behavior-drift"], threshold: 3, why: "w", response },
      aiSourced,
      "agent-z",
      complete,
    )!;
    expect(detection.gateEligible).toBe(false);
  });
  it("a lossy (guessed) normalization cannot carry a gate either", () => {
    const guessed = [1, 2, 3].map((i) =>
      obs({ type: "authorization-denied", subjectRef: "svc-l", at: `2026-08-30T10:0${i}:00Z`, lossy: true }),
    );
    const detection = runDeterministicRule(
      { ruleId: "r3", matchTypes: ["authorization-denied"], threshold: 3, why: "w", response },
      guessed,
      "svc-l",
      complete,
    )!;
    expect(detection.gateEligible).toBe(false);
  });
});

// ─── §16 exposure graph ─────────────────────────────────────────────────────

const node = (ref: string, kind: ExposureNode["kind"]): ExposureNode => ({ ref, kind, projectedFrom: "fabric-topology" });
const edge = (from: string, to: string, kind: ExposureEdge["kind"]): ExposureEdge => ({
  from,
  to,
  kind,
  projectedFrom: "fabric-topology",
});

describe("§16 exposure graph — reachability is a LOWER BOUND", () => {
  const nodes = [
    node("svc-a", "workload"),
    node("svc-b", "workload"),
    node("store-1", "data-store"),
    node("admin-1", "identity"),
  ];
  const edges = [edge("svc-a", "svc-b", "can-call"), edge("svc-b", "store-1", "can-reach"), edge("svc-b", "admin-1", "can-administer")];

  it("a complete graph yields an exact set and says so", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], [], "2026-08-30T10:00:00Z");
    expect(graphIsComplete(graph)).toBe(true);
    const reach = reachableFrom(graph, "svc-a");
    expect(reach.atLeastReachable.map((p) => p.to)).toEqual(["admin-1", "store-1", "svc-b"]);
    expect(reach.boundIsTight).toBe(true);
    expect(reach.statement).toContain("this set is exact");
  });
  it("GATE: an incomplete graph yields AT LEAST, and the statement forbids reading it as a ceiling", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], ["identity-provider", "cloud-inventory"], "2026-08-30T10:00:00Z");
    const reach = reachableFrom(graph, "svc-a");
    expect(reach.boundIsTight).toBe(false);
    expect(reach.statement).toContain("AT LEAST");
    expect(reach.statement).toContain("may not be read as a blast-radius ceiling");
    expect(reach.unprojectedSources).toEqual(["cloud-inventory", "identity-provider"]);
  });
  it("GATE: canReach answers reachable or no-path-witnessed — NEVER unreachable", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], ["identity-provider"], "2026-08-30T10:00:00Z");
    const hit = canReach(graph, "svc-a", "store-1");
    expect(hit.verdict).toBe("reachable");
    if (hit.verdict === "reachable") expect(hit.path.hops).toHaveLength(2);
    const miss = canReach(graph, "store-1", "svc-a");
    expect(miss.verdict).toBe("no-path-witnessed");
    if (miss.verdict === "no-path-witnessed") {
      expect(miss.graphComplete).toBe(false);
      expect(miss.qualification).toContain("not a finding of unreachability");
    }
    // The vocabulary contains no "unreachable" verdict at all.
    expect(JSON.stringify(miss)).not.toMatch(/"unreachable"/);
  });
  it("a witnessed path carries its actual hops, so the claim is checkable", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], [], "2026-08-30T10:00:00Z");
    const verdict = canReach(graph, "svc-a", "admin-1");
    if (verdict.verdict !== "reachable") return;
    expect(verdict.path.hops.map((h) => h.kind)).toEqual(["can-call", "can-administer"]);
  });
  it("traversal can be restricted to declared edge kinds and hop budgets", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], [], "2026-08-30T10:00:00Z");
    expect(reachableFrom(graph, "svc-a", { traverseKinds: ["can-call"] }).atLeastReachable.map((p) => p.to)).toEqual(["svc-b"]);
    expect(reachableFrom(graph, "svc-a", { maxHops: 1 }).atLeastReachable.map((p) => p.to)).toEqual(["svc-b"]);
  });
});

describe("§16 blast radius and choke points", () => {
  const nodes = [node("svc-a", "workload"), node("svc-b", "workload"), node("store-1", "data-store"), node("op-1", "operator")];
  const edges = [
    edge("svc-a", "svc-b", "can-call"),
    edge("svc-b", "store-1", "can-reach"),
    edge("svc-b", "op-1", "can-administer"),
  ];
  it("blast radius counts by kind and surfaces administrable and identity targets", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], [], "2026-08-30T10:00:00Z");
    const radius = blastRadius(graph, "svc-a");
    expect(radius.atLeastTotal).toBe(3);
    expect(radius.atLeastByKind["data-store"]).toBe(1);
    expect(radius.administrableTargets).toEqual(["op-1"]);
    expect(radius.reachableIdentities).toEqual(["op-1"]);
    expect(radius.boundIsTight).toBe(true);
  });
  it("over an incomplete graph the radius is explicitly a lower bound", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], ["cloud-inventory"], "2026-08-30T10:00:00Z");
    const radius = blastRadius(graph, "svc-a");
    expect(radius.boundIsTight).toBe(false);
    expect(radius.statement).toContain("AT LEAST");
  });
  it("choke points are MEASURED by re-running the closure, and marked provisional on an incomplete graph", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes, edges }], ["cloud-inventory"], "2026-08-30T10:00:00Z");
    const points = chokePoints(graph, "svc-a", ["svc-b", "store-1"]);
    expect(points[0]!.nodeRef).toBe("svc-b"); // removing it removes everything downstream
    expect(points[0]!.removesAtLeast).toBe(3);
    expect(points[0]!.provisional).toBe(true);
  });
  it("a dangling edge endpoint becomes a placeholder node — dropping it would HIDE reachability", () => {
    const graph = projectGraph(
      [{ sourceRef: "fabric", nodes: [node("svc-a", "workload")], edges: [edge("svc-a", "unknown-target", "can-reach")] }],
      [],
      "2026-08-30T10:00:00Z",
    );
    expect(graph.nodes.map((n) => n.ref)).toContain("unknown-target");
    expect(reachableFrom(graph, "svc-a").atLeastReachable.map((p) => p.to)).toEqual(["unknown-target"]);
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("guards — detection and exposure", () => {
  const dir = join(process.cwd(), "packages", "sentineliq", "src", "v2");
  const files = ["detection.ts", "exposure.ts"].map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  it("no clock reads, no randomness, no network", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|fetch\(/.test(f.text), f.name).toBe(false);
    }
  });
  it("gateEligible is COMPUTED, never accepted as an input", () => {
    const detection = files.find((f) => f.name === "detection.ts")!;
    expect(/gateEligible\?:|gateEligible:\s*boolean;?\s*\n\s*\}\s*\)/.test(detection.text)).toBe(false);
    expect(/gateEligible: deterministicEvidence\(/.test(detection.text)).toBe(true);
  });
  it("the exposure module publishes no 'unreachable' verdict and no upper-bound vocabulary", () => {
    const exposure = files.find((f) => f.name === "exposure.ts")!;
    expect(/"unreachable"|atMostReachable|upperBound/.test(exposure.text)).toBe(false);
  });
});
