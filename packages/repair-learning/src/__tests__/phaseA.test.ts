// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  authorityCrossesTo,
  buildFailureSignature,
  createEvidenceRecorder,
  decideOutcome,
  injectionPermitted,
  loadCorpus,
  loadScenario,
  mechanicalFaultFor,
  normalizeMessage,
  requirementToKind,
  runScenario,
  scenarioIsGrounded,
  sandboxUsableFor,
  signatureSimilarity,
  unevaluated,
  warrantsDiagnosis,
  type ConditionEvaluator,
  type Environment,
  type Evidence,
  type FaultInjector,
  type Sandbox,
  type Scenario,
  type SimulationRun,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Phase A — Capture, tested against the real V2 corpus rather than fixtures.
//
// A thousand scenarios written by somebody else is the only honest test of a
// loader. Fixtures I write agree with the code I wrote.
// ─────────────────────────────────────────────────────────────────────────────

const corpusPath = (name: string) => fileURLToPath(new URL(`../../corpus/${name}`, import.meta.url));
const corpus = JSON.parse(readFileSync(corpusPath("simulations.v2.json"), "utf8")) as unknown[];
const invariantCatalog = JSON.parse(readFileSync(corpusPath("invariant-catalog.v2.json"), "utf8")) as {
  id: string;
  status: string;
}[];

const loaded = loadCorpus(corpus);

describe("the V2 corpus loads", () => {
  it("parses every scenario", () => {
    expect(loaded.rejected).toEqual([]);
    expect(loaded.scenarios).toHaveLength(1000);
  });

  it("resolves canonical component identities", () => {
    // §3: "resolve canonical component identities". The corpus already did the
    // mapping; this asserts the loader keeps it rather than falling back to the
    // human name.
    const sim1 = loaded.scenarios.find((s) => s.id === "SIM-0001")!;
    expect(sim1.components.map((c) => c.componentId)).toContain("hive.specialized.forgeiq");
    expect(sim1.components.every((c) => c.componentId.startsWith("hive."))).toBe(true);
  });

  it("refuses a scenario that is not V2", () => {
    const result = loadScenario({ ...(corpus[0] as object), schemaVersion: "1.0" });
    expect(result.ok).toBe(false);
  });

  it("keeps V1 fields rather than dropping them", () => {
    // "Preserve the original V1 scenarios. Do not rewrite the scenario intent
    // simply to make implementation easier." The raw `engines` array is V1's;
    // a strict schema would have silently discarded it.
    const raw = corpus[0] as { engines?: string[] };
    expect(raw.engines).toBeDefined();
    expect(loadScenario(corpus[0]).ok).toBe(true);
  });
});

describe("violatedInvariants does not mean violated", () => {
  it("is non-empty on every happy-path scenario", () => {
    // The finding that changed the type. All 80 NONE_HAPPY_PATH scenarios
    // declare "No fault expected" AND carry a non-empty violatedInvariants
    // array. If the field meant what it says, the corpus would assert 160
    // constitutional breaches in scenarios where nothing goes wrong.
    const happy = loaded.scenarios.filter((s) => s.faultClass === "NONE_HAPPY_PATH");
    expect(happy.length).toBeGreaterThan(0);
    expect(happy.every((s) => s.invariantsAtRisk.length > 0)).toBe(true);
    expect(happy.every((s) => s.expectation.diagnosis.includes("No diagnosis expected"))).toBe(true);
  });

  it("is loaded under a name that cannot be misread", () => {
    const sim1 = loaded.scenarios.find((s) => s.id === "SIM-0001")!;
    expect(sim1.invariantsAtRisk).toContain("HIVE-INV-OWNERSHIP-001");
    expect(Object.keys(sim1)).not.toContain("violatedInvariants");
  });

  it("references only invariants the catalog defines", () => {
    const known = new Set(invariantCatalog.map((i) => i.id));
    const used = new Set(loaded.scenarios.flatMap((s) => s.invariantsAtRisk));
    expect([...used].filter((id) => !known.has(id))).toEqual([]);
  });

  it("carries the catalog's own caveat about itself", () => {
    // Every entry is PROPOSED_CANONICAL_REFERENCE, sourced from the migration
    // and "must be reconciled with authoritative Hive invariant catalog when
    // available". Treating it as canonical would be inventing architecture.
    expect(new Set(invariantCatalog.map((i) => i.status))).toEqual(
      new Set(["PROPOSED_CANONICAL_REFERENCE"]),
    );
  });
});

describe("the corpus admits what it could not resolve", () => {
  it("flags scenarios naming an unconfirmed component", () => {
    // 30 components are UNRESOLVED_COMPONENT / REQUIRES_ARCHITECTURE_REVIEW —
    // the V2 migration saying honestly that it could not map a name. Such a
    // scenario still runs; what it must not do is produce a repair aimed at a
    // component nobody has confirmed exists.
    const ungrounded = loaded.scenarios.filter((s) => !scenarioIsGrounded(s).grounded);
    expect(ungrounded.length).toBeGreaterThan(0);
    expect(scenarioIsGrounded(ungrounded[0]!).unresolved.length).toBeGreaterThan(0);
  });

  it("treats an ordinary scenario as grounded", () => {
    const sim1 = loaded.scenarios.find((s) => s.id === "SIM-0001")!;
    expect(scenarioIsGrounded(sim1).grounded).toBe(true);
  });
});

describe("the enums match the corpus, not my assumptions", () => {
  it("uses the severity values the corpus actually uses", () => {
    // I guessed LOW/MEDIUM/HIGH/CRITICAL and the corpus uses INFO for its
    // happy paths. 919 of 1000 scenarios were rejected on the first run.
    const severities = new Set(loaded.scenarios.map((s) => s.severity));
    expect(severities).toContain("INFO");
    expect(severities).not.toContain("LOW");
  });

  it("keeps blast radius unordered", () => {
    // Sixteen heterogeneous values. There is no honest comparison between
    // ARCHITECTURE and FINANCIAL, so nothing ranks them.
    const radii = new Set(loaded.scenarios.map((s) => s.blastRadius));
    expect(radii.size).toBeGreaterThan(10);
    expect(radii).toContain("FINANCIAL");
    expect(radii).toContain("ARCHITECTURE");
  });

  it("carries the corpus's CONTAIN_FIRST reversibility", () => {
    // A better idea than the "partially reversible" I assumed: it says the
    // question of reversibility comes after containment, not instead of it.
    expect(new Set(loaded.scenarios.map((s) => s.reversibility))).toContain("CONTAIN_FIRST");
  });
});

describe("expected diagnosis is quarantined from the diagnostic path", () => {
  it("lives under expectation, not on the scenario body", () => {
    // §1: "Expected diagnosis is a test expectation. Actual diagnosis must come
    // from runtime evidence." Nothing in the diagnostic pipeline receives a
    // Scenario, so it cannot reach the answer by accident.
    const sim = loaded.scenarios[0]!;
    expect(Object.keys(sim)).not.toContain("expectedDiagnosis");
    expect(sim.expectation.diagnosis).toBeTruthy();
  });
});

describe("sandbox and production do not share authority", () => {
  const each: Environment[] = ["SIMULATION", "DEVELOPMENT", "VALIDATION", "STAGING", "PRODUCTION"];

  it("lets authority hold only in its own environment", () => {
    for (const from of each) {
      for (const to of each) {
        expect(authorityCrossesTo(from, to).crosses, `${from}->${to}`).toBe(from === to);
      }
    }
  });

  it("does not treat higher environments as covering lower ones", () => {
    // The seductive wrong answer. STAGING authority "obviously" covers
    // SIMULATION — right up until somebody inverts the comparison.
    expect(authorityCrossesTo("STAGING", "SIMULATION").crosses).toBe(false);
    expect(authorityCrossesTo("PRODUCTION", "SIMULATION").crosses).toBe(false);
  });

  it("refuses fault injection into production", () => {
    const gate = injectionPermitted({
      fault: {
        fault: "ENGINE_UNAVAILABLE",
        targetComponentId: "hive.platform.eventiq",
        parameters: {},
        intent: "test",
      },
      environment: "PRODUCTION",
      authorityEstablishedIn: "PRODUCTION",
    });
    expect(gate.permitted).toBe(false);
    if (!gate.permitted) expect(gate.reason).toContain("does not get to cause the incidents it studies");
  });

  it("refuses a chaos scenario against production", () => {
    const prod: Sandbox = {
      environment: "PRODUCTION",
      seed: async () => undefined,
      reset: async () => undefined,
      now: () => new Date("2026-08-29T10:00:00.000Z"),
      advanceClock: () => undefined,
      tenantId: "ksix",
    };
    expect(sandboxUsableFor(prod, { scenarioType: "CHAOS_FUZZ", faultClass: "X" }).usable).toBe(false);
    expect(sandboxUsableFor(prod, { scenarioType: "FAULT_INJECTION", faultClass: "X" }).usable).toBe(false);
    expect(sandboxUsableFor(prod, { scenarioType: "VALIDATION", faultClass: "X" }).usable).toBe(true);
  });
});

describe("fault classes map honestly or not at all", () => {
  it("maps the corpus classes that have a mechanical equivalent", () => {
    expect(mechanicalFaultFor("DUPLICATE_DELIVERY")).toBe("DUPLICATE_EVENT");
    expect(mechanicalFaultFor("DEPENDENCY_UNAVAILABLE")).toBe("ENGINE_UNAVAILABLE");
  });

  it("returns null rather than inventing one", () => {
    // An engine claiming another's source of truth is not a timeout. Forcing a
    // mechanical stand-in would make the injector lie about what it did.
    expect(mechanicalFaultFor("SOURCE_OF_TRUTH_THEFT")).toBeNull();
    expect(mechanicalFaultFor("ORCHESTRATOR_OWNERSHIP_VIOLATION")).toBeNull();
  });
});

describe("evidence references rather than copies", () => {
  const recorder = () => createEvidenceRecorder();

  const evidence = (over: Record<string, unknown> = {}) => ({
    evidenceId: "ev_1",
    kind: "audit_record",
    locator: "auditiq://aud_41",
    componentId: "hive.specialized.workorderiq",
    observedAt: "2026-08-29T10:00:00.000Z",
    sensitivity: "internal",
    summary: "Work order creation denied.",
    facts: { attempt: 2, denied: true },
    ...over,
  });

  it("captures well-formed evidence", () => {
    expect(recorder().capture(evidence()).captured).toBe(true);
  });

  it("refuses to extract facts out of restricted material", () => {
    // Pulling scalars out of protected material is how it leaves its boundary
    // one field at a time.
    const r = recorder().capture(evidence({ sensitivity: "restricted" }));
    expect(r.captured).toBe(false);

    const referenced = recorder().capture(
      evidence({ sensitivity: "restricted", facts: {} }),
    );
    expect(referenced.captured).toBe(true);
  });

  it("refuses nested facts", () => {
    expect(recorder().capture(evidence({ facts: { customer: { name: "Dana" } } })).captured).toBe(false);
  });

  it("reports an unmappable requirement rather than passing it", () => {
    // A completeness check that quietly passes what it does not understand is
    // worse than none at all.
    const r = recorder();
    r.capture(evidence());
    const completeness = r.completeness(["audit record", "something nobody defined"]);
    expect(completeness.complete).toBe(false);
    expect(completeness.missing.join()).toContain("UNMAPPED");
  });

  it("maps the corpus's prose requirements where it can", () => {
    expect(requirementToKind("correlation lineage")).toBe("trace");
    expect(requirementToKind("Governance decision record")).toBe("governance_decision");
    expect(requirementToKind("Prime ownership boundary")).toBe("state_transition");
  });
});

describe("the outcome vocabulary keeps untested runs out of PASSED", () => {
  const held = (condition: string) => ({ condition, held: true, evidenceIds: ["ev_1"], detail: "ok" });
  const complete = { complete: true, missing: [], captured: [] as never[] };

  it("passes when everything held", () => {
    expect(
      decideOutcome({
        injections: [],
        faultExpected: false,
        evidenceCompleteness: complete,
        mustPassResults: [held("a")],
        engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
      }).outcome,
    ).toBe("PASSED");
  });

  it("is INCONCLUSIVE when the fault never landed", () => {
    // The single easiest way for a repair-learning corpus to become
    // decorative: a scenario that quietly ran without its fault and reported
    // success for the wrong reason.
    const result = decideOutcome({
      injections: [
        {
          fault: {
            fault: "DUPLICATE_EVENT",
            targetComponentId: "x",
            parameters: {},
            intent: "i",
          },
          injectedAt: "2026-08-29T10:00:00.000Z",
          effective: false,
          ineffectiveBecause: "No injector supplied.",
        },
      ],
      faultExpected: true,
      evidenceCompleteness: complete,
      mustPassResults: [held("a")],
      engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
    });
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.reason).toContain("nothing was actually tested");
  });

  it("is INCONCLUSIVE when required evidence is missing", () => {
    expect(
      decideOutcome({
        injections: [],
        faultExpected: false,
        evidenceCompleteness: { complete: false, missing: ["trace"], captured: [] },
        mustPassResults: [held("a")],
        engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
      }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("does not blame the engine on an untested run", () => {
    // INCONCLUSIVE outranks ENGINE_DEFECT deliberately. Whatever went wrong,
    // it was not the thing being tested, and attributing it to the engine
    // would be a false accusation drawn from an untested run.
    expect(
      decideOutcome({
        injections: [
          {
            fault: { fault: "DUPLICATE_EVENT", targetComponentId: "x", parameters: {}, intent: "i" },
            injectedAt: "t",
            effective: false,
            ineffectiveBecause: "no injector",
          },
        ],
        faultExpected: true,
        evidenceCompleteness: complete,
        mustPassResults: [held("a")],
        engineDefectCondition: { condition: "x", held: true, evidenceIds: ["ev"], detail: "engine wrong" },
      }).outcome,
    ).toBe("INCONCLUSIVE");
  });

  it("separates an engine defect from a failed condition", () => {
    expect(
      decideOutcome({
        injections: [],
        faultExpected: false,
        evidenceCompleteness: complete,
        mustPassResults: [held("a")],
        engineDefectCondition: { condition: "x", held: true, evidenceIds: ["ev"], detail: "engine wrong" },
      }).outcome,
    ).toBe("ENGINE_DEFECT");
  });

  it("says a harness error tells us nothing about the Hive", () => {
    const result = decideOutcome({
      harnessError: "executor threw",
      injections: [],
      faultExpected: false,
      evidenceCompleteness: complete,
      mustPassResults: [],
      engineDefectCondition: { condition: "x", held: false, evidenceIds: [], detail: "no" },
    });
    expect(result.outcome).toBe("HARNESS_ERROR");
    expect(result.reason).toContain("says nothing about the Hive");
  });

  it("counts an unevaluated condition as unheld", () => {
    const result = unevaluated("Prime did not persist WO");
    expect(result.held).toBe(false);
    expect(result.detail).toContain("rather than assumed satisfied");
  });

  it("warrants diagnosis only for real findings", () => {
    expect(warrantsDiagnosis("FAILED")).toBe(true);
    expect(warrantsDiagnosis("ENGINE_DEFECT")).toBe(true);
    expect(warrantsDiagnosis("INCONCLUSIVE")).toBe(false);
    expect(warrantsDiagnosis("HARNESS_ERROR")).toBe(false);
    expect(warrantsDiagnosis("PASSED")).toBe(false);
  });
});

describe("the failure signature is stable across occurrences", () => {
  const run = (over: Partial<SimulationRun> = {}): SimulationRun =>
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
      ...over,
    }) as SimulationRun;

  const signature = (over: Record<string, unknown> = {}) =>
    buildFailureSignature({
      failureSignatureId: "sig_1",
      run: run(),
      primarySymptom: "WorkOrderIQ create timed out",
      errorCodes: ["ETIMEDOUT"],
      errorMessages: ["work order wo_8f3a not found at 2026-08-29T10:14:22.881Z after 3 retries"],
      affectedComponents: ["hive.specialized.workorderiq"],
      suspectedDependencies: ["hive.platform.eventiq"],
      missingExpectedEvents: ["workorder.created"],
      tenantScope: "ksix",
      riskClass: "routine",
      invariantsAtRisk: ["HIVE-INV-IDEMPOTENCY-001"],
      ...over,
    });

  it("normalizes ids, timestamps and counts out of a message", () => {
    expect(normalizeMessage("work order wo_8f3a not found at 2026-08-29T10:14:22.881Z after 3 retries")).toBe(
      "work order <id> not found at <ts> after <n> retries",
    );
  });

  it("hashes two occurrences of the same failure identically", () => {
    // The whole reuse loop depends on this. A signature that includes a
    // timestamp is unique per run, and §30's prior-case search never matches.
    const first = signature();
    const second = signature({
      failureSignatureId: "sig_2",
      run: run({
        runId: "run_2",
        executionId: "exec_2",
        correlationId: "cor_2",
        startedAt: "2026-09-14T22:41:03.000Z",
      }),
      errorMessages: ["work order wo_ff21 not found at 2026-09-14T22:41:07.004Z after 5 retries"],
    });

    expect(second.signatureHash).toBe(first.signatureHash);
    // But they remain distinguishable as separate occurrences.
    expect(second.runFingerprint).not.toBe(first.runFingerprint);
  });

  it("hashes a genuinely different failure differently", () => {
    expect(signature({ primarySymptom: "CostIQ returned a negative margin" }).signatureHash).not.toBe(
      signature().signatureHash,
    );
    expect(signature({ affectedComponents: ["hive.specialized.costiq"] }).signatureHash).not.toBe(
      signature().signatureHash,
    );
  });

  it("treats a different contract version as a different failure", () => {
    // §31: a repair valid for EventIQ 1.2 may be unsafe for 3.0.
    expect(signature({ contractVersions: { eventiq: "1.2" } }).signatureHash).not.toBe(
      signature({ contractVersions: { eventiq: "3.0" } }).signatureHash,
    );
  });

  it("ignores corpus annotations, which are not runtime facts", () => {
    // invariantsAtRisk comes from the scenario author. Including it would make
    // two identical runtime failures hash differently because somebody edited
    // an annotation.
    expect(signature({ invariantsAtRisk: ["HIVE-INV-TENANT-001"] }).signatureHash).toBe(
      signature().signatureHash,
    );
  });

  it("ignores field order", () => {
    expect(
      signature({ affectedComponents: ["b.two", "a.one"] }).signatureHash,
    ).toBe(signature({ affectedComponents: ["a.one", "b.two"] }).signatureHash);
  });

  it("scores similarity between related failures", () => {
    const base = signature();
    expect(signatureSimilarity(base, signature())).toBe(1);

    const related = signature({
      primarySymptom: "WorkOrderIQ create timed out",
      affectedComponents: ["hive.specialized.workorderiq", "hive.specialized.inventoryiq"],
    });
    const unrelated = signature({
      primarySymptom: "CostIQ returned a negative margin",
      errorCodes: ["EMARGIN"],
      affectedComponents: ["hive.specialized.costiq"],
      suspectedDependencies: [],
      missingExpectedEvents: [],
    });

    expect(signatureSimilarity(base, related)).toBeGreaterThan(0.7);
    expect(signatureSimilarity(base, unrelated)).toBeLessThan(0.2);
  });
});

describe("the harness runs a real corpus scenario", () => {
  const sandbox = (environment: Environment = "SIMULATION"): Sandbox => {
    let clock = new Date("2026-08-29T10:00:00.000Z").getTime();
    return {
      environment,
      seed: async () => undefined,
      reset: async () => undefined,
      now: () => new Date(clock),
      advanceClock: (ms) => {
        clock += ms;
      },
      tenantId: "ksix-synthetic",
    };
  };

  const happyPath = (): Scenario =>
    loaded.scenarios.find((s) => s.faultClass === "NONE_HAPPY_PATH" && s.v1Gate)!;

  const recordingExecutor = (kinds: readonly string[]) => ({
    async execute(ctx: {
      recorder: ReturnType<typeof createEvidenceRecorder>;
      correlationId: string;
      scenario: Scenario;
    }) {
      kinds.forEach((kind, i) => {
        ctx.recorder.capture({
          evidenceId: `ev_${i}`,
          kind,
          locator: `test://${kind}`,
          componentId: ctx.scenario.components[0]?.componentId ?? "unknown",
          observedAt: "2026-08-29T10:00:00.000Z",
          summary: `captured ${kind}`,
          facts: {},
        });
      });
    },
  });

  it("produces a run record with every required identifier", async () => {
    // §3: run_id, scenario_id, scenario_version, execution_id, correlation_id.
    const result = await runScenario(happyPath(), {
      sandbox: sandbox(),
      executor: recordingExecutor(["trace", "state_transition"]),
    });

    expect(result.ran).toBe(true);
    if (!result.ran) return;
    for (const field of ["runId", "scenarioId", "scenarioVersion", "executionId", "correlationId"]) {
      expect(result.run[field as keyof SimulationRun], field).toBeTruthy();
    }
    expect(result.run.environment).toBe("SIMULATION");
  });

  it("refuses to run a fault-injection scenario against production", async () => {
    const faulted = loaded.scenarios.find((s) => s.scenarioType === "FAULT_INJECTION")!;
    const result = await runScenario(faulted, {
      sandbox: sandbox("PRODUCTION"),
      executor: recordingExecutor([]),
      authorityEstablishedIn: "PRODUCTION",
    });
    expect(result.ran).toBe(false);
  });

  it("refuses when authority was established elsewhere", async () => {
    const result = await runScenario(happyPath(), {
      sandbox: sandbox("VALIDATION"),
      executor: recordingExecutor([]),
      authorityEstablishedIn: "SIMULATION",
    });
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toContain("does not exist in VALIDATION");
  });

  it("reports INCONCLUSIVE when no injector can produce the fault", async () => {
    const faulted = loaded.scenarios.find(
      (s) => s.scenarioType === "FAULT_INJECTION" && mechanicalFaultFor(s.faultClass) !== null,
    )!;
    const result = await runScenario(faulted, {
      sandbox: sandbox(),
      executor: recordingExecutor(["trace"]),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run.outcome).toBe("INCONCLUSIVE");
    expect(result.run.injections[0]!.effective).toBe(false);
  });

  it("says so when a constitutional fault class has no mechanical form", async () => {
    const theft = loaded.scenarios.find((s) => s.faultClass === "SOURCE_OF_TRUTH_THEFT")!;
    const result = await runScenario(theft, {
      sandbox: sandbox(),
      executor: recordingExecutor(["trace"]),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run.injections[0]!.ineffectiveBecause).toContain("no mechanical equivalent");
  });

  it("injects when the host can, and then judges conditions", async () => {
    const duplicate = loaded.scenarios.find((s) => s.faultClass === "DUPLICATE_DELIVERY")!;
    const injector: FaultInjector = {
      supports: ["DUPLICATE_EVENT"],
      async inject(fault) {
        return { fault, injectedAt: "2026-08-29T10:00:00.000Z", effective: true };
      },
      async clear() {
        return undefined;
      },
    };

    // An evaluator that understands one thing and says nothing about the rest.
    const evaluator: ConditionEvaluator = {
      name: "duplicate-suppression",
      evaluate(condition: string, evidence: readonly Evidence[]) {
        if (!/duplicate|idempoten/i.test(condition)) return null;
        return {
          condition,
          held: evidence.some((e) => e.facts.duplicateSuppressed === true),
          evidenceIds: evidence.map((e) => e.evidenceId),
          detail: "checked the suppression flag",
        };
      },
    };

    const result = await runScenario(duplicate, {
      sandbox: sandbox(),
      executor: {
        async execute(ctx) {
          for (const kind of ["trace", "event", "state_transition", "audit_record", "governance_decision"]) {
            ctx.recorder.capture({
              evidenceId: `ev_${kind}`,
              kind,
              locator: `test://${kind}`,
              componentId: "hive.specialized.workorderiq",
              observedAt: "2026-08-29T10:00:00.000Z",
              summary: `captured ${kind}`,
              facts: { duplicateSuppressed: false },
            });
          }
        },
      },
      injector,
      evaluators: [evaluator],
    });

    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run.injections[0]!.effective).toBe(true);
    // Either the evidence was incomplete or a condition failed — never PASSED,
    // because the suppression flag was false.
    expect(result.run.outcome).not.toBe("PASSED");
  });

  it("carries the scenario's forbidden repair actions onto the run", async () => {
    // So a candidate is judged against the constraints of the failure it claims
    // to fix, not against whatever the corpus says later.
    const scenario = loaded.scenarios.find((s) => s.forbiddenRepairActions.length > 0)!;
    const result = await runScenario(scenario, {
      sandbox: sandbox(),
      executor: recordingExecutor(["trace"]),
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run.forbiddenRepairActions).toEqual(scenario.forbiddenRepairActions);
  });

  it("records a harness error without blaming the engine", async () => {
    const result = await runScenario(happyPath(), {
      sandbox: sandbox(),
      executor: {
        async execute() {
          throw new Error("executor exploded");
        },
      },
    });
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.run.outcome).toBe("HARNESS_ERROR");
  });
});
