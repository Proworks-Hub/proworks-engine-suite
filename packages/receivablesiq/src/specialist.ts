// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import type { CallContext, CommandMeta, ReceivablesEngine } from "./engine.js";
import { RECEIVABLES_METHODS } from "./kernel/methods.js";
import { refuse } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// The five capability names — §6.3, question-shaped, checked as a set
// operation by guard 9. `measure_receivable_credit_loss` is chartered but the
// M-12 provision matrix is deferred (draft status, §5.4): the capability
// refuses honestly rather than stubbing an allowance. Deliberately NOT
// claimed: assess_credit, issue_invoice, prioritize_collections,
// reconcile_account, post_entry, execute_payment, recognize_revenue,
// forecast_liquidity — each belongs to a neighbour.
// ─────────────────────────────────────────────────────────────────────────────

export const RECEIVABLES_CAPABILITIES = [
  "age_receivables",
  "apply_cash",
  "record_receivable",
  "report_customer_balance",
  "measure_receivable_credit_loss",
] as const;

export type ReceivablesCapability = (typeof RECEIVABLES_CAPABILITIES)[number];

export function createReceivablesSpecialist(
  engine: ReceivablesEngine,
): Specialist<ReceivablesCapability> {
  return {
    id: "receivablesiq",
    capabilities: [...RECEIVABLES_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const { ctx, meta, ...input } = request.input as {
        ctx: CallContext;
        meta?: CommandMeta;
      } & Record<string, unknown>;
      if (!ctx || !ctx.asOf) {
        return refuse(
          "policy-missing",
          RECEIVABLES_METHODS.registry,
          "Every ReceivablesIQ call carries a CallContext with an explicit asOf. There is no now().",
        );
      }
      switch (request.capability) {
        case "age_receivables":
          return engine.ageReceivables(input as unknown as Parameters<ReceivablesEngine["ageReceivables"]>[0], ctx);
        case "apply_cash":
          if (!meta) return refuse("policy-missing", RECEIVABLES_METHODS.registry, "A command carries CommandMeta.");
          return engine.applyCash(input as unknown as Parameters<ReceivablesEngine["applyCash"]>[0], ctx, meta);
        case "record_receivable":
          if (!meta) return refuse("policy-missing", RECEIVABLES_METHODS.registry, "A command carries CommandMeta.");
          return engine.recordReceivable(
            input as unknown as Parameters<ReceivablesEngine["recordReceivable"]>[0],
            ctx,
            meta,
          );
        case "report_customer_balance":
          return engine.getCustomerBalance(
            input as unknown as Parameters<ReceivablesEngine["getCustomerBalance"]>[0],
            ctx,
          );
        case "measure_receivable_credit_loss":
          return refuse(
            "policy-missing",
            RECEIVABLES_METHODS.registry,
            "The M-12 provision matrix is deferred (draft, §5.4): pooling policy, loss-rate table and forward-looking overlay governance are not built. The refusal is honest; a stubbed allowance would not be.",
          );
        default: {
          const unknown: never = request.capability;
          return refuse(
            "policy-missing",
            RECEIVABLES_METHODS.registry,
            `ReceivablesIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Kernel available. Store supplied per instance." };
    },
  };
}
