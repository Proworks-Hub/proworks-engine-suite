/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/pulse/flowControl.ts
 * Module:   neural-fabric / pulse
 * Purpose:  Saying no early, instead of collapsing later.
 */

import { type Lane, mayBeShed } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// AN UNBOUNDED QUEUE IS A CRASH WITH EXTRA STEPS
//
// §25: "No unbounded queues; saturation produces explicit slowdown or load
// shedding rather than memory collapse." §30 puts it as a design principle
// rather than an exception-handling detail, and the difference is visible in
// the failure:
//
//   Unbounded  — the queue grows, latency grows with it, memory grows, and the
//                process is killed. Everything in the queue is lost, including
//                the work that was already accepted, and there is no record of
//                what was in flight.
//   Bounded    — admission is refused at the door. The caller is told NOW, with
//                a reason, while it can still do something about it.
//
// The second is worse to look at on a dashboard and enormously better to
// operate. Refusing early is a feature.
//
// WHAT MAY BE SHED IS A LANE PROPERTY, NOT A LOAD PROPERTY
//
// Under pressure the temptation is to shed whatever is cheapest to drop. That
// is exactly backwards for evidence: the load spike and the incident are the
// same event, so shedding evidence deletes the record of the thing causing the
// problem. `mayBeShed` in the lane table settles it — EVIDENCE and COMMAND
// never, HEALTH always, and no local decision under pressure can override it.
//
// RETRY BUDGETS, BECAUSE RETRIES ARE LOAD
//
// A retry is another request. Unbudgeted retries turn a brief fault into a
// sustained overload that outlives it — the retry storm §17 warns about. The
// budget is per-window and shared, so one pathological caller cannot consume
// everyone's.
//
// Jitter is required, not optional. Without it, everything that failed at the
// same moment retries at the same moment, and the recovering dependency is hit
// by the same thundering herd on every backoff boundary.
// ─────────────────────────────────────────────────────────────────────────────

export interface QueueState {
  readonly queueKey: string;
  readonly depth: number;
  readonly capacity: number;
}

export interface AdmissionPolicy {
  /** Above this fraction, non-essential lanes are shed. */
  readonly shedAboveSaturation: number;
  /** Above this fraction, callers are told to slow down but still admitted. */
  readonly slowAboveSaturation: number;
}

export type AdmissionDecision =
  | { readonly admitted: true; readonly backpressure: "NONE" | "SLOW_DOWN"; readonly reason: string }
  | { readonly admitted: false; readonly reason: string; readonly retryable: boolean };

/**
 * Whether a signal may enter a bounded queue right now.
 *
 * Note the order: the queue being FULL is checked before the lane's shedding
 * eligibility. A full queue refuses everything, including evidence — because
 * at that point there is genuinely nowhere to put it, and pretending otherwise
 * means accepting a message that will be dropped silently later. Refusing with
 * a reason the caller can act on is the honest failure.
 */
export function admit(queue: QueueState, lane: Lane, policy: AdmissionPolicy): AdmissionDecision {
  if (queue.capacity <= 0) {
    return {
      admitted: false,
      retryable: false,
      reason: `Queue "${queue.queueKey}" has no capacity configured. A queue with no bound is not a queue, it is a memory leak with a name, so nothing is admitted to it.`,
    };
  }

  const saturation = queue.depth / queue.capacity;

  if (queue.depth >= queue.capacity) {
    return {
      admitted: false,
      retryable: true,
      reason: `Queue "${queue.queueKey}" is full at ${queue.depth}/${queue.capacity}. Refused at the door rather than accepted and dropped silently later — the caller is told now, while it can still do something.`,
    };
  }

  if (saturation >= policy.shedAboveSaturation && mayBeShed(lane)) {
    return {
      admitted: false,
      retryable: true,
      reason: `Queue "${queue.queueKey}" is ${Math.round(saturation * 100)}% full and the ${lane} lane is sheddable. Shedding this protects the lanes that are not — a superseded heartbeat costs nothing to lose, and the evidence behind it costs everything.`,
    };
  }

  if (saturation >= policy.slowAboveSaturation) {
    return {
      admitted: true,
      backpressure: "SLOW_DOWN",
      reason: `Admitted, but queue "${queue.queueKey}" is ${Math.round(saturation * 100)}% full. Slow down — this is the warning before shedding starts, and it exists so there is one.`,
    };
  }

  return {
    admitted: true,
    backpressure: "NONE",
    reason: `Admitted. Queue "${queue.queueKey}" is ${Math.round(saturation * 100)}% full.`,
  };
}

/**
 * Whether a lane may be shed under pressure.
 *
 * Delegates to the lane table rather than deciding locally, so a decision made
 * under load cannot override a decision made deliberately. Re-exported here
 * because this is where somebody looking to shed something will look.
 */
export function laneMayBeShed(lane: Lane): boolean {
  return mayBeShed(lane);
}

// ─────────────────────────────────────────────────────────────────────────────
// RETRY BUDGETS AND BACKOFF
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /**
   * The share of total sends that may be retries, within the window.
   *
   * A budget rather than a per-message limit. Per-message limits do not bound
   * total load: ten thousand messages each retrying three times is thirty
   * thousand extra requests, every one of them individually within its limit.
   */
  readonly retryBudgetFraction: number;
}

export interface RetryBudgetState {
  readonly windowKey: string;
  readonly sendsInWindow: number;
  readonly retriesInWindow: number;
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly reason: string }
  | { readonly retry: false; readonly reason: string; readonly deadLetter: boolean };

/**
 * Whether and when to retry.
 *
 * `random` is injected. Jitter without an injected source cannot be tested,
 * and a backoff nobody can test is a backoff nobody knows the shape of.
 */
export function decideRetry(
  attempt: number,
  policy: RetryPolicy,
  budget: RetryBudgetState,
  random: () => number,
): RetryDecision {
  if (attempt >= policy.maxAttempts) {
    return {
      retry: false,
      deadLetter: true,
      reason: `Attempt ${attempt} reached the limit of ${policy.maxAttempts}. Dead-lettered rather than dropped: it is not delivered, it is not lost, and somebody has to look at it.`,
    };
  }

  const allowedRetries = budget.sendsInWindow * policy.retryBudgetFraction;
  if (budget.retriesInWindow >= allowedRetries) {
    return {
      retry: false,
      deadLetter: true,
      reason: `The retry budget for this window is spent: ${budget.retriesInWindow} retries against ${budget.sendsInWindow} sends, at a ${Math.round(policy.retryBudgetFraction * 100)}% budget. Retrying anyway is how a brief fault becomes a sustained overload that outlives it.`,
    };
  }

  // Exponential, capped, then jittered across the FULL range rather than a
  // narrow band. Full jitter is what actually decorrelates a herd; jittering
  // by ±10% of a shared delay leaves every caller inside the same tenth of a
  // second.
  const exponential = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  const delayMs = Math.floor(random() * exponential);

  return {
    retry: true,
    delayMs,
    reason: `Attempt ${attempt + 1} of ${policy.maxAttempts}, after ${delayMs}ms. The delay is jittered across the whole ${exponential}ms window so callers that failed together do not retry together.`,
  };
}

/**
 * The share of the budget already spent, for reporting.
 *
 * Separate from the decision so an operator can see pressure building before
 * anything is refused.
 */
export function budgetPressure(policy: RetryPolicy, budget: RetryBudgetState): {
  readonly spent: number;
  readonly note: string;
} {
  if (budget.sendsInWindow === 0) {
    return {
      spent: 0,
      note: "No sends in this window, so no budget has been spent. This is not the same as a healthy path — nothing has been tried.",
    };
  }
  const allowed = budget.sendsInWindow * policy.retryBudgetFraction;
  const spent = allowed === 0 ? 1 : budget.retriesInWindow / allowed;
  return {
    spent,
    note:
      spent >= 1
        ? "The retry budget is spent. Further failures dead-letter immediately rather than adding load."
        : `${Math.round(spent * 100)}% of the retry budget is spent.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEAD LETTERS
// ─────────────────────────────────────────────────────────────────────────────

export interface DeadLetter {
  readonly fabricMessageId: string;
  readonly lane: Lane;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly reason: string;
  /**
   * Whether this can be replayed once the cause is fixed.
   *
   * False for anything whose lane is not replayable — a query whose caller
   * timed out long ago has nobody waiting for the answer, and delivering it
   * later is worse than not delivering it.
   */
  readonly replayable: boolean;
  readonly note: string;
}

/**
 * Records a message that could not be delivered.
 *
 * The distinction that matters is between a POISON message — one that will
 * fail identically every time — and a message that failed because something
 * downstream was temporarily unwell. Replaying the first wastes the same
 * capacity again; not replaying the second loses real work.
 */
export function deadLetter(input: {
  readonly fabricMessageId: string;
  readonly lane: Lane;
  readonly attempts: number;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly reason: string;
  /** True when every attempt failed the same way — a poison message. */
  readonly identicalFailures: boolean;
  readonly laneReplayable: boolean;
}): DeadLetter {
  const replayable = input.laneReplayable && !input.identicalFailures;
  return {
    fabricMessageId: input.fabricMessageId,
    lane: input.lane,
    attempts: input.attempts,
    firstFailedAt: input.firstFailedAt,
    lastFailedAt: input.lastFailedAt,
    reason: input.reason,
    replayable,
    note: input.identicalFailures
      ? "Every attempt failed the same way, so this is a poison message. Replaying it spends the same capacity to get the same failure — fix the cause, then replay deliberately."
      : input.laneReplayable
        ? "The failures differed, so this may be a transient fault rather than a bad message. Worth replaying once the cause is understood."
        : `The ${input.lane} lane is not replayable. Whoever was waiting for this has already stopped waiting, and delivering it now would be worse than not delivering it.`,
  };
}
