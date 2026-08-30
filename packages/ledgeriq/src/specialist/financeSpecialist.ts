// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Specialist } from "@proworks-hub/core-kit";

import { refusal } from "../contractsLocal/refusals.js";
import { LEDGER_METHODS } from "../kernel/methods.js";
import type { LedgerRuntime } from "../runtime/ledgerRuntime.js";

// ─────────────────────────────────────────────────────────────────────────────
// The one adapter LedgerIQ ships (§22.1): capability names → handlers, thin by
// design, no domain logic. The capability vocabulary is typed as string
// literals here — adding them to `financeCapabilitySchema` is a finance-core
// change (PC-5), and LedgerIQ does not import Finance Core (guard G-2).
//
// `close_period` is DELIBERATELY not claimed: CloseIQ owns the close PROCESS;
// LedgerIQ owns the period STATE, reached via `close_ledger_period` (SR-2).
// ─────────────────────────────────────────────────────────────────────────────

export const LEDGER_CAPABILITIES = [
  "post_accounting_entry",
  "validate_posting_proposal",
  "reverse_accounting_entry",
  "read_account_balance",
  "produce_trial_balance",
  "read_chart_of_accounts",
  "close_ledger_period",
  "reopen_ledger_period",
  "explain_posting_decision",
] as const;

export type LedgerCapability = (typeof LEDGER_CAPABILITIES)[number];

export function createLedgerSpecialist(runtime: LedgerRuntime): Specialist<LedgerCapability> {
  return {
    id: "ledgeriq",
    capabilities: [...LEDGER_CAPABILITIES],
    preference: 10,
    async handle(request) {
      const input = request.input as Record<string, unknown>;
      switch (request.capability) {
        case "post_accounting_entry":
          return runtime.post(input as Parameters<LedgerRuntime["post"]>[0]);
        case "validate_posting_proposal":
          return runtime.validate(input as Parameters<LedgerRuntime["validate"]>[0]);
        case "reverse_accounting_entry":
          return runtime.reverse(input as Parameters<LedgerRuntime["reverse"]>[0]);
        case "read_account_balance":
          return runtime.readAccountBalance(
            input as Parameters<LedgerRuntime["readAccountBalance"]>[0],
          );
        case "produce_trial_balance":
          return runtime.produceTrialBalance(
            input as Parameters<LedgerRuntime["produceTrialBalance"]>[0],
          );
        case "read_chart_of_accounts":
          return runtime.readChartOfAccounts(
            input as Parameters<LedgerRuntime["readChartOfAccounts"]>[0],
          );
        case "close_ledger_period":
          return runtime.closePeriod(input as Parameters<LedgerRuntime["closePeriod"]>[0]);
        case "reopen_ledger_period":
          return runtime.reopenPeriod(input as Parameters<LedgerRuntime["reopenPeriod"]>[0]);
        case "explain_posting_decision":
          // L0–L6 arrive in a later wave; an unbuilt level is a typed refusal,
          // never a stub answer.
          return {
            ok: false,
            refusal: refusal(
              "CAPABILITY_NOT_OWNED",
              LEDGER_METHODS.proposalValidation,
              "Explanation levels L0–L6 are not built yet in this installation. The refusal is honest; a stubbed explanation would not be.",
            ),
          };
        default: {
          // Exhaustiveness: a new capability name must be handled or refused.
          const unknown: never = request.capability;
          return {
            ok: false,
            refusal: refusal(
              "CAPABILITY_NOT_OWNED",
              LEDGER_METHODS.proposalValidation,
              `LedgerIQ does not answer "${String(unknown)}".`,
            ),
          };
        }
      }
    },
    async health() {
      const h = await runtime.health();
      return { healthy: h.healthy === true, detail: h.detail };
    },
  };
}
