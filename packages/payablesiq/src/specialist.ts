// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import type { CallContext, PayablesIqEngine } from "./engine.js";
import { PAYABLES_METHODS } from "./kernel/methods.js";
import { refuse } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// The six capability names — §19.1, named for the question, never the engine.
// The seventh (`open_payable_dispute`) is B-3-contingent and NOT claimed:
// its case-kit precondition is unmet. Explicitly not claimed and never
// handled here: match_invoice, forecast_liquidity, execute_payment,
// calculate_tax, analyze_spend, post_journal.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYABLES_CAPABILITIES = [
  "age_payables",
  "derive_payment_terms",
  "evaluate_early_payment_discount",
  "prioritize_payable_obligations",
  "compute_vendor_balance",
  "apply_payable_settlement",
] as const;

export type PayablesCapability = (typeof PAYABLES_CAPABILITIES)[number];

export function createPayablesSpecialist(engine: PayablesIqEngine): Specialist<PayablesCapability> {
  return {
    id: "payablesiq",
    capabilities: [...PAYABLES_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const { ctx, ...input } = request.input as { ctx: CallContext } & Record<string, unknown>;
      if (!ctx || !ctx.asOf) {
        return refuse(
          "missing-evidence",
          PAYABLES_METHODS.registry,
          "Every PayablesIQ call carries a CallContext with an explicit asOf. There is no now().",
        );
      }
      switch (request.capability) {
        case "age_payables":
          return engine.agePayables(input as unknown as Parameters<PayablesIqEngine["agePayables"]>[0], ctx);
        case "derive_payment_terms":
          return engine.derivePaymentTerms(
            input as unknown as Parameters<PayablesIqEngine["derivePaymentTerms"]>[0],
            ctx,
          );
        case "evaluate_early_payment_discount":
          return engine.evaluateEarlyPaymentDiscount(
            input as unknown as Parameters<PayablesIqEngine["evaluateEarlyPaymentDiscount"]>[0],
            ctx,
          );
        case "prioritize_payable_obligations":
          return engine.prioritizeObligations(
            input as unknown as Parameters<PayablesIqEngine["prioritizeObligations"]>[0],
            ctx,
          );
        case "compute_vendor_balance":
          return engine.computeVendorBalance(
            input as unknown as Parameters<PayablesIqEngine["computeVendorBalance"]>[0],
            ctx,
          );
        case "apply_payable_settlement":
          return engine.applySettlement(
            input as unknown as Parameters<PayablesIqEngine["applySettlement"]>[0],
            ctx,
          );
        default: {
          const unknown: never = request.capability;
          return refuse(
            "missing-evidence",
            PAYABLES_METHODS.registry,
            `PayablesIQ does not answer "${String(unknown)}".`,
          );
        }
      }
    },
    async health() {
      return { healthy: true, detail: "Kernel available. Ports supplied per instance." };
    },
  };
}
