// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  IntelligenceError,
  type Intelligence,
  type IntelligenceRequest,
  type IntelligenceResponse,
} from "@proworks-hub/intelligence-core";

import { compareRuns, runEvalSuite, type EvalSuite } from "../evals.js";

const suite: EvalSuite = {
  id: "receipt-extraction",
  engineId: "receiptiq",
  operation: "extract-line-items",
  task: "extraction",
  cases: [
    {
      id: "simple-total",
      description: "A receipt with one obvious total.",
      input: { instruction: "Extract the total.", content: "TOTAL 42.00" },
      expectation: { kind: "contains", fields: { total: 42 } },
      weight: 1,
      tags: [],
    },
    {
      id: "known-failure",
      description: "A layout that broke in production once.",
      input: { instruction: "Extract the total.", content: "42.00 <- TOTAL" },
      expectation: { kind: "contains", fields: { total: 42 } },
      // Weighted, because a case added after an incident matters more than one
      // somebody invented while writing the suite.
      weight: 3,
      tags: ["regression"],
    },
  ],
};

/** An intelligence that answers from a lookup, so a run is deterministic. */
function stub(answers: Record<string, unknown>, options: { failOn?: string } = {}): Intelligence {
  return {
    run: async <T,>(request: IntelligenceRequest): Promise<IntelligenceResponse<T>> => {
      const caseId = request.correlationId.split(":").pop()!;
      if (options.failOn === caseId) throw new IntelligenceError("provider_error", "provider down");
      return {
        requestId: request.correlationId,
        engineId: request.engineId,
        operation: request.operation,
        correlationId: request.correlationId,
        output: answers[caseId] as T,
        servedBy: { provider: "stub", model: "stub-1" },
        viaFallback: false,
        usage: { inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.001 },
        latencyMs: 20,
        instructionVersion: request.instructionVersion,
        attempts: 1,
      };
    },
  };
}

const bothRight = { "simple-total": { total: 42 }, "known-failure": { total: 42 } };
const oneWrong = { "simple-total": { total: 42 }, "known-failure": { total: 4200 } };

describe("running a suite", () => {
  it("scores by weight, not by count", async () => {
    // The weighted case is worth three of the other, so failing it costs more
    // than a naive pass count would suggest.
    const run = await runEvalSuite({ suite, intelligence: stub(oneWrong), instructionVersion: "v1" });
    expect(run.passed).toBe(1);
    expect(run.failed).toBe(1);
    expect(run.score).toBeCloseTo(1 / 4);
  });

  it("scores a clean run at 1", async () => {
    const run = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v1" });
    expect(run.score).toBe(1);
  });

  it("counts an erroring case as a failure", async () => {
    // Excluding errors would let a model that fails half the time score full
    // marks on the half it answered.
    const run = await runEvalSuite({
      suite,
      intelligence: stub(bothRight, { failOn: "simple-total" }),
      instructionVersion: "v1",
    });
    expect(run.failed).toBe(1);
    expect(run.results.find((r) => r.caseId === "simple-total")?.detail).toContain("provider down");
  });

  it("accepts extra fields the model returned", async () => {
    // Pinning the exact shape turns every additive change into a red suite,
    // and a suite that is always red is one nobody reads.
    const run = await runEvalSuite({
      suite,
      intelligence: stub({ "simple-total": { total: 42, currency: "GBP" }, "known-failure": { total: 42 } }),
      instructionVersion: "v1",
    });
    expect(run.score).toBe(1);
  });

  it("records what it cost", async () => {
    const run = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v1" });
    expect(run.estimatedCostUsd).toBeCloseTo(0.002);
  });

  it("fails a case whose predicate does not exist", async () => {
    // Skipping it would let a renamed predicate silently delete a check, and
    // the suite would go green by testing less.
    const withPredicate: EvalSuite = {
      ...suite,
      cases: [
        {
          ...suite.cases[0]!,
          expectation: { kind: "predicate", predicate: "isPlausibleTotal" },
        },
      ],
    };
    const run = await runEvalSuite({
      suite: withPredicate,
      intelligence: stub(bothRight),
      instructionVersion: "v1",
      predicates: {},
    });
    expect(run.failed).toBe(1);
    expect(run.results[0]?.detail).toContain("no predicate named");
  });

  it("runs a predicate that does exist", async () => {
    const withPredicate: EvalSuite = {
      ...suite,
      cases: [{ ...suite.cases[0]!, expectation: { kind: "predicate", predicate: "isPlausibleTotal" } }],
    };
    const run = await runEvalSuite({
      suite: withPredicate,
      intelligence: stub(bothRight),
      instructionVersion: "v1",
      predicates: {
        isPlausibleTotal: (output) =>
          typeof (output as { total?: unknown }).total === "number" || "total is not a number",
      },
    });
    expect(run.score).toBe(1);
  });
});

describe("comparing a candidate against a baseline", () => {
  it("names the cases that regressed", async () => {
    const baseline = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v1" });
    const candidate = await runEvalSuite({ suite, intelligence: stub(oneWrong), instructionVersion: "v2" });

    const comparison = compareRuns(baseline, candidate);
    expect(comparison.regressions).toEqual(["known-failure"]);
    expect(comparison.safe).toBe(false);
  });

  it("names the cases that were fixed", async () => {
    const baseline = await runEvalSuite({ suite, intelligence: stub(oneWrong), instructionVersion: "v1" });
    const candidate = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v2" });

    const comparison = compareRuns(baseline, candidate);
    expect(comparison.fixes).toEqual(["known-failure"]);
    expect(comparison.safe).toBe(true);
    expect(comparison.scoreDelta).toBeGreaterThan(0);
  });

  it("is unsafe when a case regressed even if the score improved", async () => {
    // The whole reason this returns cases rather than a number. A candidate can
    // score higher while breaking the case somebody added after an incident.
    const wide: EvalSuite = {
      ...suite,
      cases: [
        { ...suite.cases[0]!, weight: 1 },
        { ...suite.cases[1]!, weight: 1 },
        {
          id: "extra-a",
          description: "Another layout.",
          input: { instruction: "Extract the total.", content: "TOTAL: 9" },
          expectation: { kind: "contains", fields: { total: 9 } },
          weight: 5,
          tags: [],
        },
      ],
    };

    const baseline = await runEvalSuite({
      suite: wide,
      intelligence: stub({ "simple-total": { total: 42 }, "known-failure": { total: 42 }, "extra-a": { total: 0 } }),
      instructionVersion: "v1",
    });
    const candidate = await runEvalSuite({
      suite: wide,
      intelligence: stub({ "simple-total": { total: 42 }, "known-failure": { total: 0 }, "extra-a": { total: 9 } }),
      instructionVersion: "v2",
    });

    const comparison = compareRuns(baseline, candidate);
    expect(comparison.scoreDelta).toBeGreaterThan(0);
    expect(comparison.regressions).toEqual(["known-failure"]);
    expect(comparison.safe).toBe(false);
  });

  it("treats a check that stopped running as a regression", async () => {
    // Deleting a failing case is not the same as fixing it, and a comparison
    // that ignored the absence would reward exactly that.
    const baseline = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v1" });
    const smaller: EvalSuite = { ...suite, cases: [suite.cases[0]!] };
    const candidate = await runEvalSuite({ suite: smaller, intelligence: stub(bothRight), instructionVersion: "v2" });

    const comparison = compareRuns(baseline, candidate);
    expect(comparison.regressions).toEqual(["known-failure"]);
    expect(comparison.safe).toBe(false);
  });

  it("reports latency and cost movement", async () => {
    const baseline = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v1" });
    const candidate = await runEvalSuite({ suite, intelligence: stub(bothRight), instructionVersion: "v2" });
    const comparison = compareRuns(baseline, candidate);
    expect(comparison.latencyDeltaMs).toBe(0);
    expect(comparison.costDeltaUsd).toBeCloseTo(0);
  });
});
