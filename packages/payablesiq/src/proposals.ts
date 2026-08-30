// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PostingProposal, TraceContext } from "@proworks-hub/contracts";

import { PAYABLES_METHODS } from "./kernel/methods.js";
import type { PayableObligation } from "./model.js";
import { ok, refuse, type Result } from "./refusals.js";

// ─────────────────────────────────────────────────────────────────────────────
// PostingProposal construction — §19.5, LOCK-1. PayablesIQ PROPOSES; only
// LedgerIQ posts. PayablesIQ does not select accounts: the host supplies the
// account mapping, and LedgerIQ validates it against the chart. An
// originating engine that treats a proposal as posted is defective —
// `ledgerAcknowledgement` stays `unknown` until LedgerIQ answers, and
// "accounted for" refuses while it is `unknown`.
// ─────────────────────────────────────────────────────────────────────────────

export type ProposalKind = "liability-recognition" | "discount-taken" | "write-off";

export interface AccountMapping {
  /** Host-supplied account references. PayablesIQ never invents one. */
  readonly expenseOrClearingAccount: string;
  readonly payablesControlAccount: string;
  readonly discountIncomeAccount?: string;
  readonly writeOffAccount?: string;
}

export function buildPostingProposal(input: {
  readonly obligation: PayableObligation;
  readonly kind: ProposalKind;
  readonly bookId: string;
  readonly effectiveDate: string;
  readonly periodRef: { fiscalYear: number; periodNumber: number };
  readonly mapping: AccountMapping;
  readonly trace: TraceContext;
}): Result<PostingProposal> {
  const M = PAYABLES_METHODS.proposePostings;
  const o = input.obligation;

  const accounts = ((): Result<{ debit: string; credit: string; amount: typeof o.originalAmount }> => {
    switch (input.kind) {
      case "liability-recognition":
        return ok({
          debit: input.mapping.expenseOrClearingAccount,
          credit: input.mapping.payablesControlAccount,
          amount: o.originalAmount,
        });
      case "discount-taken": {
        if (!input.mapping.discountIncomeAccount) {
          return refuse("missing-evidence", M, "The host mapping names no discountIncomeAccount.");
        }
        return ok({
          debit: input.mapping.payablesControlAccount,
          credit: input.mapping.discountIncomeAccount,
          amount: o.openAmount,
        });
      }
      case "write-off": {
        if (!input.mapping.writeOffAccount) {
          return refuse("missing-evidence", M, "The host mapping names no writeOffAccount.");
        }
        return ok({
          debit: input.mapping.payablesControlAccount,
          credit: input.mapping.writeOffAccount,
          amount: o.openAmount,
        });
      }
    }
  })();
  if (!accounts.ok) return accounts;

  // Deterministic idempotency key — §19.5: regenerating a proposal for
  // unchanged facts produces a byte-identical proposal with the same key.
  const idempotencyKey = [
    o.obligationId,
    `v${o.version}`,
    input.kind,
    input.effectiveDate,
    `${PAYABLES_METHODS.proposePostings.methodId}@${PAYABLES_METHODS.proposePostings.semanticVersion}`,
  ].join("|");

  return ok({
    proposalId: `payables:${idempotencyKey}`,
    proposedBy: "hive.payablesiq",
    bookId: input.bookId,
    lines: [
      {
        lineNo: 1,
        accountCode: accounts.value.debit,
        side: "debit",
        amount: accounts.value.amount,
        dimensions: {},
        openItemRef: o.obligationId,
      },
      {
        lineNo: 2,
        accountCode: accounts.value.credit,
        side: "credit",
        amount: accounts.value.amount,
        dimensions: {},
        openItemRef: o.obligationId,
      },
    ],
    effectiveDate: input.effectiveDate,
    periodRef: input.periodRef,
    methodRef: PAYABLES_METHODS.proposePostings,
    evidence: [{ ref: `${o.obligationId}@v${o.version}`, quality: o.evidence }],
    trace: input.trace,
    idempotencyKey,
  });
}
