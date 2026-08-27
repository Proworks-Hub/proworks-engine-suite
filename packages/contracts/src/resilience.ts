// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// What happens when delivery goes wrong.
//
// The failure that matters is not a consumer erroring — that is ordinary. It is
// an event that fails, gets retried forever, and silently disappears while
// everything behind it waits. Or worse: a validation error retried a thousand
// times, because nothing distinguished "the broker is down" from "this payload
// will never be valid".
//
// So the central idea here is the smallest one: **not every failure is worth
// retrying.** A transient failure deserves backoff. A permanent failure
// deserves a dead letter and a human, immediately — retrying it burns the
// budget that the transient failures behind it needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A failure that may succeed if tried again: a broker that is down, a lock
 * that is held, a timeout, a rate limit.
 */
export class TransientError extends Error {
  readonly transient = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "TransientError";
  }
}

/**
 * A failure that will never succeed however many times it is tried: a payload
 * that does not validate, a reference to something that does not exist, a rule
 * the data breaks.
 *
 * Throwing this is how a consumer says "do not retry me, fetch a human".
 */
export class PermanentError extends Error {
  readonly transient = false as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "PermanentError";
  }
}

/**
 * Classifies an unknown thrown value.
 *
 * Unmarked errors are treated as TRANSIENT, and that default is deliberate.
 * Guessing "permanent" on an unfamiliar error dead-letters work that would have
 * succeeded on the next attempt; guessing "transient" costs a few retries and
 * then dead-letters it anyway. One default loses work, the other loses time.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof PermanentError) return false;
  if (error instanceof TransientError) return true;
  // Zod and other validation errors will never pass on a retry.
  if (error instanceof Error && /^(ZodError|ValidationError|TypeError|SyntaxError)$/.test(error.name)) {
    return false;
  }
  return true;
}

// ── Retry ────────────────────────────────────────────────────────────────────

export const retryPolicySchema = z
  .object({
    /** Total attempts including the first. 1 means never retry. */
    maxAttempts: z.number().int().min(1).default(3),
    /** First backoff, doubled each attempt. */
    baseDelayMs: z.number().int().min(0).default(50),
    /** Ceiling, so a long backoff does not become an outage of its own. */
    maxDelayMs: z.number().int().min(0).default(5_000),
    /**
     * Random spread applied to each delay, 0–1.
     *
     * Without it, everything that failed together retries together, and the
     * recovering dependency is hit by exactly the burst that knocked it over.
     */
    jitter: z.number().min(0).max(1).default(0.2),
  })
  .strict();
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 50,
  maxDelayMs: 5_000,
  jitter: 0.2,
};

/**
 * Delay before a given attempt, with exponential backoff and jitter.
 * `attempt` is 1-based; the delay before the first retry is `attempt = 1`.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const spread = capped * policy.jitter;
  return Math.max(0, Math.round(capped - spread / 2 + random() * spread));
}

// ── Dead letters ─────────────────────────────────────────────────────────────

export const deadLetterSchema = z
  .object({
    deadLetterId: z.string().min(1),
    /** The event exactly as published, so it can be replayed unchanged. */
    event: z.unknown(),
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    /** Which consumer gave up. Others may have succeeded on the same event. */
    consumer: z.string().min(1),
    attempts: z.number().int().min(1),
    /** Why it was abandoned, in a form a human can act on. */
    reason: z.string().min(1),
    errorName: z.string().min(1),
    /** Whether retrying was even attempted, so the log is not misread. */
    classification: z.enum(["transient", "permanent"]),
    firstFailedAt: z.string().min(1),
    deadLetteredAt: z.string().min(1),
    /** Carried so a dead letter can be tied back to the work that caused it. */
    trace: traceContextSchema,
  })
  .strict();
export type DeadLetter = z.infer<typeof deadLetterSchema>;

/**
 * Where events go when a consumer has given up on them.
 *
 * A port, because Family Table would keep these in IndexedDB and ProWorks in
 * Postgres. The requirement is only that they do not vanish: an event nobody
 * can find is indistinguishable from one that was handled, and that is how
 * quiet data loss happens.
 */
export interface DeadLetterQueue {
  record(letter: DeadLetter): Promise<void> | void;
  list(filter?: { consumer?: string; eventType?: string; limit?: number }):
    | Promise<DeadLetter[]>
    | DeadLetter[];
  /** Removes one, after an operator has dealt with it or replayed it. */
  resolve(deadLetterId: string): Promise<void> | void;
}

// ── Circuit breaking ─────────────────────────────────────────────────────────

/**
 * A circuit breaker exists for one situation: a dependency is down, and every
 * call to it is going to fail after a timeout.
 *
 * Retrying through that is worse than useless. Each attempt holds a worker for
 * the full timeout, so a slow dependency does not just fail — it consumes the
 * capacity that the healthy work behind it needed. Opening the circuit turns a
 * slow failure into a fast one, which is the difference between one engine
 * being down and everything being down.
 */
export type CircuitState =
  /** Calls flow. Failures are counted. */
  | "closed"
  /** Calls fail immediately without being attempted. */
  | "open"
  /** One call is let through to see whether the dependency came back. */
  | "half-open";

export interface CircuitBreakerPolicy {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** How long to stay open before letting a probe through. */
  openDurationMs: number;
  /** Consecutive successes on probes before closing again. */
  successThreshold: number;
}

export const DEFAULT_CIRCUIT_POLICY: CircuitBreakerPolicy = {
  failureThreshold: 5,
  openDurationMs: 30_000,
  successThreshold: 2,
};

/**
 * Raised instead of calling a dependency whose circuit is open.
 *
 * Transient by classification: the dependency is expected back, and the caller
 * should treat this as "try later", not "this will never work".
 */
export class CircuitOpenError extends Error {
  readonly transient = true as const;
  constructor(
    readonly circuit: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `Circuit "${circuit}" is open — not attempting the call. Retry in ${retryAfterMs}ms. ` +
        `Failing fast here is what stops a slow dependency consuming the capacity healthy work needs.`,
    );
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreaker {
  /** Runs the work, or refuses immediately if the circuit is open. */
  run<T>(circuit: string, work: () => Promise<T> | T): Promise<T>;
  state(circuit: string): CircuitState;
  /** Forces a circuit closed — an operator saying "it is fixed, try now". */
  reset(circuit: string): void;
}
