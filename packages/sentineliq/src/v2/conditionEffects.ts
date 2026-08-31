// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { restrictiveness, type ConditionLevel } from "./chambers.js";

// ─────────────────────────────────────────────────────────────────────────────
// Condition-level EFFECTS — directive §19 (DEC-028 increment 4).
//
// The audit recorded this as CONFLICT #2: the V2 build's condition levels
// were pure data. §19 escalates them: "Condition changes must have real
// effects." This module computes those effects as a POSTURE — a derived,
// declarative set of constraints other components read and apply.
//
// WHY A POSTURE AND NOT AN ACTION: Sentinel does not route, does not issue
// credentials and does not enforce. Fabric restricts lanes, Security IQ sets
// trust TTLs, the runtime reduces capability. If this module reached out and
// did those things it would become the mechanism owner the constitution says
// it is not. So it computes what the posture MUST be, hands it over, and the
// mechanism owners apply it — and a component that ignores a posture is
// itself observable (§13's sensors see the effect not happening).
//
// THE TWO INVARIANTS, both mutation-proven:
//
//   MONOTONICITY — every constraint tightens or holds as the level rises.
//   Not one loosens. A posture where RED permits something ORANGE forbade is
//   a posture that rewards an attacker for escalating.
//
//   TIME DOES NOT RESTORE TRUST (§19, verbatim). Returning to a lower level
//   is a Governance act with evidence; this module can compute the RECOVERY
//   posture but cannot compute a way back to GREEN.
// ─────────────────────────────────────────────────────────────────────────────

export interface SecurityPosture {
  readonly level: ConditionLevel;
  /** Maximum trust-evidence lifetime Security IQ should honour, in seconds.
   * Lower is stricter. */
  readonly maxTrustTtlSeconds: number;
  /** Step-up verification required for these action classes. */
  readonly stepUpRequiredFor: readonly ActionClass[];
  /** Route classes Fabric must refuse. */
  readonly deniedRouteClasses: readonly RouteClass[];
  /** AI capability classes the runtime must withhold. */
  readonly withheldAiCapabilities: readonly AiCapabilityClass[];
  /** Protected operations fail closed when their checks are merely unknown. */
  readonly failClosedOnUnknown: boolean;
  /** Only recovery-purposed routes and actions are permitted. */
  readonly recoveryOnly: boolean;
  /** Production change freeze except authorized recovery. */
  readonly productionChangeFrozen: boolean;
  /** Re-attestation required before a workload is trusted again. */
  readonly reattestationRequired: boolean;
  readonly appliedBy: readonly string[];
}

export const ACTION_CLASSES = ["read", "write", "privileged", "constitutional"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const ROUTE_CLASSES = ["intra-instance", "cross-instance", "external-egress", "collective", "emergency"] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];

export const AI_CAPABILITY_CLASSES = ["analysis", "tool-use", "external-egress", "code-generation", "autonomous-action"] as const;
export type AiCapabilityClass = (typeof AI_CAPABILITY_CLASSES)[number];

/**
 * The posture table. Each level's constraints are a superset of the level
 * below — enforced by `postureIsMonotone` and asserted in tests, so a future
 * edit that loosens something at a higher level fails rather than ships.
 */
export function postureFor(level: ConditionLevel): SecurityPosture {
  const appliedBy = ["security-iq", "neural-fabric", "model-runtime"];
  switch (level) {
    case "GREEN":
      return {
        level,
        maxTrustTtlSeconds: 3_600,
        stepUpRequiredFor: ["constitutional"],
        deniedRouteClasses: [],
        withheldAiCapabilities: [],
        failClosedOnUnknown: true, // deny-by-default is the FLOOR, not a RED behaviour
        recoveryOnly: false,
        productionChangeFrozen: false,
        reattestationRequired: false,
        appliedBy,
      };
    case "YELLOW":
      return {
        level,
        maxTrustTtlSeconds: 900,
        stepUpRequiredFor: ["privileged", "constitutional"],
        deniedRouteClasses: [],
        withheldAiCapabilities: ["autonomous-action"],
        failClosedOnUnknown: true,
        recoveryOnly: false,
        productionChangeFrozen: false,
        reattestationRequired: false,
        appliedBy,
      };
    case "ORANGE":
      return {
        level,
        maxTrustTtlSeconds: 300,
        stepUpRequiredFor: ["write", "privileged", "constitutional"],
        deniedRouteClasses: ["cross-instance", "collective"],
        withheldAiCapabilities: ["autonomous-action", "external-egress", "code-generation"],
        failClosedOnUnknown: true,
        recoveryOnly: false,
        productionChangeFrozen: false,
        reattestationRequired: false,
        appliedBy,
      };
    case "RED":
      return {
        level,
        maxTrustTtlSeconds: 60,
        stepUpRequiredFor: ["read", "write", "privileged", "constitutional"],
        deniedRouteClasses: ["cross-instance", "collective", "external-egress"],
        withheldAiCapabilities: ["autonomous-action", "external-egress", "code-generation", "tool-use"],
        failClosedOnUnknown: true,
        recoveryOnly: false,
        productionChangeFrozen: true,
        reattestationRequired: true,
        appliedBy,
      };
    case "RECOVERY":
      return {
        level,
        maxTrustTtlSeconds: 60,
        stepUpRequiredFor: ["read", "write", "privileged", "constitutional"],
        // Everything but the emergency lane; recovery traffic is explicitly
        // permitted through `recoveryOnly` rather than by reopening routes.
        deniedRouteClasses: ["intra-instance", "cross-instance", "collective", "external-egress"],
        withheldAiCapabilities: [...AI_CAPABILITY_CLASSES],
        failClosedOnUnknown: true,
        recoveryOnly: true,
        productionChangeFrozen: true,
        reattestationRequired: true,
        appliedBy,
      };
  }
}

/**
 * Monotonicity check: for two levels a ≤ b, every constraint at b is at
 * least as strict as at a. Exposed (not merely tested) so a host can assert
 * it over a customized table before trusting one.
 */
export function postureIsMonotone(lower: ConditionLevel, higher: ConditionLevel): { monotone: boolean; violations: readonly string[] } {
  if (restrictiveness(higher) < restrictiveness(lower)) return postureIsMonotone(higher, lower);
  const a = postureFor(lower);
  const b = postureFor(higher);
  const violations: string[] = [];
  if (b.maxTrustTtlSeconds > a.maxTrustTtlSeconds) violations.push(`trust TTL loosens ${a.maxTrustTtlSeconds}s -> ${b.maxTrustTtlSeconds}s`);
  for (const cls of a.stepUpRequiredFor) if (!b.stepUpRequiredFor.includes(cls)) violations.push(`step-up dropped for ${cls}`);
  for (const cls of a.deniedRouteClasses) if (!b.deniedRouteClasses.includes(cls)) violations.push(`route class re-permitted: ${cls}`);
  for (const cls of a.withheldAiCapabilities) if (!b.withheldAiCapabilities.includes(cls)) violations.push(`AI capability re-granted: ${cls}`);
  if (a.failClosedOnUnknown && !b.failClosedOnUnknown) violations.push("fail-closed dropped");
  if (a.productionChangeFrozen && !b.productionChangeFrozen) violations.push("production freeze lifted");
  if (a.reattestationRequired && !b.reattestationRequired) violations.push("re-attestation dropped");
  return { monotone: violations.length === 0, violations };
}

// ── Applying a posture to a concrete request ────────────────────────────────

export interface OperationRequest {
  readonly actionClass: ActionClass;
  readonly routeClass: RouteClass;
  readonly stepUpSatisfied: boolean;
  /** null = the check could not be evaluated. */
  readonly checksEvaluable: boolean | null;
  readonly isRecoveryPurposed: boolean;
  readonly trustEvidenceAgeSeconds: number;
}

export type PostureVerdict =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly refusals: readonly string[] };

/** The posture applied. Every refusal is named, so a denial is explainable
 * (§16 doc: observability/explainability — why a deny occurred). */
export function applyPosture(posture: SecurityPosture, request: OperationRequest): PostureVerdict {
  const refusals: string[] = [];
  if (posture.recoveryOnly && !request.isRecoveryPurposed) {
    refusals.push(`${posture.level}: recovery-only — this operation is not recovery-purposed`);
  }
  if (posture.deniedRouteClasses.includes(request.routeClass) && !(posture.recoveryOnly && request.isRecoveryPurposed)) {
    refusals.push(`${posture.level}: route class ${request.routeClass} is denied`);
  }
  if (posture.stepUpRequiredFor.includes(request.actionClass) && !request.stepUpSatisfied) {
    refusals.push(`${posture.level}: step-up verification required for ${request.actionClass}`);
  }
  if (request.trustEvidenceAgeSeconds > posture.maxTrustTtlSeconds) {
    refusals.push(`${posture.level}: trust evidence ${request.trustEvidenceAgeSeconds}s exceeds the ${posture.maxTrustTtlSeconds}s ceiling`);
  }
  if (posture.failClosedOnUnknown && request.checksEvaluable !== true) {
    refusals.push(`${posture.level}: a check could not be evaluated and the posture fails closed on unknown`);
  }
  return refusals.length === 0 ? { permitted: true } : { permitted: false, refusals };
}

// ── Returning to a lower level ──────────────────────────────────────────────

export type DeescalationOutcome =
  | { readonly permitted: true; readonly to: ConditionLevel }
  | { readonly permitted: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * §19: "Time passing alone must not restore trust." De-escalation requires a
 * Governance authorization AND evidence that the conditions which justified
 * the level no longer hold — specifically re-attestation where the level
 * required it, and closure of the incidents that raised it.
 *
 * There is no elapsed-time parameter in this function. That is the point.
 */
export function requestDeescalation(input: {
  readonly from: ConditionLevel;
  readonly to: ConditionLevel;
  readonly governanceAuthorizationRef: string | undefined;
  readonly reattestationEvidenceRefs: readonly string[];
  readonly openIncidentIds: readonly string[];
}): DeescalationOutcome {
  if (restrictiveness(input.to) >= restrictiveness(input.from)) {
    return { permitted: false, reason: "This is not a de-escalation; tightening uses requestTransition.", missing: [] };
  }
  const missing: string[] = [];
  if (input.governanceAuthorizationRef === undefined) missing.push("Governance authorization");
  if (postureFor(input.from).reattestationRequired && input.reattestationEvidenceRefs.length === 0) {
    missing.push("re-attestation evidence");
  }
  if (input.openIncidentIds.length > 0) missing.push(`closure of open incidents: ${input.openIncidentIds.join(", ")}`);
  if (missing.length > 0) {
    return {
      permitted: false,
      reason: `Returning ${input.from} -> ${input.to} requires evidence, not elapsed time.`,
      missing,
    };
  }
  return { permitted: true, to: input.to };
}
