// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DETECTORS,
  buildFailureSignature,
  createCausalGraph,
  createDiagnosticBot,
  createInvariantClassifier,
  diagnose,
  diagnosisGrantsRepairAuthority,
  symptomMistakenForCause,
  type CausalGraph,
  type Evidence,
  type InvariantCatalogEntry,
  type InvariantDetector,
  type SimulationRun,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — Diagnose.
//
// Directive §9: "Do not collapse symptom == root cause. WorkOrderIQ timeout may
// be a symptom. The root cause may be EventIQ unavailable."
// ─────────────────────────────────────────────────────────────────────────────

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../corpus/invariant-catalog.v2.json", import.meta.url)), "utf8"),
) as InvariantCatalogEntry[];

const evidence = (over: Partial<Evidence> & { evidenceId: string }): Evidence =>
  ({
    kind: "log",
    locator: `test://${over.evidenceId}`,
    componentId: "hive.specialized.workorderiq",
    observedAt: "2026-08-29T10:00:00.000Z",
    sensitivity: "internal",
    summary: "test evidence",
    facts: {},
    ...over,
  }) as Evidence;

const classifier = (detectors: readonly InvariantDetector[] = BASELINE_DETECTORS) =>
  createInvariantClassifier({ catalog, detectors });

const run = (): SimulationRun =>
  ({
    runId: "run_1",
    scenarioId: "SIM-0101",
    scenarioVersion: "2.0",
    executionId: "exec_1",
    correlationId: "cor_1",
    environment: "SIMULATION",
    startedAt: "2026-08-29T10:00:00.000Z",
    finishedAt: "2026-08-29T10:00:05.000Z",
    injections: [],
    evidence: [],
    evidenceCompleteness: { complete: true, missing: [], captured: [] },
    mustPassResults: [],
    engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
    outcome: "FAILED",
    outcomeReason: "r",
    forbiddenRepairActions: [],
    versions: {},
  }) as SimulationRun;

const signature = () =>
  buildFailureSignature({
    failureSignatureId: "sig_1",
    run: run(),
    primarySymptom: "WorkOrderIQ create timed out",
    affectedComponents: ["hive.specialized.workorderiq"],
    tenantScope: "ksix",
    riskClass: "routine",
    invariantsAtRisk: [],
  });

describe("an invariant is violated only when evidence says so", () => {
  it("reports NOT_ASSESSED when no detector implements it", () => {
    // The failure this exists to prevent: copying the corpus's annotation onto
    // the run and calling them violations. That would produce a populated
    // database of constitutional breaches nobody observed.
    const result = classifier([]).assess(["HIVE-INV-OWNERSHIP-001"], []);
    expect(result[0]!.verdict).toBe("NOT_ASSESSED");
    expect(result[0]!.detail).toContain("an unchecked invariant is not a satisfied one");
  });

  it("reports NOT_ASSESSED when a detector looked and could not decide", () => {
    // Different from having no detector, and both are different from HELD.
    const result = classifier().assess(["HIVE-INV-IDEMPOTENCY-001"], [evidence({ evidenceId: "ev_1" })]);
    expect(result[0]!.verdict).toBe("NOT_ASSESSED");
    expect(result[0]!.detail).toContain("Undecided is not held");
  });

  it("never returns HELD without evidence", () => {
    const all = classifier().assess(
      catalog.map((c) => c.id),
      [],
    );
    for (const assessment of all) {
      if (assessment.verdict === "HELD") {
        expect(assessment.evidenceIds.length, assessment.invariantId).toBeGreaterThan(0);
      }
    }
  });

  it("carries the catalog's PROPOSED status into the verdict", () => {
    // A violation of a proposed invariant is a weaker claim than a violation of
    // a ratified one, and the difference matters to whoever acts on it.
    const result = classifier().assess(["HIVE-INV-TENANT-001"], []);
    expect(result[0]!.catalogStatus).toBe("PROPOSED_CANONICAL_REFERENCE");
  });

  it("says so when an invariant is not in the catalog at all", () => {
    const result = classifier().assess(["HIVE-INV-INVENTED-999"], []);
    expect(result[0]!.catalogStatus).toBe("NOT_IN_CATALOG");
  });
});

describe("the baseline detectors decide from facts", () => {
  it("finds a split trace", () => {
    const violations = classifier().violations(
      ["HIVE-INV-CORRELATION-001"],
      [
        evidence({ evidenceId: "ev_1", facts: { correlationId: "cor_1" } }),
        evidence({ evidenceId: "ev_2", facts: { correlationId: "cor_2" } }),
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("Trace split across 2 correlation ids");
  });

  it("finds a tenant boundary crossing", () => {
    const violations = classifier().violations(
      ["HIVE-INV-TENANT-001"],
      [
        evidence({ evidenceId: "ev_1", facts: { tenantId: "ksix" } }),
        evidence({ evidenceId: "ev_2", facts: { tenantId: "other-shop" } }),
      ],
    );
    expect(violations).toHaveLength(1);
  });

  it("finds a duplicate that was not suppressed", () => {
    const violations = classifier().violations(
      ["HIVE-INV-IDEMPOTENCY-001"],
      [
        evidence({ evidenceId: "ev_1", facts: { duplicateDelivered: true } }),
        evidence({ evidenceId: "ev_2", facts: { duplicateSuppressed: false } }),
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("requires an idempotent consumer");
  });

  it("accepts a duplicate that was suppressed", () => {
    const assessed = classifier().assess(
      ["HIVE-INV-IDEMPOTENCY-001"],
      [
        evidence({ evidenceId: "ev_1", facts: { duplicateDelivered: true } }),
        evidence({ evidenceId: "ev_2", facts: { duplicateSuppressed: true } }),
      ],
    );
    expect(assessed[0]!.verdict).toBe("HELD");
  });

  it("finds a consequential action with no Governance decision", () => {
    const violations = classifier().violations(
      ["HIVE-INV-AUTHORITY-001"],
      [evidence({ evidenceId: "ev_1", facts: { consequential: true } })],
    );
    expect(violations[0]!.detail).toContain("Capability is not permission");
  });

  it("finds Prime persisting domain state", () => {
    const violations = classifier().violations(
      ["HIVE-INV-PRIME-OWNERSHIP-001"],
      [
        evidence({
          evidenceId: "ev_1",
          componentId: "hive.constitutional.prime",
          facts: { persistedEntity: "work_order" },
        }),
      ],
    );
    expect(violations[0]!.detail).toContain("Prime coordinates work; it does not own the work");
  });

  it("lets one detector's violation outweigh another's silence", () => {
    // Invariants are one-sided: a detector finding nothing may simply have been
    // looking elsewhere.
    const blind: InvariantDetector = {
      invariantId: "HIVE-INV-TENANT-001",
      name: "always-holds",
      detect: () => ({ verdict: "HELD", evidenceIds: ["ev_x"], confidence: "confirmed", detail: "fine" }),
    };
    const violations = createInvariantClassifier({
      catalog,
      detectors: [blind, ...BASELINE_DETECTORS],
    }).violations(
      ["HIVE-INV-TENANT-001"],
      [
        evidence({ evidenceId: "ev_1", facts: { tenantId: "ksix" } }),
        evidence({ evidenceId: "ev_2", facts: { tenantId: "other" } }),
      ],
    );
    expect(violations).toHaveLength(1);
  });
});

describe("the causal graph does not confuse order with cause", () => {
  const graph = (): CausalGraph => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "eventiq_down", kind: "dependency", label: "EventIQ unavailable", componentId: "hive.platform.eventiq", evidenceIds: ["ev_health"] });
    g.addNode({ nodeId: "event_missing", kind: "event", label: "workorder.created never published", evidenceIds: ["ev_missing"] });
    g.addNode({ nodeId: "wo_timeout", kind: "error", label: "WorkOrderIQ create timed out", componentId: "hive.specialized.workorderiq", evidenceIds: ["ev_timeout"] });
    g.addNode({ nodeId: "unrelated_log", kind: "event", label: "nightly cache warm started", evidenceIds: ["ev_cache"] });
    return g;
  };

  it("refuses a CAUSED edge with no evidence", () => {
    // An unevidenced causal claim is an opinion with an arrow drawn on it.
    const g = graph();
    const result = g.addEdge({
      from: "eventiq_down",
      to: "wo_timeout",
      kind: "CAUSED",
      confidence: "probable",
      provenance: "hunch",
      evidenceIds: [],
    });
    expect(result.added).toBe(false);
    if (!result.added) expect(result.reason).toContain("opinion with an arrow drawn on it");
  });

  it("accepts PRECEDED without evidence, because it claims nothing", () => {
    const g = graph();
    expect(
      g.addEdge({
        from: "unrelated_log",
        to: "wo_timeout",
        kind: "PRECEDED",
        confidence: "confirmed",
        provenance: "log ordering",
        evidenceIds: [],
      }).added,
    ).toBe(true);
  });

  it("does not treat what merely preceded as a root cause", () => {
    // Including PRECEDED would make whatever logged first the root cause of
    // everything, which is how a timeline gets mistaken for a diagnosis.
    const g = graph();
    g.addEdge({ from: "unrelated_log", to: "wo_timeout", kind: "PRECEDED", confidence: "confirmed", provenance: "ordering", evidenceIds: [] });
    g.addEdge({ from: "eventiq_down", to: "event_missing", kind: "CAUSED", confidence: "confirmed", provenance: "health check", evidenceIds: ["ev_health"] });
    g.addEdge({ from: "event_missing", to: "wo_timeout", kind: "CAUSED", confidence: "probable", provenance: "consumer wait", evidenceIds: ["ev_missing"] });

    const candidates = g.rootCauseCandidates("wo_timeout");
    expect(candidates.map((c) => c.nodeId)).toContain("eventiq_down");
    expect(candidates.map((c) => c.nodeId)).not.toContain("unrelated_log");
  });

  it("reaches past the immediate cause to the actual one", () => {
    // §9's example. The event that never arrived is the proximate cause; the
    // dependency that was down is the root.
    const g = graph();
    g.addEdge({ from: "eventiq_down", to: "event_missing", kind: "CAUSED", confidence: "confirmed", provenance: "health check", evidenceIds: ["ev_health"] });
    g.addEdge({ from: "event_missing", to: "wo_timeout", kind: "CAUSED", confidence: "confirmed", provenance: "consumer wait", evidenceIds: ["ev_missing"] });

    const [top] = g.rootCauseCandidates("wo_timeout");
    expect(top!.nodeId).toBe("eventiq_down");
    expect(top!.depth).toBe(2);
    expect(top!.pathToSymptom).toEqual(["eventiq_down", "event_missing", "wo_timeout"]);
  });

  it("discounts a path built on suspicion", () => {
    const g = graph();
    g.addEdge({ from: "eventiq_down", to: "wo_timeout", kind: "CAUSED", confidence: "suspected", provenance: "guess", evidenceIds: ["ev_health"] });
    expect(g.rootCauseCandidates("wo_timeout")[0]!.pathConfidence).toBeLessThan(0.5);
  });

  it("survives a cycle rather than looping", () => {
    const g = graph();
    g.addEdge({ from: "eventiq_down", to: "event_missing", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["e"] });
    g.addEdge({ from: "event_missing", to: "eventiq_down", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["e"] });
    g.addEdge({ from: "event_missing", to: "wo_timeout", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["e"] });
    expect(() => g.rootCauseCandidates("wo_timeout")).not.toThrow();
  });

  it("rejects an edge to a node that does not exist", () => {
    expect(
      graph().addEdge({ from: "eventiq_down", to: "ghost", kind: "PRECEDED", confidence: "confirmed", provenance: "p", evidenceIds: [] }).added,
    ).toBe(false);
  });
});

describe("diagnosis blames the dependency, not the timeout", () => {
  const setup = (contradictions?: Record<string, readonly string[]>) => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "eventiq_down", kind: "dependency", label: "EventIQ unavailable", componentId: "hive.platform.eventiq", evidenceIds: ["ev_health"] });
    g.addNode({ nodeId: "event_missing", kind: "event", label: "workorder.created never published", evidenceIds: ["ev_missing"] });
    g.addNode({ nodeId: "wo_timeout", kind: "error", label: "WorkOrderIQ create timed out", componentId: "hive.specialized.workorderiq", evidenceIds: ["ev_timeout"] });
    g.addEdge({ from: "eventiq_down", to: "event_missing", kind: "CAUSED", confidence: "confirmed", provenance: "health check", evidenceIds: ["ev_health"] });
    g.addEdge({ from: "event_missing", to: "wo_timeout", kind: "CAUSED", confidence: "confirmed", provenance: "consumer wait", evidenceIds: ["ev_missing"] });

    return diagnose({
      diagnosisId: "dx_1",
      signature: signature(),
      evidence: [
        evidence({ evidenceId: "ev_health", componentId: "hive.platform.eventiq", kind: "engine_health", facts: { correlationId: "cor_1" } }),
        evidence({ evidenceId: "ev_timeout", componentId: "hive.specialized.workorderiq", facts: { correlationId: "cor_1" } }),
      ],
      graph: g,
      symptomNodeId: "wo_timeout",
      classifier: classifier(),
      invariantsToAssess: ["HIVE-INV-CORRELATION-001"],
      ...(contradictions === undefined ? {} : { contradictions }),
    });
  };

  it("selects EventIQ, not WorkOrderIQ", () => {
    // The §9 example, end to end. WorkOrderIQ is where the pain was felt.
    const d = setup({});
    expect(d.selectedRootCause?.componentId).toBe("hive.platform.eventiq");
    expect(d.selectedRootCause?.statement).toBe("EventIQ unavailable");
  });

  it("does not mistake the symptom for the cause", () => {
    expect(symptomMistakenForCause(setup({}))).toBe(false);
  });

  it("records the causal chain", () => {
    expect(setup({}).causalChain).toEqual(["eventiq_down", "event_missing", "wo_timeout"]);
  });

  it("demands review when nobody looked for contradicting evidence", () => {
    // Absence of contradiction that nobody looked for is not confirmation.
    const d = setup();
    expect(d.requiresHumanReview).toBe(true);
    expect(d.reviewReason).toContain("No contradicting evidence was searched for");
    expect(d.selectedRootCause).toBeNull();
  });

  it("keeps contradicting evidence rather than discarding it", () => {
    const d = setup({ eventiq_down: ["ev_eventiq_was_healthy"] });
    const hypothesis = d.candidateRootCauses.find((h) => h.statement === "EventIQ unavailable")!;
    expect(hypothesis.contradictingEvidence).toEqual(["ev_eventiq_was_healthy"]);
    // A contradiction caps confidence mechanically, not by judgement.
    expect(hypothesis.confidence).toBe("suspected");
    expect(d.requiresHumanReview).toBe(true);
  });

  it("demands review when two hypotheses are indistinguishable", () => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });
    for (const id of ["cause_a", "cause_b"]) {
      g.addNode({ nodeId: id, kind: "dependency", label: id, componentId: "hive.platform.eventiq", evidenceIds: [] });
      g.addEdge({ from: id, to: "sym", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["ev_health"] });
    }

    const d = diagnose({
      diagnosisId: "dx_2",
      signature: signature(),
      evidence: [evidence({ evidenceId: "ev_health", componentId: "hive.platform.eventiq" })],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: [],
      contradictions: {},
    });

    expect(d.requiresHumanReview).toBe(true);
    expect(d.reviewReason).toContain("does not distinguish them");
  });

  it("demands review when the graph offers nothing", () => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });
    const d = diagnose({
      diagnosisId: "dx_3",
      signature: signature(),
      evidence: [],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: [],
      contradictions: {},
    });
    expect(d.selectedRootCause).toBeNull();
    expect(d.reviewReason).toContain("an edge is missing");
  });

  it("demands review when an invariant could not be assessed", () => {
    // A repair may restore function while leaving an unchecked invariant broken.
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });
    g.addNode({ nodeId: "cause", kind: "dependency", label: "cause", componentId: "hive.platform.eventiq", evidenceIds: [] });
    g.addEdge({ from: "cause", to: "sym", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["ev_1"] });

    const d = diagnose({
      diagnosisId: "dx_4",
      signature: signature(),
      evidence: [evidence({ evidenceId: "ev_1", componentId: "hive.platform.eventiq" })],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: ["HIVE-INV-CHARTER-001"],
      contradictions: {},
    });

    expect(d.unassessedInvariants).toHaveLength(1);
    expect(d.requiresHumanReview).toBe(true);
    expect(d.reviewReason).toContain("HIVE-INV-CHARTER-001");
  });

  it("recommends repair classes from violations, not from annotations", () => {
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });
    g.addNode({ nodeId: "cause", kind: "dependency", label: "no idempotency key", componentId: "hive.specialized.workorderiq", evidenceIds: [] });
    g.addEdge({ from: "cause", to: "sym", kind: "CAUSED", confidence: "confirmed", provenance: "p", evidenceIds: ["ev_1"] });

    const d = diagnose({
      diagnosisId: "dx_5",
      signature: signature(),
      evidence: [
        evidence({ evidenceId: "ev_1", componentId: "hive.specialized.workorderiq", facts: { duplicateDelivered: true } }),
        evidence({ evidenceId: "ev_2", componentId: "hive.specialized.workorderiq", facts: { duplicateSuppressed: false } }),
      ],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: ["HIVE-INV-IDEMPOTENCY-001"],
      contradictions: {},
    });

    expect(d.violatedInvariants.map((v) => v.invariantId)).toEqual(["HIVE-INV-IDEMPOTENCY-001"]);
    expect(d.recommendedRepairClasses).toContain("IDEMPOTENCY");
  });
});

describe("the diagnostic bot reads, analyzes and proposes — nothing else", () => {
  const bot = (over: Partial<Parameters<typeof createDiagnosticBot>[0]["scope"]> = {}) =>
    createDiagnosticBot({
      botId: "bot_1",
      scope: {
        runIds: ["run_1"],
        tenants: ["ksix"],
        mayReadContracts: true,
        mayReadArchitectureDocs: true,
        mayReadPriorCases: true,
        ...over,
      },
    });

  it("exposes no method that modifies, deploys or grants", () => {
    // §11's prohibitions, enforced by absence. A `deploy()` that refuses is one
    // `if (force)` away from deploying.
    for (const method of Object.keys(bot())) {
      expect(/modify|deploy|grant|write|apply|expand/i.test(method), method).toBe(false);
    }
    expect(Object.keys(bot()).sort()).toEqual(["botId", "mayRead", "proposeDiagnosis", "scope"]);
  });

  it("refuses a run outside its scope", () => {
    expect(bot().mayRead({ runId: "run_99" }).within).toBe(false);
  });

  it("refuses another tenant", () => {
    const check = bot().mayRead({ tenant: "other-shop" });
    expect(check.within).toBe(false);
    if (!check.within) expect(check.reason).toContain("whatever the motive");
  });

  it("refuses to diagnose from mixed-tenant evidence", () => {
    // A mixed-tenant evidence set is how cross-tenant inference happens
    // without anybody intending it.
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });

    const result = bot().proposeDiagnosis({
      runId: "run_1",
      tenant: "ksix",
      diagnosisId: "dx_1",
      signature: signature(),
      evidence: [
        evidence({ evidenceId: "ev_1", facts: { tenantId: "ksix" } }),
        evidence({ evidenceId: "ev_2", facts: { tenantId: "other-shop" } }),
      ],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: [],
      contradictions: {},
    });

    expect(result.proposed).toBe(false);
    if (!result.proposed) expect(result.reason).toContain("across a tenant boundary");
  });

  it("cannot widen its own scope after construction", () => {
    // Foundry Charter §18: "Foundry may design authority but may not grant it
    // to itself."
    const scope = { runIds: ["run_1"], tenants: ["ksix"], mayReadContracts: false, mayReadArchitectureDocs: false, mayReadPriorCases: false };
    const b = createDiagnosticBot({ botId: "bot_2", scope });
    scope.runIds.push("run_99");
    expect(b.mayRead({ runId: "run_99" }).within).toBe(false);
    expect(() => {
      // Through `unknown`: the whole point of this probe is to reach past
      // `readonly` and confirm the freeze is enforced at runtime rather than
      // only in the type. A direct cast is rejected because the types do not
      // overlap — which is the type system doing its job, not an obstacle.
      (b.scope as unknown as { runIds: string[] }).runIds.push("run_98");
    }).toThrow();
  });

  it("honours a read restriction on contracts", () => {
    expect(bot({ mayReadContracts: false }).mayRead({ resource: "mayReadContracts" }).within).toBe(false);
  });

  it("announces every proposal", () => {
    // §16 audit: material actions are identified.
    const seen: string[] = [];
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });

    createDiagnosticBot({
      botId: "bot_3",
      scope: { runIds: ["run_1"], tenants: ["ksix"], mayReadContracts: true, mayReadArchitectureDocs: true, mayReadPriorCases: true },
      onProposal: (_d, botId) => seen.push(botId),
    }).proposeDiagnosis({
      runId: "run_1",
      tenant: "ksix",
      diagnosisId: "dx_1",
      signature: signature(),
      evidence: [],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: [],
      contradictions: {},
    });

    expect(seen).toEqual(["bot_3"]);
  });

  it("gains no repair authority by being right", () => {
    // Competence is not authority, and the inference from one to the other is
    // the most sympathetic-sounding way a repair system acquires powers
    // nobody granted it.
    const g = createCausalGraph();
    g.addNode({ nodeId: "sym", kind: "error", label: "symptom", evidenceIds: [] });
    const d = diagnose({
      diagnosisId: "dx_1",
      signature: signature(),
      evidence: [],
      graph: g,
      symptomNodeId: "sym",
      classifier: classifier(),
      invariantsToAssess: [],
      contradictions: {},
    });
    expect(diagnosisGrantsRepairAuthority(d)).toBe(false);
  });
});
