// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { AuditIq } from "@proworks-hub/auditiq";

import type { Diagnosis } from "./diagnostics/diagnosis.js";
import type { AgentLease } from "./repair/lease.js";
import type { RepairCandidate } from "./repair/candidate.js";
import type { GeneralizedRule } from "./knowledge/generalization.js";
import type { ScoredRepair } from "./validation/scoring.js";
import type { ValidationVerdict } from "./validation/validators.js";

// ─────────────────────────────────────────────────────────────────────────────
// AuditIQ wiring (directive §38).
//
// The directive lists eleven repair-learning actions that must be recorded:
//
//   diagnosis_created        repair_candidate_created   repair_rejected
//   repair_validated         repair_selected            repair_applied
//   repair_rolled_back       repair_generalized         repair_pattern_promoted
//   agent_lease_issued       agent_lease_expired
//
// Foundry Charter §16: "Material Foundry actions shall identify what was
// inspected, proposed, changed, which agents/resources participated, tests run,
// authority permitting the action, and validation that followed."
//
// WHY THIS IS A SEPARATE MODULE
//
// Nothing in the repair-learning pipeline imports AuditIQ. Every module exposes
// a callback seam — `onProposal`, `onAuthored`, `onFinding` — and this module is
// the only thing that binds those seams to a real audit store.
//
// That is not ceremony. A pipeline that imported AuditIQ directly would be one
// where an engine cannot run without an audit store present, and a host would
// eventually make it optional to get a test passing. Keeping the dependency
// pointing this way means the pipeline is unaware and the wiring is explicit.
//
// WHAT GOES IN, AND WHAT DOES NOT
//
// References and scalars. Not the candidate's diff, not the evidence, not the
// rule text. AuditIQ's own charter says it owns "audit event structures... NOT
// domain source records", and its `detail` field refuses nested objects for
// exactly this reason. An audit record that carried the whole candidate would
// make AuditIQ a second store of everything repair learning has ever seen.
//
// REJECTIONS ARE RECORDED AS LOUDLY AS APPROVALS
//
// `repair_rejected` is in the directive's list and is the more interesting
// entry. A repair-learning system whose audit trail shows only successes is one
// where the constitutional vetoes left no trace, and the veto is the part
// somebody will want to review.
// ─────────────────────────────────────────────────────────────────────────────

/** The eleven actions §38 requires, as a closed set. */
export const REPAIR_AUDIT_ACTIONS = [
  "repair.diagnosis_created",
  "repair.candidate_created",
  "repair.rejected",
  "repair.validated",
  "repair.selected",
  "repair.applied",
  "repair.rolled_back",
  "repair.generalized",
  "repair.pattern_promoted",
  "repair.agent_lease_issued",
  "repair.agent_lease_expired",
] as const;
export type RepairAuditAction = (typeof REPAIR_AUDIT_ACTIONS)[number];

export interface AuditContext {
  /** Which tenant this activity concerns. */
  readonly tenant: { organizationId: string; roles: readonly string[] };
  readonly correlationId: string;
  readonly executionId?: string;
  /** The Governance decision permitting the repair-learning activity. */
  readonly governanceDecisionId?: string;
}

export interface RepairAuditor {
  diagnosisCreated(diagnosis: Diagnosis, byBot: string, context: AuditContext): void;
  candidateCreated(candidate: RepairCandidate, context: AuditContext): void;
  /** Records a refusal. The most interesting entry in the list. */
  candidateRejected(
    candidateId: string,
    verdict: ValidationVerdict & { valid: false },
    context: AuditContext,
  ): void;
  candidateValidated(candidateId: string, verdict: ValidationVerdict, context: AuditContext): void;
  repairSelected(score: ScoredRepair, context: AuditContext): void;
  repairApplied(candidateId: string, environment: string, context: AuditContext): void;
  repairRolledBack(candidateId: string, why: string, context: AuditContext): void;
  lessonGeneralized(rule: GeneralizedRule, context: AuditContext): void;
  patternPromoted(patternId: string, fromRuleIds: readonly string[], context: AuditContext): void;
  leaseIssued(lease: AgentLease, context: AuditContext): void;
  leaseExpired(lease: AgentLease, context: AuditContext): void;
  /** Records that were refused by AuditIQ. Should be empty. */
  rejected(): readonly string[];
}

export function createRepairAuditor(input: {
  audit: AuditIq;
  /** The component recording. Defaults to the Foundry subsystem. */
  component?: string;
  now?: () => Date;
}): RepairAuditor {
  // Dots, not a slash. `identifierSchema` permits letters, digits, dot, colon,
  // underscore and hyphen — a `/` is refused, which the first run of these
  // tests demonstrated by rejecting all eleven writes.
  const component = input.component ?? "hive.constitutional.foundry.repair-learning";
  const now = input.now ?? (() => new Date());
  const refusals: string[] = [];

  /**
   * One write path.
   *
   * Every call funnels through here so that the actor, component and outcome
   * shape are identical across all eleven actions — an audit trail whose
   * records disagree about their own shape is one nobody can query.
   */
  const write = (input_: {
    action: RepairAuditAction;
    target: { type: string; id: string };
    outcome: "succeeded" | "failed" | "denied";
    reason: string;
    context: AuditContext;
    detail?: Readonly<Record<string, string | number | boolean>>;
  }): void => {
    const result = input.audit.record({
      // The actor is the SUBSYSTEM, not a human. Foundry Charter §16 asks which
      // agents participated, and the honest answer for an automated action is
      // the automation.
      actor: { actorId: component, kind: "service" },
      tenant: { organizationId: input_.context.tenant.organizationId, roles: [...input_.context.tenant.roles] },
      component,
      action: input_.action,
      target: input_.target,
      trace: {
        correlationId: input_.context.correlationId,
        ...(input_.context.executionId ? { causationId: input_.context.executionId } : {}),
      },
      outcome: input_.outcome,
      reason: input_.reason,
      ...(input_.context.governanceDecisionId
        ? { governanceDecisionId: input_.context.governanceDecisionId }
        : {}),
      ...(input_.context.executionId ? { executionId: input_.context.executionId } : {}),
      ...(input_.detail ? { detail: input_.detail } : {}),
      occurredAt: now().toISOString(),
    });

    if (!result.accepted) {
      // A refused audit write is itself a finding: something in this subsystem
      // is emitting malformed evidence. Collected rather than thrown, because
      // an audit failure must not abort the repair it was recording.
      refusals.push(`${input_.action}: ${result.reason}`);
    }
  };

  return {
    diagnosisCreated(diagnosis, byBot, context) {
      write({
        action: "repair.diagnosis_created",
        target: { type: "diagnosis", id: diagnosis.diagnosisId },
        outcome: "succeeded",
        reason:
          diagnosis.selectedRootCause === null
            ? `Diagnosis proposed with no selected root cause: ${diagnosis.reviewReason}`
            : `Diagnosis proposed: ${diagnosis.selectedRootCause.statement}`,
        context,
        detail: {
          byBot,
          failureSignatureId: diagnosis.failureSignatureId,
          // Counts and flags, never the evidence itself.
          violatedInvariants: diagnosis.violatedInvariants.length,
          unassessedInvariants: diagnosis.unassessedInvariants.length,
          requiresHumanReview: diagnosis.requiresHumanReview,
          confidence: diagnosis.confidence ?? "none",
        },
      });
    },

    candidateCreated(candidate, context) {
      write({
        action: "repair.candidate_created",
        target: { type: "repair_candidate", id: candidate.repairCandidateId },
        outcome: "succeeded",
        reason: candidate.description,
        context,
        detail: {
          authoredBy: candidate.authoredBy,
          diagnosisId: candidate.diagnosisId,
          repairClass: candidate.repairClass,
          risk: candidate.risk,
          reversibility: candidate.reversibility,
          actionCount: candidate.proposedActions.length,
        },
      });
    },

    candidateRejected(candidateId, verdict, context) {
      // OUTCOME IS `failed`, NOT `denied`, AND THAT DISTINCTION COST ME A BUG.
      //
      // My first version used `denied`, reasoning that a constitutional veto is
      // a decision rather than a fault. AuditIQ refused every such record: its
      // schema requires a `denied` action to reference the Governance decision
      // that denied it.
      //
      // The schema is right and I was wrong. A validator veto is not a
      // Governance denial. The `governanceDecisionId` this subsystem holds is
      // the decision PERMITTING the repair-learning session — recording it as
      // the denier would attribute a refusal to a decision that authorized the
      // work. `denied` is reserved for an actual Governance refusal, and a
      // validator rejection is a validation failure.
      write({
        action: "repair.rejected",
        target: { type: "repair_candidate", id: candidateId },
        outcome: "failed",
        reason: verdict.reason,
        context,
        detail: {
          ...(verdict.vetoedBy ? { vetoedBy: verdict.vetoedBy } : {}),
          failedValidators: verdict.results.filter((r) => r.outcome === "FAILED").length,
          notRun: verdict.notRun.length,
        },
      });
    },

    candidateValidated(candidateId, verdict, context) {
      write({
        action: "repair.validated",
        target: { type: "repair_candidate", id: candidateId },
        outcome: verdict.valid ? "succeeded" : "failed",
        reason: verdict.valid
          ? `Validated by ${verdict.results.filter((r) => r.outcome === "PASSED").length} validator(s).`
          : verdict.reason,
        context,
        detail: {
          validatorsRun: verdict.results.filter((r) => r.outcome !== "NOT_RUN").length,
          validatorsNotRun: verdict.notRun.length,
        },
      });
    },

    repairSelected(score, context) {
      write({
        action: "repair.selected",
        target: { type: "repair_candidate", id: score.repairCandidateId },
        outcome: "succeeded",
        reason: "Selected as the least disruptive admissible repair.",
        context,
        detail: {
          admissible: score.admissible,
          advisoryAggregate: score.advisoryAggregate ?? -1,
          unmeasuredDimensions: score.unmeasured.length,
        },
      });
    },

    repairApplied(candidateId, environment, context) {
      write({
        action: "repair.applied",
        target: { type: "repair_candidate", id: candidateId },
        outcome: "succeeded",
        reason: `Applied in ${environment}.`,
        context,
        detail: { environment },
      });
    },

    repairRolledBack(candidateId, why, context) {
      write({
        action: "repair.rolled_back",
        target: { type: "repair_candidate", id: candidateId },
        outcome: "failed",
        reason: why,
        context,
      });
    },

    lessonGeneralized(rule, context) {
      write({
        action: "repair.generalized",
        target: { type: "generalized_rule", id: rule.ruleId },
        outcome: "succeeded",
        reason: rule.title,
        context: { ...context, governanceDecisionId: rule.provenance.governanceReference },
        detail: {
          status: rule.status,
          confidence: rule.confidence,
          evidenceCount: rule.evidenceCount,
          derivedFromCases: rule.provenance.derivedFromCaseIds.length,
          constitutionVersion: rule.constitutionVersion,
        },
      });
    },

    patternPromoted(patternId, fromRuleIds, context) {
      write({
        action: "repair.pattern_promoted",
        target: { type: "repair_pattern", id: patternId },
        outcome: "succeeded",
        reason: `Promoted from ${fromRuleIds.length} approved rule(s).`,
        context,
        detail: { ruleCount: fromRuleIds.length },
      });
    },

    leaseIssued(lease, context) {
      write({
        action: "repair.agent_lease_issued",
        target: { type: "agent_lease", id: lease.agentId },
        outcome: "succeeded",
        reason: lease.mission,
        context: { ...context, governanceDecisionId: lease.governanceReference },
        detail: {
          agentType: lease.agentType,
          environment: lease.targetEnvironment,
          expiresAt: lease.expiresAt,
          // The field an auditor looks for first.
          deploymentAuthority: lease.deploymentAuthority,
          allowedActions: lease.allowedActions.length,
          maxFiles: lease.maxChangeScope.maxFiles,
          sentinelSession: lease.sentinelSession,
        },
      });
    },

    leaseExpired(lease, context) {
      write({
        action: "repair.agent_lease_expired",
        target: { type: "agent_lease", id: lease.agentId },
        outcome: "succeeded",
        reason: `Lease expired at ${lease.expiresAt}. Authority ended.`,
        context,
        detail: { agentType: lease.agentType, environment: lease.targetEnvironment },
      });
    },

    rejected: () => [...refusals],
  };
}

/**
 * Binds an auditor to the pipeline's callback seams.
 *
 * Returns the options objects each constructor takes, so a host writes this
 * once rather than remembering which seam belongs to which module. Missing a
 * seam is how an audit trail ends up with nine of eleven action types and
 * nobody noticing which two.
 */
export function auditSeams(auditor: RepairAuditor, context: AuditContext) {
  return {
    /** For `createDiagnosticBot`. */
    diagnosticBot: {
      onProposal: (diagnosis: Diagnosis, botId: string) =>
        auditor.diagnosisCreated(diagnosis, botId, context),
    },
    /** For `createRepairBot`. */
    repairBot: {
      onAuthored: (candidate: RepairCandidate) => auditor.candidateCreated(candidate, context),
    },
    /** For `createSentinelIq`, when Sentinel observes repair activity (§37). */
    sentinel: {
      onFinding: (finding: { finding: { findingId: string; summary: string } }) =>
        auditor.candidateRejected(
          finding.finding.findingId,
          {
            valid: false,
            reason: `Sentinel finding: ${finding.finding.summary}`,
            results: [],
            notRun: [],
          },
          context,
        ),
    },
  };
}
