// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BASELINE_DETECTORS,
  EXTENDED_DETECTORS,
  SUPPORTED_FAULTS,
  UNSUPPORTED_FAULTS,
  createInvariantClassifier,
  createMechanicalInjector,
  effectOf,
  injectableFaultSchema,
  loadCorpus,
  mechanicalFaultFor,
  mechanicalFaultSchema,
  runScenario,
  type Environment,
  type InvariantCatalogEntry,
  type Sandbox,
  type Scenario,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mechanical fault injection.
//
// Until this existed, every fault-injection scenario returned INCONCLUSIVE —
// correctly, but uselessly.
// ─────────────────────────────────────────────────────────────────────────────

const corpus = loadCorpus(
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../corpus/simulations.v2.json", import.meta.url)), "utf8"),
  ) as unknown[],
);

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../corpus/invariant-catalog.v2.json", import.meta.url)), "utf8"),
) as InvariantCatalogEntry[];

const classifier = createInvariantClassifier({
  catalog,
  detectors: [...BASELINE_DETECTORS, ...EXTENDED_DETECTORS],
});

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

const fault = (over: Record<string, unknown> = {}) =>
  injectableFaultSchema.parse({
    fault: "DUPLICATE_EVENT",
    targetComponentId: "hive.specialized.workorderiq",
    parameters: {},
    intent: "redeliver the intake message",
    ...over,
  });

describe("the injector says what it can and cannot do", () => {
  it("supports fifteen mechanical faults", () => {
    expect(SUPPORTED_FAULTS).toHaveLength(15);
    expect(createMechanicalInjector().supports).toBe(SUPPORTED_FAULTS);
  });

  it("accounts for every fault class in the directive's list", () => {
    // Supported or explicitly unsupported-with-a-reason. Nothing silently
    // missing — a host that later gains a real queue can check this list rather
    // than rediscovering why QUEUE_BACKLOG never fired.
    const all = mechanicalFaultSchema.options;
    const unaccounted = all.filter(
      (f) => !SUPPORTED_FAULTS.includes(f) && UNSUPPORTED_FAULTS[f] === undefined,
    );
    expect(unaccounted).toEqual([]);
    expect(Object.keys(UNSUPPORTED_FAULTS)).toHaveLength(10);
  });

  it("refuses an unsupported fault with its reason", async () => {
    const record = await createMechanicalInjector().inject(
      fault({ fault: "DATABASE_FAILURE" }),
      sandbox(),
    );
    expect(record.effective).toBe(false);
    expect(record.ineffectiveBecause).toContain("cannot make one fail meaningfully");
  });

  it("refuses production independently of the harness gate", async () => {
    // A gate checked in exactly one place is a gate until somebody adds a
    // second caller.
    const record = await createMechanicalInjector().inject(fault(), sandbox("PRODUCTION"));
    expect(record.effective).toBe(false);
    expect(record.ineffectiveBecause).toContain("independently of the harness gate");
  });
});

describe("the fault plane is a query surface, not a mutation one", () => {
  it("exposes no way for an executor to clear its own fault", () => {
    // A test double that could clear its own fault would pass every scenario.
    const injector = createMechanicalInjector();
    expect(Object.keys(injector.plane).sort()).toEqual(["active", "observe", "peek"]);
  });

  it("reports a fault to the component it targets and nobody else", async () => {
    const injector = createMechanicalInjector();
    await injector.inject(fault(), sandbox());

    expect(injector.plane.observe("hive.specialized.workorderiq")?.fault).toBe("DUPLICATE_EVENT");
    expect(injector.plane.observe("hive.specialized.costiq")).toBeNull();
  });

  it("counts observations", async () => {
    const injector = createMechanicalInjector();
    await injector.inject(fault(), sandbox());
    injector.plane.observe("hive.specialized.workorderiq");
    injector.plane.observe("hive.specialized.workorderiq");
    expect(injector.history()[0]!.observations).toBe(2);
  });

  it("lets peek check without counting", async () => {
    const injector = createMechanicalInjector();
    await injector.inject(fault(), sandbox());
    injector.plane.peek("hive.specialized.workorderiq", "DUPLICATE_EVENT");
    expect(injector.history()[0]!.observations).toBe(0);
  });

  it("expires a fault after its observation budget", async () => {
    // How "it fails once then recovers" gets expressed without the executor
    // knowing anything about time.
    const injector = createMechanicalInjector();
    await injector.inject(
      fault({ fault: "DEPENDENCY_TIMEOUT", parameters: { expiresAfterObservations: 2 } }),
      sandbox(),
    );

    expect(injector.plane.observe("hive.specialized.workorderiq")).not.toBeNull();
    expect(injector.plane.observe("hive.specialized.workorderiq")).not.toBeNull();
    expect(injector.plane.observe("hive.specialized.workorderiq")).toBeNull();
  });

  it("clears everything on request", async () => {
    const injector = createMechanicalInjector();
    await injector.inject(fault(), sandbox());
    await injector.clear();
    expect(injector.plane.active()).toEqual([]);
  });
});

describe("every fault produces evidence a detector can act on", () => {
  it("gives each supported fault a defined effect", () => {
    // A fault that produces no detectable evidence tests nothing.
    for (const f of SUPPORTED_FAULTS) {
      const effect = effectOf({
        fault: f,
        targetComponentId: "c",
        parameters: {},
        observations: 1,
      });
      expect(effect.detail, f).not.toContain("bug in the injector");
      const hasSignal = effect.shouldFail || Object.keys(effect.facts).length > 0;
      expect(hasSignal, f).toBe(true);
    }
  });

  it("makes a duplicate succeed rather than fail", () => {
    // The interesting case is one that succeeds twice. A duplicate that fails
    // loudly is the system working.
    const effect = effectOf({
      fault: "DUPLICATE_EVENT",
      targetComponentId: "c",
      parameters: {},
      observations: 1,
    });
    expect(effect.shouldFail).toBe(false);
    expect(effect.facts.duplicateDelivered).toBe(true);
  });

  it("makes a tenant mismatch succeed rather than fail", () => {
    // Same reasoning: a mismatch that errors is the system working. The
    // dangerous case is the one that crosses the boundary quietly.
    const effect = effectOf({
      fault: "TENANT_MISMATCH",
      targetComponentId: "c",
      parameters: { foreignTenantId: "other-shop" },
      observations: 1,
    });
    expect(effect.shouldFail).toBe(false);
    expect(effect.facts.tenantId).toBe("other-shop");
  });

  it("produces facts the detectors actually read", () => {
    // The coupling is deliberate: injected fault -> evidence facts -> detected
    // violation. Verified end to end here rather than assumed.
    const corruption = effectOf({
      fault: "STATE_CORRUPTION",
      targetComponentId: "hive.specialized.inventoryiq",
      parameters: { onHand: 100, available: 90, reserved: 4 },
      observations: 1,
    });

    const verdict = classifier.assess(
      ["HIVE-INV-INVENTORY-001"],
      [
        {
          evidenceId: "ev_1",
          kind: "state_transition",
          locator: "test://ev_1",
          componentId: "hive.specialized.inventoryiq",
          observedAt: "2026-08-29T10:00:00.000Z",
          sensitivity: "internal",
          summary: corruption.detail,
          facts: corruption.facts,
        },
      ],
    )[0]!;

    expect(verdict.verdict).toBe("VIOLATED");
  });

  it("turns a partial workflow failure into a detectable recovery violation", () => {
    const effect = effectOf({
      fault: "PARTIAL_WORKFLOW_FAILURE",
      targetComponentId: "hive.specialized.workorderiq",
      parameters: {},
      observations: 1,
    });

    const verdict = classifier.assess(
      ["HIVE-INV-RECOVERY-001"],
      [
        {
          evidenceId: "ev_1",
          kind: "state_transition",
          locator: "test://ev_1",
          componentId: "hive.specialized.workorderiq",
          observedAt: "2026-08-29T10:00:00.000Z",
          sensitivity: "internal",
          summary: effect.detail,
          facts: effect.facts,
        },
      ],
    )[0]!;

    expect(verdict.verdict).toBe("VIOLATED");
  });

  it("returns no effect when nothing is active", () => {
    expect(effectOf(null).shouldFail).toBe(false);
    expect(effectOf(null).facts).toEqual({});
  });
});

describe("a corpus fault-injection scenario now actually injects", () => {
  const duplicateScenario = (): Scenario =>
    corpus.scenarios.find((s) => s.faultClass === "DUPLICATE_DELIVERY")!;

  it("no longer returns INCONCLUSIVE for a mechanically-expressible fault", async () => {
    // The whole point. Before this injector existed, this scenario reported
    // INCONCLUSIVE because nothing could produce its fault.
    const injector = createMechanicalInjector({ now: () => new Date("2026-08-29T10:00:00.000Z") });
    const scenario = duplicateScenario();

    const result = await runScenario(scenario, {
      sandbox: sandbox(),
      injector,
      executor: {
        async execute(ctx) {
          const active = injector.plane.observe(scenario.components[0]!.componentId);
          const effect = effectOf(active);

          for (const kind of [
            "trace",
            "event",
            "state_transition",
            "audit_record",
            "governance_decision",
            "engine_health",
            "tenant_context",
            "contract_version",
          ]) {
            ctx.recorder.capture({
              evidenceId: `ev_${kind}`,
              kind,
              locator: `test://${kind}`,
              componentId: scenario.components[0]!.componentId,
              observedAt: "2026-08-29T10:00:00.000Z",
              summary: effect.detail,
              facts: {
                correlationId: ctx.correlationId,
                tenantId: "ksix",
                ...effect.facts,
                // The system under test does NOT suppress the duplicate.
                duplicateSuppressed: false,
              },
            });
          }
        },
      },
    });

    expect(result.ran).toBe(true);
    if (!result.ran) return;

    expect(result.run.injections[0]!.effective).toBe(true);
    expect(result.run.outcome).not.toBe("INCONCLUSIVE");
  });

  it("produces evidence that diagnoses the idempotency violation", async () => {
    const injector = createMechanicalInjector();
    const scenario = duplicateScenario();
    const component = scenario.components[0]!.componentId;

    const result = await runScenario(scenario, {
      sandbox: sandbox(),
      injector,
      executor: {
        async execute(ctx) {
          const effect = effectOf(injector.plane.observe(component));
          for (const kind of ["trace", "event", "state_transition", "audit_record", "governance_decision", "engine_health", "tenant_context", "contract_version"]) {
            ctx.recorder.capture({
              evidenceId: `ev_${kind}`,
              kind,
              locator: `test://${kind}`,
              componentId: component,
              observedAt: "2026-08-29T10:00:00.000Z",
              summary: effect.detail,
              facts: { correlationId: ctx.correlationId, ...effect.facts, duplicateSuppressed: false },
            });
          }
        },
      },
    });

    if (!result.ran) throw new Error("expected a run");

    const violations = classifier.violations(["HIVE-INV-IDEMPOTENCY-001"], result.run.evidence);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain("requires an idempotent consumer");
  });

  it("still reports honestly when the fault class has no mechanical form", async () => {
    // SOURCE_OF_TRUTH_THEFT is constitutional, not infrastructural. The
    // injector's existence does not change that.
    const theft = corpus.scenarios.find((s) => s.faultClass === "SOURCE_OF_TRUTH_THEFT")!;
    expect(mechanicalFaultFor(theft.faultClass)).toBeNull();

    const result = await runScenario(theft, {
      sandbox: sandbox(),
      injector: createMechanicalInjector(),
      executor: { async execute() {} },
    });

    if (!result.ran) throw new Error("expected a run");
    expect(result.run.injections[0]!.effective).toBe(false);
    expect(result.run.injections[0]!.ineffectiveBecause).toContain("no mechanical equivalent");
    expect(result.run.outcome).toBe("INCONCLUSIVE");
  });
});
