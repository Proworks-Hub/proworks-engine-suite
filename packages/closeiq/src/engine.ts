// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { GovernanceDecision, TenantContext, TraceContext } from "@proworks-hub/contracts";

import { buildWaiver, requireHumanAuthorization } from "./kernel/authorization.js";
import { CLOSE_METHODS, type SatisfactionContext } from "./kernel/evidence.js";
import { assessReadiness, type ReadinessAssessment } from "./kernel/readiness.js";
import {
  certify,
  computeReconciliation,
  proposeCertification,
} from "./kernel/reconciliation.js";
import { completeTask, instantiateTasks, startTask, validateTemplate } from "./kernel/tasks.js";
import {
  ADJUSTMENT_TRANSITIONS,
  type AccountReconciliation,
  type AdjustmentRequest,
  type AdjustmentState,
  type BalanceObservation,
  type CertificationCandidate,
  type CertificationRecord,
  type CloseEvidenceRef,
  type ClosePeriodRecord,
  type CloseProfile,
  type CloseSignOff,
  type CloseTask,
  type CloseTemplate,
  type EvidenceKind,
  type ReconcilingItem,
} from "./model.js";
import { ok, refuse, type Result } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine — thin state over the pure kernels, tenant-scoped in memory
// (persistence ports arrive in a later wave; recorded in the hiveMap gap).
// `ledger-closed` is NOT CloseIQ's assertion: it is set only by
// recordPeriodCloseOutcome, carrying LedgerIQ's answer. CloseIQ never infers
// a close from its own checklist finishing.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallContext {
  readonly tenant: TenantContext;
  readonly trace: TraceContext;
  readonly asOf: string;
}

interface TenantState {
  periods: Map<string, ClosePeriodRecord>;
  tasks: Map<string, CloseTask>;
  reconciliations: Map<string, AccountReconciliation>;
  candidates: Map<string, CertificationCandidate>;
  adjustments: Map<string, AdjustmentRequest>;
  signOffs: Map<string, CloseSignOff>;
  consumedGovernanceRefs: Set<string>;
  openExceptions: number;
}

export interface CloseEngineOptions {
  readonly currencyRegistry: Readonly<Record<string, number>>;
  /** Evidence kinds this installation can actually produce (template load check). */
  readonly producibleEvidenceKinds: readonly EvidenceKind[];
  /** Materiality thresholds per tenant, minor units. Absent = unbound = undeterminable. */
  readonly materialityThresholdMinor?: bigint;
  /** Control-test populations, when a ControlCatalogPort is bound. */
  readonly controlPopulations?: ReadonlyMap<string, readonly string[]>;
}

export function createCloseEngine(options: CloseEngineOptions) {
  const tenants = new Map<string, TenantState>();
  const stateFor = (ctx: CallContext): TenantState => {
    const existing = tenants.get(ctx.tenant.organizationId);
    if (existing) return existing;
    const fresh: TenantState = {
      periods: new Map(),
      tasks: new Map(),
      reconciliations: new Map(),
      candidates: new Map(),
      adjustments: new Map(),
      signOffs: new Map(),
      consumedGovernanceRefs: new Set(),
      openExceptions: 0,
    };
    tenants.set(ctx.tenant.organizationId, fresh);
    return fresh;
  };

  const satisfactionContext = (subjectId: string): SatisfactionContext => ({
    subjectId,
    ...(options.controlPopulations !== undefined
      ? { controlPopulations: options.controlPopulations }
      : {}),
  });

  return {
    name: "closeiq" as const,

    instantiateClose(
      input: {
        template: CloseTemplate;
        periodRef: { fiscalYear: number; periodNumber: number };
        entityScope: readonly string[];
        closeDayZero: string;
      },
      ctx: CallContext,
    ): Result<{ closePeriod: ClosePeriodRecord; tasks: readonly CloseTask[] }> {
      const valid = validateTemplate(input.template, options.producibleEvidenceKinds);
      if (!valid.ok) return valid;
      const state = stateFor(ctx);
      const closePeriodId = `close:${ctx.tenant.organizationId}:${input.periodRef.fiscalYear}-${input.periodRef.periodNumber}`;
      if (state.periods.has(closePeriodId)) {
        return refuse("wrong-state", CLOSE_METHODS.templateInstantiation, `${closePeriodId} already exists; reopening creates a NEW version, never a rewrite.`);
      }
      const tasks = instantiateTasks(input.template, closePeriodId);
      const record: ClosePeriodRecord = {
        closePeriodId,
        tenantRef: ctx.tenant.organizationId,
        periodRef: input.periodRef,
        entityScope: input.entityScope,
        templateRef: {
          templateId: input.template.templateId,
          semanticVersion: input.template.semanticVersion,
        },
        closeDayZero: input.closeDayZero,
        processState: "in-progress",
        taskIds: tasks.map((t) => t.closeTaskId),
        version: 1,
        createdAt: ctx.asOf,
      };
      state.periods.set(closePeriodId, record);
      for (const task of tasks) state.tasks.set(task.closeTaskId, task);
      return ok({ closePeriod: record, tasks });
    },

    startTask(input: { taskId: string; by: string }, ctx: CallContext): Result<CloseTask> {
      const state = stateFor(ctx);
      const task = state.tasks.get(input.taskId);
      if (!task) return refuse("wrong-state", CLOSE_METHODS.templateInstantiation, `Task ${input.taskId} does not exist.`);
      const outcome = startTask(task, state.tasks, input.by, ctx.asOf);
      if (outcome.ok) state.tasks.set(input.taskId, outcome.value);
      return outcome;
    },

    completeTask(
      input: { taskId: string; evidence: readonly CloseEvidenceRef[]; by: string },
      ctx: CallContext,
    ): Result<CloseTask> {
      const state = stateFor(ctx);
      const task = state.tasks.get(input.taskId);
      if (!task) return refuse("wrong-state", CLOSE_METHODS.evidenceSatisfaction, `Task ${input.taskId} does not exist.`);
      const outcome = completeTask(
        task,
        state.tasks,
        input.evidence,
        input.by,
        ctx.asOf,
        satisfactionContext(input.taskId),
      );
      if (outcome.ok) state.tasks.set(input.taskId, outcome.value);
      return outcome;
    },

    waiveTask(
      input: { taskId: string; by: string; reason: string; governance?: GovernanceDecision },
      ctx: CallContext,
    ): Result<CloseTask> {
      const state = stateFor(ctx);
      const task = state.tasks.get(input.taskId);
      if (!task) return refuse("wrong-state", CLOSE_METHODS.waiver, `Task ${input.taskId} does not exist.`);
      const outcome = buildWaiver(
        task,
        input.by,
        input.reason,
        input.governance,
        ctx.asOf,
        state.consumedGovernanceRefs,
      );
      if (outcome.ok && outcome.value.status === "waived") {
        state.consumedGovernanceRefs.add(outcome.value.governanceRef);
        state.tasks.set(input.taskId, outcome.value);
      }
      return outcome;
    },

    computeReconciliation(
      input: {
        reconciliationId: string;
        closePeriodId: string;
        accountRef: string;
        observations: readonly BalanceObservation[];
        reconcilingItems?: readonly ReconcilingItem[];
      },
      ctx: CallContext,
    ): Result<AccountReconciliation> {
      const state = stateFor(ctx);
      const prior = state.reconciliations.get(input.reconciliationId);
      const outcome = computeReconciliation(
        input.reconciliationId,
        input.closePeriodId,
        input.accountRef,
        input.observations,
        input.reconcilingItems ?? [],
        ctx.asOf,
        options.currencyRegistry,
      );
      if (outcome.ok) {
        // certification-void: a changed balance voids a prior certification;
        // the record is retained and readable (LOCK-3).
        const next =
          prior?.certification !== undefined &&
          prior.balanceFingerprint !== outcome.value.balanceFingerprint
            ? { ...outcome.value, certification: prior.certification, state: "certification-void" as const }
            : prior?.certification !== undefined
              ? { ...outcome.value, certification: prior.certification, state: "certified" as const }
              : outcome.value;
        state.reconciliations.set(input.reconciliationId, next);
        return ok(next);
      }
      return outcome;
    },

    proposeCertification(
      input: {
        reconciliationId: string;
        profile: CloseProfile;
        ruleId: "zero-balance" | "no-activity" | "within-threshold" | "aged-item-free";
        priorCertifiedFingerprint?: string;
      },
      ctx: CallContext,
    ): Result<CertificationCandidate> {
      const state = stateFor(ctx);
      const reconciliation = state.reconciliations.get(input.reconciliationId);
      if (!reconciliation) {
        return refuse("wrong-state", CLOSE_METHODS.autoCertWithinThreshold, `Reconciliation ${input.reconciliationId} does not exist.`);
      }
      const outcome = proposeCertification(
        reconciliation,
        input.profile,
        input.ruleId,
        options.materialityThresholdMinor,
        input.priorCertifiedFingerprint,
      );
      if (outcome.ok) state.candidates.set(outcome.value.candidateId, outcome.value);
      return outcome;
    },

    certify(
      input: {
        candidateId: string;
        governance?: GovernanceDecision;
        grantedRule?: { methodId: string; semanticVersion: string };
        by: string;
      },
      ctx: CallContext,
    ): Result<CertificationRecord> {
      const state = stateFor(ctx);
      const candidate = state.candidates.get(input.candidateId);
      if (!candidate) return refuse("candidate-stale", CLOSE_METHODS.autoCertWithinThreshold, `Candidate ${input.candidateId} does not exist.`);
      const reconciliation = state.reconciliations.get(candidate.reconciliationId);
      if (!reconciliation) return refuse("wrong-state", CLOSE_METHODS.autoCertWithinThreshold, "The reconciliation vanished.");
      const outcome = certify(candidate, reconciliation, input.governance, input.grantedRule, input.by, ctx.asOf);
      if (outcome.ok) {
        state.reconciliations.set(reconciliation.reconciliationId, {
          ...reconciliation,
          certification: outcome.value,
          state: "certified",
        });
      }
      return outcome;
    },

    transitionAdjustment(
      input: {
        adjustmentRequestId: string;
        to: AdjustmentState;
        by: string;
        reason?: string;
        governance?: GovernanceDecision;
        description?: string;
      },
      ctx: CallContext,
    ): Result<AdjustmentRequest> {
      const M = CLOSE_METHODS.authorizationHold;
      const state = stateFor(ctx);
      let adjustment = state.adjustments.get(input.adjustmentRequestId);
      if (!adjustment) {
        if (input.to !== "drafted") {
          return refuse("wrong-state", M, `Adjustment ${input.adjustmentRequestId} does not exist; only 'drafted' creates one.`);
        }
        adjustment = {
          adjustmentRequestId: input.adjustmentRequestId,
          closePeriodId: "unassigned",
          state: "drafted",
          description: input.description ?? "",
          evidence: [],
          preparedBy: input.by,
        };
        state.adjustments.set(adjustment.adjustmentRequestId, adjustment);
        return ok(adjustment);
      }
      const legal = ADJUSTMENT_TRANSITIONS.some(
        (t) => t.from === adjustment?.state && t.to === input.to,
      );
      if (!legal) {
        return refuse("wrong-state", M, `No legal transition ${adjustment.state} → ${input.to}; the table enumerates every exit.`);
      }
      if (input.to === "authorized") {
        // THE exit from the held state — the full M-7 ladder.
        const authorization = requireHumanAuthorization({
          by: input.by,
          reason: input.reason ?? "",
          governance: input.governance,
          itemId: adjustment.adjustmentRequestId,
          consumedGovernanceRefs: state.consumedGovernanceRefs,
          preparedBy: adjustment.preparedBy,
        });
        if (!authorization.ok) return authorization;
        state.consumedGovernanceRefs.add(authorization.value.governanceRef);
        const next: AdjustmentRequest = {
          ...adjustment,
          state: "authorized",
          authorizedBy: input.by,
          governanceRef: authorization.value.governanceRef,
        };
        state.adjustments.set(next.adjustmentRequestId, next);
        return ok(next);
      }
      const next: AdjustmentRequest = { ...adjustment, state: input.to };
      state.adjustments.set(next.adjustmentRequestId, next);
      return ok(next);
    },

    assessReadiness(input: { closePeriodId: string }, ctx: CallContext): Result<ReadinessAssessment> {
      const state = stateFor(ctx);
      const period = state.periods.get(input.closePeriodId);
      if (!period) return refuse("wrong-state", CLOSE_METHODS.readiness, `${input.closePeriodId} does not exist.`);
      const tasks = period.taskIds
        .map((id) => state.tasks.get(id))
        .filter((t): t is CloseTask => t !== undefined);
      const reconciliations = [...state.reconciliations.values()].filter(
        (r) => r.closePeriodId === input.closePeriodId,
      );
      const assessment = assessReadiness({
        tasks,
        reconciliations,
        requiredCertifications: [],
        adjustments: [...state.adjustments.values()],
        openExceptionCount: state.openExceptions,
        materialityBound: options.materialityThresholdMinor !== undefined,
        requiredPortsBound: true,
      });
      state.periods.set(period.closePeriodId, {
        ...period,
        readinessFingerprint: assessment.readinessFingerprint,
      });
      return ok(assessment);
    },

    recordSignOff(
      input: {
        closePeriodId: string;
        by: string;
        statement: string;
        readinessFingerprint: string;
        governance?: GovernanceDecision;
      },
      ctx: CallContext,
    ): Result<CloseSignOff> {
      const M = CLOSE_METHODS.signoff;
      const state = stateFor(ctx);
      const period = state.periods.get(input.closePeriodId);
      if (!period) return refuse("wrong-state", M, `${input.closePeriodId} does not exist.`);
      if (input.statement.trim().length === 0) {
        return refuse("empty-statement", M, "A sign-off is a record of a human act; an empty statement records nothing.");
      }
      const blockingIncomplete = period.taskIds
        .map((id) => state.tasks.get(id))
        .filter((t) => t && t.criticality === "blocking" && t.status !== "completed");
      if (blockingIncomplete.length > 0) {
        return refuse(
          "blocking-incomplete",
          M,
          `${blockingIncomplete.length} blocking tasks are not completed. A waived blocking task does not sign off.`,
        );
      }
      if (period.readinessFingerprint === undefined || period.readinessFingerprint !== input.readinessFingerprint) {
        return refuse("stale-fingerprint", M, "Readiness changed after you looked; reassess and sign the current state.");
      }
      const authorization = requireHumanAuthorization({
        by: input.by,
        reason: input.statement,
        governance: input.governance,
        itemId: input.closePeriodId,
        consumedGovernanceRefs: state.consumedGovernanceRefs,
      });
      if (!authorization.ok) return authorization;
      state.consumedGovernanceRefs.add(authorization.value.governanceRef);
      const signOff: CloseSignOff = {
        signOffId: `signoff:${input.closePeriodId}`,
        closePeriodId: input.closePeriodId,
        signedBy: input.by,
        governanceRef: authorization.value.governanceRef,
        statement: input.statement,
        readinessFingerprint: input.readinessFingerprint,
        signedAt: ctx.asOf,
      };
      state.signOffs.set(signOff.signOffId, signOff);
      state.periods.set(period.closePeriodId, { ...period, processState: "signed-off" });
      return ok(signOff);
    },

    /** CloseIQ's rung on the period state is REQUEST. LedgerIQ decides. */
    requestPeriodClose(input: { closePeriodId: string }, ctx: CallContext): Result<{ requested: true }> {
      const state = stateFor(ctx);
      const period = state.periods.get(input.closePeriodId);
      if (!period) return refuse("wrong-state", CLOSE_METHODS.signoff, `${input.closePeriodId} does not exist.`);
      if (period.processState !== "signed-off") {
        return refuse("wrong-state", CLOSE_METHODS.signoff, `The close is ${period.processState}, not signed-off; nothing is requested.`);
      }
      state.periods.set(period.closePeriodId, { ...period, processState: "ledger-close-requested" });
      return ok({ requested: true });
    },

    /** ledger-closed is LEDGERIQ's answer, recorded verbatim — never inferred. */
    recordPeriodCloseOutcome(
      input: { closePeriodId: string; outcome: "closed" | "refused"; refusalDetail?: string },
      ctx: CallContext,
    ): Result<ClosePeriodRecord> {
      const state = stateFor(ctx);
      const period = state.periods.get(input.closePeriodId);
      if (!period) return refuse("wrong-state", CLOSE_METHODS.signoff, `${input.closePeriodId} does not exist.`);
      const next: ClosePeriodRecord = {
        ...period,
        processState: input.outcome === "closed" ? "ledger-closed" : "ledger-close-refused",
      };
      state.periods.set(period.closePeriodId, next);
      return ok(next);
    },

    /** A waiver that can only be found by knowing to filter for it is a waiver nobody finds. */
    listWaivers(ctx: CallContext): readonly { taskId: string; reason: string; governanceRef: string }[] {
      const state = stateFor(ctx);
      return [...state.tasks.values()]
        .filter((t): t is Extract<CloseTask, { status: "waived" }> => t.status === "waived")
        .map((t) => ({ taskId: t.closeTaskId, reason: t.reason, governanceRef: t.governanceRef }));
    },

    getTask(input: { taskId: string }, ctx: CallContext): CloseTask | undefined {
      return stateFor(ctx).tasks.get(input.taskId);
    },
  };
}

export type CloseEngine = ReturnType<typeof createCloseEngine>;
