// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { environmentSchema } from "./environment.js";
import type { InjectionRecord } from "./faults.js";
import type { Evidence, EvidenceCompleteness } from "../evidence/evidence.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Simulation Run record.
//
// Directive §3: "Every run must receive a unique run_id, scenario_id,
// scenario_version, execution_id, correlation_id" and must "produce a
// structured Simulation Run record."
//
// THE OUTCOME VOCABULARY IS THE IMPORTANT PART
//
// A run is not pass/fail. The corpus draws a distinction that a boolean would
// destroy: `mustPass` are conditions the run must satisfy, while
// `mustFailTheEngineIf` describes a condition under which THE ENGINE is broken
// rather than the test. Those are different findings with different owners —
// one is a scenario that did not hold, the other is a defect in the Hive.
//
// And a third case matters more than either: a run whose fault never actually
// landed. That is not a pass. It is an untested scenario wearing a green tick,
// and it is the single easiest way for a repair-learning corpus to become
// decorative.
// ─────────────────────────────────────────────────────────────────────────────

export const runOutcomeSchema = z.enum([
  /** Every mustPass held and no engine-failure condition was met. */
  "PASSED",
  /** A mustPass condition did not hold. The scenario found something. */
  "FAILED",
  /** `mustFailTheEngineIf` was met: the Hive is wrong, not the test. */
  "ENGINE_DEFECT",
  /**
   * The fault never landed, or required evidence was never captured.
   *
   * NOT a pass. A scenario that quietly ran without its fault reports success
   * for the wrong reason, and nothing downstream can tell the difference.
   */
  "INCONCLUSIVE",
  /** The harness itself broke. Says nothing about the Hive. */
  "HARNESS_ERROR",
]);
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

export const conditionResultSchema = z
  .object({
    condition: z.string().min(1),
    held: z.boolean(),
    /** Which evidence decided it. Empty means nothing did — see below. */
    evidenceIds: z.array(z.string().min(1)).default([]),
    detail: z.string().min(1),
  })
  .strict();
export type ConditionResult = z.infer<typeof conditionResultSchema>;

/**
 * A condition nothing evaluated.
 *
 * The corpus's mustPass conditions are prose ("one workOrderId", "Prime did not
 * persist WO"). A harness cannot mechanically evaluate every one of them, and
 * pretending otherwise is how a suite reports a thousand passes it never
 * checked. An unevaluated condition is recorded as exactly that.
 */
export function unevaluated(condition: string): ConditionResult {
  return {
    condition,
    held: false,
    evidenceIds: [],
    detail:
      "Not evaluated: no evaluator in this harness understands this condition. Recorded as unheld rather than assumed satisfied.",
  };
}

export interface SimulationRun {
  readonly runId: string;
  readonly scenarioId: string;
  readonly scenarioVersion: string;
  readonly executionId: string;
  readonly correlationId: string;

  readonly environment: z.infer<typeof environmentSchema>;
  readonly startedAt: string;
  readonly finishedAt: string;

  readonly injections: readonly InjectionRecord[];
  readonly evidence: readonly Evidence[];
  readonly evidenceCompleteness: EvidenceCompleteness;

  readonly mustPassResults: readonly ConditionResult[];
  readonly engineDefectCondition: ConditionResult;

  readonly outcome: RunOutcome;
  readonly outcomeReason: string;

  /**
   * Forbidden repair actions this scenario declares.
   *
   * Carried on the RUN, not looked up later, so that a repair candidate is
   * judged against the constraints of the failure it claims to fix rather than
   * against whatever the corpus says today.
   */
  readonly forbiddenRepairActions: readonly string[];

  /** Versions in play, for the signature and for reuse compatibility. */
  readonly versions: Readonly<Record<string, string>>;
}

/**
 * Decides the outcome from what actually happened.
 *
 * Order matters and is deliberate:
 *
 *   HARNESS_ERROR   we broke, so we know nothing
 *   INCONCLUSIVE    the fault did not land, so we tested nothing
 *   ENGINE_DEFECT   the Hive is wrong, which outranks a failed condition
 *   FAILED          a condition did not hold
 *   PASSED          everything held
 *
 * INCONCLUSIVE sits above the two failure states on purpose. A run whose fault
 * never landed cannot report ENGINE_DEFECT — whatever went wrong, it was not
 * the thing being tested, and attributing it to the engine would be a false
 * accusation drawn from an untested run.
 */
export function decideOutcome(input: {
  harnessError?: string;
  injections: readonly InjectionRecord[];
  faultExpected: boolean;
  evidenceCompleteness: EvidenceCompleteness;
  mustPassResults: readonly ConditionResult[];
  engineDefectCondition: ConditionResult;
}): { outcome: RunOutcome; reason: string } {
  if (input.harnessError) {
    return {
      outcome: "HARNESS_ERROR",
      reason: `The harness failed, so this run says nothing about the Hive: ${input.harnessError}`,
    };
  }

  if (input.faultExpected) {
    const landed = input.injections.filter((i) => i.effective);
    if (landed.length === 0) {
      const why = input.injections
        .map((i) => i.ineffectiveBecause ?? "no reason given")
        .join("; ");
      return {
        outcome: "INCONCLUSIVE",
        reason:
          "The scenario expected a fault and none was injected effectively, so nothing was actually tested. " +
          `Reported: ${why || "no injection was attempted"}.`,
      };
    }
  }

  if (!input.evidenceCompleteness.complete) {
    return {
      outcome: "INCONCLUSIVE",
      reason:
        "The scenario's required evidence was not captured, so its conditions cannot be judged from evidence: " +
        `${input.evidenceCompleteness.missing.join("; ")}.`,
    };
  }

  if (input.engineDefectCondition.held) {
    return {
      outcome: "ENGINE_DEFECT",
      reason: `The engine-failure condition was met: ${input.engineDefectCondition.detail}`,
    };
  }

  const broken = input.mustPassResults.filter((r) => !r.held);
  if (broken.length > 0) {
    return {
      outcome: "FAILED",
      reason: `${broken.length} of ${input.mustPassResults.length} required conditions did not hold: ${broken
        .map((b) => b.condition)
        .join("; ")}.`,
    };
  }

  return {
    outcome: "PASSED",
    reason: `All ${input.mustPassResults.length} required conditions held and no engine-failure condition was met.`,
  };
}

/** True when a run produced something worth diagnosing. */
export function warrantsDiagnosis(outcome: RunOutcome): boolean {
  return outcome === "FAILED" || outcome === "ENGINE_DEFECT";
}
