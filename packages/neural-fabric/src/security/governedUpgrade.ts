/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/security/governedUpgrade.ts
 * Module:   neural-fabric / security
 * Purpose:  One operator today, a quorum tomorrow — and no back door either way.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// A SINGLE-OPERATOR PHASE THAT IS A GOVERNANCE STATE, NOT A BACKDOOR
//
// §34.7 addresses a problem most systems handle badly. A new deployment has one
// operator. Requiring multi-party approval for critical changes is correct and
// impossible, so the usual outcome is a check that "temporarily" accepts one
// approver — and the check is still there four years later, because nothing
// ever made it stop.
//
// The plan's answer, and this implementation of it: bootstrap is a VERSIONED
// GOVERNANCE STATE with explicit entry and exit criteria, not a flag. It is
// visible, it is dated, it records who it applies to, and — the part that
// matters — it becomes MORE restrictive automatically as operators are
// enrolled. It cannot outlive the condition that justified it.
//
// "Bootstrap authority is not an invisible backdoor. It is a versioned
//  governance state with explicit entry/exit criteria and must become more
//  restrictive as additional trusted operators are enrolled."
//
// UPGRADES TRAVEL AS SIGNED REFERENCES, NEVER AS PAYLOAD
//
// §34.7 again: "Upgrade packages travel by signed artifact reference, not
// arbitrary code blobs in ordinary messages." An ordinary message carrying
// executable content is a remote code execution channel that every routing
// rule will faithfully deliver.
//
// AND SENTINEL CANNOT LOCK THE HUMANS OUT
//
// §34.8 is the constraint that makes the rest safe to build. Sentinel may pause
// an upgrade, require re-verification, and suspend individual sessions. What it
// may never do is permanently remove the authorized human recovery path,
// because a security system that can lock out its owners has become the threat
// it was built to contain.
// ─────────────────────────────────────────────────────────────────────────────

export const governanceStateSchema = z
  .object({
    stateId: z.string().min(1),
    /** Bootstrap is a version of the governance state, so it appears in history. */
    phase: z.enum(["BOOTSTRAP", "MULTI_OPERATOR"]),
    /** How many independent operators must approve a critical change. */
    requiredApprovals: z.number().int().positive(),
    /** Operators currently enrolled and trusted. */
    enrolledOperatorIds: z.array(z.string().min(1)),
    /**
     * What has to become true for bootstrap to end.
     *
     * Required while in bootstrap. A phase with no exit criteria is a phase
     * that does not end, which is the failure this whole design exists to
     * prevent.
     */
    exitCriteria: z.string().min(1).nullable(),
    enteredAt: z.string().min(1),
    /** The decision that established this state. */
    authorizingDecisionRef: z.string().min(1),
  })
  .strict()
  .refine((s) => s.phase !== "BOOTSTRAP" || s.exitCriteria !== null, {
    message:
      "A bootstrap phase must state what ends it. Without exit criteria it is not a phase, it is a permanent exception with a temporary-sounding name.",
    path: ["exitCriteria"],
  })
  .refine((s) => s.phase !== "BOOTSTRAP" || s.enrolledOperatorIds.length <= 1, {
    message:
      "Bootstrap is for a single operator. With more than one enrolled, the condition that justified single-operator approval no longer holds and the state should have advanced.",
    path: ["phase"],
  });
export type GovernanceState = z.infer<typeof governanceStateSchema>;

/**
 * The approvals a critical change needs, given who is enrolled.
 *
 * Computed from the enrolled population rather than read from configuration,
 * so it tightens automatically. A configured threshold is a number somebody has
 * to remember to change, and the whole failure mode here is that nobody does.
 */
export function requiredApprovalsFor(
  state: GovernanceState,
  changeRisk: "ROUTINE" | "CRITICAL",
): { readonly required: number; readonly reason: string } {
  if (changeRisk === "ROUTINE") {
    return { required: 1, reason: "A routine change needs one authorized approver." };
  }

  const enrolled = state.enrolledOperatorIds.length;

  if (enrolled <= 1) {
    return {
      required: 1,
      reason: `Only ${enrolled} operator is enrolled, so a critical change can be approved by one. This is the bootstrap condition, and it is a fact about the population rather than a permission somebody granted — enrol a second operator and this becomes two without anybody changing a setting.`,
    };
  }

  // Two is the meaningful step. Beyond that, requiring a majority scales the
  // guarantee with the population instead of leaving it fixed at the number
  // that happened to be convenient when it was written.
  const required = Math.max(2, Math.ceil(enrolled / 2));
  return {
    required,
    reason: `${enrolled} operators are enrolled, so a critical change needs ${required}. Derived from the population rather than configured, because a configured threshold is a number somebody has to remember to raise and nobody does.`,
  };
}

export type PhaseVerdict =
  | { readonly mayRemain: true; readonly reason: string }
  | { readonly mayRemain: false; readonly reason: string; readonly requiredAction: string };

/**
 * Whether the bootstrap phase is still justified.
 *
 * Checked rather than assumed. The condition that justifies single-operator
 * approval is that there IS one operator, and the moment that stops being true
 * the phase has outlived its reason — whatever the configuration still says.
 */
export function bootstrapStillJustified(state: GovernanceState): PhaseVerdict {
  if (state.phase !== "BOOTSTRAP") {
    return { mayRemain: true, reason: "Not in bootstrap." };
  }

  if (state.enrolledOperatorIds.length > 1) {
    return {
      mayRemain: false,
      reason: `${state.enrolledOperatorIds.length} operators are enrolled and the state still says BOOTSTRAP. The condition that justified single-operator approval no longer holds.`,
      requiredAction:
        "Advance the governance state to MULTI_OPERATOR. Until then, critical changes are approved by a threshold derived from the population rather than by the bootstrap allowance — the phase does not get to outlive its reason.",
    };
  }

  return {
    mayRemain: true,
    reason: `One operator is enrolled, so bootstrap still describes reality. It ends when: ${state.exitCriteria}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPGRADES
// ─────────────────────────────────────────────────────────────────────────────

export const upgradeRequestSchema = z
  .object({
    upgradeId: z.string().min(1),
    targetComponent: z.string().min(1),
    /**
     * A REFERENCE to a signed artifact. Never the artifact.
     *
     * An ordinary message carrying executable content is a remote code
     * execution channel that every routing rule will faithfully deliver.
     */
    artifactRef: z.string().min(1),
    artifactSignature: z.string().min(1),
    signedBy: z.string().min(1),
    risk: z.enum(["ROUTINE", "CRITICAL"]),
    /** Distinct operator ids that have approved. Duplicates do not count. */
    approvals: z.array(z.string().min(1)),
    /** Evidence the change was tested somewhere it could not hurt anything. */
    sandboxEvidenceRef: z.string().min(1).nullable(),
    rollbackPlanRef: z.string().min(1).nullable(),
    requestedAt: z.string().min(1),
  })
  .strict();
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>;

export type UpgradeVerdict =
  | { readonly mayProceed: true; readonly reason: string }
  | { readonly mayProceed: false; readonly reason: string; readonly missing: readonly string[] };

/**
 * Whether an upgrade may be routed to production.
 *
 * Every requirement is checked and ALL failures are returned, because an
 * operator preparing a critical change should learn everything that is missing
 * in one attempt rather than discovering them one rejection at a time.
 */
export function mayRouteUpgrade(
  request: UpgradeRequest,
  state: GovernanceState,
  sentinelPaused: boolean,
): UpgradeVerdict {
  const missing: string[] = [];

  // Distinct approvers. Counting an id twice would make a threshold of two
  // satisfiable by one person clicking twice, which is the most obvious way to
  // defeat multi-party approval and therefore the one to close first.
  const distinct = new Set(request.approvals);
  const { required, reason: approvalReason } = requiredApprovalsFor(state, request.risk);

  if (distinct.size < required) {
    missing.push(
      `${required} distinct approvals and ${distinct.size} supplied. ${approvalReason}${
        distinct.size !== request.approvals.length
          ? ` (${request.approvals.length} were submitted, and duplicates do not count — a threshold satisfiable by one person approving twice is not a threshold.)`
          : ""
      }`,
    );
  }

  for (const approver of distinct) {
    if (!state.enrolledOperatorIds.includes(approver)) {
      missing.push(
        `"${approver}" approved and is not an enrolled operator. An approval from outside the enrolled set is not an approval.`,
      );
    }
  }

  if (request.risk === "CRITICAL" && request.sandboxEvidenceRef === null) {
    missing.push(
      "sandbox evidence for a critical change. §18 is explicit that sandbox results are evidence rather than authorization — but an upgrade with no evidence at all has neither.",
    );
  }

  if (request.risk === "CRITICAL" && request.rollbackPlanRef === null) {
    missing.push(
      "a rollback plan for a critical change. An upgrade that cannot be undone is a decision that cannot be revisited, and it should be taken as one rather than as a deployment.",
    );
  }

  const bootstrap = bootstrapStillJustified(state);
  if (!bootstrap.mayRemain) {
    missing.push(
      `the governance state is stale: ${bootstrap.reason} ${bootstrap.requiredAction}`,
    );
  }

  if (sentinelPaused) {
    // Sentinel may pause. It may not permanently prevent — see the recovery
    // path below.
    missing.push(
      "Sentinel has paused this upgrade pending re-verification. That is a pause and not a veto: the authorized human recovery path remains, because a security system that could permanently lock out its owners would have become the threat it was built to contain.",
    );
  }

  if (missing.length > 0) {
    return {
      mayProceed: false,
      missing,
      reason: `The upgrade is not routable yet. ${missing.length} requirement${missing.length === 1 ? " is" : "s are"} unmet, all listed so they can be fixed in one pass.`,
    };
  }

  return {
    mayProceed: true,
    reason: `Routable: ${distinct.size} of ${required} required approvals from enrolled operators, signed artifact ${request.artifactRef} by ${request.signedBy}${
      request.risk === "CRITICAL" ? ", with sandbox evidence and a rollback plan" : ""
    }.`,
  };
}

/**
 * Whether Sentinel can permanently remove the human recovery path.
 *
 * Always false. §34.8's constraint, as a function CI asserts. Sentinel may
 * pause, require re-verification, and suspend a session; it may never leave
 * the owners with no route back in.
 */
export function sentinelMayRemoveRecoveryPath(): false {
  return false;
}

export interface RecoveryPath {
  readonly available: true;
  readonly requirements: readonly string[];
  readonly note: string;
}

/**
 * The route back in when everything else has failed.
 *
 * `available` is the literal `true`, not a boolean. There is no input to this
 * function that makes the recovery path unavailable, and the type says so —
 * which is a stronger statement than a runtime check somebody could pass the
 * wrong argument to.
 */
export function constitutionalRecoveryPath(): RecoveryPath {
  return {
    available: true,
    requirements: [
      "Independent recovery credentials, held outside any running session.",
      "Identity proof over a channel separate from the compromised one.",
      "Immutable evidence of the recovery, recorded whether or not it succeeds.",
      "Where more than one operator is enrolled, quorum approval rather than a single senior identity.",
    ],
    note:
      "This path is always available. Sentinel may pause an upgrade, require re-verification, and suspend an individual session — it may not remove this, because a security system that can permanently lock out its owners has become the threat it was built to contain.",
  };
}
