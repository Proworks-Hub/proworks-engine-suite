// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import type { Intelligence, IntelligenceRequest } from "@proworks-hub/intelligence-core";

// ─────────────────────────────────────────────────────────────────────────────
// Making a model change measurable instead of arguable.
//
// Without this, "the new model is better" is a claim somebody made after
// looking at four outputs they chose. With it, a change is a number against a
// fixed set of cases, and a regression is a specific case that used to pass.
//
// The design decision that matters most: a run reports WHICH CASES CHANGED, not
// just a score. Two runs that both score 0.8 can disagree about every single
// case, and an aggregate that hides that is how a "no worse" model ships and
// breaks a customer's particular workflow.
// ─────────────────────────────────────────────────────────────────────────────

export const evalCaseSchema = z
  .object({
    id: z.string().min(1),
    /** What this case is checking, for whoever reads a failure in six months. */
    description: z.string().min(1),
    input: z.object({ instruction: z.string().min(1), content: z.string().optional() }).strict(),
    /**
     * What a correct answer looks like.
     *
     * Deliberately not a single expected string. Most useful cases have several
     * acceptable answers, and a suite that demands one exact output measures
     * conformity to a previous model rather than correctness.
     */
    expectation: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("exact"), value: z.unknown() }).strict(),
      z.object({ kind: z.literal("contains"), fields: z.record(z.string(), z.unknown()) }).strict(),
      z.object({ kind: z.literal("oneOf"), values: z.array(z.unknown()).min(1) }).strict(),
      /** A named predicate the suite's owner supplies. */
      z.object({ kind: z.literal("predicate"), predicate: z.string().min(1) }).strict(),
    ]),
    /** Cases that matter more, e.g. a past production failure. */
    weight: z.number().positive().default(1),
    tags: z.array(z.string()).default([]),
  })
  .strict();
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalSuiteSchema = z
  .object({
    id: z.string().min(1),
    engineId: z.string().min(1),
    operation: z.string().min(1),
    task: z.string().min(1),
    cases: z.array(evalCaseSchema).min(1),
  })
  .strict();
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export interface CaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly output: unknown;
  readonly detail?: string;
  readonly latencyMs: number;
  readonly estimatedCostUsd?: number;
  readonly servedBy: { provider: string; model: string };
}

export interface EvalRun {
  readonly suiteId: string;
  readonly ranAt: string;
  /** What was being tested. Both, because either can cause a regression. */
  readonly instructionVersion: string;
  readonly results: readonly CaseResult[];
  /** Weighted pass rate, 0..1. */
  readonly score: number;
  readonly passed: number;
  readonly failed: number;
  readonly totalLatencyMs: number;
  readonly estimatedCostUsd?: number;
}

export type Predicates = Record<string, (output: unknown) => boolean | string>;

function judge(expectation: EvalCase["expectation"], output: unknown, predicates: Predicates): { passed: boolean; detail?: string } {
  switch (expectation.kind) {
    case "exact":
      return JSON.stringify(output) === JSON.stringify(expectation.value)
        ? { passed: true }
        : { passed: false, detail: `expected ${JSON.stringify(expectation.value)}` };

    case "oneOf":
      return expectation.values.some((value) => JSON.stringify(value) === JSON.stringify(output))
        ? { passed: true }
        : { passed: false, detail: "not one of the accepted answers" };

    case "contains": {
      if (output === null || typeof output !== "object") {
        return { passed: false, detail: "output is not an object" };
      }
      const record = output as Record<string, unknown>;
      // Only the named fields are checked. A model returning MORE than asked is
      // not a failure — pinning the exact shape turns every additive change
      // into a red suite and trains people to ignore it.
      for (const [key, value] of Object.entries(expectation.fields)) {
        if (JSON.stringify(record[key]) !== JSON.stringify(value)) {
          return { passed: false, detail: `field "${key}" was ${JSON.stringify(record[key])}` };
        }
      }
      return { passed: true };
    }

    case "predicate": {
      const predicate = predicates[expectation.predicate];
      // A missing predicate FAILS the case. Skipping it would let a renamed
      // predicate silently remove a check, and the suite would go green by
      // testing less.
      if (!predicate) return { passed: false, detail: `no predicate named "${expectation.predicate}"` };
      const verdict = predicate(output);
      return verdict === true ? { passed: true } : { passed: false, detail: typeof verdict === "string" ? verdict : "predicate returned false" };
    }
  }
}

export interface RunEvalOptions {
  suite: EvalSuite;
  intelligence: Intelligence;
  instructionVersion: string;
  predicates?: Predicates;
  outputSchema?: Record<string, unknown>;
  now?: () => number;
}

export async function runEvalSuite(options: RunEvalOptions): Promise<EvalRun> {
  const now = options.now ?? (() => Date.now());
  const predicates = options.predicates ?? {};
  const results: CaseResult[] = [];
  let cost = 0;
  let sawCost = false;

  for (const testCase of options.suite.cases) {
    const request: IntelligenceRequest = {
      engineId: options.suite.engineId,
      operation: options.suite.operation,
      task: options.suite.task as IntelligenceRequest["task"],
      stakes: "normal",
      input: { instruction: testCase.input.instruction, ...(testCase.input.content ? { content: testCase.input.content } : {}) },
      correlationId: `eval:${options.suite.id}:${testCase.id}`,
      instructionVersion: options.instructionVersion,
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    };

    const started = now();
    try {
      const response = await options.intelligence.run(request);
      const verdict = judge(testCase.expectation, response.output, predicates);
      if (response.usage.estimatedCostUsd !== undefined) {
        cost += response.usage.estimatedCostUsd;
        sawCost = true;
      }
      results.push({
        caseId: testCase.id,
        passed: verdict.passed,
        output: response.output,
        ...(verdict.detail ? { detail: verdict.detail } : {}),
        latencyMs: response.latencyMs,
        ...(response.usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: response.usage.estimatedCostUsd }),
        servedBy: { provider: response.servedBy.provider, model: response.servedBy.model },
      });
    } catch (cause) {
      // An erroring case is a failing case. Excluding errors would let a model
      // that fails half the time score full marks on the half it answered.
      results.push({
        caseId: testCase.id,
        passed: false,
        output: null,
        detail: cause instanceof Error ? cause.message : String(cause),
        latencyMs: now() - started,
        servedBy: { provider: "none", model: "none" },
      });
    }
  }

  const weightOf = new Map(options.suite.cases.map((testCase) => [testCase.id, testCase.weight]));
  const totalWeight = options.suite.cases.reduce((sum, testCase) => sum + testCase.weight, 0);
  const earned = results.reduce(
    (sum, result) => sum + (result.passed ? (weightOf.get(result.caseId) ?? 1) : 0),
    0,
  );

  return {
    suiteId: options.suite.id,
    ranAt: new Date(now()).toISOString(),
    instructionVersion: options.instructionVersion,
    results,
    score: totalWeight === 0 ? 0 : earned / totalWeight,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    totalLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
    ...(sawCost ? { estimatedCostUsd: cost } : {}),
  };
}

// ── Comparing runs ───────────────────────────────────────────────────────────

export interface EvalComparison {
  readonly scoreDelta: number;
  /** Cases that passed on the baseline and fail now. The reason this exists. */
  readonly regressions: readonly string[];
  /** Cases that failed before and pass now. */
  readonly fixes: readonly string[];
  readonly latencyDeltaMs: number;
  readonly costDeltaUsd?: number;
  /** True when nothing regressed, whatever the score did. */
  readonly safe: boolean;
}

/**
 * Compares a candidate against a baseline.
 *
 * The verdict is NOT "did the score go up". A candidate can score higher while
 * breaking cases that used to work, and those cases are usually the ones
 * somebody added after a production incident. `safe` is false whenever anything
 * regressed, regardless of the aggregate.
 */
export function compareRuns(baseline: EvalRun, candidate: EvalRun): EvalComparison {
  const before = new Map(baseline.results.map((result) => [result.caseId, result.passed]));
  const after = new Map(candidate.results.map((result) => [result.caseId, result.passed]));

  const regressions: string[] = [];
  const fixes: string[] = [];

  for (const [caseId, passedBefore] of before) {
    const passedAfter = after.get(caseId);
    // A case present in the baseline and absent from the candidate counts as a
    // regression: the check stopped running, which is not the same as passing.
    if (passedAfter === undefined) {
      if (passedBefore) regressions.push(caseId);
      continue;
    }
    if (passedBefore && !passedAfter) regressions.push(caseId);
    if (!passedBefore && passedAfter) fixes.push(caseId);
  }

  return {
    scoreDelta: candidate.score - baseline.score,
    regressions,
    fixes,
    latencyDeltaMs: candidate.totalLatencyMs - baseline.totalLatencyMs,
    ...(baseline.estimatedCostUsd !== undefined && candidate.estimatedCostUsd !== undefined
      ? { costDeltaUsd: candidate.estimatedCostUsd - baseline.estimatedCostUsd }
      : {}),
    safe: regressions.length === 0,
  };
}
