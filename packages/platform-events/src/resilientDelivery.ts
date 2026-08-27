// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { DeadLetter, DeadLetterQueue, PlatformEvent, RetryPolicy } from "@proworks-hub/contracts";
import {
  DEFAULT_RETRY_POLICY,
  TransientError,
  backoffDelayMs,
  isTransient,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Delivering an event to one consumer, and deciding what to do when it fails.
//
// Separate from the bus on purpose. Retry and dead-letter policy is the same
// whichever transport is underneath, and a real broker adapter should be able
// to reuse this rather than reimplement it slightly differently.
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryOutcome {
  delivered: boolean;
  attempts: number;
  deadLettered: boolean;
  /** Present when delivery failed. */
  error?: Error;
}

export interface ResilientDeliveryOptions {
  retry?: RetryPolicy;
  deadLetters?: DeadLetterQueue;
  /**
   * A handler that never returns is worse than one that throws: it holds the
   * delivery open and everything behind it waits on work that will never
   * finish. A timeout converts that into an ordinary transient failure.
   */
  handlerTimeoutMs?: number;
  now?: () => Date;
  /** Injected so tests need not actually wait out a backoff. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  generateId?: () => string;
  onAttemptFailed?: (info: {
    event: PlatformEvent;
    consumer: string;
    attempt: number;
    error: Error;
    willRetry: boolean;
  }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultId = () => {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return typeof g.crypto?.randomUUID === "function"
    ? `dlq_${g.crypto.randomUUID()}`
    : `dlq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

async function withTimeout<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
  if (!ms || ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TransientError(`handler exceeded ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Delivers one event to one handler, retrying transient failures and
 * dead-lettering what it cannot deliver.
 *
 * The rule that matters: a PERMANENT failure is dead-lettered on the first
 * attempt. Retrying a payload that will never validate wastes the retry budget
 * that transient failures behind it needed, and delays the human who has to
 * look at it either way.
 */
export async function deliverWithResilience(
  event: PlatformEvent,
  consumer: string,
  handler: (event: PlatformEvent) => Promise<void> | void,
  options: ResilientDeliveryOptions = {},
): Promise<DeliveryOutcome> {
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const generateId = options.generateId ?? defaultId;

  let firstFailedAt: string | undefined;
  let lastError: Error | undefined;
  let attempt = 0;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
    try {
      await withTimeout(Promise.resolve(handler(event)), options.handlerTimeoutMs);
      return { delivered: true, attempts: attempt, deadLettered: false };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      lastError = error;
      firstFailedAt ??= now().toISOString();

      const transient = isTransient(error);
      const attemptsLeft = attempt < policy.maxAttempts;
      const willRetry = transient && attemptsLeft;

      options.onAttemptFailed?.({ event, consumer, attempt, error, willRetry });

      if (!willRetry) {
        if (options.deadLetters) {
          const letter: DeadLetter = {
            deadLetterId: generateId(),
            event,
            eventId: event.eventId,
            eventType: event.eventType,
            consumer,
            attempts: attempt,
            reason: error.message,
            errorName: error.name,
            classification: transient ? "transient" : "permanent",
            firstFailedAt,
            deadLetteredAt: now().toISOString(),
            trace: event.trace,
          };
          await options.deadLetters.record(letter);
        }
        return { delivered: false, attempts: attempt, deadLettered: Boolean(options.deadLetters), error };
      }

      await sleep(backoffDelayMs(attempt, policy, random));
    }
  }

  // Unreachable while maxAttempts >= 1, but a loop that can fall out without
  // an answer is a loop that will eventually surprise somebody.
  return {
    delivered: false,
    attempts: attempt,
    deadLettered: false,
    ...(lastError ? { error: lastError } : {}),
  };
}

/**
 * A dead-letter queue held in memory. Enough to assert behaviour in a test; a
 * host binds something durable, because surviving the restart is the point.
 */
export function createInMemoryDeadLetterQueue(): DeadLetterQueue & { size(): number } {
  const letters = new Map<string, DeadLetter>();
  return {
    record: (letter) => {
      letters.set(letter.deadLetterId, letter);
    },
    list: (filter) => {
      let all = [...letters.values()];
      if (filter?.consumer) all = all.filter((l) => l.consumer === filter.consumer);
      if (filter?.eventType) all = all.filter((l) => l.eventType === filter.eventType);
      return filter?.limit ? all.slice(0, filter.limit) : all;
    },
    resolve: (deadLetterId) => {
      letters.delete(deadLetterId);
    },
    size: () => letters.size,
  };
}
