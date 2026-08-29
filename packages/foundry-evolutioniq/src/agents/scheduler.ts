// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { AgentRuntime, TerminationRecord } from "./runtime.js";

// ─────────────────────────────────────────────────────────────────────────────
// The supervisor scheduler.
//
// `supervise()` existed and nothing called it, which made containment a
// capability rather than a behaviour. This drives it.
//
// HOST-AGNOSTIC MEANS THE TIMER IS INJECTED
//
// Nothing here imports a timer API. A `Ticker` is a thing that can arrange for
// a callback later and can be cancelled — `setInterval` satisfies it, so does a
// cron, so does a test that advances by hand, so does a Durable Object alarm or
// a Lambda schedule. §41's portability rule is the reason: a scheduler built on
// `setInterval` runs in Node and nowhere else, and the Hive is not promised to
// one runtime.
//
// A default Node ticker is provided at the foot of this file because making the
// common case require ceremony is how people write their own worse one.
//
// THREE FAILURE MODES THIS EXISTS TO PREVENT
//
// 1. OVERLAPPING SWEEPS. A sweep that takes longer than the interval must not
//    have a second one start beside it. Two concurrent sweeps can both decide
//    to terminate the same agent, and the second one operates on state the
//    first is halfway through changing.
//
// 2. A SWEEP THAT THROWS KILLING THE SCHEDULER. Containment that stops working
//    the first time something unexpected happens is containment that stops
//    working precisely when it is needed. Errors are caught, counted, and
//    surfaced — and the scheduler keeps going.
//
// 3. SILENT DEATH. A scheduler that stops sweeping and says nothing leaves
//    every agent unsupervised while the system reports itself healthy. Health
//    is derived from whether sweeps are actually happening, not from whether
//    `start()` was called.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A host's ability to arrange for something to happen later.
 *
 * Two methods, because that is all a scheduler needs and every extra method is
 * one more thing a host must implement to run the Hive on its platform.
 */
export interface Ticker {
  /** Arranges for `fn` to run repeatedly, roughly every `intervalMs`. */
  schedule(intervalMs: number, fn: () => void): void;
  /** Stops it. Must be safe to call when nothing is scheduled. */
  cancel(): void;
}

export interface SweepRecord {
  readonly sweepNumber: number;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly agentsChecked: number;
  readonly terminations: readonly TerminationRecord[];
  /** Set when the sweep threw. The scheduler continues regardless. */
  readonly error: string | null;
}

export const SUPERVISOR_HEALTH = ["healthy", "degraded", "unavailable", "stopped"] as const;
export type SupervisorHealth = (typeof SUPERVISOR_HEALTH)[number];

export interface SupervisorStatus {
  readonly running: boolean;
  readonly health: SupervisorHealth;
  readonly detail: string;
  readonly sweeps: number;
  readonly terminationsTotal: number;
  readonly consecutiveErrors: number;
  readonly lastSweepAt: string | null;
  /** Sweeps skipped because the previous one was still running. */
  readonly overlapsSkipped: number;
}

export interface SupervisorScheduler {
  start(): void;
  stop(): void;
  /**
   * Runs one sweep now.
   *
   * Exposed so a host can drive the supervisor from a cron, a queue message, or
   * a test — and so `start()` is a convenience over this rather than the only
   * way in.
   */
  tick(): Promise<SweepRecord>;
  status(): SupervisorStatus;
  history(limit?: number): readonly SweepRecord[];
}

export interface SupervisorSchedulerOptions {
  runtime: AgentRuntime;
  ticker: Ticker;
  intervalMs: number;
  now?: () => Date;
  /**
   * Consecutive errors before health is `unavailable`.
   *
   * Not one, because a single transient failure is noise. Not ten, because by
   * then the agents have been unsupervised for ten intervals.
   */
  unhealthyAfterConsecutiveErrors?: number;
  /**
   * How long a sweep may take before the scheduler reports itself degraded.
   *
   * A sweep slower than its own interval means overlaps are being skipped,
   * which means the effective supervision interval is longer than configured
   * and nobody was told.
   */
  slowSweepMs?: number;
  onSweep?: (record: SweepRecord) => void;
  onError?: (error: string, consecutive: number) => void;
  /** How many sweeps to retain. */
  historyLimit?: number;
}

export function createSupervisorScheduler(
  options: SupervisorSchedulerOptions,
): SupervisorScheduler {
  const now = options.now ?? (() => new Date());
  const unhealthyAfter = options.unhealthyAfterConsecutiveErrors ?? 3;
  const slowSweepMs = options.slowSweepMs ?? options.intervalMs;
  const historyLimit = options.historyLimit ?? 50;

  let running = false;
  let sweeping = false;
  let sweepNumber = 0;
  let consecutiveErrors = 0;
  let terminationsTotal = 0;
  let overlapsSkipped = 0;
  let lastSweepAt: string | null = null;
  let lastDurationMs = 0;
  const history: SweepRecord[] = [];

  const record = (entry: SweepRecord) => {
    history.push(entry);
    if (history.length > historyLimit) history.shift();
    options.onSweep?.(entry);
  };

  const tick = async (): Promise<SweepRecord> => {
    // ── Overlap guard ────────────────────────────────────────────────────────
    //
    // Two concurrent sweeps can both decide to terminate the same agent, and
    // the second operates on state the first is halfway through changing.
    // Skipping is the right answer rather than queueing: the next tick will
    // catch whatever this one would have.
    if (sweeping) {
      overlapsSkipped += 1;
      const skipped: SweepRecord = {
        sweepNumber,
        startedAt: now().toISOString(),
        durationMs: 0,
        agentsChecked: 0,
        terminations: [],
        error: "Skipped: the previous sweep is still running.",
      };
      record(skipped);
      return skipped;
    }

    sweeping = true;
    sweepNumber += 1;
    const startedAt = now();
    const agentsChecked = options.runtime.running().length;

    try {
      const terminations = await options.runtime.supervise();
      terminationsTotal += terminations.length;
      consecutiveErrors = 0;
      lastSweepAt = startedAt.toISOString();
      lastDurationMs = now().getTime() - startedAt.getTime();

      const entry: SweepRecord = {
        sweepNumber,
        startedAt: lastSweepAt,
        durationMs: lastDurationMs,
        agentsChecked,
        terminations,
        error: null,
      };
      record(entry);
      return entry;
    } catch (cause) {
      // A sweep that throws must not stop the scheduler. Containment that
      // breaks the first time something unexpected happens breaks precisely
      // when it is needed.
      consecutiveErrors += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      lastSweepAt = startedAt.toISOString();
      lastDurationMs = now().getTime() - startedAt.getTime();

      const entry: SweepRecord = {
        sweepNumber,
        startedAt: lastSweepAt,
        durationMs: lastDurationMs,
        agentsChecked,
        terminations: [],
        error: message,
      };
      record(entry);
      options.onError?.(message, consecutiveErrors);
      return entry;
    } finally {
      sweeping = false;
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      options.ticker.schedule(options.intervalMs, () => {
        // The returned promise is deliberately not awaited — a ticker callback
        // is synchronous by contract. Every failure path inside `tick` is
        // already caught, so there is nothing here that can reject.
        void tick();
      });
    },

    stop() {
      if (!running) return;
      running = false;
      options.ticker.cancel();
    },

    tick,

    status() {
      // ── Health is derived from behaviour, not from intent ─────────────────
      //
      // A scheduler that stopped sweeping and says nothing leaves every agent
      // unsupervised while reporting itself fine.
      if (!running) {
        return {
          running: false,
          health: "stopped",
          detail:
            "The supervisor is not running. No agent is being watched between calls; only call-time lease checks apply.",
          sweeps: sweepNumber,
          terminationsTotal,
          consecutiveErrors,
          lastSweepAt,
          overlapsSkipped,
        };
      }

      if (consecutiveErrors >= unhealthyAfter) {
        return {
          running: true,
          health: "unavailable",
          detail: `${consecutiveErrors} consecutive sweeps failed. Agents are effectively unsupervised despite the scheduler running.`,
          sweeps: sweepNumber,
          terminationsTotal,
          consecutiveErrors,
          lastSweepAt,
          overlapsSkipped,
        };
      }

      if (consecutiveErrors > 0) {
        return {
          running: true,
          health: "degraded",
          detail: `${consecutiveErrors} recent sweep(s) failed. Supervision is intermittent.`,
          sweeps: sweepNumber,
          terminationsTotal,
          consecutiveErrors,
          lastSweepAt,
          overlapsSkipped,
        };
      }

      if (lastDurationMs > slowSweepMs) {
        return {
          running: true,
          health: "degraded",
          detail: `The last sweep took ${lastDurationMs}ms against a ${slowSweepMs}ms budget. Overlapping ticks are being skipped, so the effective supervision interval is longer than configured.`,
          sweeps: sweepNumber,
          terminationsTotal,
          consecutiveErrors,
          lastSweepAt,
          overlapsSkipped,
        };
      }

      if (sweepNumber === 0) {
        return {
          running: true,
          health: "degraded",
          detail:
            "Started, and no sweep has completed yet. Nothing is confirmed to be watching until one has.",
          sweeps: 0,
          terminationsTotal,
          consecutiveErrors,
          lastSweepAt,
          overlapsSkipped,
        };
      }

      return {
        running: true,
        health: "healthy",
        detail: `${sweepNumber} sweep(s) completed, ${terminationsTotal} termination(s).`,
        sweeps: sweepNumber,
        terminationsTotal,
        consecutiveErrors,
        lastSweepAt,
        overlapsSkipped,
      };
    },

    history: (limit) => (limit === undefined ? [...history] : history.slice(-limit)),
  };
}

/**
 * A ticker for a host that has `setInterval`.
 *
 * Provided because making the common case require ceremony is how people write
 * their own worse one. It is the only thing in this package that touches a
 * platform API, and it is one function so a host on another runtime can replace
 * exactly this much.
 *
 * `unref` is called when available: a supervisor should not be the reason a
 * process refuses to exit.
 */
export function createIntervalTicker(): Ticker {
  let handle: ReturnType<typeof setInterval> | null = null;

  return {
    schedule(intervalMs, fn) {
      if (handle !== null) clearInterval(handle);
      handle = setInterval(fn, intervalMs);
      const maybeUnref = handle as unknown as { unref?: () => void };
      maybeUnref.unref?.();
    },
    cancel() {
      if (handle !== null) clearInterval(handle);
      handle = null;
    },
  };
}

/**
 * A ticker a test or a cron drives by hand.
 *
 * `fire()` runs whatever was scheduled, once. Nothing happens on its own, which
 * is what makes a scheduler test deterministic rather than a race against a
 * real timer.
 */
export interface ManualTicker extends Ticker {
  fire(): void;
  readonly scheduledIntervalMs: number | null;
}

export function createManualTicker(): ManualTicker {
  let fn: (() => void) | null = null;
  let intervalMs: number | null = null;

  return {
    schedule(ms, callback) {
      intervalMs = ms;
      fn = callback;
    },
    cancel() {
      fn = null;
      intervalMs = null;
    },
    fire() {
      fn?.();
    },
    get scheduledIntervalMs() {
      return intervalMs;
    },
  };
}
