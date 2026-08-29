// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { isTerminal, type Mission, type MissionControl } from "./mission.js";

// ─────────────────────────────────────────────────────────────────────────────
// The cross-mission scheduler.
//
// Mission Control tracks one mission's lifecycle. This decides which missions
// may run AT THE SAME TIME, which is a different question and the one that
// causes damage when nobody answers it.
//
// THE CONFLICT THAT MATTERS
//
// Two missions mutating the same component concurrently produce a workspace
// each, both branched from the same base, both validated in isolation, both
// passing. Then both are promoted and the second silently reverts half of the
// first. Every individual step was correct and the outcome is a change nobody
// authored.
//
// So component overlap is a hard conflict: two missions whose scopes intersect
// do not run together, and the second waits. Not "warns" — waits. A warning
// about a race is a race with a log line.
//
// FAIRNESS IS A SAFETY PROPERTY HERE, NOT A COURTESY
//
// A naive "highest priority first" scheduler starves low-priority missions
// forever, and the low-priority queue is exactly where the documentation-drift
// and stale-manifest missions live. Those are the ones that, left undone for
// long enough, become the reason a high-priority mission was needed. So waiting
// time counts: a mission's effective priority rises the longer it waits, and
// there is a test that a starved mission eventually runs.
//
// WHAT THIS DOES NOT DO
//
// It does not run missions. It decides what MAY run and reports why the rest
// may not. Actually spawning is the Agent Runtime's job, and keeping the
// decision separate from the doing means the decision can be inspected before
// anything is spawned.
// ─────────────────────────────────────────────────────────────────────────────

export const missionPrioritySchema = z.enum([
  /** A constitutional or security regression. Jumps everything. */
  "CRITICAL",
  /** A failing invariant with tenant impact. */
  "HIGH",
  "NORMAL",
  /** Drift corrections, documentation, stale manifests. */
  "LOW",
]);
export type MissionPriority = z.infer<typeof missionPrioritySchema>;

const PRIORITY_WEIGHT: Readonly<Record<MissionPriority, number>> = Object.freeze({
  CRITICAL: 1000,
  HIGH: 100,
  NORMAL: 10,
  LOW: 1,
});

export const conflictKindSchema = z.enum([
  /** Two missions would mutate the same component. */
  "COMPONENT_OVERLAP",
  /** Two missions would write the same repository beyond the concurrent cap. */
  "REPOSITORY_CONTENTION",
  /** The global agent limit is reached. */
  "CONCURRENCY_LIMIT",
  /** The per-environment limit is reached. */
  "ENVIRONMENT_LIMIT",
]);
export type ConflictKind = z.infer<typeof conflictKindSchema>;

export interface SchedulingConflict {
  readonly kind: ConflictKind;
  readonly missionId: string;
  /** The mission already running that this one conflicts with, if any. */
  readonly conflictsWith: string | null;
  readonly detail: string;
}

export interface QueuedMission {
  readonly missionId: string;
  readonly priority: MissionPriority;
  readonly queuedAt: string;
  /** How many admission rounds this mission has been passed over. */
  readonly passedOver: number;
}

export interface AdmissionDecision {
  /** Missions that may start now, in the order they should be started. */
  readonly admit: readonly string[];
  /** Missions held back, each with the reason. */
  readonly hold: readonly SchedulingConflict[];
  /** Missions whose priority was raised by waiting. */
  readonly boosted: readonly { missionId: string; passedOver: number }[];
}

export interface MissionScheduler {
  /** Adds an AUTHORIZED mission to the queue. */
  enqueue(missionId: string, priority: MissionPriority): { queued: boolean; reason: string };
  /** Removes a mission from the queue without running it. */
  dequeue(missionId: string, reason: string): { removed: boolean; reason: string };

  /**
   * Decides what may run now.
   *
   * Pure with respect to the queue: calling it twice without starting anything
   * returns the same answer. `admitted()` is what records a start.
   */
  admit(): AdmissionDecision;

  /** Records that a mission actually started, so conflicts account for it. */
  admitted(missionId: string): { ok: boolean; reason: string };
  /** Records that a mission ended, freeing its components. */
  released(missionId: string): { ok: boolean; reason: string };

  /** What a mission is waiting on, or null if it is not queued. */
  waitingOn(missionId: string): readonly SchedulingConflict[] | null;

  queue(): readonly QueuedMission[];
  runningMissions(): readonly string[];
}

export interface MissionSchedulerOptions {
  missions: MissionControl;
  now?: () => Date;
  /** How many missions may run at once, across everything. */
  maxConcurrentMissions?: number;
  /** How many may run in one environment. */
  maxPerEnvironment?: number;
  /** How many may touch one repository at once. */
  maxPerRepository?: number;
  /**
   * How many times a mission may be passed over before it outranks everything.
   *
   * The anti-starvation valve. Without it the LOW queue never drains, and the
   * LOW queue is where the drift corrections live.
   */
  starvationThreshold?: number;
  onAdmitted?: (missionId: string) => void;
  onHeld?: (conflict: SchedulingConflict) => void;
}

export function createMissionScheduler(options: MissionSchedulerOptions): MissionScheduler {
  const now = options.now ?? (() => new Date());
  const maxConcurrent = options.maxConcurrentMissions ?? 3;
  const maxPerEnvironment = options.maxPerEnvironment ?? 2;
  const maxPerRepository = options.maxPerRepository ?? 2;
  const starvationThreshold = options.starvationThreshold ?? 5;

  const queued = new Map<string, QueuedMission>();
  const running = new Set<string>();

  /** Components held by currently running missions. */
  const heldComponents = (): Map<string, string> => {
    const held = new Map<string, string>();
    for (const missionId of running) {
      const mission = options.missions.get(missionId);
      if (!mission) continue;
      for (const component of mission.scope.components) held.set(component, missionId);
    }
    return held;
  };

  /**
   * Effective priority, including the starvation boost.
   *
   * A mission passed over `starvationThreshold` times outranks everything else
   * of its own priority and above — deliberately a hard jump rather than a
   * gentle slope, because a gentle slope on a busy queue is still starvation
   * with extra arithmetic.
   */
  const effectivePriority = (entry: QueuedMission): number => {
    const base = PRIORITY_WEIGHT[entry.priority];
    if (entry.passedOver >= starvationThreshold) return PRIORITY_WEIGHT.CRITICAL + entry.passedOver;
    return base + entry.passedOver;
  };

  const conflictsFor = (
    mission: Mission,
    held: Map<string, string>,
    provisionalRunning: readonly string[],
  ): SchedulingConflict[] => {
    const conflicts: SchedulingConflict[] = [];

    // ── Component overlap. The one that causes silent damage. ──────────────
    for (const component of mission.scope.components) {
      const holder = held.get(component);
      if (holder !== undefined && holder !== mission.missionId) {
        conflicts.push({
          kind: "COMPONENT_OVERLAP",
          missionId: mission.missionId,
          conflictsWith: holder,
          detail:
            `${component} is already being changed by ${holder}. Two missions branching the same component from the same base ` +
            "both validate in isolation, both pass, and the second silently reverts half of the first.",
        });
      }
    }

    if (provisionalRunning.length >= maxConcurrent) {
      conflicts.push({
        kind: "CONCURRENCY_LIMIT",
        missionId: mission.missionId,
        conflictsWith: null,
        detail: `${provisionalRunning.length} missions are running and the limit is ${maxConcurrent}.`,
      });
    }

    const inEnvironment = provisionalRunning.filter(
      (id) => options.missions.get(id)?.scope.environment === mission.scope.environment,
    ).length;
    if (inEnvironment >= maxPerEnvironment) {
      conflicts.push({
        kind: "ENVIRONMENT_LIMIT",
        missionId: mission.missionId,
        conflictsWith: null,
        detail: `${inEnvironment} missions are running in ${mission.scope.environment} and the limit is ${maxPerEnvironment}.`,
      });
    }

    const inRepository = provisionalRunning.filter(
      (id) => options.missions.get(id)?.scope.repository === mission.scope.repository,
    ).length;
    if (inRepository >= maxPerRepository) {
      conflicts.push({
        kind: "REPOSITORY_CONTENTION",
        missionId: mission.missionId,
        conflictsWith: null,
        detail: `${inRepository} missions are touching ${mission.scope.repository} and the limit is ${maxPerRepository}.`,
      });
    }

    return conflicts;
  };

  return {
    enqueue(missionId, priority) {
      const mission = options.missions.get(missionId);
      if (!mission) return { queued: false, reason: `No mission ${missionId}.` };

      if (mission.state !== "AUTHORIZED" && mission.state !== "PROVISIONED") {
        return {
          queued: false,
          reason: `Mission ${missionId} is ${mission.state}. Only an AUTHORIZED or PROVISIONED mission is queued — queueing earlier would schedule work Governance has not permitted.`,
        };
      }

      if (queued.has(missionId)) return { queued: false, reason: `Already queued.` };
      if (running.has(missionId)) return { queued: false, reason: `Already running.` };

      queued.set(missionId, {
        missionId,
        priority,
        queuedAt: now().toISOString(),
        passedOver: 0,
      });
      return { queued: true, reason: `Queued at ${priority}.` };
    },

    dequeue(missionId, reason) {
      if (!queued.delete(missionId)) return { removed: false, reason: `Not queued.` };
      return { removed: true, reason };
    },

    admit() {
      const admit: string[] = [];
      const hold: SchedulingConflict[] = [];
      const boosted: { missionId: string; passedOver: number }[] = [];

      const held = heldComponents();
      const provisional = [...running];

      const candidates = [...queued.values()].sort(
        (a, b) =>
          effectivePriority(b) - effectivePriority(a) ||
          new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime(),
      );

      for (const entry of candidates) {
        const mission = options.missions.get(entry.missionId);
        if (!mission || isTerminal(mission.state)) {
          // A mission that ended while queued is simply dropped. Reporting it
          // as a conflict would fill the hold list with noise.
          queued.delete(entry.missionId);
          continue;
        }

        if (entry.passedOver >= starvationThreshold) {
          boosted.push({ missionId: entry.missionId, passedOver: entry.passedOver });
        }

        const conflicts = conflictsFor(mission, held, provisional);
        if (conflicts.length > 0) {
          hold.push(...conflicts);
          for (const c of conflicts) options.onHeld?.(c);
          continue;
        }

        admit.push(entry.missionId);
        // Provisionally reserve, so two queued missions competing for the same
        // component do not both get admitted in one round.
        provisional.push(entry.missionId);
        for (const component of mission.scope.components) held.set(component, entry.missionId);
      }

      return { admit, hold, boosted };
    },

    admitted(missionId) {
      const entry = queued.get(missionId);
      if (!entry) return { ok: false, reason: `Mission ${missionId} is not queued.` };

      queued.delete(missionId);
      running.add(missionId);

      // Everything still queued has now been passed over once more. This is
      // what makes the starvation boost accumulate.
      for (const [id, q] of queued) {
        queued.set(id, { ...q, passedOver: q.passedOver + 1 });
      }

      options.onAdmitted?.(missionId);
      return { ok: true, reason: `${missionId} admitted.` };
    },

    released(missionId) {
      if (!running.delete(missionId)) {
        return { ok: false, reason: `Mission ${missionId} is not running.` };
      }
      return { ok: true, reason: `${missionId} released; its components are free.` };
    },

    waitingOn(missionId) {
      const entry = queued.get(missionId);
      if (!entry) return null;
      const mission = options.missions.get(missionId);
      if (!mission) return [];
      return conflictsFor(mission, heldComponents(), [...running]);
    },

    queue: () =>
      [...queued.values()].sort((a, b) => effectivePriority(b) - effectivePriority(a)),
    runningMissions: () => [...running],
  };
}

/**
 * Whether two missions could safely run at the same time.
 *
 * Exported so a caller can check before proposing a second mission, rather than
 * proposing it and discovering the conflict at admission. Component overlap is
 * the only hard conflict between a pair — the rest are capacity limits, which
 * are properties of the whole system rather than of the pair.
 */
export function missionsConflict(a: Mission, b: Mission): { conflict: boolean; reason: string } {
  const overlap = a.scope.components.filter((c) => b.scope.components.includes(c));
  if (overlap.length > 0) {
    return {
      conflict: true,
      reason: `${a.missionId} and ${b.missionId} both change ${overlap.join(", ")}. They must not run concurrently.`,
    };
  }
  return { conflict: false, reason: "No component overlap." };
}
