// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 §2/§7/§14/§21.1 — the two chambers, the security condition
// levels, and the failure model.
//
// Shield faces outward (threats, attacks, compromise signals); Guard faces
// inward (identity/trust evidence, charter boundaries, integrity, privileged
// action conformity). The architectural correction the V2 document leads
// with: Sentinel is NOT the mechanism owner and NOT Governance — it observes,
// verifies, detects, challenges, recommends, and may request only explicitly
// chartered containment.
//
// The doctrine that shapes every function here: graceful security degradation
// means becoming MORE restrictive under uncertainty, not less. Neither
// chamber silently absorbs the other permanently; restoration requires
// evidence and controlled recovery (§21.1).
// ─────────────────────────────────────────────────────────────────────────────

export const chamberSchema = z.enum(["shield", "guard"]);
export type Chamber = z.infer<typeof chamberSchema>;

export const chamberHealthSchema = z.enum(["operational", "impaired", "compromised-suspected"]);
export type ChamberHealth = z.infer<typeof chamberHealthSchema>;

export interface ChamberState {
  readonly chamber: Chamber;
  readonly health: ChamberHealth;
  /** Set when the OTHER chamber is covering; bounded, never permanent. */
  readonly crossCoverageActive: boolean;
  readonly crossCoverageSince: string | null;
}

export interface CrossCoveragePosture {
  /** What the healthy chamber does for the impaired one. */
  readonly coveringChamber: Chamber;
  readonly behaviors: readonly string[];
  /** §14/§21.1: the impaired chamber's authority is NOT assumed. */
  readonly authorityAssumed: false;
  /** Sensitive/high-risk operations fail closed during coverage. */
  readonly sensitiveOperationsFailClosed: boolean;
  /** Visibility degradation is EXPLICIT, never silent. */
  readonly degradationExplicit: true;
}

/**
 * §14 cross-coverage: if Guard is impaired, Shield continues detection and
 * may request pre-chartered containment — high-risk configuration and
 * privileged actions fail closed or need the direct Governance path. If
 * Shield is impaired, Guard forces a stricter pre-approved condition:
 * restrict lanes, fail closed, quarantine candidates, require stronger
 * authorization, block unverified changes.
 */
export function crossCoverage(impaired: Chamber, since: string): CrossCoveragePosture {
  if (impaired === "guard") {
    return {
      coveringChamber: "shield",
      behaviors: [
        "continue threat detection",
        "pre-chartered containment requests remain available",
        `guard impaired since ${since}: high-risk configuration and privileged actions fail closed or require the direct Governance path`,
      ],
      authorityAssumed: false,
      sensitiveOperationsFailClosed: true,
      degradationExplicit: true,
    };
  }
  return {
    coveringChamber: "guard",
    behaviors: [
      "tighten to predefined stricter posture",
      "restrict lanes; quarantine candidates; require stronger authorization",
      "block unverified changes",
      `shield impaired since ${since}: threat visibility degrades EXPLICITLY — existing cryptographic/authz enforcement continues`,
    ],
    authorityAssumed: false,
    sensitiveOperationsFailClosed: true,
    degradationExplicit: true,
  };
}

export type RestorationOutcome =
  | { readonly restored: true; readonly evidenceRefs: readonly string[] }
  | { readonly restored: false; readonly reason: string };

/** §21.1: restoration requires evidence and controlled recovery — a chamber
 * does not return to operational because time passed or someone asked. */
export function restoreChamber(
  state: ChamberState,
  integrityEvidenceRefs: readonly string[],
  attestationFresh: boolean,
): RestorationOutcome {
  if (state.health === "operational") return { restored: true, evidenceRefs: [] };
  if (integrityEvidenceRefs.length === 0) {
    return { restored: false, reason: "Restoration requires integrity evidence; none supplied." };
  }
  if (!attestationFresh) {
    return { restored: false, reason: "Restoration requires fresh re-attestation, not a stale one." };
  }
  return { restored: true, evidenceRefs: integrityEvidenceRefs };
}

// ── §7 / §21.10 · security condition levels ─────────────────────────────────

/** Five levels. The V2 document names the fifth BLACK in §7 and RECOVERY in
 * §21.10 — one level, two names; RECOVERY is canonical here with BLACK as
 * the recorded alias. */
export const CONDITION_LEVELS = ["GREEN", "YELLOW", "ORANGE", "RED", "RECOVERY"] as const;
export const conditionLevelSchema = z.enum(CONDITION_LEVELS);
export type ConditionLevel = z.infer<typeof conditionLevelSchema>;

export const CONDITION_ALIAS: Readonly<Record<string, ConditionLevel>> = { BLACK: "RECOVERY" };

export function restrictiveness(level: ConditionLevel): number {
  return CONDITION_LEVELS.indexOf(level);
}

export interface ConditionBehavior {
  readonly level: ConditionLevel;
  readonly behaviors: readonly string[];
}

export const CONDITION_BEHAVIORS: readonly ConditionBehavior[] = [
  { level: "GREEN", behaviors: ["standard zero-trust controls", "normal routing", "continuous monitoring"] },
  {
    level: "YELLOW",
    behaviors: ["shorter trust TTLs", "stronger challenge/re-authentication", "increased logging", "reduced external routes"],
  },
  {
    level: "ORANGE",
    behaviors: [
      "sensitive cross-instance lanes restricted",
      "privileged actions require stronger/repeated Governance checks",
      "suspicious zones isolated",
      "restricted external/AI capabilities",
    ],
  },
  {
    level: "RED",
    behaviors: [
      "fail closed for nonessential protected operations",
      "quarantine compromised workloads/instances through Security IQ primitives",
      "emergency-only communication lanes remain",
    ],
  },
  {
    level: "RECOVERY",
    behaviors: [
      "production changes frozen except authorized recovery",
      "forensic evidence preservation",
      "known-good restore/attestation required before reentry",
      "staged unquarantine and post-incident review",
    ],
  },
];

export interface ConditionTransition {
  readonly from: ConditionLevel;
  readonly to: ConditionLevel;
  readonly requestedBy: Chamber;
  readonly charteredCriterionRef: string;
  /** A transition toward MORE restrictive can proceed on chartered criteria;
   * material authority remains governed, and RELAXING always needs it. */
  readonly requiresGovernance: boolean;
}

export type TransitionOutcome =
  | { readonly ok: true; readonly transition: ConditionTransition }
  | { readonly ok: false; readonly reason: string };

/**
 * §7: transitions may be automatically REQUESTED by Shield/Guard on chartered
 * criteria; material authority remains governed. The asymmetry implemented:
 * tightening under a chartered criterion is allowed without waiting (that is
 * what pre-approval means); loosening ALWAYS requires Governance — degrading
 * gracefully means never becoming less restrictive on Sentinel's own signal.
 */
export function requestTransition(
  current: ConditionLevel,
  target: ConditionLevel,
  requestedBy: Chamber,
  charteredCriterionRef: string | undefined,
  governanceAuthorized: boolean,
): TransitionOutcome {
  if (charteredCriterionRef === undefined || charteredCriterionRef.trim() === "") {
    return { ok: false, reason: "A condition transition needs a chartered criterion reference; Sentinel does not improvise levels." };
  }
  const tightening = restrictiveness(target) > restrictiveness(current);
  if (!tightening && !governanceAuthorized) {
    return {
      ok: false,
      reason: `Relaxing ${current} -> ${target} requires Governance authorization; only tightening is pre-approved.`,
    };
  }
  return {
    ok: true,
    transition: {
      from: current,
      to: target,
      requestedBy,
      charteredCriterionRef,
      requiresGovernance: !tightening,
    },
  };
}

// ── §14 · the failure model, as required behaviors ──────────────────────────

export type FailureScenario =
  | "shield-unavailable"
  | "guard-unavailable"
  | "securityiq-provider-outage"
  | "governance-unavailable"
  | "fabric-partition"
  | "collective-unavailable"
  | "one-specialist-compromised";

export interface RequiredFailureBehavior {
  readonly scenario: FailureScenario;
  readonly behaviors: readonly string[];
  /** The invariant every row shares: nothing fails OPEN for protected
   * operations, and no authority is invented. */
  readonly failsOpenForProtectedOperations: false;
  readonly authorityInvented: false;
}

export function requiredBehavior(scenario: FailureScenario): RequiredFailureBehavior {
  const behaviors: Record<FailureScenario, readonly string[]> = {
    "shield-unavailable": [
      "Guard + Security IQ tighten to predefined posture",
      "existing cryptographic/authz enforcement continues",
      "threat visibility degrades explicitly",
    ],
    "guard-unavailable": [
      "Shield continues detection",
      "high-risk configuration/privileged actions fail closed or require the direct Governance path",
      "Guard authority is not silently assumed",
    ],
    "securityiq-provider-outage": [
      "cached short-lived trust may support explicitly allowed local continuity",
      "protected new sessions/actions fail closed after TTL",
      "emergency local safety actions remain available",
    ],
    "governance-unavailable": [
      "no new protected authority is invented",
      "previously authorized bounded work follows its explicit validity/TTL",
      "high-risk new actions stop",
    ],
    "fabric-partition": [
      "local Instance remains operational",
      "cross-instance routes stop/degrade",
      "no direct private-store bypass",
    ],
    "collective-unavailable": [
      "local Sentinel/Security continues",
      "generalized threat-feed freshness degrades visibly",
    ],
    "one-specialist-compromised": [
      "blast radius is compartmentalized",
      "independent evidence/checks can quarantine it",
      "it cannot grant itself broader authority",
    ],
  };
  return {
    scenario,
    behaviors: behaviors[scenario],
    failsOpenForProtectedOperations: false,
    authorityInvented: false,
  };
}
