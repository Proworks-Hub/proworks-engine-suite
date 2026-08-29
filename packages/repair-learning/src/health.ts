// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { HealthState } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Health, and the promise that this subsystem can be switched off (§40).
//
// "Repair Learning must fail safely. If repair knowledge is unavailable, the
// Hive should still operate. The Repair Learning subsystem must not become a
// hard dependency for ordinary domain execution."
//
// Foundry Charter §14 says the same about Foundry itself: "If unavailable,
// ordinary Hive operations should continue; evolution may pause and repairs
// requiring Foundry may escalate."
//
// This is a promise that is easy to make and easy to break. A subsystem becomes
// a hard dependency gradually — one caller that awaits a lookup, one path that
// throws when the store is empty — and nobody notices until the day it is down
// and order intake stops with it.
//
// So the promise is a FUNCTION with a test, rather than a paragraph in a
// README. `withRepairKnowledge` runs a lookup and returns a degraded answer if
// anything at all goes wrong, including the lookup throwing. A caller written
// against it cannot accidentally make repair learning load-bearing, because
// there is no failure mode it propagates.
// ─────────────────────────────────────────────────────────────────────────────

export interface RepairLearningHealth {
  readonly state: HealthState;
  readonly detail: string;
  /** What still works when the state is `degraded`. */
  readonly stillAvailable: readonly string[];
  /** What does not. */
  readonly unavailable: readonly string[];
}

export interface HealthInputs {
  /** Can prior cases be read? */
  readonly experienceStoreReachable: boolean;
  /** Can patterns be read? */
  readonly patternLibraryReachable: boolean;
  /** Can new runs be executed? */
  readonly harnessOperational: boolean;
  /** Is the subsystem deliberately isolated (§37, Sentinel containment)? */
  readonly isolated?: boolean;
}

/**
 * The five-state Constitutional Heartbeat, applied to this subsystem.
 *
 * `degraded` is the common and correct state here: repair learning with no
 * prior knowledge can still capture, diagnose and validate. Losing the memory
 * is not losing the function.
 */
export function repairLearningHealth(inputs: HealthInputs): RepairLearningHealth {
  if (inputs.isolated === true) {
    return {
      state: "isolated",
      detail:
        "Repair learning has been isolated, most likely by Sentinel. It is observing nothing and proposing nothing. Ordinary Hive operation is unaffected.",
      stillAvailable: [],
      unavailable: ["capture", "diagnosis", "repair proposal", "retrieval", "generalization"],
    };
  }

  if (!inputs.harnessOperational && !inputs.experienceStoreReachable) {
    return {
      state: "unavailable",
      detail:
        "Neither the harness nor the experience store is reachable. No failure can be captured and no prior case retrieved. Ordinary Hive operation continues; repairs that would have used this must escalate.",
      stillAvailable: [],
      unavailable: ["capture", "diagnosis", "retrieval", "reuse"],
    };
  }

  if (!inputs.experienceStoreReachable || !inputs.patternLibraryReachable) {
    // The important case, and the reason `degraded` exists as a state. A repair
    // learning system with no memory is a repair learning system that has not
    // learned anything yet — which is exactly where it started, and it worked
    // then.
    return {
      state: "degraded",
      detail:
        "Prior repair knowledge is unreachable, so nothing can be reused and no lesson can be generalized. Capture, diagnosis and validation are unaffected — a repair learning system with no memory is one that has not learned anything yet, which is where it began.",
      stillAvailable: ["capture", "diagnosis", "repair proposal", "validation"],
      unavailable: ["similar-case retrieval", "pattern reuse", "generalization"],
    };
  }

  if (!inputs.harnessOperational) {
    return {
      state: "degraded",
      detail:
        "The scenario harness cannot execute, so no new failure can be captured. Prior knowledge remains readable.",
      stillAvailable: ["retrieval", "pattern lookup"],
      unavailable: ["capture", "scenario execution"],
    };
  }

  return {
    state: "healthy",
    detail: "Harness, experience store and pattern library are all reachable.",
    stillAvailable: ["capture", "diagnosis", "repair proposal", "validation", "retrieval", "generalization"],
    unavailable: [],
  };
}

export interface DegradedAnswer<T> {
  readonly value: T | null;
  readonly degraded: boolean;
  readonly reason: string | null;
}

/**
 * Runs a repair-knowledge lookup so that it can never break the caller.
 *
 * The mechanism behind §40's promise. Every failure — a throw, a rejection, a
 * timeout, an unreachable store — becomes `{value: null, degraded: true}`. The
 * caller gets an answer shaped the same way every time and has no exception to
 * handle, so the path where repair learning is down is the same code path as
 * the path where it simply found nothing.
 *
 * That symmetry is the whole point. A caller that has to write a try/catch
 * around repair knowledge will eventually write one that rethrows.
 */
export async function withRepairKnowledge<T>(
  lookup: () => Promise<T> | T,
  options: { timeoutMs?: number } = {},
): Promise<DegradedAnswer<T>> {
  const timeoutMs = options.timeoutMs ?? 2000;

  try {
    const value = await Promise.race([
      Promise.resolve(lookup()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("repair-knowledge-timeout")), timeoutMs),
      ),
    ]);
    return { value, degraded: false, reason: null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      value: null,
      degraded: true,
      reason:
        message === "repair-knowledge-timeout"
          ? `Repair knowledge did not answer within ${timeoutMs}ms. Proceeding without it.`
          : `Repair knowledge is unavailable (${message}). Proceeding without it.`,
    };
  }
}

/**
 * Whether ordinary domain execution may proceed without this subsystem.
 *
 * Always true. §40: "The Repair Learning subsystem must not become a hard
 * dependency for ordinary domain execution."
 *
 * The same shape as `healthGrantsAuthority()` in Foundation and
 * `absorbsAuthorityFrom()` in Sentinel: a named place where the rule is
 * written, so a caller wondering whether to block on repair learning finds a
 * function that says no rather than an absence they resolve by blocking.
 */
export function ordinaryOperationRequiresRepairLearning(): false {
  return false;
}
