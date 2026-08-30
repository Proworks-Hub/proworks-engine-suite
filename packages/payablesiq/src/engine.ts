// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  type ExactMoney,
  type Percentage,
  type PostingProposal,
  type TenantContext,
  type TraceContext,
} from "@proworks-hub/contracts";

import { agePayables, computeVendorBalance, type AgingMethod, type VendorBalanceResult } from "./kernel/aging.js";
import { annualizedYield, captureVerdict, discountAmount, discountBase, type YieldMethod } from "./kernel/discount.js";
import { addDays, daysBetween, type ISODate } from "./kernel/dates.js";
import { PAYABLES_METHODS, validateAgingScheme, validateTermsDefinition } from "./kernel/methods.js";
import { prioritizeObligations, type PaymentCandidateSet, type PriorityInputs } from "./kernel/priority.js";
import { applySettlement, reconcileOpenAmount } from "./kernel/settlement.js";
import { deriveDueDate, resolveTermsDate, splitInstallments, type TermsFacts } from "./kernel/terms.js";
import {
  obligationFingerprint,
  payableObligationSchema,
  settlementApplicationSchema,
  type AgingScheme,
  type AgingSnapshot,
  type BusinessCalendar,
  type PayableObligation,
  type PaymentTermsDefinition,
} from "./model.js";
import { buildPostingProposal, type AccountMapping, type ProposalKind } from "./proposals.js";
import type {
  AgingSnapshotRepository,
  PayableObligationRepository,
  SettlementApplicationRepository,
} from "./ports.js";
import { ok, refuse, type Result } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine surface — §19.2. `asOf` is a required CallContext member: time
// enters only as an explicit input, and there is no now(). Every mutating
// path writes a NEW version through an append-only port.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallContext {
  readonly tenant: TenantContext;
  readonly trace: TraceContext;
  readonly asOf: ISODate;
}

export interface PayablesIqOptions {
  readonly obligations: PayableObligationRepository;
  readonly applications: SettlementApplicationRepository;
  readonly snapshots: AgingSnapshotRepository;
  /** Bound ⇒ vendor identities resolve; unbound ⇒ "unresolved", stated. */
  readonly vendorResolverBound?: boolean;
}

export interface RecordObligationInput {
  readonly obligation: unknown;
  readonly terms?: PaymentTermsDefinition;
  readonly termsFacts?: TermsFacts;
  readonly calendar?: BusinessCalendar;
}

export interface DiscountEvaluationInput {
  readonly obligationId: string;
  /** REQUIRED — no default. The three methods differ by 7.85 points on 2/10 net 30. */
  readonly yieldMethod?: YieldMethod;
  readonly paymentLeadDays?: number;
}

export interface DiscountEvaluation {
  readonly verdict: "capturable" | "lapsed";
  readonly discountAmount: ExactMoney;
  readonly payableIfDiscounted: ExactMoney;
  readonly annualizedYield: Percentage;
  readonly discountDate: ISODate;
}

export function createPayablesIqEngine(options: PayablesIqOptions) {
  return {
    name: "payablesiq" as const,

    /**
     * Records an obligation, deriving terms where a definition + facts are
     * supplied. Idempotency scope 1: the same fingerprint asserted twice
     * lands once — the second assertion returns the existing obligation.
     */
    async recordObligation(
      input: RecordObligationInput,
      ctx: CallContext,
    ): Promise<Result<PayableObligation & { duplicateOf?: string }>> {
      const M = PAYABLES_METHODS.recordObligation;
      const parsed = payableObligationSchema.safeParse(input.obligation);
      if (!parsed.success) {
        return refuse(
          "missing-evidence",
          M,
          `The obligation does not parse: ${parsed.error.issues[0]?.path.join(".") ?? "unknown field"}. The schema has no defaults to fill silence with.`,
        );
      }
      let obligation = parsed.data;

      if (input.terms) {
        const rejection = validateTermsDefinition(input.terms);
        if (rejection) {
          return refuse("invariant-violated", M, `${rejection.rule}: ${rejection.detail}`);
        }
        const termsDate = resolveTermsDate(input.terms, input.termsFacts ?? {});
        if (!termsDate.ok) return termsDate;
        const due = deriveDueDate(
          termsDate.value,
          input.terms.rule,
          input.terms.dueDateAdjustment,
          input.calendar,
        );
        if (!due.ok) return due;
        obligation = {
          ...obligation,
          termsRef: input.terms.methodRef,
          termsResolution: "derived",
          termsDate: termsDate.value,
          dueDate: due.value,
          discountSchedule: input.terms.discountSchedule,
        };
      }

      const fp = obligationFingerprint(obligation);
      const existing = await options.obligations.findByFingerprint(fp, ctx.tenant);
      const prior = existing[0];
      if (prior) {
        // Landed once; the duplicate assertion is provenance, not a liability.
        return ok({ ...prior, duplicateOf: prior.obligationId });
      }
      await options.obligations.put(obligation, ctx.tenant);
      return ok(obligation);
    },

    async derivePaymentTerms(
      input: { terms: PaymentTermsDefinition; facts: TermsFacts; calendar?: BusinessCalendar; originalAmount?: ExactMoney },
      _ctx: CallContext,
    ): Promise<Result<{ termsDate: ISODate; dueDate: ISODate; discountDates: readonly { days: number; date: ISODate }[]; installments?: readonly { installmentSequence: number; amount: ExactMoney; dueDate: ISODate }[] }>> {
      const rejection = validateTermsDefinition(input.terms);
      if (rejection) {
        return refuse("invariant-violated", PAYABLES_METHODS.registry, `${rejection.rule}: ${rejection.detail}`);
      }
      const termsDate = resolveTermsDate(input.terms, input.facts);
      if (!termsDate.ok) return termsDate;
      const due = deriveDueDate(termsDate.value, input.terms.rule, input.terms.dueDateAdjustment, input.calendar);
      if (!due.ok) return due;
      const discountDates = input.terms.discountSchedule.map((tier) => ({
        days: tier.days,
        date: addDays(termsDate.value, tier.days),
      }));
      let installments;
      if (input.terms.installments) {
        if (!input.originalAmount) {
          return refuse(
            "missing-evidence",
            PAYABLES_METHODS.splitInstallments,
            "Installment terms need the originalAmount to split.",
          );
        }
        const split = splitInstallments(input.originalAmount, input.terms);
        if (!split.ok) return split;
        const out = [];
        for (const inst of split.value) {
          const instDue = deriveDueDate(termsDate.value, inst.rule, input.terms.dueDateAdjustment, input.calendar);
          if (!instDue.ok) return instDue;
          out.push({ installmentSequence: inst.installmentSequence, amount: inst.amount, dueDate: instDue.value });
        }
        installments = out;
      }
      return ok({
        termsDate: termsDate.value,
        dueDate: due.value,
        discountDates,
        ...(installments ? { installments } : {}),
      });
    },

    async evaluateEarlyPaymentDiscount(
      input: DiscountEvaluationInput,
      ctx: CallContext,
    ): Promise<Result<DiscountEvaluation>> {
      const M = PAYABLES_METHODS.discountAmount;
      if (input.yieldMethod === undefined) {
        return refuse(
          "missing-method-argument",
          M,
          "yieldMethod is required: simple-360, simple-365 and compounded-act365f differ by 7.85 percentage points on 2/10 net 30.",
        );
      }
      const obligation = await options.obligations.getLatest(input.obligationId, ctx.tenant);
      if (!obligation) {
        return refuse("missing-evidence", M, `Obligation ${input.obligationId} does not exist for this tenant.`);
      }
      if (obligation.termsResolution !== "derived" && obligation.termsResolution !== "supplied") {
        return refuse(
          "terms-unresolved",
          M,
          `Obligation ${input.obligationId} has termsResolution '${obligation.termsResolution}'; a discount needs a derivable schedule.`,
        );
      }
      const tier = obligation.discountSchedule[0];
      if (!tier || obligation.termsDate === undefined || obligation.dueDate === undefined) {
        return refuse("missing-evidence", M, `Obligation ${input.obligationId} carries no discount schedule.`);
      }
      const base = discountBase(
        obligation.originalAmount,
        { discountBase: "gross-including-tax" },
        obligation.taxAmount,
      );
      if (!base.ok) return base;
      const amounts = discountAmount(base.value, tier, { roundingMode: "half-even" });
      const netDays = daysBetween(obligation.termsDate, obligation.dueDate);
      const yieldResult = annualizedYield(tier.percentage, tier.days, netDays, input.yieldMethod);
      if (!yieldResult.ok) return yieldResult;
      const discountDate = addDays(obligation.termsDate, tier.days);
      const verdict = captureVerdict(ctx.asOf, discountDate, input.paymentLeadDays);
      if (!verdict.ok) return verdict;
      return ok({
        verdict: verdict.value,
        discountAmount: amounts.discountAmount,
        payableIfDiscounted: amounts.payableIfDiscounted,
        annualizedYield: { percent: yieldResult.value.percent },
        discountDate,
      });
    },

    async agePayables(
      input: { scheme: AgingScheme; method: AgingMethod; agingRunId: string; lastApplicationDates?: Readonly<Record<string, ISODate>> },
      ctx: CallContext,
    ): Promise<Result<AgingSnapshot>> {
      const rejection = validateAgingScheme(input.scheme);
      if (rejection) {
        return refuse(
          "invariant-violated",
          PAYABLES_METHODS.registry,
          `${rejection.rule}: ${rejection.detail} (rejected at registration, not at use)`,
        );
      }
      const obligations = await options.obligations.listOpen({}, ctx.tenant);
      // The read path verifies the stored openAmount before it feeds a total.
      for (const o of obligations) {
        const apps = await options.applications.listForObligation(o.obligationId, ctx.tenant);
        const reconciled = reconcileOpenAmount(o, apps);
        if (!reconciled.ok) return reconciled;
      }
      const snapshot = agePayables({
        obligations,
        scheme: input.scheme,
        asOf: ctx.asOf,
        method: input.method,
        ...(input.lastApplicationDates ? { lastApplicationDates: input.lastApplicationDates } : {}),
        agingRunId: input.agingRunId,
      });
      if (!snapshot.ok) return snapshot;
      await options.snapshots.put(snapshot.value, ctx.tenant);
      return snapshot;
    },

    async computeVendorBalance(
      input: { vendorRef: string },
      ctx: CallContext,
    ): Promise<Result<VendorBalanceResult>> {
      const obligations = await options.obligations.listOpen({ vendorRef: input.vendorRef }, ctx.tenant);
      return computeVendorBalance(obligations, input.vendorRef, ctx.asOf, options.vendorResolverBound === true);
    },

    async applySettlement(
      input: { application: unknown },
      ctx: CallContext,
    ): Promise<Result<PayableObligation & { replayed: boolean }>> {
      const M = PAYABLES_METHODS.applySettlement;
      const parsed = settlementApplicationSchema.safeParse(input.application);
      if (!parsed.success) {
        return refuse(
          "missing-evidence",
          M,
          `The application does not parse: ${parsed.error.issues[0]?.path.join(".") ?? "unknown"}.`,
        );
      }
      const application = parsed.data;
      const obligation = await options.obligations.getLatest(application.obligationId, ctx.tenant);
      if (!obligation) {
        return refuse("missing-evidence", M, `Obligation ${application.obligationId} does not exist for this tenant.`);
      }
      const prior = await options.applications.listForObligation(application.obligationId, ctx.tenant);
      const outcome = applySettlement(obligation, prior, application);
      if (!outcome.ok) return outcome;
      if (!outcome.value.replayed) {
        await options.applications.put(application, ctx.tenant);
        await options.obligations.put(outcome.value.next, ctx.tenant);
      }
      return ok({ ...outcome.value.next, replayed: outcome.value.replayed });
    },

    async prioritizeObligations(
      input: Omit<PriorityInputs, "obligations" | "asOf">,
      ctx: CallContext,
    ): Promise<Result<PaymentCandidateSet>> {
      const obligations = await options.obligations.listOpen({}, ctx.tenant);
      return prioritizeObligations({ ...input, obligations, asOf: ctx.asOf });
    },

    async proposePostings(
      input: { obligationId: string; kind: ProposalKind; bookId: string; effectiveDate: ISODate; periodRef: { fiscalYear: number; periodNumber: number }; mapping: AccountMapping },
      ctx: CallContext,
    ): Promise<Result<PostingProposal>> {
      const obligation = await options.obligations.getLatest(input.obligationId, ctx.tenant);
      if (!obligation) {
        return refuse(
          "missing-evidence",
          PAYABLES_METHODS.proposePostings,
          `Obligation ${input.obligationId} does not exist for this tenant.`,
        );
      }
      if (obligation.freshness === "recalculation-required") {
        // A stale method must not produce an accounting consequence (§23.1).
        return refuse(
          "stale-result",
          PAYABLES_METHODS.proposePostings,
          `Obligation ${input.obligationId} is recalculation-required; re-derive before proposing a posting.`,
        );
      }
      return buildPostingProposal({
        obligation,
        kind: input.kind,
        bookId: input.bookId,
        effectiveDate: input.effectiveDate,
        periodRef: input.periodRef,
        mapping: input.mapping,
        trace: ctx.trace,
      });
    },

    /**
     * "Accounted for" refuses while the ledger acknowledgement is unknown —
     * an originating engine that treats a proposal as posted is defective.
     */
    async reportAccountedFor(
      input: { obligationId: string },
      ctx: CallContext,
    ): Promise<Result<{ accountedFor: true }>> {
      const M = PAYABLES_METHODS.proposePostings;
      const obligation = await options.obligations.getLatest(input.obligationId, ctx.tenant);
      if (!obligation) {
        return refuse("missing-evidence", M, `Obligation ${input.obligationId} does not exist for this tenant.`);
      }
      if (obligation.ledgerAcknowledgement !== "posted") {
        return refuse(
          "missing-evidence",
          M,
          `ledgerAcknowledgement is '${obligation.ledgerAcknowledgement}'. A proposal is not a posting; LedgerIQ has not confirmed this one.`,
        );
      }
      return ok({ accountedFor: true });
    },

    /** L0/L1 only in this wave; deeper levels refuse honestly rather than stub. */
    async explain(
      input: { obligationId: string; level: "L0" | "L1" | "L2" | "L3" | "L4" | "L5" | "L6" },
      ctx: CallContext,
    ): Promise<Result<{ level: string; answer: Record<string, unknown> }>> {
      const M = PAYABLES_METHODS.recordObligation;
      const obligation = await options.obligations.getLatest(input.obligationId, ctx.tenant);
      if (!obligation) {
        return refuse("missing-evidence", M, `Obligation ${input.obligationId} does not exist for this tenant.`);
      }
      if (input.level === "L0") {
        return ok({
          level: "L0",
          answer: {
            openAmount: obligation.openAmount,
            status: obligation.status,
            dueDate: obligation.dueDate ?? "terms-unresolved",
          },
        });
      }
      if (input.level === "L1") {
        return ok({
          level: "L1",
          answer: {
            openAmount: obligation.openAmount,
            status: obligation.status,
            termsResolution: obligation.termsResolution,
            evidence: obligation.evidence,
            caveats: [
              ...(obligation.termsResolution !== "derived" && obligation.termsResolution !== "supplied"
                ? ["terms-unresolved: this item ages in the terms-unknown bucket"]
                : []),
              `assumedMoneyScale: ${obligation.assumedMoneyScale}`,
            ],
          },
        });
      }
      return refuse(
        "missing-evidence",
        M,
        `Explanation level ${input.level} is not built in this wave. The refusal is honest; a stub would not be.`,
      );
    },
  };
}

export type PayablesIqEngine = ReturnType<typeof createPayablesIqEngine>;

/** True zero check used by tests; exported to keep the helper single-sourced. */
export function isZeroAmount(m: ExactMoney): boolean {
  return exactMinorUnits(m) === 0n;
}
