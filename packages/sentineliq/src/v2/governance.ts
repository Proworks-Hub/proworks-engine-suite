// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel V2 §21.7–§21.9 — human operator protection, constitutional
// recovery, the risk-based upgrade authorization chain, and Bootstrap
// Governance.
//
// The constitutional line, verbatim from §21.7: "No single Sentinel
// component may delete founder/senior authority records, rewrite the
// Constitution, or permanently revoke the last valid recovery authority on
// its own." Implemented structurally: the operator-registry type has no
// remove operation that can take the last recovery authority, and session
// containment of a senior identity always leaves an independent recovery
// path standing.
//
// §21.9: the single-operator build phase is a formally recorded Bootstrap
// Governance STATE — a governed configuration record, never a hidden
// hard-coded bypass — with explicit exit criteria and no casual re-entry.
// ─────────────────────────────────────────────────────────────────────────────

// ── Operator registry — the last recovery authority is irremovable ──────────

export interface OperatorRecord {
  readonly principalRef: string; // human.
  readonly privilege: "standard" | "senior" | "recovery-authority";
}

export type RegistryChangeOutcome =
  | { readonly ok: true; readonly operators: readonly OperatorRecord[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Removing an operator record: permitted for standard/senior records with
 * authorization — but there is NO path that removes the last
 * recovery-authority record. Not "requires more approval": the operation
 * does not exist (§21.7, certification gate §21.12).
 */
export function removeOperator(
  operators: readonly OperatorRecord[],
  principalRef: string,
  authorizedBy: string,
): RegistryChangeOutcome {
  if (!authorizedBy.startsWith("human.")) {
    return { ok: false, reason: "Operator registry changes are human-authorized, attributable acts." };
  }
  const target = operators.find((o) => o.principalRef === principalRef);
  if (target === undefined) return { ok: false, reason: `No operator record for ${principalRef}.` };
  if (target.privilege === "recovery-authority") {
    const remainingRecovery = operators.filter(
      (o) => o.privilege === "recovery-authority" && o.principalRef !== principalRef,
    );
    if (remainingRecovery.length === 0) {
      return {
        ok: false,
        reason:
          "The last valid recovery authority cannot be revoked by any Sentinel operation — the operation does not exist. Enroll a replacement recovery authority first.",
      };
    }
  }
  return { ok: true, operators: operators.filter((o) => o.principalRef !== principalRef) };
}

// ── Session containment — protect the Hive, preserve recovery ───────────────

export type SessionContainmentOutcome =
  | {
      readonly contained: true;
      readonly action: "challenged" | "paused" | "capability-reduced" | "quarantined";
      readonly escalatedTo: string;
      /** For a senior identity: the pause is on the SESSION; an independent
       * constitutional recovery path remains standing. */
      readonly independentRecoveryPathPreserved: true;
    }
  | { readonly contained: false; readonly reason: string };

export function containOperatorSession(input: {
  readonly operator: OperatorRecord;
  readonly evidenceRefs: readonly string[];
  readonly requestedAction: "challenged" | "paused" | "capability-reduced" | "quarantined";
  readonly escalationTargetRef: string;
}): SessionContainmentOutcome {
  if (input.evidenceRefs.length === 0) {
    return { contained: false, reason: "Operator containment needs defined evidence thresholds met — evidence, not vibes." };
  }
  if (input.operator.privilege === "recovery-authority" && input.requestedAction === "quarantined") {
    // A credible-compromise pause of an individual SESSION is available;
    // quarantining the last recovery identity's access wholesale is not a
    // Sentinel power. Downgrade to the strongest preserved action.
    return {
      contained: true,
      action: "paused",
      escalatedTo: input.escalationTargetRef,
      independentRecoveryPathPreserved: true,
    };
  }
  return {
    contained: true,
    action: input.requestedAction,
    escalatedTo: input.escalationTargetRef,
    independentRecoveryPathPreserved: true,
  };
}

// ── Break-glass — separate credentials, immutable evidence, review ──────────

export const breakGlassRecordSchema = z
  .object({
    recordRef: z.string().min(1),
    usedBy: z.string().startsWith("human."),
    /** Separate credentials/channel — NOT an everyday bypass token. */
    separateCredentialChannelRef: z.string().min(1),
    explicitReason: z.string().min(1),
    timeLimitSeconds: z.number().int().positive(),
    heightenedLoggingActive: z.literal(true),
    postUseReviewRequired: z.literal(true),
  })
  .strict();
export type BreakGlassRecord = z.infer<typeof breakGlassRecordSchema>;

export function openBreakGlass(input: {
  recordRef: string;
  usedBy: string;
  separateCredentialChannelRef: string | undefined;
  explicitReason: string;
  timeLimitSeconds: number;
}): { ok: true; record: BreakGlassRecord } | { ok: false; reason: string } {
  if (input.separateCredentialChannelRef === undefined) {
    return { ok: false, reason: "Break-glass uses separate credentials and channels — an everyday token reused here is a bypass, not a recovery path." };
  }
  const parsed = breakGlassRecordSchema.safeParse({
    recordRef: input.recordRef,
    usedBy: input.usedBy,
    separateCredentialChannelRef: input.separateCredentialChannelRef,
    explicitReason: input.explicitReason,
    timeLimitSeconds: input.timeLimitSeconds,
    heightenedLoggingActive: true,
    postUseReviewRequired: true,
  });
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid break-glass record" };
  return { ok: true, record: parsed.data };
}

// ── §21.8 · the risk-based upgrade authorization chain ──────────────────────

export type UpgradeClass =
  | "routine-low-risk-patch"
  | "sensitive-security-configuration"
  | "core-constitutional-high-blast-radius"
  | "emergency-security-patch";

export interface UpgradeRequest {
  readonly upgradeRef: string;
  readonly upgradeClass: UpgradeClass;
  readonly approvals: readonly string[]; // human. principals
  readonly automatedTestsPassed: boolean;
  readonly integrityVerified: boolean;
  readonly sandboxValidated: boolean;
  readonly artifactSigned: boolean;
  readonly rollbackPlanRef: string | null;
  readonly governanceAuthorized: boolean;
  readonly emergencyPolicyRef: string | null;
}

export type UpgradeVerdict =
  | { readonly authorized: true; readonly retrospectiveReviewRequired: boolean; readonly bootstrapSatisfiedQuorum: boolean }
  | { readonly authorized: false; readonly missing: readonly string[] };

export interface GovernanceMode {
  readonly mode: "bootstrap" | "normal";
  /** §21.9: identified through a governed record, never a hidden bypass. */
  readonly bootstrapPrincipalRef: string | null;
  readonly bootstrapStateRecordRef: string | null;
}

/**
 * §21.8 with §21.9 folded in: the quorum a class requires, and how bootstrap
 * legitimately satisfies it. Bootstrap changes the HUMAN QUORUM only — every
 * integrity, identity, sandbox, rollback and constitutional check still
 * applies to the bootstrap principal.
 */
export function authorizeUpgrade(request: UpgradeRequest, governance: GovernanceMode): UpgradeVerdict {
  const missing: string[] = [];
  const humanApprovals = request.approvals.filter((a) => a.startsWith("human."));
  const distinct = new Set(humanApprovals);
  const quorumRequired = request.upgradeClass === "core-constitutional-high-blast-radius" && governance.mode === "normal" ? 2 : 1;
  const bootstrapCoversQuorum =
    governance.mode === "bootstrap" &&
    governance.bootstrapStateRecordRef !== null &&
    governance.bootstrapPrincipalRef !== null &&
    distinct.has(governance.bootstrapPrincipalRef);
  if (distinct.size < quorumRequired && !bootstrapCoversQuorum) {
    missing.push(`${quorumRequired} distinct human approval(s); ${distinct.size} supplied`);
  }
  if (!request.automatedTestsPassed) missing.push("automated tests");
  if (!request.integrityVerified) missing.push("Sentinel integrity verification");
  switch (request.upgradeClass) {
    case "routine-low-risk-patch":
      break;
    case "sensitive-security-configuration":
      if (!request.artifactSigned) missing.push("signed artifact");
      break;
    case "core-constitutional-high-blast-radius":
      if (!request.sandboxValidated) missing.push("sandbox validation");
      if (!request.artifactSigned) missing.push("signed artifact");
      if (request.rollbackPlanRef === null) missing.push("rollback plan");
      if (!request.governanceAuthorized) missing.push("Governance authorization");
      break;
    case "emergency-security-patch":
      if (request.emergencyPolicyRef === null) missing.push("predefined emergency policy reference");
      break;
  }
  if (missing.length > 0) return { authorized: false, missing };
  return {
    authorized: true,
    // Emergency shortening and every bootstrap-quorum action get mandatory
    // retrospective review — bootstrap actions are clearly marked in
    // evidence so they can be reviewed later (§21.9).
    retrospectiveReviewRequired: request.upgradeClass === "emergency-security-patch" || bootstrapCoversQuorum,
    bootstrapSatisfiedQuorum: bootstrapCoversQuorum,
  };
}

// ── §21.9 · bootstrap exit and re-entry ─────────────────────────────────────

export type BootstrapTransitionOutcome =
  | { readonly ok: true; readonly governance: GovernanceMode }
  | { readonly ok: false; readonly reason: string };

/** Exit is explicit: enough trusted operators enrolled and Governance
 * activates normal mode — after which critical-action thresholds increase
 * automatically (the quorum in authorizeUpgrade). */
export function exitBootstrap(
  governance: GovernanceMode,
  enrolledTrustedOperators: number,
  governanceActivationRef: string | undefined,
): BootstrapTransitionOutcome {
  if (governance.mode !== "bootstrap") return { ok: false, reason: "Not in bootstrap mode." };
  if (enrolledTrustedOperators < 2) {
    return { ok: false, reason: "Exit requires sufficient trusted operators enrolled; one is not a quorum pool." };
  }
  if (governanceActivationRef === undefined) {
    return { ok: false, reason: "Governance activates normal mode; the activation is a recorded act." };
  }
  return { ok: true, governance: { mode: "normal", bootstrapPrincipalRef: null, bootstrapStateRecordRef: null } };
}

/** Re-entering bootstrap after exit is an EXCEPTIONAL constitutional
 * recovery action — a break-glass record plus Governance-recorded
 * constitutional basis — never a routine setting toggle. */
export function reenterBootstrap(
  governance: GovernanceMode,
  breakGlass: BreakGlassRecord | undefined,
  constitutionalRecoveryRecordRef: string | undefined,
  bootstrapPrincipalRef: string,
  newStateRecordRef: string,
): BootstrapTransitionOutcome {
  if (governance.mode === "bootstrap") return { ok: false, reason: "Already in bootstrap mode." };
  if (breakGlass === undefined || constitutionalRecoveryRecordRef === undefined) {
    return {
      ok: false,
      reason: "Re-entering bootstrap is an exceptional constitutional recovery action: break-glass evidence AND a recorded constitutional basis are required, never a settings toggle.",
    };
  }
  return {
    ok: true,
    governance: { mode: "bootstrap", bootstrapPrincipalRef, bootstrapStateRecordRef: newStateRecordRef },
  };
}
