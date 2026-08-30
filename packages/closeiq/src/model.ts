// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import {
  evidenceQualitySchema,
  exactMoneySchema,
  methodRefSchema,
  sourceStrengthSchema,
  traceContextSchema,
  type SourceStrength,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Canonical model — blueprint §14. The load-bearing choice: `CloseTask` is a
// DISCRIMINATED UNION on status, not a record with a status field. There is
// no `completed` inhabitant without non-empty evidence and a recorded
// satisfaction verdict — the invariant lives in the type, not in one check a
// refactor can bypass. `waived` is NOT `completed`: a separate variant with a
// separate name, counted separately everywhere, because a boolean waived flag
// on a completed task is precisely how a waiver becomes invisible.
//
// `ClosePeriod.updatedAt` was CUT by the blueprint's own reader audit (§14.8)
// and does not exist here.
// ─────────────────────────────────────────────────────────────────────────────

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoInstantSchema = z.string().min(1);

export const closeProcessStateSchema = z.enum([
  "not-started",
  "in-progress",
  "substantially-complete",
  "awaiting-signoff",
  "signed-off",
  "ledger-close-requested",
  "ledger-closed",
  "ledger-close-refused",
  "reopened",
]);
export type CloseProcessState = z.infer<typeof closeProcessStateSchema>;

export const evidenceKindSchema = z.enum([
  "reconciliation-result",
  "posting-confirmed",
  "posting-proposed",
  "ledger-event",
  "document-ref",
  "control-test-result",
  "computed-assertion",
  "consolidation-run",
  "report-run",
  "variance-result",
  "human-attestation",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * LOCK-2 as arithmetic: the minimum permitted floor on any clause is
 * `derived`, and `ai-candidate` ranks below it on the ordered enum — so an AI
 * candidate can never satisfy any clause, not by rule but by comparison.
 */
export const CLAUSE_FLOOR_MINIMUM: SourceStrength = "derived";

export const evidenceClauseSchema = z
  .object({
    kind: evidenceKindSchema,
    minCount: z.number().int().min(1),
    minSourceStrength: sourceStrengthSchema,
    /** Measured against an explicit asOf, never now(). */
    maxAgeDays: z.number().int().min(0).optional(),
  })
  .strict();
export type EvidenceClause = z.infer<typeof evidenceClauseSchema>;

export const evidenceRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    /** ALL clauses must be satisfied. */
    clauses: z.array(evidenceClauseSchema).min(1),
    attestationSufficient: z.boolean(),
  })
  .strict();
export type EvidenceRequirement = z.infer<typeof evidenceRequirementSchema>;

export const closeEvidenceRefSchema = z
  .object({
    evidenceId: z.string().min(1),
    kind: evidenceKindSchema,
    /** Opaque scoped reference — an AuditIQ record, a ReconciliationId, a ProposalRef. */
    target: z.string().min(1),
    quality: evidenceQualitySchema,
    observedAt: isoDateSchema,
    producedBy: z.string().min(1),
  })
  .strict();
export type CloseEvidenceRef = z.infer<typeof closeEvidenceRefSchema>;

export interface SatisfactionVerdict {
  /** Per clause: which evidence ids satisfied it — inspectable, not a boolean. */
  readonly perClause: readonly {
    readonly clauseKind: EvidenceKind;
    readonly satisfiedBy: readonly string[];
  }[];
}

export interface UnmetClause {
  readonly clauseKind: EvidenceKind;
  readonly needed: number;
  readonly found: number;
  /** Why candidates were dropped, named so the caller fixes the right thing. */
  readonly drops: readonly string[];
}

export const taskDefinitionSchema = z
  .object({
    taskDefinitionId: z.string().min(1),
    semanticVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1),
    taskClass: z.enum(["automated", "manual", "review", "informational"]),
    criticality: z.enum(["blocking", "required", "advisory"]),
    owner: z.string().min(1),
    reviewer: z.string().min(1).optional(),
    /** Task-definition ids of predecessors within the template. */
    predecessors: z.array(z.string().min(1)),
    dueOffsetWorkDays: z.number().int(),
    evidenceRequirement: evidenceRequirementSchema,
  })
  .strict();
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;

export const closeTemplateSchema = z
  .object({
    templateId: z.string().min(1),
    semanticVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    tasks: z.array(taskDefinitionSchema).min(1),
  })
  .strict();
export type CloseTemplate = z.infer<typeof closeTemplateSchema>;

interface CloseTaskCommon {
  readonly closeTaskId: string;
  readonly closePeriodId: string;
  readonly definitionRef: { readonly taskDefinitionId: string; readonly semanticVersion: string };
  readonly name: string;
  readonly taskClass: TaskDefinition["taskClass"];
  readonly criticality: TaskDefinition["criticality"];
  readonly owner: string;
  readonly reviewer?: string;
  readonly predecessors: readonly string[];
  readonly dueOffsetWorkDays: number;
  /** Copied BY VALUE from the definition at instantiation, with its version. */
  readonly evidenceRequirement: EvidenceRequirement;
}

export type CloseTask =
  | ({ readonly status: "pending" } & CloseTaskCommon)
  | ({ readonly status: "blocked"; readonly blockedBy: readonly string[] } & CloseTaskCommon)
  | ({ readonly status: "in-progress"; readonly startedBy: string; readonly startedAt: string } & CloseTaskCommon)
  | ({
      readonly status: "completed";
      /** Cannot be empty, by type. The only producer is completeTask(). */
      readonly evidence: readonly [CloseEvidenceRef, ...CloseEvidenceRef[]];
      readonly satisfaction: SatisfactionVerdict;
      readonly completedBy: string;
      readonly completedAt: string;
      readonly methodRef: { readonly methodId: string; readonly semanticVersion: string };
      readonly startedBy?: string;
    } & CloseTaskCommon)
  | ({
      readonly status: "waived";
      readonly waivedBy: string;
      readonly waivedAt: string;
      readonly reason: string;
      readonly governanceRef: string;
      /** What was NOT met, by value, so a reader sees exactly what was missing. */
      readonly unmetRequirement: EvidenceRequirement;
    } & CloseTaskCommon)
  | ({ readonly status: "failed"; readonly exceptionId: string } & CloseTaskCommon);

export interface ClosePeriodRecord {
  readonly closePeriodId: string;
  readonly tenantRef: string;
  readonly periodRef: { readonly fiscalYear: number; readonly periodNumber: number };
  readonly entityScope: readonly string[];
  readonly templateRef: { readonly templateId: string; readonly semanticVersion: string };
  readonly closeDayZero: string;
  readonly processState: CloseProcessState;
  readonly taskIds: readonly string[];
  readonly materialityPolicyRef?: { readonly methodId: string; readonly semanticVersion: string };
  readonly readinessFingerprint?: string;
  readonly supersedes?: string;
  readonly version: number;
  readonly createdAt: string;
}

// ── Reconciliation: three facts, never conflated (§14.4) ────────────────────

export const reconciliationStateSchema = z.enum([
  "not-started",
  "in-progress",
  "balanced",
  "explained-difference",
  "unexplained-difference",
  "unsubstantiated-unknown",
  "rounding-indeterminate",
  "certified",
  "certification-void",
]);
export type ReconciliationState = z.infer<typeof reconciliationStateSchema>;

export const balanceObservationSchema = z
  .object({
    source: z.enum(["ledger", "sub-ledger", "external-statement", "schedule", "third-party-confirmation"]),
    balance: exactMoneySchema,
    asOf: isoDateSchema,
    provenance: z.string().min(1),
    quality: evidenceQualitySchema,
  })
  .strict();
export type BalanceObservation = z.infer<typeof balanceObservationSchema>;

export const reconcilingItemSchema = z
  .object({
    itemId: z.string().min(1),
    description: z.string().min(1),
    amount: exactMoneySchema,
    identifiedOn: isoDateSchema,
    expectedClearBy: isoDateSchema.optional(),
    disposition: z.enum(["expected-timing", "error-to-adjust", "unidentified", "written-off-proposed"]),
  })
  .strict();
export type ReconcilingItem = z.infer<typeof reconcilingItemSchema>;

export interface AccountReconciliation {
  readonly reconciliationId: string;
  readonly closePeriodId: string;
  readonly accountRef: string;
  readonly observations: readonly BalanceObservation[];
  readonly reconcilingItems: readonly ReconcilingItem[];
  /** ABSENT when undeterminable — not zero. */
  readonly difference?: { amount: string; currency: string; scale: number };
  readonly state: ReconciliationState;
  readonly certification?: CertificationRecord;
  readonly balanceFingerprint: string;
  readonly asOf: string;
}

export interface CertificationCandidate {
  readonly candidateId: string;
  readonly reconciliationId: string;
  readonly ruleRef: { readonly methodId: string; readonly semanticVersion: string };
  readonly balanceFingerprint: string;
}

export interface CertificationRecord {
  readonly certificationId: string;
  readonly certifiedBy: string;
  readonly governanceRef: string;
  readonly ruleRef?: { readonly methodId: string; readonly semanticVersion: string };
  readonly balanceFingerprint: string;
  readonly certifiedAt: string;
}

export const closeProfileSchema = z
  .object({
    profileId: z.string().min(1),
    accountRef: z.string().min(1),
    /** `unknown` is a first-class tier AND the default: an unrated account is
     * treated strictest and blocks auto-certification entirely. */
    riskTier: z.enum(["high", "medium", "low", "unknown"]),
    requiredFrequency: z.enum(["monthly", "quarterly", "annual", "unknown"]),
    requiredReviewLevel: z.number().int().min(0),
    evidenceRequirement: evidenceRequirementSchema,
    autoCertifiable: z.boolean(),
    /** Reconciling-item age limit for the aged-item-free rule. */
    agedItemLimitDays: z.number().int().min(0).optional(),
  })
  .strict();
export type CloseProfile = z.infer<typeof closeProfileSchema>;

export const cutOffRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    transactionClass: z.enum([
      "revenue",
      "purchase",
      "goods-receipt",
      "inventory-movement",
      "payroll",
      "expense-claim",
      "accrual",
      "other",
    ]),
    /** WHICH date decides — named per class, required, NO default (K-11). */
    governingDateField: z.string().min(1),
    cutOffDate: isoDateSchema,
    /** Read by M-6: widens the acceptance band; recorded on the finding as applied. */
    graceWindowDays: z.number().int().min(0),
    methodRef: methodRefSchema,
  })
  .strict();
export type CutOffRule = z.infer<typeof cutOffRuleSchema>;

export interface CutOffFinding {
  readonly findingId: string;
  readonly ruleId: string;
  readonly subjectRef: string;
  readonly governingDate: string;
  readonly recordedPeriodEnd: string;
  readonly amount: { amount: string; currency: string; scale: number };
  /** The window that was APPLIED — "inside the window" and "inside the period" are different statements. */
  readonly graceWindowDaysApplied: number;
}

// ── Adjustment / exception state machines — every state has an exit ─────────

export const adjustmentStateSchema = z.enum([
  "drafted",
  "evidence-attached",
  "reviewed",
  "awaiting-human-authorization",
  "authorized",
  "submitted-as-proposal",
  "posted-confirmed",
  "refused-by-ledger",
  "withdrawn",
]);
export type AdjustmentState = z.infer<typeof adjustmentStateSchema>;

export const ADJUSTMENT_TRANSITIONS: readonly { from: AdjustmentState; to: AdjustmentState }[] = [
  { from: "drafted", to: "evidence-attached" },
  { from: "drafted", to: "withdrawn" },
  { from: "evidence-attached", to: "reviewed" },
  { from: "evidence-attached", to: "withdrawn" },
  { from: "reviewed", to: "awaiting-human-authorization" },
  { from: "reviewed", to: "withdrawn" },
  // THE exit the repository's shipped defect lacked: a held item can be
  // authorized (M-7) or withdrawn. Never only entered.
  { from: "awaiting-human-authorization", to: "authorized" },
  { from: "awaiting-human-authorization", to: "withdrawn" },
  { from: "authorized", to: "submitted-as-proposal" },
  { from: "submitted-as-proposal", to: "posted-confirmed" },
  { from: "submitted-as-proposal", to: "refused-by-ledger" },
  { from: "refused-by-ledger", to: "drafted" },
];
export const TERMINAL_ADJUSTMENT_STATES: readonly AdjustmentState[] = ["posted-confirmed", "withdrawn"];

export interface AdjustmentRequest {
  readonly adjustmentRequestId: string;
  readonly closePeriodId: string;
  readonly state: AdjustmentState;
  readonly description: string;
  readonly evidence: readonly CloseEvidenceRef[];
  readonly preparedBy: string;
  readonly authorizedBy?: string;
  readonly governanceRef?: string;
}

export interface CloseSignOff {
  readonly signOffId: string;
  readonly closePeriodId: string;
  readonly signedBy: string;
  readonly governanceRef: string;
  readonly statement: string;
  readonly readinessFingerprint: string;
  readonly signedAt: string;
  readonly supersededBy?: string;
}

export const traceSchema = traceContextSchema;
