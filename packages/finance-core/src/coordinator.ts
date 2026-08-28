// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { RequestContext } from "@proworks-hub/contracts";

import type {
  FinanceAnswer,
  FinanceCapability,
  FinanceRegistry,
  FinanceRequest,
  FinanceSpecialist,
} from "./registry.js";

// ─────────────────────────────────────────────────────────────────────────────
// The coordinator.
//
// Prime asks a DOMAIN question — "what is the financial impact of this?" — and
// this decides which specialist answers, calls it, and normalizes the result.
// Prime never learns that CostIQ exists.
//
// Rule 12 is most of the code here. One failed specialist must not collapse the
// Hive, so every call has a timeout, a failure is a typed outcome rather than a
// thrown exception, and a request touching several capabilities returns what
// succeeded alongside what did not.
//
// PARTIAL IS A FIRST-CLASS ANSWER. "Cost is £412; margin could not be computed
// because BudgetIQ is unavailable" is far more useful than an error, and it is
// the shape a shop owner can act on.
// ─────────────────────────────────────────────────────────────────────────────

export type FinanceFailure =
  | "no_specialist"
  | "timeout"
  | "specialist_error"
  | "not_permitted";

export interface FinanceRefusal {
  readonly capability: FinanceCapability;
  readonly failure: FinanceFailure;
  /** In words an operator can act on. */
  readonly reason: string;
  readonly specialist?: string;
}

export type FinanceOutcome<TOutput = unknown> =
  | { ok: true; answer: FinanceAnswer<TOutput> }
  | { ok: false; refusal: FinanceRefusal };

export interface CoordinatorOptions {
  registry: FinanceRegistry;
  /** Per-specialist ceiling. A hung specialist must not hold Prime open. */
  timeoutMs?: number;
  /** Try the next candidate when the first fails. */
  allowFallback?: boolean;
  now?: () => number;
  /** Reports every attempt, for the console. */
  onAttempt?(event: {
    capability: FinanceCapability;
    specialist: string;
    outcome: "success" | "failure";
    failure?: FinanceFailure;
    latencyMs: number;
    correlationId: string;
  }): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    // Cleared in `finally`, or a slow-but-successful call leaves a timer
    // holding the process open for its full duration.
    if (timer) clearTimeout(timer);
  }
}

export interface FinanceCoordinator {
  /** Answers one capability. */
  ask<TOutput = unknown>(request: FinanceRequest): Promise<FinanceOutcome<TOutput>>;
  /**
   * Answers several, returning everything that worked and everything that did
   * not. The shape Prime actually wants for a cross-capability question.
   */
  askAll(
    requests: readonly FinanceRequest[],
  ): Promise<{ answers: FinanceAnswer[]; refusals: FinanceRefusal[]; complete: boolean }>;
  /** What this Core can answer right now, and how healthy its specialists are. */
  status(): Promise<{
    core: "finance";
    capabilities: FinanceCapability[];
    specialists: { id: string; healthy: boolean | null; detail: string }[];
  }>;
}

export function createFinanceCoordinator(options: CoordinatorOptions): FinanceCoordinator {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  const attempt = async (
    specialist: FinanceSpecialist,
    request: FinanceRequest,
  ): Promise<FinanceOutcome> => {
    const started = now();
    try {
      const output = await withTimeout(specialist.handle(request), timeoutMs);
      const latencyMs = now() - started;

      options.onAttempt?.({
        capability: request.capability,
        specialist: specialist.id,
        outcome: "success",
        latencyMs,
        correlationId: request.correlationId,
      });

      return {
        ok: true,
        answer: { capability: request.capability, output, servedBy: specialist.id, latencyMs },
      };
    } catch (cause) {
      const latencyMs = now() - started;
      const timedOut = cause instanceof Error && cause.message === "timeout";
      const failure: FinanceFailure = timedOut ? "timeout" : "specialist_error";

      options.onAttempt?.({
        capability: request.capability,
        specialist: specialist.id,
        outcome: "failure",
        failure,
        latencyMs,
        correlationId: request.correlationId,
      });

      return {
        ok: false,
        refusal: {
          capability: request.capability,
          failure,
          specialist: specialist.id,
          reason: timedOut
            ? `${specialist.id} did not answer within ${timeoutMs}ms.`
            : `${specialist.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
  };

  const coordinator: FinanceCoordinator = {
    async ask<TOutput>(request: FinanceRequest): Promise<FinanceOutcome<TOutput>> {
      const candidates = options.registry.candidates(request.capability);

      if (candidates.length === 0) {
        // Not an error — a statement about what this installation has. A host
        // with no BudgetIQ genuinely cannot forecast, and saying so beats a
        // stack trace.
        return {
          ok: false,
          refusal: {
            capability: request.capability,
            failure: "no_specialist",
            reason: `No registered specialist answers "${request.capability}" in this installation.`,
          },
        };
      }

      const usable = options.allowFallback ? candidates : candidates.slice(0, 1);
      let last: FinanceOutcome | undefined;

      for (const specialist of usable) {
        const outcome = await attempt(specialist, request);
        if (outcome.ok) return outcome as FinanceOutcome<TOutput>;
        last = outcome;
      }

      return last as FinanceOutcome<TOutput>;
    },

    async askAll(requests) {
      const answers: FinanceAnswer[] = [];
      const refusals: FinanceRefusal[] = [];

      // Sequential rather than parallel. Financial specialists share a database
      // and a tenant, and firing six concurrent requests at one shop's data is
      // how a coordinator becomes the thing that causes the timeouts it then
      // reports.
      for (const request of requests) {
        const outcome = await coordinator.ask(request);
        if (outcome.ok) answers.push(outcome.answer);
        else refusals.push(outcome.refusal);
      }

      return { answers, refusals, complete: refusals.length === 0 };
    },

    async status() {
      const specialists = await Promise.all(
        options.registry.registered().map(async (specialist) => {
          if (!specialist.health) {
            // Null, not false. A specialist that does not report health has not
            // said it is unwell, and rendering it as unhealthy would produce a
            // console full of red for engines that are fine.
            return { id: specialist.id, healthy: null, detail: "Does not report health." };
          }
          try {
            const health = await withTimeout(specialist.health(), timeoutMs);
            return { id: specialist.id, healthy: health.healthy, detail: health.detail };
          } catch {
            return { id: specialist.id, healthy: false, detail: "Health check did not answer." };
          }
        }),
      );

      return { core: "finance" as const, capabilities: options.registry.capabilities(), specialists };
    },
  };

  return coordinator;
}

/**
 * Builds the request Prime sends for a domain question.
 *
 * Exists so correlation and causation are attached in one place. A coordinator
 * that let callers assemble these by hand would eventually receive one without
 * a correlation id, and that request becomes invisible in every trace.
 */
export function financeRequest<TInput>(input: {
  capability: FinanceCapability;
  input: TInput;
  context: RequestContext;
  correlationId: string;
  causationId?: string;
}): FinanceRequest<TInput> {
  return {
    capability: input.capability,
    input: input.input,
    context: input.context,
    correlationId: input.correlationId,
    ...(input.causationId ? { causationId: input.causationId } : {}),
  };
}
