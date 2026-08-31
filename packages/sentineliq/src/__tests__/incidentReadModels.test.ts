// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  SOC_VIEWS,
  activeIncidents,
  addDetection,
  aiSecurity,
  attackSurface,
  correlateDetections,
  coverageView,
  downgradeSeverity,
  maxRequestableRung,
  openIncident,
  projectGraph,
  recoveryReadiness,
  securityOverview,
  threatActivity,
  transitionIncident,
  type CollectionResult,
  type SensorCoverage,
  type ThreatDetection,
} from "../index.js";

function detection(overrides: Partial<ThreatDetection> & { detectionId: string; subjectRef: string }): ThreatDetection {
  return {
    method: "deterministic-rule",
    observationTypes: ["authorization-denied"],
    subjectKind: "identity",
    firstObservedAt: "2026-08-30T10:00:00Z",
    lastObservedAt: "2026-08-30T10:05:00Z",
    observationIds: ["obs-1"],
    confidence: "confirmed",
    severity: "moderate",
    why: "test",
    attackTechniqueRefs: [],
    recommendedResponse: { rung: "challenge", authorityRequired: "chartered-containment", rationale: "r" },
    coverage: { observationsConsidered: 1, windowStart: "a", windowEnd: "b", sensorGaps: [], complete: true },
    gateEligible: true,
    aiAssist: null,
    ...overrides,
  };
}

describe("§20 correlation — witnessed relationships only, never time proximity", () => {
  it("same subject joins", () => {
    const result = correlateDetections([
      { detection: detection({ detectionId: "d1", subjectRef: "svc-a" }) },
      { detection: detection({ detectionId: "d2", subjectRef: "svc-a" }) },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.members.map((m) => m.detectionId)).toEqual(["d1", "d2"]);
    expect(result.groups[0]!.bases[0]!.kind).toBe("same-subject");
  });
  it("a shared correlation id joins across different subjects", () => {
    const result = correlateDetections([
      { detection: detection({ detectionId: "d1", subjectRef: "svc-a" }), correlationId: "chain-7" },
      { detection: detection({ detectionId: "d2", subjectRef: "svc-b" }), correlationId: "chain-7" },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.bases.some((b) => b.kind === "shared-correlation-id")).toBe(true);
  });
  it("graph reachability joins — the exposure graph is what makes a lateral chain one incident", () => {
    const result = correlateDetections([
      { detection: detection({ detectionId: "d1", subjectRef: "svc-a" }), reachableSubjectRefs: ["svc-b"] },
      { detection: detection({ detectionId: "d2", subjectRef: "svc-b" }) },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.bases.some((b) => b.kind === "graph-reachable")).toBe(true);
  });
  it("GATE: two unrelated detections at the same moment do NOT join — time is not a link", () => {
    const sameInstant = { firstObservedAt: "2026-08-30T10:00:00Z", lastObservedAt: "2026-08-30T10:00:00Z" };
    const result = correlateDetections([
      { detection: detection({ detectionId: "d1", subjectRef: "svc-a", ...sameInstant }) },
      { detection: detection({ detectionId: "d2", subjectRef: "svc-z", ...sameInstant }) },
    ]);
    expect(result.groups).toHaveLength(0);
    expect(result.unlinked.map((d) => d.detectionId)).toEqual(["d1", "d2"]);
  });
  it("an unlinked detection stays its own — never merged into the nearest group", () => {
    const result = correlateDetections([
      { detection: detection({ detectionId: "d1", subjectRef: "svc-a" }) },
      { detection: detection({ detectionId: "d2", subjectRef: "svc-a" }) },
      { detection: detection({ detectionId: "d9", subjectRef: "lonely" }) },
    ]);
    expect(result.groups).toHaveLength(1);
    expect(result.unlinked.map((d) => d.detectionId)).toEqual(["d9"]);
  });
});

describe("§20 incidents — severity rises, confidence is the weakest, closing is earned", () => {
  const opened = () =>
    openIncident({
      incidentId: "inc-1",
      detections: [
        detection({ detectionId: "d1", subjectRef: "svc-a", severity: "moderate", confidence: "confirmed" }),
        detection({ detectionId: "d2", subjectRef: "svc-a", severity: "high", confidence: "probable" }),
      ],
      openedAt: "2026-08-30T10:00:00Z",
    });
  it("opens at the WORST severity and the WEAKEST confidence", () => {
    const incident = opened();
    expect(incident.severity).toBe("high");
    expect(incident.confidence).toBe("probable");
    expect(incident.deterministicallySupported).toBe(true);
    expect(incident.status).toBe("open");
  });
  it("adding evidence can only RAISE severity", () => {
    const raised = addDetection(opened(), detection({ detectionId: "d3", subjectRef: "svc-a", severity: "catastrophic" }), "2026-08-30T10:10:00Z");
    expect(raised.severity).toBe("catastrophic");
    const notLowered = addDetection(raised, detection({ detectionId: "d4", subjectRef: "svc-a", severity: "low" }), "2026-08-30T10:20:00Z");
    expect(notLowered.severity).toBe("catastrophic"); // never falls on its own
  });
  it("GATE: lowering severity needs a named human AND a reason — no automatic de-escalation", () => {
    const incident = opened();
    const noHuman = downgradeSeverity(incident, "low", { decidedBy: "sentinel.auto", decision: "downgrade", reason: "looks fine", at: "t" });
    expect(noHuman.ok).toBe(false);
    const noReason = downgradeSeverity(incident, "low", { decidedBy: "human.steven", decision: "downgrade", reason: "  ", at: "t" });
    expect(noReason.ok).toBe(false);
    const proper = downgradeSeverity(incident, "low", { decidedBy: "human.steven", decision: "downgrade", reason: "known maintenance window", at: "t" });
    expect(proper.ok).toBe(true);
    if (proper.ok) expect(proper.incident.humanDecisions).toHaveLength(1);
  });
  it("status moves forward only, and Shield cannot verify itself", () => {
    const incident = opened();
    expect(transitionIncident(incident, "contained", "t").ok).toBe(false); // skips verified
    expect(transitionIncident(incident, "verified", "t", { verifiedByChamber: "shield" }).ok).toBe(false);
    const verified = transitionIncident(incident, "verified", "t", { verifiedByChamber: "guard" });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(transitionIncident(verified.incident, "open", "t").ok).toBe(false); // no going back
  });
  it("GATE: closing requires recovery evidence AND the authority review", () => {
    let incident = opened();
    for (const [to, opts] of [
      ["verified", { verifiedByChamber: "guard" as const }],
      ["contained", {}],
      ["recovering", {}],
    ] as const) {
      const step = transitionIncident(incident, to, "t", opts);
      if (!step.ok) throw new Error(step.reason);
      incident = step.incident;
    }
    const noEvidence = transitionIncident(incident, "closed", "t", { authorityReviewCompleted: true });
    expect(noEvidence.ok).toBe(false);
    const noReview = transitionIncident(incident, "closed", "t", { recoveryEvidenceRefs: ["audit://recovery/1"] });
    expect(noReview.ok).toBe(false);
    if (!noReview.ok) expect(noReview.reason).toContain("silently expanded Sentinel authority");
    const proper = transitionIncident(incident, "closed", "t", {
      recoveryEvidenceRefs: ["audit://recovery/1"],
      authorityReviewCompleted: true,
    });
    expect(proper.ok).toBe(true);
  });
  it("a false positive is declared by a human — Sentinel does not clear its own findings", () => {
    const incident = opened();
    expect(transitionIncident(incident, "closed-false-positive", "t").ok).toBe(false);
    const declared = transitionIncident(incident, "closed-false-positive", "t", {
      humanDecision: { decidedBy: "human.steven", decision: "false-positive", reason: "planned pen test", at: "t" },
    });
    expect(declared.ok).toBe(true);
  });
  it("GATE: an incident with no deterministic support cannot request past challenge", () => {
    const aiOnly = openIncident({
      incidentId: "inc-ai",
      detections: [detection({ detectionId: "d1", subjectRef: "svc-a", gateEligible: false, severity: "catastrophic", confidence: "confirmed" })],
      openedAt: "t",
    });
    expect(aiOnly.deterministicallySupported).toBe(false);
    expect(maxRequestableRung(aiOnly)).toBe("challenge");
    // With deterministic support the ceiling follows confidence.
    expect(maxRequestableRung(openIncident({ incidentId: "i", detections: [detection({ detectionId: "d", subjectRef: "s", confidence: "suspected" })], openedAt: "t" }))).toBe("throttle");
    expect(maxRequestableRung(openIncident({ incidentId: "i", detections: [detection({ detectionId: "d", subjectRef: "s", confidence: "probable" })], openedAt: "t" }))).toBe("segment");
    expect(maxRequestableRung(openIncident({ incidentId: "i", detections: [detection({ detectionId: "d", subjectRef: "s", confidence: "confirmed" })], openedAt: "t" }))).toBe("revoke");
  });
});

describe("§21 read models — a view never outruns its evidence", () => {
  const completeCoverage: SensorCoverage = {
    boundKinds: ["hive-native"],
    unboundKinds: [],
    unclaimedObservationTypes: [],
    coverageStatement: "all bound",
  };
  const partialCoverage: SensorCoverage = {
    boundKinds: ["hive-native"],
    unboundKinds: ["runtime"],
    unclaimedObservationTypes: ["process-executed"],
    coverageStatement: "runtime unbound",
  };
  const collectionWithGap: CollectionResult = {
    observations: [],
    gaps: [{ providerRef: "edr", sensorKind: "host-edr", reason: "unavailable", degraded: false }],
    complete: false,
  };
  it("GATE: over a partial view the basis says counts are lower bounds and silence is not safety", () => {
    const view = securityOverview({
      conditionLevel: "GREEN",
      chambers: [],
      incidents: [],
      detections: [],
      coverage: partialCoverage,
      collection: collectionWithGap,
    });
    expect(view.basis.complete).toBe(false);
    expect(view.basis.statement).toContain("absence of findings is not an absence of activity");
    expect(view.basis.gaps.length).toBeGreaterThan(0);
    // The count field NAMES itself a lower bound, so a renderer cannot drop
    // the qualification.
    expect(Object.keys(view)).toContain("atLeastActiveDetections");
  });
  it("a complete view says so plainly", () => {
    const view = securityOverview({
      conditionLevel: "GREEN",
      chambers: [],
      incidents: [],
      detections: [],
      coverage: completeCoverage,
      collection: { observations: [], gaps: [], complete: true },
    });
    expect(view.basis.complete).toBe(true);
  });
  it("active incidents sort by severity then age, and surface the requestable ceiling", () => {
    const rows = activeIncidents(
      [
        openIncident({ incidentId: "low", detections: [detection({ detectionId: "a", subjectRef: "s1", severity: "low" })], openedAt: "2026-08-30T09:00:00Z" }),
        openIncident({ incidentId: "cat", detections: [detection({ detectionId: "b", subjectRef: "s2", severity: "catastrophic" })], openedAt: "2026-08-30T10:00:00Z" }),
      ],
      maxRequestableRung,
    );
    expect(rows.map((r) => r.incidentId)).toEqual(["cat", "low"]);
    expect(rows[0]!.maxRequestableRung).toBe("revoke");
  });
  it("closed incidents leave the active view", () => {
    const incident = openIncident({ incidentId: "i", detections: [detection({ detectionId: "d", subjectRef: "s" })], openedAt: "t" });
    const closed = { ...incident, status: "closed" as const };
    expect(activeIncidents([closed], maxRequestableRung)).toHaveLength(0);
  });
  it("threat activity separates non-gating detections so an advisory pile never reads as actionable", () => {
    const view = threatActivity(
      [
        detection({ detectionId: "d1", subjectRef: "s", attackTechniqueRefs: ["T1078"] }),
        detection({ detectionId: "d2", subjectRef: "s", gateEligible: false, method: "cross-source-correlation" }),
      ],
      completeCoverage,
      null,
    );
    expect(view.atLeastTotal).toBe(2);
    expect(view.nonGatingCount).toBe(1);
    expect(view.byTechnique["T1078"]).toBe(1);
  });
  it("the attack-surface view reports graph incompleteness rather than a node count alone", () => {
    const graph = projectGraph([{ sourceRef: "fabric", nodes: [], edges: [] }], ["cloud-inventory"], "t");
    const view = attackSurface(graph);
    expect(view.graphComplete).toBe(false);
    expect(view.statement).toContain("lower bounds");
  });
  it("the coverage view names blind spots and publishes NO percentage", () => {
    const view = coverageView(partialCoverage);
    expect(view.blindSpots).toEqual(["process-executed"]);
    expect(JSON.stringify(view)).not.toMatch(/percent|%/i);
  });
  it("GATE: the AI view renders aiGatedActions as a structural zero — a non-zero there is a defect", () => {
    const view = aiSecurity([detection({ detectionId: "d", subjectRef: "s", aiAssist: { modelRef: "m", contribution: "proposed-detection" }, gateEligible: false })], completeCoverage, null);
    expect(view.aiGatedActions).toBe(0);
    expect(view.aiProposedDetections).toBe(1);
  });
  it("recovery readiness exposes the structurally-impossible case so it stays checkable", () => {
    const view = recoveryReadiness([]);
    expect(view.closedWithoutRecoveryEvidence).toBe(0);
  });
  it("the SOC catalogue declares its own missing views rather than omitting them", () => {
    expect(SOC_VIEWS).toHaveLength(15);
    const missing = SOC_VIEWS.filter((v) => v.projection === null).map((v) => v.view);
    expect(missing).toContain("fabric-security");
    expect(missing).toContain("compliance-evidence");
    // The gap is visible in the catalogue, which is the point.
    expect(missing.length).toBeGreaterThan(0);
  });
});

// ─── guards ─────────────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("guards — incidents and read models", () => {
  const dir = join(process.cwd(), "packages", "sentineliq", "src", "v2");
  const files = ["incident.ts", "readModels.ts"].map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  it("no clock reads, no randomness, no storage", () => {
    for (const f of files) {
      expect(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/.test(f.text), f.name).toBe(false);
    }
  });
  it("read models publish no coverage percentage anywhere", () => {
    const readModels = files.find((f) => f.name === "readModels.ts")!;
    expect(/coveragePercent|coveragePct|percentComplete/.test(readModels.text)).toBe(false);
  });
  it("no automatic severity downgrade path exists", () => {
    const incident = files.find((f) => f.name === "incident.ts")!;
    // downgradeSeverity is the only lowering path and it demands a human.
    expect(/decision\.decidedBy\.startsWith\("human\."\)/.test(incident.text)).toBe(true);
    expect(/autoDowngrade|deEscalateAutomatically/.test(incident.text)).toBe(false);
  });
});
