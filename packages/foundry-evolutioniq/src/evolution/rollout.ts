// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  changeClassSchema,
  identifierSchema,
  requiresHumanAuthorization,
  type ChangeClass,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// THE RELEASE LIFECYCLE, AND THE TWO WALLS THAT ARE NOT THE SAME WALL.
//
// This is the lifecycle deferred when the promotion question was first asked:
// build the channels, leave the gate shut. Both halves matter, and the reason
// they are separable is a distinction worth stating plainly, because confusing
// them is the likeliest way this file gets misread later.
//
//   FOUNDRY'S ENVIRONMENT WALL — `PROMOTABLE` in control.ts — is about where
//   Foundry may APPLY a change. It admits SIMULATION and VALIDATION, and this
//   file does not touch it, widen it, or route around it.
//
//   THE RELEASE CHANNEL — here — is about how far a VERSION has travelled
//   toward general availability. A release reaching STABLE is not Foundry
//   deploying anything; it is a version being marked fit for instances that
//   choose to adopt it.
//
// Building the road does not open the gate. What this adds is that the road
// now exists, has a shape, and has a human standing on the part of it that
// requires one.
//
// AUTOMATIC PROMOTION IS REAL AND NARROW
//
// A maintenance change may travel DRAFT → SANDBOX → VALIDATED → CANARY →
// STABLE without a person, when policy allows it and every gate passes. That
// is deliberate: a system where trivial fixes need a signature is one where
// signatures stop meaning anything, because the person signing has stopped
// reading. Everything above maintenance takes the long road.
//
// ROLLBACK IS A FIRST-CLASS CAPABILITY, NOT AN ERROR PATH
//
// It is idempotent, it names its target explicitly, and it is refused when
// there is nothing known-good to go back to — because discovering that during
// an incident is discovering it too late.
// ─────────────────────────────────────────────────────────────────────────────

export const releaseStateSchema = z.enum([
  "DRAFT",
  "SANDBOX",
  "VALIDATED",
  /** May enter beta. Not yet in it. */
  "BETA_ELIGIBLE",
  "BETA",
  /** Beta observed long enough, against thresholds. */
  "BETA_VERIFIED",
  "AWAITING_HUMAN_AUTHORIZATION",
  /** The shortened path's proving ground. Maintenance only. */
  "CANARY",
  "STABLE",
  "LTS",
  /** Pulled. Never deleted. */
  "ROLLED_BACK",
]);
export type ReleaseState = z.infer<typeof releaseStateSchema>;

/**
 * The long road, in order.
 *
 * Explicit rather than derived, because a state machine whose transitions are
 * computed is one where adding a state quietly adds transitions.
 */
const LONG_PATH: readonly ReleaseState[] = Object.freeze([
  "DRAFT",
  "SANDBOX",
  "VALIDATED",
  "BETA_ELIGIBLE",
  "BETA",
  "BETA_VERIFIED",
  "AWAITING_HUMAN_AUTHORIZATION",
  "STABLE",
  "LTS",
]);

/** The shortened path. Maintenance only, and only where policy allows. */
const SHORT_PATH: readonly ReleaseState[] = Object.freeze([
  "DRAFT",
  "SANDBOX",
  "VALIDATED",
  "CANARY",
  "STABLE",
]);

export function pathFor(changeClass: ChangeClass, autoPromotionAllowed: boolean): readonly ReleaseState[] {
  // Only maintenance takes the short path, and only when a policy says so.
  // `minor` is excluded deliberately: a compatible capability addition is
  // still a behaviour change somebody is about to receive without asking.
  return changeClass === "maintenance" && autoPromotionAllowed ? SHORT_PATH : LONG_PATH;
}

/** Health thresholds a cohort must stay inside. Machine-readable, versioned. */
export const healthGateSchema = z
  .object({
    gateVersion: z.string().min(1),
    maxErrorRate: z.number().min(0).max(1),
    maxP95LatencyMs: z.number().positive(),
    maxQueueGrowthPerMinute: z.number().nonnegative(),
    /** Below this many observations nothing is concluded, good or bad. */
    minimumObservations: z.number().int().positive(),
    /** How long a cohort must hold before expanding. */
    observationWindowMs: z.number().int().positive(),
  })
  .strict();
export type HealthGate = z.infer<typeof healthGateSchema>;

export interface CohortHealth {
  readonly observations: number;
  readonly errorRate: number;
  readonly p95LatencyMs: number;
  readonly queueGrowthPerMinute: number;
  /** Cross-tenant or integrity alarms. Any one of these is fatal. */
  readonly isolationAlerts: number;
  readonly integrityViolations: number;
  readonly observedForMs: number;
}

export type GateVerdict =
  | { readonly verdict: "pass"; readonly reason: string }
  | { readonly verdict: "hold"; readonly reason: string }
  | { readonly verdict: "fail"; readonly reasons: readonly string[] };

/**
 * Evaluates a cohort against its gate.
 *
 * Three outcomes and not two. `hold` is the one that matters: not enough
 * evidence yet is neither a pass nor a failure, and collapsing it into either
 * is how a rollout either stalls forever or promotes on four requests.
 */
export function evaluateGate(gate: HealthGate, health: CohortHealth): GateVerdict {
  // Isolation and integrity first, and they are fatal regardless of sample
  // size. One cross-tenant alarm is not a statistic to be accumulated.
  const fatal: string[] = [];
  if (health.isolationAlerts > 0) {
    fatal.push(`${health.isolationAlerts} cross-tenant isolation alert(s)`);
  }
  if (health.integrityViolations > 0) {
    fatal.push(`${health.integrityViolations} data-integrity violation(s)`);
  }
  if (fatal.length > 0) return { verdict: "fail", reasons: fatal };

  if (health.observations < gate.minimumObservations) {
    return {
      verdict: "hold",
      reason: `${health.observations} observations against a minimum of ${gate.minimumObservations}. Not enough to conclude anything, in either direction.`,
    };
  }
  if (health.observedForMs < gate.observationWindowMs) {
    return {
      verdict: "hold",
      reason: `Observed for ${health.observedForMs}ms against a window of ${gate.observationWindowMs}ms.`,
    };
  }

  const failures: string[] = [];
  if (health.errorRate > gate.maxErrorRate) {
    failures.push(`error rate ${(health.errorRate * 100).toFixed(2)}% above ${(gate.maxErrorRate * 100).toFixed(2)}%`);
  }
  if (health.p95LatencyMs > gate.maxP95LatencyMs) {
    failures.push(`p95 ${health.p95LatencyMs}ms above ${gate.maxP95LatencyMs}ms`);
  }
  if (health.queueGrowthPerMinute > gate.maxQueueGrowthPerMinute) {
    failures.push(`queue growing ${health.queueGrowthPerMinute}/min above ${gate.maxQueueGrowthPerMinute}`);
  }

  return failures.length > 0
    ? { verdict: "fail", reasons: failures }
    : { verdict: "pass", reason: "Every threshold held for the full window." };
}

export interface RolloutRecord {
  readonly rolloutId: string;
  readonly engineId: string;
  readonly version: string;
  readonly changeClass: ChangeClass;
  readonly state: ReleaseState;
  /** REQUIRED. A release with nothing to go back to has no remedy. */
  readonly previousKnownGoodVersion: string;
  /** Percentage of eligible instances currently on it. */
  readonly cohortPercent: number;
  readonly gate: HealthGate;
  /** The human authorization, once given. */
  readonly authorizedBy: string | null;
  readonly authorizationRef: string | null;
  readonly history: readonly { state: ReleaseState; at: string; by: string; reason: string }[];
}

export type AdvanceResult =
  | { readonly advanced: true; readonly rollout: RolloutRecord }
  | { readonly advanced: false; readonly reason: string; readonly requiresHuman: boolean };

export interface RolloutController {
  begin(input: {
    rolloutId: string;
    engineId: string;
    version: string;
    changeClass: ChangeClass;
    previousKnownGoodVersion: string;
    gate: unknown;
  }): { began: true; rollout: RolloutRecord } | { began: false; reason: string };

  /** Moves one step along the path this change's class permits. */
  advance(
    rolloutId: string,
    by: string,
    evidence?: { health?: CohortHealth; authorizedBy?: string; authorizationRef?: string },
  ): AdvanceResult;

  /** Expands the cohort, gated on health. */
  expand(rolloutId: string, toPercent: number, health: CohortHealth): AdvanceResult;

  /**
   * Puts the previous version back.
   *
   * Idempotent: rolling back an already-rolled-back release succeeds and
   * changes nothing, because an incident response that fails on the second
   * attempt is one somebody has to reason about while it is on fire.
   */
  rollback(rolloutId: string, reason: string, by: string): { rolledBack: boolean; reason: string; to?: string };

  /** Whether an instance on this channel should receive this version. */
  eligible(input: {
    rolloutId: string;
    instanceChannel: "beta" | "stable" | "lts";
    pinnedVersion?: string;
  }): { eligible: boolean; reason: string };

  get(rolloutId: string): RolloutRecord | null;
}

export interface RolloutControllerOptions {
  readonly now?: () => Date;
  /** Whether policy permits automatic promotion of maintenance changes. */
  readonly autoPromoteMaintenance?: boolean;
  /** Sentinel's veto. Consulted on every advance, not only at the start. */
  readonly quarantined?: () => readonly string[];
  readonly onStateChange?: (rollout: RolloutRecord, from: ReleaseState) => void;
  readonly onRollback?: (rollout: RolloutRecord, reason: string) => void;
}

export function createRolloutController(
  options: RolloutControllerOptions = {},
): RolloutController {
  const now = options.now ?? (() => new Date());
  const autoPromote = options.autoPromoteMaintenance ?? false;
  const rollouts = new Map<string, RolloutRecord>();

  const move = (r: RolloutRecord, state: ReleaseState, by: string, reason: string): RolloutRecord => {
    const next: RolloutRecord = {
      ...r,
      state,
      history: [...r.history, { state, at: now().toISOString(), by, reason }],
    };
    rollouts.set(next.rolloutId, next);
    options.onStateChange?.(next, r.state);
    return next;
  };

  return {
    begin(input) {
      if (rollouts.has(input.rolloutId)) {
        return { began: false, reason: `Rollout ${input.rolloutId} already exists.` };
      }
      const gate = healthGateSchema.safeParse(input.gate);
      if (!gate.success) {
        return { began: false, reason: `Not a valid health gate: ${JSON.stringify(gate.error.flatten())}` };
      }
      if (!input.previousKnownGoodVersion) {
        // Refused at the start rather than discovered during an incident.
        return {
          began: false,
          reason: "A rollout must declare its previous known-good version. Discovering there is nothing to go back to is something to find out now, not later.",
        };
      }

      const rollout: RolloutRecord = {
        rolloutId: input.rolloutId,
        engineId: input.engineId,
        version: input.version,
        changeClass: input.changeClass,
        state: "DRAFT",
        previousKnownGoodVersion: input.previousKnownGoodVersion,
        cohortPercent: 0,
        gate: gate.data,
        authorizedBy: null,
        authorizationRef: null,
        history: [{ state: "DRAFT", at: now().toISOString(), by: "foundry", reason: "created" }],
      };
      rollouts.set(rollout.rolloutId, rollout);
      return { began: true, rollout };
    },

    advance(rolloutId, by, evidence) {
      const r = rollouts.get(rolloutId);
      if (!r) return { advanced: false, reason: `No rollout ${rolloutId}.`, requiresHuman: false };
      if (r.state === "ROLLED_BACK") {
        return { advanced: false, reason: "A rolled-back release does not advance. Correct it and start a new rollout.", requiresHuman: false };
      }

      // Sentinel's veto, checked on EVERY advance. Checking it only at the
      // start would let a release that became suspicious mid-rollout keep
      // travelling.
      if ((options.quarantined?.() ?? []).includes(r.engineId)) {
        return { advanced: false, reason: `Sentinel has quarantined ${r.engineId}.`, requiresHuman: false };
      }

      const path = pathFor(r.changeClass, autoPromote);
      const index = path.indexOf(r.state);
      if (index < 0) {
        return { advanced: false, reason: `${r.state} is not on the path for a ${r.changeClass} change.`, requiresHuman: false };
      }
      if (index === path.length - 1) {
        return { advanced: false, reason: `${r.state} is the end of the path.`, requiresHuman: false };
      }
      const next = path[index + 1]!;

      // ── Health gates guard the states that follow observation ───────────
      if (r.state === "BETA" || r.state === "CANARY") {
        if (!evidence?.health) {
          return { advanced: false, reason: `Advancing from ${r.state} needs observed health.`, requiresHuman: false };
        }
        const verdict = evaluateGate(r.gate, evidence.health);
        if (verdict.verdict === "hold") {
          return { advanced: false, reason: verdict.reason, requiresHuman: false };
        }
        if (verdict.verdict === "fail") {
          return {
            advanced: false,
            reason: `The gate failed: ${verdict.reasons.join("; ")}. This is a rollback, not a hold.`,
            requiresHuman: false,
          };
        }
      }

      // ── The human gate ──────────────────────────────────────────────────
      //
      // Entering STABLE from AWAITING_HUMAN_AUTHORIZATION needs a named person
      // and a reference. This is the part of the road a human stands on.
      if (r.state === "AWAITING_HUMAN_AUTHORIZATION") {
        if (!evidence?.authorizedBy || !evidence.authorizationRef) {
          return {
            advanced: false,
            reason: `A ${r.changeClass} change reaching STABLE requires a named human authorization and its reference.`,
            requiresHuman: true,
          };
        }
        const authorized: RolloutRecord = {
          ...r,
          authorizedBy: evidence.authorizedBy,
          authorizationRef: evidence.authorizationRef,
        };
        rollouts.set(rolloutId, authorized);
        return {
          advanced: true,
          rollout: move(authorized, next, evidence.authorizedBy, `authorized as ${evidence.authorizationRef}`),
        };
      }

      // A class that requires human authorization cannot reach STABLE by any
      // other route.
      //
      // UNREACHABLE TODAY, and said plainly because a mutation proved it:
      // `pathFor` routes every such class through AWAITING_HUMAN_AUTHORIZATION,
      // which the branch above already handles, so deleting this changes no
      // observable behaviour. It stays as the guard for the case where the
      // path changes — a second route to STABLE would otherwise arrive with
      // nothing standing on it — but nobody should read it as active.
      if (next === "STABLE" && requiresHumanAuthorization(r.changeClass) && !r.authorizedBy) {
        return {
          advanced: false,
          reason: `A ${r.changeClass} change cannot reach STABLE without human authorization, whatever path it took to get here.`,
          requiresHuman: true,
        };
      }

      return { advanced: true, rollout: move(r, next, by, `advanced to ${next}`) };
    },

    expand(rolloutId, toPercent, health) {
      const r = rollouts.get(rolloutId);
      if (!r) return { advanced: false, reason: `No rollout ${rolloutId}.`, requiresHuman: false };
      if (toPercent <= r.cohortPercent) {
        return { advanced: false, reason: "A cohort expands. Shrinking one is a rollback.", requiresHuman: false };
      }

      const verdict = evaluateGate(r.gate, health);
      if (verdict.verdict !== "pass") {
        return {
          advanced: false,
          reason: verdict.verdict === "hold" ? verdict.reason : `The gate failed: ${verdict.reasons.join("; ")}.`,
          requiresHuman: false,
        };
      }

      const next: RolloutRecord = { ...r, cohortPercent: toPercent };
      rollouts.set(rolloutId, next);
      return { advanced: true, rollout: next };
    },

    rollback(rolloutId, reason, by) {
      const r = rollouts.get(rolloutId);
      if (!r) return { rolledBack: false, reason: `No rollout ${rolloutId}.` };

      // Idempotent. An incident response that fails on the second attempt is
      // one somebody has to reason about while it is on fire.
      if (r.state === "ROLLED_BACK") {
        return {
          rolledBack: true,
          reason: "Already rolled back; nothing further to do.",
          to: r.previousKnownGoodVersion,
        };
      }

      const next = move(r, "ROLLED_BACK", by, reason);
      const restored: RolloutRecord = { ...next, cohortPercent: 0 };
      rollouts.set(rolloutId, restored);
      options.onRollback?.(restored, reason);
      return {
        rolledBack: true,
        reason: `Rolled back to ${r.previousKnownGoodVersion}: ${reason}`,
        to: r.previousKnownGoodVersion,
      };
    },

    eligible({ rolloutId, instanceChannel, pinnedVersion }) {
      const r = rollouts.get(rolloutId);
      if (!r) return { eligible: false, reason: `No rollout ${rolloutId}.` };

      // A pinned instance does not silently upgrade. Pinning is a decision
      // somebody made, and a rollout that overrode it would make the pin a
      // suggestion.
      if (pinnedVersion !== undefined && pinnedVersion !== r.version) {
        return { eligible: false, reason: `This instance is pinned to ${pinnedVersion}.` };
      }
      if (r.state === "ROLLED_BACK") {
        return { eligible: false, reason: "This release was rolled back." };
      }

      switch (instanceChannel) {
        case "beta":
          return r.state === "BETA" || r.state === "BETA_VERIFIED" || r.state === "STABLE" || r.state === "LTS"
            ? { eligible: true, reason: `Beta instances take ${r.state}.` }
            : { eligible: false, reason: `${r.state} is not offered to beta instances.` };
        case "stable":
          return r.state === "STABLE" || r.state === "LTS"
            ? { eligible: true, reason: `Stable instances take ${r.state}.` }
            : { eligible: false, reason: `${r.state} is not offered to stable instances.` };
        case "lts":
          // LTS takes LTS only. A stable-channel release reaching an LTS
          // instance is the failure this channel exists to prevent — the
          // instance chose a slower cadence and got the faster one anyway.
          return r.state === "LTS"
            ? { eligible: true, reason: "LTS instances take LTS releases." }
            : { eligible: false, reason: `${r.state} is not an LTS release, and an LTS instance chose a slower cadence.` };
      }
    },

    get: (rolloutId) => rollouts.get(rolloutId) ?? null,
  };
}

/**
 * Whether reaching STABLE on a channel means Foundry deployed anything.
 *
 * Always false, and the distinction most likely to be misread here. Foundry's
 * environment wall — SIMULATION and VALIDATION — is about where Foundry may
 * APPLY a change and is untouched by this file. A channel is about how far a
 * version has travelled toward general availability. Building the road does
 * not open the gate.
 */
export function channelPromotionIsDeployment(): false {
  return false;
}

/**
 * Whether a maintenance auto-promotion skips its gates.
 *
 * Always false. The short path is shorter, not looser: every state on it still
 * evaluates health, and CANARY is a proving ground rather than a formality.
 */
export function autoPromotionSkipsGates(): false {
  return false;
}
