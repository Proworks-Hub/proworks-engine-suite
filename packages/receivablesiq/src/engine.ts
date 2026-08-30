// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
  exactMoneySchema,
  type ExactMoney,
  type TenantContext,
  type TraceContext,
} from "@proworks-hub/contracts";

import { ageReceivables, cei, dsoCountback, dsoSimple, type AgingSnapshot, type DsoResult } from "./kernel/agingAndMetrics.js";
import { matchCascade } from "./kernel/matching.js";
import { RECEIVABLES_METHODS } from "./kernel/methods.js";
import { replayTo, type ProjectionState } from "./kernel/projection.js";
import {
  journalKindSchema,
  MATERIAL_KINDS,
  receivableJournalEntrySchema,
  type AgingPolicy,
  type CashReceipt,
  type JournalKind,
  type MatchPolicy,
  type OpenItem,
} from "./model.js";
import type { ReceivableStorePort } from "./ports.js";
import { ok, refuse, type ReceivablesRefusal, type Result } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine surface — §19. Every command carries a TenantContext, a
// TraceContext, an idempotencyKey and a principal; every query takes an
// explicit asOf. There is no now(). The store unbound is a refusal on every
// path, never an empty answer.
// ─────────────────────────────────────────────────────────────────────────────

export interface CallContext {
  readonly tenant: TenantContext;
  readonly trace: TraceContext;
  readonly asOf: string;
}

export interface CommandMeta {
  readonly idempotencyKey: string;
  readonly principal: string;
  readonly authorizationRef?: string;
}

export interface ReceivablesEngineOptions {
  readonly store?: ReceivableStorePort;
  /** ISO-4217 → scale. Configuration, never hardcoded (R-E). */
  readonly currencyRegistry: Readonly<Record<string, number>>;
}

export function createReceivablesEngine(options: ReceivablesEngineOptions) {
  const M = RECEIVABLES_METHODS;

  const storeOr = <T>(fn: (store: ReceivableStorePort) => Promise<Result<T>>): Promise<Result<T>> => {
    if (!options.store) {
      return Promise.resolve(
        refuse<T>("store-port-unbound", M.registry, "No ReceivableStorePort is bound. An unbound store never reads as an empty book."),
      );
    }
    return fn(options.store);
  };

  async function appendFact(
    store: ReceivableStorePort,
    ctx: CallContext,
    meta: CommandMeta,
    kind: JournalKind,
    payload: Record<string, unknown>,
    effectiveAt: string,
  ): Promise<Result<{ entryId: string; deduplicated: boolean }>> {
    if (await store.hasIdempotencyKey(ctx.tenant.organizationId, meta.idempotencyKey)) {
      // The reader E2E-03 lacked: a replayed command converges, never doubles.
      return ok({ entryId: `dedup:${meta.idempotencyKey}`, deduplicated: true });
    }
    if (MATERIAL_KINDS.includes(kind) && meta.authorizationRef === undefined) {
      return refuse(
        "authorization-required",
        M.registry,
        `${kind} reduces a balance and requires an authorization reference. Absent means refused, not assumed.`,
      );
    }
    const sequence = await store.nextSequence(ctx.tenant.organizationId);
    const entry = receivableJournalEntrySchema.parse({
      entryId: `rje:${ctx.tenant.organizationId}:${sequence}`,
      tenantRef: ctx.tenant.organizationId,
      sequence,
      recordedAt: `${ctx.asOf}T00:00:00Z`,
      effectiveAt,
      kind: journalKindSchema.parse(kind),
      payload,
      methodRef: M.intake,
      evidence: [],
      trace: ctx.trace,
      idempotencyKey: meta.idempotencyKey,
      principal: meta.principal,
      ...(meta.authorizationRef !== undefined ? { authorizationRef: meta.authorizationRef } : {}),
    });
    await store.append([entry]);
    return ok({ entryId: entry.entryId, deduplicated: false });
  }

  async function project(store: ReceivableStorePort, ctx: CallContext): Promise<ProjectionState> {
    return replayTo(await store.readJournal(ctx.tenant.organizationId), ctx.asOf);
  }

  return {
    name: "receivablesiq" as const,

    /** M-1 — recording an open item. */
    recordReceivable: (
      input: {
        openItemId: string;
        customerRef: string;
        documentRef: string;
        itemKind: OpenItem["itemKind"];
        sign: "debit" | "credit";
        originalAmount: unknown;
        documentDate: string;
        dueDate?: string;
        discountTerms?: readonly { days: number; percentage: string }[];
        components?: readonly unknown[];
        backdatingAuthorizationRef?: string;
      },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store) => {
        const amount = exactMoneySchema.safeParse(input.originalAmount);
        if (!amount.success) {
          return refuse("policy-invalid", M.intake, "originalAmount is not an ExactMoney; a JSON number is refused, not coerced.");
        }
        const declaredScale = options.currencyRegistry[amount.data.currency];
        if (declaredScale === undefined || declaredScale !== amount.data.scale) {
          return refuse(
            "unknown-currency-scale",
            M.intake,
            `Currency ${amount.data.currency} at scale ${amount.data.scale} is not in the registry. A defaulted scale is unknown presented as a value.`,
          );
        }
        if (input.sign === "debit" && exactMinorUnits(amount.data) < 0n) {
          return refuse("policy-invalid", M.intake, "A negative originalAmount with a debit sign is a credit wearing the wrong sign.");
        }
        if (
          input.dueDate !== undefined &&
          input.dueDate < input.documentDate &&
          input.backdatingAuthorizationRef === undefined
        ) {
          return refuse(
            "authorization-required",
            M.intake,
            `dueDate ${input.dueDate} precedes documentDate ${input.documentDate}; backdating needs an explicit authorization.`,
          );
        }
        const state = await project(store, ctx);
        for (const item of state.openItems.values()) {
          if (item.documentRef === input.documentRef) {
            return refuse("duplicate-intake", M.intake, `documentRef ${input.documentRef} was already recorded as ${item.openItemId}.`);
          }
        }
        return appendFact(
          store,
          ctx,
          meta,
          "receivable.recorded",
          {
            openItemId: input.openItemId,
            customerRef: input.customerRef,
            documentRef: input.documentRef,
            itemKind: input.itemKind,
            sign: input.sign,
            originalAmount: amount.data,
            documentDate: input.documentDate,
            ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
            discountTerms: input.discountTerms ?? [],
            components: input.components ?? [],
          },
          input.documentDate,
        );
      }),

    /** Records a cash receipt; Oracle's lockbox duplicate rule refuses, names the prior receipt. */
    recordCashReceipt: (
      input: {
        cashReceiptId: string;
        customerRef?: string;
        amount: unknown;
        valueDate: string;
        receivedDate: string;
        instrument: string;
        payerReference?: string;
        sourceMessageRef: string;
        remittanceRefs?: readonly string[];
      },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store) => {
        const amount = exactMoneySchema.safeParse(input.amount);
        if (!amount.success) {
          return refuse("policy-invalid", M.intake, "amount is not an ExactMoney.");
        }
        const state = await project(store, ctx);
        for (const receipt of state.receipts.values()) {
          const duplicate =
            receipt.sourceMessageRef === input.sourceMessageRef &&
            receipt.payerReference === input.payerReference &&
            receipt.amount.amount === amount.data.amount &&
            receipt.amount.currency === amount.data.currency &&
            receipt.customerRef === input.customerRef;
          if (duplicate) {
            return refuse(
              "duplicate-receipt",
              M.intake,
              `A receipt with the same (payerReference, amount, currency, customer) already exists in this source: ${receipt.cashReceiptId}. Refused, not merged.`,
            );
          }
        }
        return appendFact(
          store,
          ctx,
          meta,
          "cash.received",
          {
            cashReceiptId: input.cashReceiptId,
            ...(input.customerRef !== undefined ? { customerRef: input.customerRef } : {}),
            amount: amount.data,
            valueDate: input.valueDate,
            receivedDate: input.receivedDate,
            instrument: input.instrument,
            ...(input.payerReference !== undefined ? { payerReference: input.payerReference } : {}),
            sourceMessageRef: input.sourceMessageRef,
            remittanceRefs: input.remittanceRefs ?? [],
          },
          input.receivedDate,
        );
      }),

    identifyCashReceipt: (
      input: { cashReceiptId: string; customerRef: string },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store) =>
        appendFact(store, ctx, meta, "cash.identified", input as unknown as Record<string, unknown>, ctx.asOf),
      ),

    /**
     * Applies cash — explicit allocations, or the M-4 cascade when
     * `autoMatch` is set. Cross-currency application refuses: the
     * ExchangeRatePort is unbound in this installation, and the booking rate
     * is never substituted.
     */
    applyCash: (
      input: {
        cashReceiptId: string;
        allocations?: readonly { openItemId: string; amount: unknown }[];
        autoMatch?: { policy: MatchPolicy };
      },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store): Promise<Result<{ applicationIds: readonly string[]; matcher?: string }>> => {
        const state = await project(store, ctx);
        const receipt = state.receipts.get(input.cashReceiptId);
        if (!receipt) {
          return refuse("no-candidate", M.matchingCascade, `Receipt ${input.cashReceiptId} does not exist for this tenant.`);
        }
        if (receipt.state === "unidentified") {
          return refuse("unidentified-customer", M.matchingCascade, "Identify the payer first; the engine never guesses the customer.");
        }
        if (receipt.state === "returned") {
          return refuse("policy-invalid", M.matchingCascade, "A returned receipt applies nothing; a re-presented payment is a NEW receipt.");
        }

        let targets: readonly { openItemId: string; amount: ExactMoney }[];
        let matcher: string | undefined;
        if (input.allocations && input.allocations.length > 0) {
          const parsed: { openItemId: string; amount: ExactMoney }[] = [];
          for (const a of input.allocations) {
            const amount = exactMoneySchema.safeParse(a.amount);
            if (!amount.success) return refuse("policy-invalid", M.allocation, "An allocation amount is not an ExactMoney.");
            parsed.push({ openItemId: a.openItemId, amount: amount.data });
          }
          targets = parsed;
        } else if (input.autoMatch) {
          const solution = matchCascade(receipt, [...state.openItems.values()], input.autoMatch.policy);
          if (!solution.ok) return solution;
          matcher = solution.value.matcher;
          let remaining = exactMinorUnits(receipt.unappliedAmount);
          const built: { openItemId: string; amount: ExactMoney }[] = [];
          for (const id of solution.value.openItemIds) {
            const item = state.openItems.get(id);
            if (!item) continue;
            const openUnits = exactMinorUnits(item.openAmount);
            const take = remaining < openUnits ? remaining : openUnits;
            if (take <= 0n) break;
            built.push({
              openItemId: id,
              amount: exactMoneyFromMinorUnits(take, receipt.amount.currency, receipt.amount.scale),
            });
            remaining -= take;
          }
          targets = built;
        } else {
          return refuse("policy-missing", M.allocation, "Supply explicit allocations or an autoMatch policy.");
        }

        // Budget and boundary checks, all-or-nothing.
        let totalUnits = 0n;
        for (const t of targets) {
          const item = state.openItems.get(t.openItemId);
          if (!item) return refuse("no-candidate", M.allocation, `Open item ${t.openItemId} does not exist.`);
          if (item.openAmount.currency !== receipt.amount.currency) {
            return refuse(
              "rate-port-unbound",
              M.applicationFx,
              `Item ${t.openItemId} is ${item.openAmount.currency}; the receipt is ${receipt.amount.currency}. No ExchangeRatePort is bound, and the booking rate is never substituted.`,
            );
          }
          if (exactMinorUnits(t.amount) > exactMinorUnits(item.openAmount)) {
            return refuse("policy-invalid", M.allocation, `Allocation to ${t.openItemId} exceeds its open amount.`);
          }
          totalUnits += exactMinorUnits(t.amount);
        }
        if (totalUnits > exactMinorUnits(receipt.unappliedAmount)) {
          return refuse("policy-invalid", M.allocation, "Allocations exceed the receipt's unapplied amount.");
        }

        const applicationIds: string[] = [];
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (!t) continue;
          const applicationId = `app:${meta.idempotencyKey}:${i + 1}`;
          const appended = await appendFact(
            store,
            ctx,
            { ...meta, idempotencyKey: `${meta.idempotencyKey}:${i + 1}` },
            "application.made",
            {
              applicationId,
              cashReceiptId: receipt.cashReceiptId,
              openItemId: t.openItemId,
              appliedAmount: t.amount,
              strategy: "partial",
            },
            ctx.asOf,
          );
          if (!appended.ok) return appended as Result<never>;
          applicationIds.push(applicationId);
        }
        return ok({ applicationIds, ...(matcher !== undefined ? { matcher } : {}) });
      }),

    /** A correction is a reversal plus a new application — LOCK-3 in the smallest unit. */
    reverseApplication: (
      input: { applicationId: string; reason: string },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store) => {
        if (meta.authorizationRef === undefined) {
          return refuse("authorization-required", M.registry, "Reversing an application requires an authorization reference.");
        }
        const state = await project(store, ctx);
        const target = state.applications.get(input.applicationId);
        if (!target) {
          return refuse("no-candidate", M.registry, `Application ${input.applicationId} does not exist.`);
        }
        if (target.reversedBy !== undefined) {
          return refuse("policy-invalid", M.registry, `Application ${input.applicationId} is already reversed.`);
        }
        return appendFact(
          store,
          ctx,
          meta,
          "application.reversed",
          { applicationId: input.applicationId, reason: input.reason },
          ctx.asOf,
        );
      }),

    placeOnAccount: (input: { cashReceiptId: string }, ctx: CallContext, meta: CommandMeta) =>
      storeOr(async (store) => {
        const state = await project(store, ctx);
        const receipt = state.receipts.get(input.cashReceiptId);
        if (!receipt) return refuse("no-candidate", M.registry, `Receipt ${input.cashReceiptId} does not exist.`);
        if (receipt.state !== "identified-unapplied") {
          return refuse(
            "policy-invalid",
            M.registry,
            `Only an identified, unapplied receipt parks on account; this one is ${receipt.state}.`,
          );
        }
        return appendFact(store, ctx, meta, "cash.placed-on-account", { cashReceiptId: input.cashReceiptId }, ctx.asOf);
      }),

    recordWriteOff: (
      input: { openItemId: string; amount: unknown },
      ctx: CallContext,
      meta: CommandMeta,
    ) =>
      storeOr(async (store) => {
        const amount = exactMoneySchema.safeParse(input.amount);
        if (!amount.success) return refuse("policy-invalid", M.registry, "amount is not an ExactMoney.");
        const state = await project(store, ctx);
        const item = state.openItems.get(input.openItemId);
        if (!item) return refuse("no-candidate", M.registry, `Open item ${input.openItemId} does not exist.`);
        if (exactMinorUnits(amount.data) > exactMinorUnits(item.openAmount)) {
          return refuse("policy-invalid", M.registry, "A write-off cannot exceed the open amount.");
        }
        return appendFact(
          store,
          ctx,
          meta,
          "writeoff.recorded",
          { openItemId: input.openItemId, amount: amount.data },
          ctx.asOf,
        );
      }),

    // ── Queries (pure over the replay; asOf from the context) ──────────────

    getOpenItem: (input: { openItemId: string }, ctx: CallContext) =>
      storeOr(async (store): Promise<Result<OpenItem>> => {
        const state = await project(store, ctx);
        const item = state.openItems.get(input.openItemId);
        return item
          ? ok(item)
          : refuse("no-candidate", M.projection, `Open item ${input.openItemId} does not exist as of ${ctx.asOf}.`);
      }),

    getCustomerBalance: (input: { customerRef: string }, ctx: CallContext) =>
      storeOr(async (store): Promise<Result<{ perCurrency: readonly { currency: string; balance: ExactMoney }[] }>> => {
        const state = await project(store, ctx);
        const perCurrency = new Map<string, { units: bigint; scale: number }>();
        for (const item of state.openItems.values()) {
          if (item.customerRef !== input.customerRef) continue;
          const units = exactMinorUnits(exactMoneySchema.parse(item.openAmount));
          const signed = item.sign === "credit" ? -units : units;
          const cell = perCurrency.get(item.openAmount.currency) ?? { units: 0n, scale: item.openAmount.scale };
          cell.units += signed;
          perCurrency.set(item.openAmount.currency, cell);
        }
        return ok({
          perCurrency: [...perCurrency.entries()]
            .sort()
            .map(([currency, cell]) => ({ currency, balance: exactMoneyFromMinorUnits(cell.units, currency, cell.scale) })),
        });
      }),

    ageReceivables: (input: { policy: AgingPolicy; currency: string }, ctx: CallContext) =>
      storeOr(async (store): Promise<Result<AgingSnapshot>> => {
        const scale = options.currencyRegistry[input.currency];
        if (scale === undefined) {
          return refuse("unknown-currency-scale", M.agingPolicy, `Currency ${input.currency} is not in the registry.`);
        }
        const state = await project(store, ctx);
        return ageReceivables(
          [...state.openItems.values()],
          [...state.receipts.values()],
          input.policy,
          ctx.asOf,
          input.currency,
          scale,
        );
      }),

    computeDso: (
      input:
        | { variant: "simple"; arBalance: ExactMoney; creditSales: ExactMoney; periodDays: number }
        | { variant: "countback"; arBalance: ExactMoney; periodSeries: readonly { period: string; creditSales: ExactMoney; days: number }[] }
        | { variant: "cei"; beginningAr: ExactMoney; creditSales: ExactMoney; endingAr: ExactMoney },
    ): Result<DsoResult> => {
      // The variant selector has NO default and must be named by the caller (K-11).
      switch (input.variant) {
        case "simple":
          return dsoSimple(input.arBalance, input.creditSales, input.periodDays);
        case "countback":
          return dsoCountback(input.arBalance, input.periodSeries);
        case "cei":
          return cei(input.beginningAr, input.creditSales, input.endingAr);
      }
    },
  };
}

export type ReceivablesEngine = ReturnType<typeof createReceivablesEngine>;
export type { AgingSnapshot, CashReceipt, OpenItem, ReceivablesRefusal };
