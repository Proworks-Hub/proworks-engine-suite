// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { EngineHealth } from "./health.js";
import { assessRollback, type EngineRelease } from "./release.js";

// ─────────────────────────────────────────────────────────────────────────────
// Automatic recovery, and the reasons it usually should not fire.
//
// An automatic rollback is a production change made by software with nobody
// watching. That is defensible only when the evidence is strong enough that a
// competent engineer would reach the same conclusion without hesitating — so
// this file is mostly a list of ways the evidence is NOT strong enough:
//
//   The problem must CORRELATE TO A DEPLOYMENT. An engine that has been
//   degraded for a week is not evidence that this morning's release broke it,
//   and rolling back would remove a fix while leaving the fault.
//
//   There must be ENOUGH SAMPLES. Two failures out of three requests is 66%,
//   and it is also nothing.
//
//   The rollback must be SAFE. A policy that rolls back across an irreversible
//   migration turns an incident into a data problem.
//
// When any of those is missing the answer is escalate, not guess. Waking a
// person is cheap; an unattended wrong rollback is not.
// ─────────────────────────────────────────────────────────────────────────────

export const recoveryActionSchema = z.enum([
  /** Stop promoting the candidate further. Always safe. */
  "pause_rollout",
  /** Send new work to the previous version where the architecture allows. */
  "divert_traffic",
  /** Put the previous known-good version back. */
  "rollback",
  /** Turn off the new behaviour without changing the deployed version. */
  "disable_feature",
  /** Do nothing automatically; tell a person. */
  "escalate",
]);
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const recoveryPolicySchema = z
  .object({
    engineId: z.string().min(1),
    enabled: z.boolean().default(false),
    /** How long after a deployment a fault still counts as caused by it. */
    correlationWindowMs: z.number().int().positive().default(30 * 60_000),
    /** How long a condition must hold before it counts. */
    observationWindowMs: z.number().int().positive().default(5 * 60_000),
    /** Below this many observations, no automatic action. */
    minimumSampleSize: z.number().int().positive().default(50),
    errorRateThreshold: z.number().min(0).max(1).default(0.1),
    /** Actions this policy is permitted to take, in order of preference. */
    allowedActions: z.array(recoveryActionSchema).default(["pause_rollout", "escalate"]),
    maxAttempts: z.number().int().positive().default(1),
    cooldownMs: z.number().int().positive().default(60 * 60_000),
    notify: z.array(z.string()).default([]),
  })
  .strict();
export type RecoveryPolicy = z.infer<typeof recoveryPolicySchema>;

export interface RecoveryContext {
  policy: RecoveryPolicy;
  health: EngineHealth;
  /** How many observations the error rate is computed from. */
  sampleSize: number;
  errorRate: number;
  /** The release currently deployed, and when. */
  current: EngineRelease;
  deployedAt: string;
  target?: EngineRelease;
  between?: readonly EngineRelease[];
  /** Automatic attempts already made in this cooldown period. */
  attemptsMade: number;
  lastAttemptAt?: string;
  now: number;
}

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  /** Why, in terms an operator can check. */
  readonly reason: string;
  /** What the decision rested on, so it can be argued with afterwards. */
  readonly evidence: readonly string[];
  /** True when a person must act. */
  readonly requiresHuman: boolean;
}

/**
 * Decides what, if anything, to do automatically.
 *
 * Returns `escalate` far more often than `rollback`, by design.
 */
export function decideRecovery(context: RecoveryContext): RecoveryDecision {
  const { policy, health, now } = context;
  const evidence: string[] = [];

  if (!policy.enabled) {
    return {
      action: "escalate",
      reason: "Automatic recovery is not enabled for this engine.",
      evidence: [],
      requiresHuman: true,
    };
  }

  const healthy = health.state === "operational" || health.state === "busy";
  if (healthy) {
    return {
      action: "escalate",
      reason: "The engine is healthy; there is nothing to recover from.",
      evidence: [`state=${health.state}`],
      requiresHuman: false,
    };
  }

  // A deliberate outage is not a fault, and rolling back during planned
  // maintenance would undo whatever the maintenance was for.
  if (health.state === "maintenance") {
    return {
      action: "escalate",
      reason: "The engine is in maintenance. Automatic recovery does not act during planned work.",
      evidence: [],
      requiresHuman: false,
    };
  }

  const sinceDeploy = now - Date.parse(context.deployedAt);
  if (Number.isNaN(sinceDeploy) || sinceDeploy > policy.correlationWindowMs) {
    return {
      action: "escalate",
      reason:
        "The fault does not correlate to a recent deployment, so rolling back would remove a change that is probably not the cause.",
      evidence: [`deployed ${Math.round(sinceDeploy / 60_000)}m ago`],
      requiresHuman: true,
    };
  }
  evidence.push(`deployed ${Math.round(sinceDeploy / 60_000)}m ago, inside the correlation window`);

  if (context.sampleSize < policy.minimumSampleSize) {
    // Two failures out of three is 66% and also nothing.
    return {
      action: "escalate",
      reason: `Only ${context.sampleSize} observations; the policy needs ${policy.minimumSampleSize} before acting.`,
      evidence,
      requiresHuman: true,
    };
  }
  evidence.push(`${context.sampleSize} observations, ${(context.errorRate * 100).toFixed(1)}% failing`);

  if (context.errorRate < policy.errorRateThreshold) {
    return {
      action: "escalate",
      reason: "The error rate is below the policy threshold.",
      evidence,
      requiresHuman: true,
    };
  }

  if (context.attemptsMade >= policy.maxAttempts) {
    // Repeating a recovery that did not work is how an incident becomes a
    // loop, and the loop hides the original fault.
    return {
      action: "escalate",
      reason: `Automatic recovery has already been attempted ${context.attemptsMade} time(s). Further attempts need a person.`,
      evidence,
      requiresHuman: true,
    };
  }

  if (context.lastAttemptAt) {
    const sinceAttempt = now - Date.parse(context.lastAttemptAt);
    if (sinceAttempt < policy.cooldownMs) {
      return {
        action: "escalate",
        reason: "Still inside the cooldown from the last automatic attempt.",
        evidence,
        requiresHuman: true,
      };
    }
  }

  // Pausing a rollout is always safe and always worth doing first: it stops the
  // problem spreading while everything else is considered.
  if (policy.allowedActions.includes("pause_rollout")) {
    evidence.push("rollout paused to stop the change spreading");
  }

  if (!policy.allowedActions.includes("rollback")) {
    return {
      action: policy.allowedActions.includes("pause_rollout") ? "pause_rollout" : "escalate",
      reason: "This policy does not permit automatic rollback.",
      evidence,
      requiresHuman: true,
    };
  }

  const rollback = assessRollback(context.current, context.target, context.between ?? []);
  if (rollback.verdict === "unsafe") {
    // The most important refusal here. Rolling back across an irreversible
    // migration turns an incident into a data problem, and does it
    // automatically, at whatever hour this fired.
    return {
      action: policy.allowedActions.includes("pause_rollout") ? "pause_rollout" : "escalate",
      reason: `Rollback is unsafe: ${rollback.reasons[0] ?? "unknown reason"}`,
      evidence: [...evidence, ...rollback.reasons],
      requiresHuman: true,
    };
  }

  if (rollback.verdict === "safe_with_warnings") {
    return {
      action: "escalate",
      reason: `Rollback is possible but not clean: ${rollback.reasons[0] ?? ""}. A person should decide.`,
      evidence: [...evidence, ...rollback.reasons],
      requiresHuman: true,
    };
  }

  return {
    action: "rollback",
    reason: `Fault correlates to ${context.current.version}, deployed ${Math.round(sinceDeploy / 60_000)}m ago, and ${rollback.to} is a clean target.`,
    evidence: [...evidence, ...rollback.reasons],
    requiresHuman: false,
  };
}

// ── Verifying that recovery worked ───────────────────────────────────────────

export const recoveryStateSchema = z.enum([
  "requested",
  "running",
  "failed",
  /** Action completed; not yet trusted. */
  "recovering",
  /** Looks right, but the observation window has not elapsed. */
  "monitoring",
  "resolved",
]);
export type RecoveryState = z.infer<typeof recoveryStateSchema>;

export interface RecoveryVerification {
  readonly state: RecoveryState;
  readonly reason: string;
  /** How long the evidence must keep holding before this resolves. */
  readonly remainingMs?: number;
}

/**
 * Decides whether a recovery has actually worked.
 *
 * Deliberately slow to say yes. An engine goes healthy for ten seconds after
 * almost any restart, and declaring victory there is how an incident gets
 * closed twice.
 */
export function verifyRecovery(input: {
  health: EngineHealth;
  /** When the recovery action finished. */
  actionCompletedAt: string;
  observationWindowMs: number;
  /** Whether the smoke checks a host ran came back clean. */
  smokeChecksPassed?: boolean;
  now: number;
}): RecoveryVerification {
  const elapsed = input.now - Date.parse(input.actionCompletedAt);

  if (input.smokeChecksPassed === false) {
    return {
      state: "failed",
      reason: "Smoke checks failed after the recovery action, so the engine is not serving correctly.",
    };
  }

  const healthy = input.health.state === "operational" || input.health.state === "busy";

  if (!healthy) {
    // Still bad after the action means the action did not work — and that is a
    // worse position than before it, because a change was made and the fault
    // remains.
    return {
      state: input.health.state === "unknown" ? "recovering" : "failed",
      reason:
        input.health.state === "unknown"
          ? "No telemetry since the action; the engine may still be starting."
          : `The engine is still ${input.health.state} after recovery: ${input.health.reason}`,
    };
  }

  if (input.smokeChecksPassed !== true) {
    return {
      state: "recovering",
      reason: "Health looks right, but no smoke check has confirmed the engine actually serves work.",
    };
  }

  if (elapsed < input.observationWindowMs) {
    return {
      state: "monitoring",
      reason: "Healthy and serving, but not for long enough to call it resolved.",
      remainingMs: input.observationWindowMs - elapsed,
    };
  }

  return {
    state: "resolved",
    reason: `Healthy and serving for ${Math.round(elapsed / 60_000)} minutes with smoke checks passing.`,
  };
}
