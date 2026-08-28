// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// What an engine asks an intelligence for.
//
// Provider-independent by construction: there is no `model` field, no
// `temperature`, no message array, and nothing named after a vendor. An engine
// states the TASK and the SHAPE it needs back; choosing a model to satisfy that
// is the runtime's job, and keeping the choice out of here is what lets a
// provider be replaced without touching a single engine.
//
// The temptation is always to add `model?: string` "just for this one case".
// The moment that exists, one engine pins itself to a model name, that name is
// deprecated, and the engine that was supposed to be portable now has a vendor
// migration in it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds of work an intelligence can be asked to do.
 *
 * Deliberately about the SHAPE of the problem, not the size of the model. A
 * caller says "extraction" and means "pull known fields out of this"; it does
 * not mean "use a small model", because which model is cheap enough for
 * extraction changes every few months.
 */
export const intelligenceTaskSchema = z.enum([
  /** Multi-step judgement where the reasoning matters as much as the answer. */
  "reasoning",
  /** Pull known fields out of unstructured input. */
  "extraction",
  /** Choose among a fixed set of labels. */
  "classification",
  /** Produce prose, a description, a name. */
  "generation",
  /** Interpret an image. */
  "vision",
  /** Produce a vector for similarity. */
  "embedding",
]);
export type IntelligenceTask = z.infer<typeof intelligenceTaskSchema>;

/**
 * How much the caller cares if this is wrong.
 *
 * Drives routing and fallback: a `critical` request must not be quietly served
 * by a weaker fallback model, because the caller asked for care and would
 * rather have an error than a plausible wrong answer.
 */
export const stakesSchema = z.enum(["low", "normal", "critical"]);
export type Stakes = z.infer<typeof stakesSchema>;

export const intelligenceInputSchema = z
  .object({
    /** The instruction. What the model is being asked to do. */
    instruction: z.string().min(1),
    /** The material to work on. Kept separate so the two can be cached apart. */
    content: z.string().optional(),
    /**
     * Images, as opaque references rather than bytes.
     *
     * Bytes in a request travel through every log, retry and queue that touches
     * it. A reference is resolved once, by whatever holds the artifact.
     */
    imageRefs: z.array(z.string().min(1)).optional(),
    /** Prior turns, when the task genuinely needs them. */
    priorTurns: z
      .array(z.object({ role: z.enum(["caller", "intelligence"]), text: z.string() }).strict())
      .optional(),
  })
  .strict();
export type IntelligenceInput = z.infer<typeof intelligenceInputSchema>;

export const intelligenceRequestSchema = z
  .object({
    /** Which engine is asking. Required — an unattributed call cannot be billed,
     *  rate-limited, or explained to whoever asks why spend went up. */
    engineId: z.string().min(1),
    /** What the engine was doing, e.g. "classify-receipt-line". */
    operation: z.string().min(1),
    task: intelligenceTaskSchema,
    stakes: stakesSchema.default("normal"),
    input: intelligenceInputSchema,
    /**
     * The shape required back, as a JSON Schema fragment.
     *
     * Present for every task except generation and embedding. A caller that
     * cannot say what shape it needs is a caller that will parse prose with a
     * regular expression.
     */
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    /** Ties the call to the work that caused it. */
    correlationId: z.string().min(1),
    /**
     * The version of the instruction, set by the caller.
     *
     * Required so an eval can say "this regression appeared when the prompt
     * changed" rather than leaving somebody to guess.
     */
    instructionVersion: z.string().min(1),
    /** Hard ceiling. A request with no budget can spend without limit. */
    maxCostUsd: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type IntelligenceRequest = z.infer<typeof intelligenceRequestSchema>;

// ── Responses ────────────────────────────────────────────────────────────────

/** What it cost, in tokens and money, and how confident the money figure is. */
export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /**
     * Estimated, and labelled as such everywhere it surfaces.
     *
     * Prices change without notice and a table in a repository goes stale
     * silently. `pricedAt` is what lets a reader judge whether to trust it.
     */
    estimatedCostUsd: z.number().nonnegative().optional(),
    pricedAt: z.string().optional(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

export interface IntelligenceResponse<T = unknown> {
  readonly requestId: string;
  readonly engineId: string;
  readonly operation: string;
  readonly correlationId: string;
  /** The structured result, already validated against `outputSchema`. */
  readonly output: T;
  /** Which provider and model actually served it. Never chosen by the caller. */
  readonly servedBy: { provider: string; model: string; modelVersion?: string };
  /** True when the primary route failed and a fallback answered. */
  readonly viaFallback: boolean;
  readonly usage: Usage;
  readonly latencyMs: number;
  readonly instructionVersion: string;
  /** Attempts made, including the successful one. */
  readonly attempts: number;
}

/**
 * Why a request could not be served.
 *
 * Separated into the cases a caller acts on differently. An engine can
 * reasonably retry a `timeout` later, must not retry `budget_exceeded` without
 * changing something, and should treat `invalid_output` as a bug in its own
 * schema or instruction rather than a provider problem.
 */
export const intelligenceFailureSchema = z.enum([
  "no_route",
  "timeout",
  "provider_error",
  "rate_limited",
  "invalid_output",
  "budget_exceeded",
  "refused",
]);
export type IntelligenceFailure = z.infer<typeof intelligenceFailureSchema>;

export class IntelligenceError extends Error {
  constructor(
    readonly failure: IntelligenceFailure,
    message: string,
    readonly detail?: { provider?: string; model?: string; attempts?: number },
  ) {
    super(message);
    this.name = "IntelligenceError";
  }

  /** Whether trying again unchanged could plausibly work. */
  get retryable(): boolean {
    return this.failure === "timeout" || this.failure === "rate_limited" || this.failure === "provider_error";
  }
}

/**
 * The port an engine depends on.
 *
 * One method. An engine that holds this cannot discover which provider is
 * behind it, cannot name a model, and cannot reach anything vendor-specific —
 * which is the entire point.
 */
export interface Intelligence {
  run<T = unknown>(request: IntelligenceRequest): Promise<IntelligenceResponse<T>>;
}

/**
 * An intelligence that refuses everything.
 *
 * The default for a host that has not configured one. Engines must cope with
 * this: an AI capability that is unavailable should degrade to the deterministic
 * path, not break the product.
 */
export const UNAVAILABLE_INTELLIGENCE: Intelligence = {
  run: () =>
    Promise.reject(
      new IntelligenceError("no_route", "No intelligence provider is configured for this host."),
    ),
};
