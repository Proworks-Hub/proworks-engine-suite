// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  AuthorityEnvelope,
  Governance,
  GovernanceDecision,
  RiskClass,
} from "@proworks-hub/contracts";

import {
  CONSTITUTIONAL_CORE_PROTECTIONS,
  matches,
  type CoreProtection,
  type PolicyGrant,
  type PolicySet,
} from "./policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Governance Engine baseline.
//
// Charter §2 — the one question: "May this actor, engine, AI, service, or
// workflow perform this action, for this purpose, using this information, under
// these conditions?"
//
// Charter §4 — what it owns: authorization decisions, policy relationships,
// permission boundaries, delegation state, authority scope. It does NOT own
// Finance, Operations, Resources, work orders, customers, or any domain state.
// There is no domain type anywhere in this package, and that is the boundary
// made structural rather than promised.
//
// Charter §18 — the invariants this file is built around:
//
//   "Missing permission does not create permission."
//   "Uncertainty does not create authority."
//
// Both are the same shape: every path that cannot establish authority must end
// in a denial, never in a fall-through.
// ─────────────────────────────────────────────────────────────────────────────

const RISK_ORDER: Readonly<Record<RiskClass, number>> = Object.freeze({
  routine: 0,
  elevated: 1,
  high: 2,
  critical: 3,
});

export interface GovernanceEngineOptions {
  policy: PolicySet;
  /**
   * Additional protections beyond the constitutional set.
   *
   * The constitutional ones are always applied; these are added, never
   * substituted. A configuration that could remove a Core Protection would
   * make it configuration rather than protection.
   */
  additionalProtections?: readonly CoreProtection[];
  now?: () => Date;
  /** Called for every decision. Charter §17: consequential decisions are explainable. */
  onDecision?: (decision: GovernanceDecision, envelope: AuthorityEnvelope) => void;
  /** Injectable so a caller can correlate a decision with its own records. */
  generateDecisionId?: () => string;
}

/** Why a grant did not apply. Kept so a denial can say what was close. */
interface GrantMiss {
  readonly grantId: string;
  readonly failed: string;
}

export interface GovernanceEngine extends Governance {
  /** Which policy is in force. For an operator asking what is configured. */
  describe(): { policyId: string; version: string; grants: number; protections: number };
}

export function createGovernanceEngine(options: GovernanceEngineOptions): GovernanceEngine {
  const now = options.now ?? (() => new Date());
  const newId =
    options.generateDecisionId ??
    (() => `gd_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

  // Constitutional protections FIRST and always. A configured policy cannot
  // remove one, only add to the set.
  const protections: CoreProtection[] = [
    ...CONSTITUTIONAL_CORE_PROTECTIONS,
    ...(options.additionalProtections ?? []),
    ...options.policy.protections,
  ];

  const decide = (
    envelope: AuthorityEnvelope,
    decision: GovernanceDecision["decision"],
    reason: string,
    extra: Partial<GovernanceDecision> = {},
  ): GovernanceDecision => {
    const result: GovernanceDecision = {
      decision,
      reason,
      policyId: options.policy.policyId,
      policyVersion: options.policy.version,
      ...(options.policy.constitutionVersion
        ? { constitutionVersion: options.policy.constitutionVersion }
        : {}),
      conditions: [],
      decisionId: newId(),
      decidedAt: now().toISOString(),
      ...extra,
    };
    options.onDecision?.(result, envelope);
    return result;
  };

  const grantApplies = (
    grant: PolicyGrant,
    envelope: AuthorityEnvelope,
    at: Date,
  ): GrantMiss | null => {
    if (!matches(grant.actors, envelope.actorId)) return { grantId: grant.grantId, failed: "actor" };
    if (!matches(grant.actions, envelope.requestedAction))
      return { grantId: grant.grantId, failed: "action" };
    if (!matches(grant.tenants, envelope.tenant.organizationId))
      return { grantId: grant.grantId, failed: "tenant" };
    if (!matches(grant.purposes, envelope.purpose))
      return { grantId: grant.grantId, failed: "purpose" };

    if (RISK_ORDER[envelope.riskClass] > RISK_ORDER[grant.maxRiskClass]) {
      return { grantId: grant.grantId, failed: "riskClass" };
    }

    // Time bounds are checked against the engine's clock, never the caller's.
    // A caller that could supply "now" could outlive its own grant.
    if (grant.notBefore && at < new Date(grant.notBefore)) {
      return { grantId: grant.grantId, failed: "notBefore" };
    }
    if (grant.expiresAt && at >= new Date(grant.expiresAt)) {
      return { grantId: grant.grantId, failed: "expired" };
    }
    return null;
  };

  return {
    describe: () => ({
      policyId: options.policy.policyId,
      version: options.policy.version,
      grants: options.policy.grants.length,
      protections: protections.length,
    }),

    async authorize(envelope: AuthorityEnvelope): Promise<GovernanceDecision> {
      const at = now();

      // ── 1. Core Protections, before anything else ────────────────────────
      // Checked first so no permissive grant can out-vote a prohibition. A
      // protection evaluated after grants would be a protection a broad grant
      // could defeat by matching first.
      for (const protection of protections) {
        if (matches(protection.actions, envelope.requestedAction)) {
          return decide(
            envelope,
            "PROHIBITED",
            `${protection.reason} (${protection.constitutionalBasis}). No policy, grant or override can permit this.`,
          );
        }
      }

      // ── 2. The request must be well formed enough to decide ──────────────
      // Charter §18: uncertainty does not create authority. Each is checked
      // separately so the denial names what was missing.
      if (!envelope.actorId) {
        return decide(envelope, "DENIED", "No actor. An action with no actor cannot be authorized.");
      }
      if (!envelope.tenant?.organizationId) {
        return decide(envelope, "DENIED", "No tenant. Consequential action must be scoped to a tenant.");
      }
      if (!envelope.purpose) {
        return decide(
          envelope,
          "DENIED",
          "No purpose. Authority is purpose-bound (Constitution §1.7); an action with no stated purpose cannot be checked against one.",
        );
      }
      if (envelope.expiresAt && at >= new Date(envelope.expiresAt)) {
        return decide(
          envelope,
          "DENIED",
          `The request's authority basis expired at ${envelope.expiresAt}. Expired authority is absent authority.`,
        );
      }

      // ── 3. Grants ─────────────────────────────────────────────────────────
      const misses: GrantMiss[] = [];
      for (const grant of options.policy.grants) {
        const miss = grantApplies(grant, envelope, at);
        if (miss) {
          misses.push(miss);
          continue;
        }

        if (grant.conditions.length > 0) {
          return decide(
            envelope,
            "PERMITTED_WITH_CONDITIONS",
            `Permitted by ${grant.grantId}: ${grant.reason}`,
            { conditions: [...grant.conditions] },
          );
        }

        return decide(envelope, "PERMITTED", `Permitted by ${grant.grantId}: ${grant.reason}`);
      }

      // ── 4. Nothing matched ────────────────────────────────────────────────
      // Charter §18: "Missing permission does not create permission." The
      // near-misses are reported because "denied" alone sends an operator to
      // read the policy file, and "the grant that covers this action does not
      // cover this tenant" does not.
      const expired = misses.filter((m) => m.failed === "expired");
      const detail =
        expired.length > 0
          ? ` ${expired.length} grant(s) would have applied but have expired: ${expired
              .map((m) => m.grantId)
              .join(", ")}.`
          : misses.length > 0
            ? ` Closest grants did not match on: ${[...new Set(misses.map((m) => m.failed))].join(", ")}.`
            : " No grants are configured.";

      return decide(
        envelope,
        "DENIED",
        `No grant permits "${envelope.requestedAction}" for "${envelope.actorId}" in tenant ` +
          `"${envelope.tenant.organizationId}" for purpose "${envelope.purpose}".${detail}`,
      );
    },
  };
}
