// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  IntelligenceError,
  intelligenceRequestSchema,
  type Intelligence,
  type IntelligenceRequest,
  type IntelligenceResponse,
  type Usage,
} from "@proworks-hub/intelligence-core";

import { estimateCost, type ModelDescriptor, type ModelRegistry } from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// Turning a task into an answer.
//
// This is the only place that knows a provider exists. Engines hold the
// `Intelligence` port; adapters hold vendor SDKs; this sits between and owns
// the parts everyone otherwise reimplements badly: routing, timeout, retry,
// fallback, output validation and cost.
//
// The rules it encodes are the ones that go wrong quietly:
//
//   A FALLBACK IS NOT FREE. Substituting a weaker model changes the answer, so
//   `viaFallback` is on every response and a critical request will not accept
//   one it was not cleared for.
//
//   AN UNVALIDATED STRUCTURED OUTPUT IS NOT A RESULT. A model that returns
//   almost-JSON has failed, and passing it on turns a provider problem into a
//   parsing bug three layers away.
//
//   NO SECRETS HERE. Adapters hold credentials. This file never sees one, so a
//   log line from it cannot leak one.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderCall {
  model: ModelDescriptor;
  request: IntelligenceRequest;
  signal: AbortSignal;
}

export interface ProviderResult {
  /** Raw text, or an already-parsed object when the provider guarantees shape. */
  raw: string | Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number };
  modelVersion?: string;
}

/**
 * What a vendor adapter implements.
 *
 * Deliberately tiny. An adapter translates one call and reports usage; it does
 * not retry, route, validate or price, because five adapters doing those five
 * ways is how behaviour becomes provider-dependent.
 */
export interface ProviderAdapter {
  readonly provider: string;
  call(input: ProviderCall): Promise<ProviderResult>;
}

export interface RuntimeTelemetry {
  onAttempt?(event: {
    engineId: string;
    operation: string;
    provider: string;
    model: string;
    attempt: number;
    outcome: "success" | "failure";
    failure?: string;
    latencyMs: number;
    usage?: Usage;
    correlationId: string;
    instructionVersion: string;
  }): void;
}

export interface ModelRuntimeOptions {
  registry: ModelRegistry;
  adapters: readonly ProviderAdapter[];
  telemetry?: RuntimeTelemetry;
  /** Attempts per model before moving to the next route. */
  attemptsPerModel?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  /** Validates output against the request's schema. Injected so the runtime
   *  does not depend on a particular JSON Schema library. */
  validateOutput?(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; error: string };
}

/** Parses a provider's text into an object, or fails clearly. */
function parseStructured(raw: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof raw !== "string") return raw;

  // Providers habitually wrap JSON in prose or a fenced block. Recovering from
  // that is worth doing once here rather than in every engine — but only by
  // extracting a complete object, never by patching what looks broken.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new IntelligenceError(
      "invalid_output",
      "The model did not return a JSON object matching the requested shape.",
    );
  }
}

export function createModelRuntime(options: ModelRuntimeOptions): Intelligence {
  const attemptsPerModel = options.attemptsPerModel ?? 2;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const byProvider = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));

  return {
    async run<T>(rawRequest: IntelligenceRequest): Promise<IntelligenceResponse<T>> {
      const request = intelligenceRequestSchema.parse(rawRequest);
      const routes = options.registry.routesFor(request.task, request.stakes);

      if (routes.length === 0) {
        throw new IntelligenceError(
          "no_route",
          `No model is registered for task "${request.task}" at stakes "${request.stakes}".`,
        );
      }

      let attempts = 0;
      let lastError: IntelligenceError | undefined;

      for (const [routeIndex, model] of routes.entries()) {
        const adapter = byProvider.get(model.provider);
        if (!adapter) {
          // A route naming an adapter nobody registered is a configuration
          // error, not a reason to fail the request while other routes remain.
          lastError = new IntelligenceError("no_route", `No adapter for provider "${model.provider}".`);
          continue;
        }

        for (let tries = 0; tries < attemptsPerModel; tries += 1) {
          attempts += 1;
          const started = now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultTimeoutMs);

          try {
            const result = await adapter.call({ model, request, signal: controller.signal });
            const latencyMs = now() - started;

            const cost = estimateCost(model, result.usage);
            const usage: Usage = { ...result.usage, ...(cost ?? {}) };

            // Checked AFTER the call, because the true cost is only known once
            // the tokens are. A pre-flight estimate would be a guess, and a
            // guess is the wrong thing to enforce a budget with.
            if (
              request.maxCostUsd !== undefined &&
              usage.estimatedCostUsd !== undefined &&
              usage.estimatedCostUsd > request.maxCostUsd
            ) {
              throw new IntelligenceError(
                "budget_exceeded",
                `Call cost an estimated $${usage.estimatedCostUsd.toFixed(4)}, over the $${request.maxCostUsd} ceiling.`,
              );
            }

            let output: unknown = result.raw;
            if (request.outputSchema) {
              output = parseStructured(result.raw);
              const validation = options.validateOutput?.(output, request.outputSchema);
              if (validation && !validation.ok) {
                // A shape the caller cannot rely on is not a result. Failing
                // here turns a provider problem into a provider problem,
                // instead of a parsing bug three layers away.
                throw new IntelligenceError("invalid_output", validation.error, {
                  provider: model.provider,
                  model: model.model,
                });
              }
            }

            options.telemetry?.onAttempt?.({
              engineId: request.engineId,
              operation: request.operation,
              provider: model.provider,
              model: model.model,
              attempt: attempts,
              outcome: "success",
              latencyMs,
              usage,
              correlationId: request.correlationId,
              instructionVersion: request.instructionVersion,
            });

            return {
              requestId: `${request.correlationId}:${request.engineId}:${attempts}`,
              engineId: request.engineId,
              operation: request.operation,
              correlationId: request.correlationId,
              output: output as T,
              servedBy: {
                provider: model.provider,
                model: model.model,
                ...(result.modelVersion ? { modelVersion: result.modelVersion } : {}),
              },
              // True whenever the first route did not serve it. Surfaced
              // because a fallback changes the answer, and an operator
              // comparing two outputs needs to know they came from different
              // models.
              viaFallback: routeIndex > 0,
              usage,
              latencyMs,
              instructionVersion: request.instructionVersion,
              attempts,
            };
          } catch (cause) {
            const latencyMs = now() - started;
            const error =
              cause instanceof IntelligenceError
                ? cause
                : new IntelligenceError(
                    controller.signal.aborted ? "timeout" : "provider_error",
                    cause instanceof Error ? cause.message : String(cause),
                    { provider: model.provider, model: model.model },
                  );
            lastError = error;

            options.telemetry?.onAttempt?.({
              engineId: request.engineId,
              operation: request.operation,
              provider: model.provider,
              model: model.model,
              attempt: attempts,
              outcome: "failure",
              failure: error.failure,
              latencyMs,
              correlationId: request.correlationId,
              instructionVersion: request.instructionVersion,
            });

            // A budget ceiling is the caller's decision, not a transient
            // fault. Retrying or falling back would spend more money to
            // disobey the instruction.
            if (error.failure === "budget_exceeded") throw error;

            // Retrying the same model with the same input produces the same
            // malformed output. Move on rather than burning the attempt.
            if (error.failure === "invalid_output") break;
          } finally {
            clearTimeout(timeout);
          }
        }
      }

      throw (
        lastError ??
        new IntelligenceError("provider_error", "Every route failed without reporting a reason.")
      );
    },
  };
}
