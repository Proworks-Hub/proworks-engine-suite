// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it, vi } from "vitest";
import { IntelligenceError, type IntelligenceRequest } from "@proworks-hub/intelligence-core";

import { createModelRegistry, estimateCost, priceAgeDays } from "../registry.js";
import { createModelRuntime, type ProviderAdapter, type ProviderResult } from "../runtime.js";

const PRIMARY = {
  provider: "alpha",
  model: "alpha-large",
  tasks: ["reasoning", "extraction", "classification"],
  preference: 10,
  allowedForCritical: true,
  supportsStructuredOutput: true,
  pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15, pricedAt: "2026-08-01T00:00:00.000Z" },
};

const CHEAP = {
  provider: "beta",
  model: "beta-small",
  tasks: ["extraction", "classification"],
  preference: 50,
  allowedForCritical: false,
  supportsStructuredOutput: false,
  pricing: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4, pricedAt: "2026-08-01T00:00:00.000Z" },
};

const registry = createModelRegistry([PRIMARY, CHEAP]);

const adapter = (
  provider: string,
  impl: ProviderAdapter["call"],
): ProviderAdapter => ({ provider, call: impl });

const ok = (raw: string | Record<string, unknown>): ProviderResult => ({
  raw,
  usage: { inputTokens: 1_000, outputTokens: 200 },
});

const request = (over: Partial<IntelligenceRequest> = {}): IntelligenceRequest => ({
  engineId: "receiptiq",
  operation: "extract-line-items",
  task: "extraction",
  stakes: "normal",
  input: { instruction: "Extract the line items." },
  correlationId: "corr-1",
  instructionVersion: "v3",
  ...over,
});

describe("routing", () => {
  it("prefers the better-ranked model", async () => {
    const runtime = createModelRuntime({
      registry,
      adapters: [adapter("alpha", async () => ok("{}")), adapter("beta", async () => ok("{}"))],
    });
    const response = await runtime.run(request());
    expect(response.servedBy.model).toBe("alpha-large");
    expect(response.viaFallback).toBe(false);
  });

  it("refuses when no model serves the task", async () => {
    const runtime = createModelRuntime({ registry, adapters: [adapter("alpha", async () => ok("{}"))] });
    await expect(runtime.run(request({ task: "vision" }))).rejects.toThrow(/No model is registered/);
  });

  it("will not serve a critical request from a model not cleared for it", async () => {
    // A caller that said the answer matters would rather have an error than a
    // plausible answer from the cheap model.
    const cheapOnly = createModelRegistry([CHEAP]);
    const runtime = createModelRuntime({ registry: cheapOnly, adapters: [adapter("beta", async () => ok("{}"))] });
    await expect(runtime.run(request({ stakes: "critical" }))).rejects.toThrow(/No model is registered/);
  });

  it("skips a route whose adapter was never registered", async () => {
    // A configuration error, not a reason to fail while other routes remain.
    const runtime = createModelRuntime({ registry, adapters: [adapter("beta", async () => ok("{}"))] });
    const response = await runtime.run(request());
    expect(response.servedBy.provider).toBe("beta");
  });
});

describe("failure and fallback", () => {
  it("retries the same model before moving on", async () => {
    const alpha = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValue(ok("{}"));
    const runtime = createModelRuntime({ registry, adapters: [adapter("alpha", alpha)] });

    const response = await runtime.run(request());
    expect(alpha).toHaveBeenCalledTimes(2);
    expect(response.viaFallback).toBe(false);
  });

  it("falls back to the next model and says so", async () => {
    // A fallback changes the answer, so an operator comparing two outputs has
    // to be able to see they came from different models.
    const runtime = createModelRuntime({
      registry,
      adapters: [
        adapter("alpha", async () => {
          throw new Error("down");
        }),
        adapter("beta", async () => ok("{}")),
      ],
    });
    const response = await runtime.run(request());
    expect(response.servedBy.model).toBe("beta-small");
    expect(response.viaFallback).toBe(true);
  });

  it("reports a timeout as a timeout", async () => {
    const runtime = createModelRuntime({
      registry: createModelRegistry([PRIMARY]),
      adapters: [
        adapter("alpha", ({ signal }) =>
          new Promise<ProviderResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
        ),
      ],
      attemptsPerModel: 1,
    });

    await expect(runtime.run(request({ timeoutMs: 20 }))).rejects.toMatchObject({ failure: "timeout" });
  });

  it("marks transient failures retryable and permanent ones not", () => {
    expect(new IntelligenceError("timeout", "x").retryable).toBe(true);
    expect(new IntelligenceError("rate_limited", "x").retryable).toBe(true);
    expect(new IntelligenceError("invalid_output", "x").retryable).toBe(false);
    expect(new IntelligenceError("budget_exceeded", "x").retryable).toBe(false);
  });
});

describe("structured output is validated, not hoped for", () => {
  const schema = { type: "object", required: ["total"] };
  const validate = (value: unknown) =>
    value !== null && typeof value === "object" && "total" in value
      ? ({ ok: true } as const)
      : ({ ok: false, error: "missing total" } as const);

  it("parses JSON wrapped in a fenced block", async () => {
    // Providers habitually wrap JSON in prose. Recovering once here beats every
    // engine doing it differently.
    const runtime = createModelRuntime({
      registry,
      adapters: [adapter("alpha", async () => ok('Here you go:\n```json\n{"total": 42}\n```'))],
      validateOutput: validate,
    });
    const response = await runtime.run(request({ outputSchema: schema }));
    expect(response.output).toEqual({ total: 42 });
  });

  it("fails rather than passing on almost-JSON", async () => {
    const runtime = createModelRuntime({
      registry: createModelRegistry([PRIMARY]),
      adapters: [adapter("alpha", async () => ok("total: 42"))],
      validateOutput: validate,
      attemptsPerModel: 1,
    });
    await expect(runtime.run(request({ outputSchema: schema }))).rejects.toMatchObject({
      failure: "invalid_output",
    });
  });

  it("fails when the shape is valid JSON but wrong", async () => {
    const runtime = createModelRuntime({
      registry: createModelRegistry([PRIMARY]),
      adapters: [adapter("alpha", async () => ok('{"sum": 42}'))],
      validateOutput: validate,
      attemptsPerModel: 1,
    });
    await expect(runtime.run(request({ outputSchema: schema }))).rejects.toMatchObject({
      failure: "invalid_output",
    });
  });

  it("does not retry the same model after malformed output", async () => {
    // The same input produces the same malformed output. Retrying burns money
    // to learn nothing.
    const alpha = vi.fn(async () => ok("not json"));
    const runtime = createModelRuntime({
      registry: createModelRegistry([PRIMARY]),
      adapters: [adapter("alpha", alpha)],
      attemptsPerModel: 3,
      validateOutput: validate,
    });
    await expect(runtime.run(request({ outputSchema: schema }))).rejects.toThrow();
    expect(alpha).toHaveBeenCalledTimes(1);
  });

  it("leaves raw text alone when no shape was asked for", async () => {
    const runtime = createModelRuntime({
      registry,
      adapters: [adapter("alpha", async () => ok("a plain sentence"))],
    });
    const response = await runtime.run(request({ task: "reasoning" }));
    expect(response.output).toBe("a plain sentence");
  });
});

describe("cost", () => {
  it("estimates from the registry's prices", () => {
    const cost = estimateCost(registry.all()[0]!, { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(cost?.estimatedCostUsd).toBeCloseTo(3 + 1.5);
    expect(cost?.pricedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("returns nothing rather than zero when there is no price", () => {
    // Zero is a claim that the call was free, which is never true and makes a
    // spend dashboard read low.
    const unpriced = createModelRegistry([{ ...PRIMARY, pricing: undefined }]);
    expect(estimateCost(unpriced.all()[0]!, { inputTokens: 10, outputTokens: 10 })).toBeUndefined();
  });

  it("refuses a call that exceeds the caller's ceiling", async () => {
    const runtime = createModelRuntime({
      registry,
      adapters: [
        adapter("alpha", async () => ({ raw: "{}", usage: { inputTokens: 10_000_000, outputTokens: 0 } })),
      ],
    });
    await expect(runtime.run(request({ maxCostUsd: 0.01 }))).rejects.toMatchObject({
      failure: "budget_exceeded",
    });
  });

  it("does not fall back after a budget refusal", async () => {
    // Falling back would spend more money to disobey the instruction.
    const beta = vi.fn(async () => ok("{}"));
    const runtime = createModelRuntime({
      registry,
      adapters: [
        adapter("alpha", async () => ({ raw: "{}", usage: { inputTokens: 10_000_000, outputTokens: 0 } })),
        adapter("beta", beta),
      ],
    });
    await expect(runtime.run(request({ maxCostUsd: 0.01 }))).rejects.toThrow();
    expect(beta).not.toHaveBeenCalled();
  });

  it("reports how stale a price is", () => {
    const age = priceAgeDays("2026-08-01T00:00:00.000Z", new Date("2026-08-27T00:00:00.000Z"));
    expect(age).toBe(26);
    expect(priceAgeDays("not a date")).toBeNull();
  });
});

describe("telemetry", () => {
  it("reports every attempt, including the failures", async () => {
    const onAttempt = vi.fn();
    const runtime = createModelRuntime({
      registry,
      adapters: [
        adapter("alpha", async () => {
          throw new Error("down");
        }),
        adapter("beta", async () => ok("{}")),
      ],
      telemetry: { onAttempt },
      attemptsPerModel: 1,
    });

    await runtime.run(request());
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ outcome: "failure", provider: "alpha" });
    expect(onAttempt.mock.calls[1]![0]).toMatchObject({ outcome: "success", provider: "beta" });
  });

  it("carries the correlation and instruction version through", async () => {
    const onAttempt = vi.fn();
    const runtime = createModelRuntime({
      registry,
      adapters: [adapter("alpha", async () => ok("{}"))],
      telemetry: { onAttempt },
    });
    await runtime.run(request({ correlationId: "ord-99", instructionVersion: "v7" }));
    expect(onAttempt.mock.calls[0]![0]).toMatchObject({ correlationId: "ord-99", instructionVersion: "v7" });
  });
});

describe("the registry as data", () => {
  it("warns about models with an announced end date", () => {
    const soon = createModelRegistry([{ ...PRIMARY, deprecatedAfter: "2026-09-15T00:00:00.000Z" }]);
    expect(soon.deprecated(30, new Date("2026-08-27T00:00:00.000Z"))).toHaveLength(1);
    expect(soon.deprecated(5, new Date("2026-08-27T00:00:00.000Z"))).toHaveLength(0);
  });

  it("refuses a descriptor with fields nobody declared", () => {
    expect(() => createModelRegistry([{ ...PRIMARY, apiKey: "sk-secret" } as never])).toThrow();
  });
});
