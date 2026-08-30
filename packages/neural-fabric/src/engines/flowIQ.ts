/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/flowIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Sharing capacity so one tenant's bad day is not everyone's.
 */

import type { Lane } from "../domain/lanes.js";
import type { Priority } from "../domain/envelope.js";

// ─────────────────────────────────────────────────────────────────────────────
// A GLOBAL RATE LIMIT PROTECTS THE SYSTEM AND NOT ITS USERS
//
// One limit across all traffic stops the system falling over and does nothing
// about the case that actually happens: one tenant, or one runaway workload,
// consuming the whole allowance while everybody else is throttled for a
// problem that is not theirs.
//
// So limits here are per SCOPE — a tenant, a capability, a workload — and the
// scope is part of the key. The failure it prevents is the support call that
// begins "our system is fine, why are we being rate limited".
//
// A TOKEN BUCKET, BECAUSE BURSTS ARE NORMAL
//
// A fixed window is simpler and wrong in a specific way: a caller sending its
// whole quota in the last second of one window and the first second of the
// next has sent double the rate across that boundary, and every fixed-window
// limiter permits it. A bucket that refills continuously has no boundary to
// exploit and lets a legitimate burst through — which matters because real
// traffic is bursty and a limiter that punishes normal behaviour gets raised
// until it stops limiting.
//
// PRIORITY IS A TIE-BREAK, NOT A BYPASS
//
// §6 and §11 make priority a fabric scheduling class bounded by policy. Here it
// decides who goes first when there is contention; it never creates capacity
// and never lets a caller past a limit. EMERGENCY traffic still consumes
// tokens, because an emergency that could spend an unlimited allowance is a
// denial of service with a good reason attached.
// ─────────────────────────────────────────────────────────────────────────────

export interface RateLimit {
  /** What is being limited: a tenant, a capability, a workload. */
  readonly scopeKey: string;
  /** Sustained rate, in permits per second. */
  readonly refillPerSecond: number;
  /** How much burst is allowed above the sustained rate. */
  readonly burstCapacity: number;
}

export interface BucketState {
  readonly scopeKey: string;
  readonly tokens: number;
  readonly lastRefillAt: string;
}

export type LimitDecision =
  | { readonly allowed: true; readonly state: BucketState; readonly remaining: number; readonly note: string }
  | { readonly allowed: false; readonly retryAfterMs: number; readonly note: string };

/**
 * Whether a signal fits within its scope's allowance.
 *
 * `now` is an argument, as everywhere else. A limiter that reads the clock
 * cannot be tested at a boundary, and the boundary is where every limiter bug
 * lives.
 */
export function consume(
  limit: RateLimit,
  state: BucketState | null,
  cost: number,
  now: string,
): LimitDecision {
  if (limit.refillPerSecond <= 0 || limit.burstCapacity <= 0) {
    return {
      allowed: false,
      retryAfterMs: 0,
      note: `The limit for "${limit.scopeKey}" permits nothing (${limit.refillPerSecond}/s, burst ${limit.burstCapacity}). A zero limit is a closed door, and it is reported as one rather than treated as "unlimited" — the opposite reading is how a misconfiguration becomes an outage in the wrong direction.`,
    };
  }

  const current = state ?? { scopeKey: limit.scopeKey, tokens: limit.burstCapacity, lastRefillAt: now };

  const elapsedMs = Math.max(0, Date.parse(now) - Date.parse(current.lastRefillAt));
  const refilled = Math.min(
    limit.burstCapacity,
    current.tokens + (elapsedMs / 1000) * limit.refillPerSecond,
  );

  if (refilled >= cost) {
    const remaining = refilled - cost;
    return {
      allowed: true,
      state: { scopeKey: limit.scopeKey, tokens: remaining, lastRefillAt: now },
      remaining,
      note: `Allowed. ${remaining.toFixed(1)} of ${limit.burstCapacity} permits remain for "${limit.scopeKey}".`,
    };
  }

  const deficit = cost - refilled;
  const retryAfterMs = Math.ceil((deficit / limit.refillPerSecond) * 1000);

  return {
    allowed: false,
    retryAfterMs,
    note: `"${limit.scopeKey}" is over its allowance: ${refilled.toFixed(1)} permits available and ${cost} needed. Retry after ${retryAfterMs}ms. The limit is per scope rather than global, so this is this caller's allowance and nobody else is being throttled for it.`,
  };
}

/**
 * Whether priority lets a caller past a rate limit.
 *
 * Always false. An emergency that could spend an unlimited allowance is a
 * denial of service with a good reason attached.
 */
export function priorityBypassesLimits(): false {
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULING UNDER CONTENTION
// ─────────────────────────────────────────────────────────────────────────────

export interface QueuedSignal {
  readonly signalId: string;
  readonly scopeKey: string;
  readonly lane: Lane;
  readonly priority: Priority;
  readonly enqueuedAt: string;
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = Object.freeze({
  EMERGENCY: 0,
  HIGH: 1,
  NORMAL: 2,
  BULK: 3,
});

export interface ScheduleResult {
  readonly order: readonly QueuedSignal[];
  /** Scopes that were held back to stop one consuming the whole queue. */
  readonly deprioritisedScopes: readonly string[];
  readonly note: string;
}

/**
 * The order to serve a contended queue in.
 *
 * Priority first, then AGE, then id. Age matters more than it looks: without
 * it, a steady stream of higher-priority work starves everything below it
 * indefinitely, and the starved work is invisible because it is still queued
 * rather than failed.
 *
 * `maxConsecutivePerScope` is the fairness valve. One scope holding a thousand
 * high-priority signals would otherwise occupy the whole queue while behaving
 * entirely within its rights.
 */
export function schedule(
  queued: readonly QueuedSignal[],
  maxConsecutivePerScope: number,
): ScheduleResult {
  const sorted = [...queued].sort((a, b) => {
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    const byAge = a.enqueuedAt.localeCompare(b.enqueuedAt);
    if (byAge !== 0) return byAge;
    return a.signalId.localeCompare(b.signalId);
  });

  const order: QueuedSignal[] = [];
  const held: QueuedSignal[] = [];
  const deprioritised = new Set<string>();
  let lastScope: string | null = null;
  let run = 0;

  for (const signal of sorted) {
    if (signal.scopeKey === lastScope) {
      run += 1;
    } else {
      lastScope = signal.scopeKey;
      run = 1;
    }

    if (run > maxConsecutivePerScope) {
      held.push(signal);
      deprioritised.add(signal.scopeKey);
      // Reset so the next scope gets a fair run rather than inheriting this
      // one's exhausted count.
      lastScope = null;
      run = 0;
      continue;
    }
    order.push(signal);
  }

  return {
    order: [...order, ...held],
    deprioritisedScopes: [...deprioritised].sort(),
    note:
      deprioritised.size === 0
        ? `${order.length} signals scheduled by priority, then age. Age matters: without it a steady stream of higher-priority work starves everything below it, and the starved work is invisible because it is still queued rather than failed.`
        : `${deprioritised.size} scope${deprioritised.size === 1 ? " was" : "s were"} held back after ${maxConsecutivePerScope} consecutive signals: ${[...deprioritised].sort().join(", ")}. Each was behaving entirely within its rights, and one scope occupying the whole queue is still everyone else's outage.`,
  };
}

/**
 * How much of a shared allowance each scope is using.
 *
 * Reported so pressure is visible before anything is refused. A limiter that
 * only speaks when it refuses gives an operator no warning and no way to tell
 * a spike from a trend.
 */
export function shareOfCapacity(
  usageByScope: ReadonlyMap<string, number>,
): {
  readonly shares: readonly { readonly scopeKey: string; readonly share: number }[];
  readonly dominant: string | null;
  readonly note: string;
} {
  const total = [...usageByScope.values()].reduce((a, b) => a + b, 0);

  if (total === 0) {
    return {
      shares: [],
      dominant: null,
      note: "No usage recorded. Not the same as healthy — nothing has been measured.",
    };
  }

  const shares = [...usageByScope.entries()]
    .map(([scopeKey, used]) => ({ scopeKey, share: used / total }))
    .sort((a, b) => b.share - a.share || a.scopeKey.localeCompare(b.scopeKey));

  const top = shares[0]!;
  const dominant = top.share >= 0.5 && shares.length > 1 ? top.scopeKey : null;

  return {
    shares,
    dominant,
    note:
      dominant === null
        ? `Capacity is spread across ${shares.length} scope${shares.length === 1 ? "" : "s"}, none taking half.`
        : `"${dominant}" is using ${Math.round(top.share * 100)}% of the capacity across ${shares.length} scopes. Not a fault and worth seeing before the limiter starts refusing, because a spike and a trend look identical at the moment of refusal.`,
  };
}
