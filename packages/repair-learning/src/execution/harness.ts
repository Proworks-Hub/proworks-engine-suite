// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createEvidenceRecorder,
  type Evidence,
  type EvidenceRecorder,
} from "../evidence/evidence.js";
import type { Scenario } from "../scenario/scenario.js";
import {
  authorityCrossesTo,
  sandboxUsableFor,
  type Environment,
  type Sandbox,
} from "./environment.js";
import {
  injectableFaultSchema,
  injectionPermitted,
  mechanicalFaultFor,
  type FaultInjector,
  type InjectionRecord,
} from "./faults.js";
import {
  decideOutcome,
  unevaluated,
  type ConditionResult,
  type SimulationRun,
} from "./run.js";

// ─────────────────────────────────────────────────────────────────────────────
// The scenario execution harness (directive §3).
//
// Runs a scenario in a sandbox, injects its fault, lets a host-supplied executor
// drive the actual engines, captures evidence, evaluates conditions, and
// produces a Simulation Run record.
//
// WHAT THIS HARNESS DOES NOT DO
//
// It does not know how to drive ForgeIQ, or how to tell whether "Prime did not
// persist WO". Those are host concerns, injected as an executor and a set of
// condition evaluators. A harness that hard-coded them would work for exactly
// the engines in this repo and would violate §41's portability rule the first
// time somebody ran it elsewhere.
//
// What the harness owns is the parts that must be identical for every scenario:
// identity, environment gating, injection gating, evidence completeness, and the
// outcome rules — particularly the rule that an unevaluated condition counts as
// unheld and an uninjected fault makes the run INCONCLUSIVE.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates one of a scenario's prose conditions against captured evidence.
 *
 * Returns null when this evaluator does not understand the condition, so the
 * harness can record it as unevaluated rather than guessing.
 */
export interface ConditionEvaluator {
  readonly name: string;
  evaluate(condition: string, evidence: readonly Evidence[]): ConditionResult | null;
}

/** Drives the actual system under test. Host-supplied. */
export interface ScenarioExecutor {
  execute(context: {
    scenario: Scenario;
    sandbox: Sandbox;
    recorder: EvidenceRecorder;
    executionId: string;
    correlationId: string;
  }): Promise<void>;
}

export interface HarnessOptions {
  sandbox: Sandbox;
  executor: ScenarioExecutor;
  injector?: FaultInjector;
  evaluators?: readonly ConditionEvaluator[];
  /** Where the authority to run was established. Defaults to the sandbox's own. */
  authorityEstablishedIn?: Environment;
  generateId?: (prefix: string) => string;
  versions?: Readonly<Record<string, string>>;
}

export type RunResult =
  | { readonly ran: true; readonly run: SimulationRun }
  | { readonly ran: false; readonly reason: string };

function evaluateCondition(
  condition: string,
  evidence: readonly Evidence[],
  evaluators: readonly ConditionEvaluator[],
): ConditionResult {
  for (const evaluator of evaluators) {
    const result = evaluator.evaluate(condition, evidence);
    if (result) return result;
  }
  return unevaluated(condition);
}

export async function runScenario(
  scenario: Scenario,
  options: HarnessOptions,
): Promise<RunResult> {
  const newId =
    options.generateId ?? ((prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  const evaluators = options.evaluators ?? [];
  const authorityEstablishedIn = options.authorityEstablishedIn ?? options.sandbox.environment;

  // ── Gate before anything runs ─────────────────────────────────────────────
  const usable = sandboxUsableFor(options.sandbox, {
    scenarioType: scenario.scenarioType,
    faultClass: scenario.faultClass,
  });
  if (!usable.usable) return { ran: false, reason: usable.reason };

  const crossing = authorityCrossesTo(authorityEstablishedIn, options.sandbox.environment);
  if (!crossing.crosses) return { ran: false, reason: crossing.reason };

  const runId = newId("run");
  const executionId = newId("exec");
  const correlationId = newId("cor");
  const startedAt = options.sandbox.now().toISOString();
  const recorder = createEvidenceRecorder();

  // ── Inject ────────────────────────────────────────────────────────────────
  //
  // A scenario expects a fault when its type says so. Whether one can actually
  // be injected is a separate question, and the gap between the two is what
  // makes a run INCONCLUSIVE rather than passing.
  const faultExpected =
    scenario.scenarioType === "FAULT_INJECTION" || scenario.scenarioType === "CHAOS_FUZZ";
  const injections: InjectionRecord[] = [];

  if (faultExpected) {
    const mechanical = mechanicalFaultFor(scenario.faultClass);

    if (mechanical === null) {
      injections.push({
        fault: injectableFaultSchema.parse({
          fault: "STATE_CORRUPTION",
          targetComponentId: scenario.components[0]?.componentId ?? "unknown",
          parameters: {},
          intent: scenario.faultInjection ?? scenario.faultClass,
        }),
        injectedAt: options.sandbox.now().toISOString(),
        effective: false,
        ineffectiveBecause:
          `The corpus fault class "${scenario.faultClass}" has no mechanical equivalent, so nothing could be ` +
          "injected. It describes a constitutional failure rather than an infrastructure one, and inventing a " +
          "mechanical stand-in would make the run report a fault it never caused.",
      });
    } else if (!options.injector) {
      injections.push({
        fault: injectableFaultSchema.parse({
          fault: mechanical,
          targetComponentId: scenario.components[0]?.componentId ?? "unknown",
          parameters: {},
          intent: scenario.faultInjection ?? scenario.faultClass,
        }),
        injectedAt: options.sandbox.now().toISOString(),
        effective: false,
        ineffectiveBecause: "No fault injector was supplied to the harness.",
      });
    } else {
      const fault = injectableFaultSchema.parse({
        fault: mechanical,
        targetComponentId: scenario.components[0]?.componentId ?? "unknown",
        parameters: {},
        intent: scenario.faultInjection ?? scenario.faultClass,
      });

      const gate = injectionPermitted({
        fault,
        environment: options.sandbox.environment,
        authorityEstablishedIn,
      });

      if (!gate.permitted) {
        injections.push({
          fault,
          injectedAt: options.sandbox.now().toISOString(),
          effective: false,
          ineffectiveBecause: gate.reason,
        });
      } else if (!options.injector.supports.includes(mechanical)) {
        injections.push({
          fault,
          injectedAt: options.sandbox.now().toISOString(),
          effective: false,
          ineffectiveBecause: `This injector does not support ${mechanical}.`,
        });
      } else {
        injections.push(await options.injector.inject(fault, options.sandbox));
      }
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  let harnessError: string | undefined;
  try {
    await options.executor.execute({
      scenario,
      sandbox: options.sandbox,
      recorder,
      executionId,
      correlationId,
    });
  } catch (cause) {
    // The harness broke, which says nothing about the Hive. Distinguished from
    // a scenario failure so a broken harness cannot be read as a broken engine.
    harnessError = cause instanceof Error ? cause.message : String(cause);
  }

  const evidence = recorder.all();
  const evidenceCompleteness = recorder.completeness(scenario.requiredEvidence);

  const mustPassResults = scenario.expectation.mustPass.map((condition) =>
    evaluateCondition(condition, evidence, evaluators),
  );
  const engineDefectCondition = evaluateCondition(
    scenario.expectation.mustFailTheEngineIf,
    evidence,
    evaluators,
  );

  const { outcome, reason } = decideOutcome({
    ...(harnessError === undefined ? {} : { harnessError }),
    injections,
    faultExpected,
    evidenceCompleteness,
    mustPassResults,
    engineDefectCondition,
  });

  return {
    ran: true,
    run: {
      runId,
      scenarioId: scenario.id,
      scenarioVersion: scenario.schemaVersion,
      executionId,
      correlationId,
      environment: options.sandbox.environment,
      startedAt,
      finishedAt: options.sandbox.now().toISOString(),
      injections,
      evidence,
      evidenceCompleteness,
      mustPassResults,
      engineDefectCondition,
      outcome,
      outcomeReason: reason,
      forbiddenRepairActions: scenario.forbiddenRepairActions,
      versions: options.versions ?? {},
    },
  };
}
