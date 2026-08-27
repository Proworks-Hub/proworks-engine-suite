// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  CircuitBreaker,
  CircuitBreakerPolicy,
  CircuitState,
  RateLimitDecision,
  RateLimitRule,
  RateLimiter,
} from "@proworks-hub/contracts";
import { CircuitOpenError, DEFAULT_CIRCUIT_POLICY, isTransient } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaking and rate limiting, in memory.
//
// Both are per-process here, which is honest rather than ideal: three copies of
// a service each keep their own counts, so a limit of 100 becomes 300 and a
// circuit opens three times independently. That is fine for one process and
// wrong for a fleet — a fleet needs shared state behind the same ports, which
// is exactly why they are ports.
// ─────────────────────────────────────────────────────────────────────────────

interface CircuitRecord {
  state: CircuitState;
  failures: number;
  successes: number;
  openedAt?: number;
}

export interface InMemoryCircuitBreakerOptions {
  policy?: Partial<CircuitBreakerPolicy>;
  now?: () => number;
  onStateChange?: (circuit: string, from: CircuitState, to: CircuitState) => void;
}

export interface InMemoryCircuitBreaker extends CircuitBreaker {
  /** Every circuit and its state, for a dashboard or a test. */
  snapshot(): Array<{ circuit: string; state: CircuitState; failures: number }>;
}

export function createCircuitBreaker(options: InMemoryCircuitBreakerOptions = {}): InMemoryCircuitBreaker {
  const policy: CircuitBreakerPolicy = { ...DEFAULT_CIRCUIT_POLICY, ...options.policy };
  const now = options.now ?? (() => Date.now());
  const circuits = new Map<string, CircuitRecord>();

  const get = (circuit: string): CircuitRecord => {
    const existing = circuits.get(circuit);
    if (existing) return existing;
    const fresh: CircuitRecord = { state: "closed", failures: 0, successes: 0 };
    circuits.set(circuit, fresh);
    return fresh;
  };

  const transition = (circuit: string, record: CircuitRecord, to: CircuitState): void => {
    if (record.state === to) return;
    options.onStateChange?.(circuit, record.state, to);
    record.state = to;
    record.failures = 0;
    record.successes = 0;
    if (to === "open") record.openedAt = now();
  };

  return {
    async run<T>(circuit: string, work: () => Promise<T> | T): Promise<T> {
      const record = get(circuit);

      if (record.state === "open") {
        const elapsed = now() - (record.openedAt ?? 0);
        if (elapsed < policy.openDurationMs) {
          throw new CircuitOpenError(circuit, policy.openDurationMs - elapsed);
        }
        // Long enough. Let exactly one call through to see if it came back.
        transition(circuit, record, "half-open");
      }

      try {
        const result = await work();
        if (record.state === "half-open") {
          record.successes += 1;
          if (record.successes >= policy.successThreshold) transition(circuit, record, "closed");
        } else {
          // A success resets the count. The threshold is about CONSECUTIVE
          // failures — an occasional error under load is not an outage.
          record.failures = 0;
        }
        return result;
      } catch (cause) {
        // A permanent error says the REQUEST was wrong, not the dependency.
        // Counting it would open the circuit on bad input and deny service to
        // everyone else for a mistake one caller made.
        if (!isTransient(cause)) throw cause;

        if (record.state === "half-open") {
          transition(circuit, record, "open");
        } else {
          record.failures += 1;
          if (record.failures >= policy.failureThreshold) transition(circuit, record, "open");
        }
        throw cause;
      }
    },

    state: (circuit) => get(circuit).state,

    reset(circuit) {
      const record = get(circuit);
      transition(circuit, record, "closed");
    },

    snapshot: () =>
      [...circuits.entries()].map(([circuit, r]) => ({
        circuit,
        state: r.state,
        failures: r.failures,
      })),
  };
}

// ── Rate limiting ────────────────────────────────────────────────────────────

/**
 * A sliding-window limiter.
 *
 * Sliding rather than fixed: a fixed window lets a caller spend its whole
 * allowance at 11:59:59 and the next one at 12:00:00, which is twice the limit
 * in two seconds and defeats the point.
 */
/**
 * Narrower than the RateLimiter port: this one decides synchronously.
 *
 * Every concrete implementation in this suite narrows its port. A port that
 * returns `T | Promise<T>` typechecks wrong at each call site that forgets to
 * await, and tests do not catch it because they run with types stripped.
 */
export interface InMemoryRateLimiter extends RateLimiter {
  check(key: string, rule: RateLimitRule): RateLimitDecision;
  reset(key: string): void;
  size(): number;
}

export function createRateLimiter(options: { now?: () => number } = {}): InMemoryRateLimiter {
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    check(key: string, rule: RateLimitRule): RateLimitDecision {
      const at = now();
      const cutoff = at - rule.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

      if (recent.length >= rule.limit) {
        const oldest = recent[0]!;
        const retryAfterMs = Math.max(0, oldest + rule.windowMs - at);
        hits.set(key, recent);
        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(oldest + rule.windowMs).toISOString(),
          retryAfterMs,
        };
      }

      recent.push(at);
      hits.set(key, recent);
      return {
        allowed: true,
        remaining: rule.limit - recent.length,
        resetAt: new Date(at + rule.windowMs).toISOString(),
      };
    },

    reset(key) {
      hits.delete(key);
    },

    size: () => hits.size,
  };
}
