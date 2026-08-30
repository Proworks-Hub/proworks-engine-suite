/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/security/posture.ts
 * Module:   neural-fabric / security
 * Purpose:  Getting stricter when the security system goes quiet, not looser.
 */

import type { Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// AN UNREACHABLE SENTINEL TIGHTENS THE FABRIC. IT DOES NOT RELAX IT.
//
// §33.4 states the rule and it inverts the ordinary instinct. When a dependency
// is unavailable, the reflex is to carry on without it — the system stays up,
// users are unaffected, and the outage is invisible. For a cache that is
// correct. For the component that decides whether traffic is safe, it converts
// a security outage into a security bypass, and it does so silently.
//
// So a Sentinel or Security IQ outage RAISES the condition level. That is
// deliberately the expensive direction: it degrades service while the security
// system is down, which is exactly the trade §34.9 asks for — "Sentinel outage
// causes the Fabric to enter the configured safer posture rather than
// unrestricted allow."
//
// THE CACHED POSTURE IS SHORT-LIVED AND FAIL-SAFE
//
// §33.4 also asks Pulse to hold a locally cached, short-lived, fail-safe
// posture so it can fail closed when Sentinel is briefly unreachable. Two
// properties do the work:
//
//   SHORT-LIVED  — a cached posture that never expires is a posture nobody can
//                  revoke, and a compromised node would keep the last
//                  permissive answer forever.
//   FAIL-SAFE    — when it expires, the fallback is the STRICTEST level, not
//                  the last known one. "It was green ten minutes ago" is not
//                  evidence that it is green now.
//
// AND POSTURE NEVER GRANTS ANYTHING
//
// Every level here restricts. There is no level that permits something the
// normal level does not, including RECOVERY — recovery restores what was
// suspended, and restoring is not granting. An engine whose emergency mode
// could widen access would be an engine where declaring an emergency is an
// attack.
// ─────────────────────────────────────────────────────────────────────────────

export type ConditionLevel = "GREEN" | "YELLOW" | "ORANGE" | "RED" | "RECOVERY";

/** Strictness order. RECOVERY sits between ORANGE and YELLOW deliberately. */
const STRICTNESS: Readonly<Record<ConditionLevel, number>> = Object.freeze({
  GREEN: 0,
  YELLOW: 1,
  RECOVERY: 2,
  ORANGE: 3,
  RED: 4,
});

export interface PostureDefinition {
  readonly level: ConditionLevel;
  readonly trigger: string;
  /** Lanes that keep flowing normally. */
  readonly lanesNormal: readonly Lane[];
  /** Lanes restricted to explicitly verified routes. */
  readonly lanesRestricted: readonly Lane[];
  /** Lanes suspended entirely. */
  readonly lanesSuspended: readonly Lane[];
  /** Whether traffic may cross an instance boundary at this level. */
  readonly crossInstancePermitted: boolean;
  /** How long a trust assertion stays valid. Shorter means more re-checking. */
  readonly trustTtlSeconds: number;
  readonly operatorNote: string;
}

const ALL: readonly Lane[] = ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "HEALTH", "ARTIFACT"];

export const POSTURES: Readonly<Record<ConditionLevel, PostureDefinition>> = Object.freeze({
  GREEN: {
    level: "GREEN",
    trigger: "Normal operation. Sentinel and Security IQ are reachable and report nothing.",
    lanesNormal: ALL,
    lanesRestricted: [],
    lanesSuspended: [],
    crossInstancePermitted: true,
    trustTtlSeconds: 3600,
    operatorNote: "Ordinary authorized routes, ordinary QoS, standard verification.",
  },
  YELLOW: {
    level: "YELLOW",
    trigger: "Elevated. Something is unusual, or a security dependency is briefly unreachable.",
    lanesNormal: ["QUERY", "EVENT", "STREAM", "EVIDENCE", "HEALTH"],
    lanesRestricted: ["COMMAND", "WORKFLOW", "ARTIFACT"],
    lanesSuspended: [],
    crossInstancePermitted: true,
    trustTtlSeconds: 300,
    operatorNote:
      "Trust assertions expire in five minutes instead of an hour, so a revocation takes effect quickly. Nothing is blocked; state-changing lanes are verified more often.",
  },
  ORANGE: {
    level: "ORANGE",
    trigger: "An active threat is being handled.",
    lanesNormal: ["EVIDENCE", "HEALTH"],
    lanesRestricted: ["QUERY", "EVENT", "COMMAND"],
    lanesSuspended: ["STREAM", "WORKFLOW", "ARTIFACT"],
    crossInstancePermitted: false,
    trustTtlSeconds: 60,
    operatorNote:
      "Cross-instance traffic stops and high-volume lanes are suspended, which frees capacity and shrinks the surface at once. Local essential operation continues — containing a threat by stopping the business is rarely the right trade.",
  },
  RED: {
    level: "RED",
    trigger: "Severe compromise.",
    lanesNormal: ["EVIDENCE", "HEALTH"],
    lanesRestricted: ["COMMAND"],
    lanesSuspended: ["QUERY", "EVENT", "STREAM", "WORKFLOW", "ARTIFACT"],
    crossInstancePermitted: false,
    trustTtlSeconds: 30,
    operatorNote:
      "Fail closed on everything except explicitly verified essential routes. Evidence and health stay up — an incident the operators cannot see is worse than one they cannot stop.",
  },
  RECOVERY: {
    level: "RECOVERY",
    trigger: "Restoring after an incident, with trust being re-attested.",
    lanesNormal: ["EVIDENCE", "HEALTH"],
    lanesRestricted: ["QUERY", "COMMAND", "EVENT", "WORKFLOW"],
    lanesSuspended: ["STREAM", "ARTIFACT"],
    crossInstancePermitted: false,
    trustTtlSeconds: 120,
    operatorNote:
      "Routes come back gradually and trust is re-attested rather than assumed. Stricter than YELLOW on purpose: a system that has just been compromised has not yet earned the benefit of the doubt.",
  },
});

/**
 * How a lane is treated at a level.
 *
 * Explicit rather than derived, because "restricted" and "suspended" have
 * different operational meanings and a numeric comparison would collapse them.
 */
export function laneTreatment(level: ConditionLevel, lane: Lane): "NORMAL" | "RESTRICTED" | "SUSPENDED" {
  const posture = POSTURES[level];
  if (posture.lanesSuspended.includes(lane)) return "SUSPENDED";
  if (posture.lanesRestricted.includes(lane)) return "RESTRICTED";
  return "NORMAL";
}

/**
 * Whether evidence and health survive every level.
 *
 * They do, and it is a function so a test asserts it. Losing the ability to
 * see an incident is worse than the incident, and a posture that silenced
 * telemetry would blind the response it exists to support.
 */
export function evidenceSurvivesEveryLevel(): boolean {
  return (Object.keys(POSTURES) as ConditionLevel[]).every(
    (level) => laneTreatment(level, "EVIDENCE") !== "SUSPENDED" && laneTreatment(level, "HEALTH") !== "SUSPENDED",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CACHED POSTURE
// ─────────────────────────────────────────────────────────────────────────────

export interface CachedPosture {
  readonly level: ConditionLevel;
  readonly assertedAt: string;
  readonly assertedBy: string;
  /** After this, the cache is not merely stale — it is unusable. */
  readonly expiresAt: string;
}

export interface PostureResolution {
  readonly level: ConditionLevel;
  readonly fromCache: boolean;
  readonly reason: string;
}

/**
 * The level to operate at, given what is reachable.
 *
 * `securityReachable` false is not a neutral input. It raises the floor,
 * because an unreachable security system is itself a reason for caution — and
 * because the alternative, carrying on unchanged, converts a security outage
 * into a security bypass.
 */
export function resolvePosture(
  live: ConditionLevel | null,
  cached: CachedPosture | null,
  securityReachable: boolean,
  now: string,
  /** Where posture falls back to when nothing is known. */
  failSafeLevel: ConditionLevel = "ORANGE",
): PostureResolution {
  if (live !== null && securityReachable) {
    return { level: live, fromCache: false, reason: `Sentinel reports ${live}.` };
  }

  if (cached !== null && now < cached.expiresAt) {
    // Tightened while the authority is unreachable. The cached value is
    // evidence about the past, and the present is less certain than the past
    // was — so the cached level is a FLOOR, not the answer.
    const raised = stricter(cached.level, "YELLOW");
    return {
      level: raised,
      fromCache: true,
      reason: `Security is unreachable and the cached posture (${cached.level}, asserted by ${cached.assertedBy}) is still valid until ${cached.expiresAt}. Operating at ${raised} — the cache is evidence about the past, and an unreachable authority makes the present less certain than the past was.`,
    };
  }

  return {
    level: failSafeLevel,
    fromCache: false,
    reason:
      cached === null
        ? `No live posture and nothing cached. Falling back to ${failSafeLevel} rather than to GREEN — "nobody has told us there is a problem" is not evidence that there is not one.`
        : `The cached posture expired at ${cached.expiresAt} and security is unreachable. Falling back to ${failSafeLevel} rather than to the last known level, because "it was ${cached.level} ten minutes ago" is not evidence about now.`,
  };
}

/** The stricter of two levels. */
export function stricter(a: ConditionLevel, b: ConditionLevel): ConditionLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Whether moving from one level to another loosens the posture.
 *
 * Used to require that a loosening carries an authority behind it. Tightening
 * may be automatic; relaxing may not, because an automatic relax is one bad
 * signal away from being an attack.
 */
export function isLoosening(from: ConditionLevel, to: ConditionLevel): boolean {
  return STRICTNESS[to] < STRICTNESS[from];
}

export type PostureTransitionOutcome =
  | { readonly permitted: true; readonly reason: string }
  | { readonly permitted: false; readonly reason: string };

/**
 * Whether a posture change may proceed.
 *
 * Tightening never needs permission — it costs availability and grants
 * nothing, and requiring approval to become safer is how a system stays unsafe
 * during the minutes that matter. Loosening always needs an authority, and
 * going straight from RED to GREEN is refused outright: a system that was
 * severely compromised has not earned the benefit of the doubt, and RECOVERY
 * exists to be passed through.
 */
export function mayTransition(
  from: ConditionLevel,
  to: ConditionLevel,
  authorityRef: string | null,
): PostureTransitionOutcome {
  if (!isLoosening(from, to)) {
    return {
      permitted: true,
      reason: `Tightening from ${from} to ${to} needs no authorization. It costs availability and grants nothing, and requiring approval to become safer is how a system stays unsafe during the minutes that matter.`,
    };
  }

  if (authorityRef === null) {
    return {
      permitted: false,
      reason: `Relaxing from ${from} to ${to} needs an authorization reference and none was supplied. An automatic relax is one bad signal away from being an attack.`,
    };
  }

  if (from === "RED" && to === "GREEN") {
    return {
      permitted: false,
      reason:
        "RED does not become GREEN directly, even with authority. A severely compromised system has not earned the benefit of the doubt; RECOVERY exists to be passed through, with trust re-attested rather than assumed.",
    };
  }

  return { permitted: true, reason: `Relaxing from ${from} to ${to}, authorized by ${authorityRef}.` };
}

/**
 * Whether any posture level grants access the normal level does not.
 *
 * Always false. An engine whose emergency mode could widen access would be an
 * engine where declaring an emergency is an attack.
 */
export function postureMayGrantAccess(): false {
  return false;
}
