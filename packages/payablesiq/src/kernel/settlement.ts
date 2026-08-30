// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  exactMinorUnits,
  exactMoneyFromMinorUnits,
} from "@proworks-hub/contracts";

import type { ObligationStatus, PayableObligation, SettlementApplication } from "../model.js";
import { ok, refuse, type Result } from "../refusals.js";
import { PAYABLES_METHODS } from "./methods.js";

// ─────────────────────────────────────────────────────────────────────────────
// settlement.apply — §14.3 rule 1 and the state machine of §13.4.
//
// `openAmount` is derived, and the derivation is authoritative:
//   openAmount = originalAmount − Σ(consuming applications) + Σ(reversals)
// The stored value exists for query performance and is VERIFIED on every read
// path; a mismatch is a typed refusal naming both figures, never a silent
// correction — the stored-and-never-consulted defect, inverted on purpose.
// ─────────────────────────────────────────────────────────────────────────────

const CONSUMING: readonly SettlementApplication["kind"][] = [
  "settlement",
  "credit-memo",
  "discount-taken",
  "write-off",
];

export function deriveOpenAmountUnits(
  original: bigint,
  applications: readonly SettlementApplication[],
): bigint {
  let open = original;
  for (const app of applications) {
    const units = exactMinorUnits(app.appliedAmount);
    if (CONSUMING.includes(app.kind)) open -= units;
    else open += units; // reversal restores
  }
  return open;
}

/** The read-path cross-check. A mismatch names both figures and refuses. */
export function reconcileOpenAmount(
  obligation: PayableObligation,
  applications: readonly SettlementApplication[],
): Result<"reconciled"> {
  const derived = deriveOpenAmountUnits(exactMinorUnits(obligation.originalAmount), applications);
  const stored = exactMinorUnits(obligation.openAmount);
  if (derived !== stored) {
    const { currency, scale } = obligation.openAmount;
    return refuse(
      "invariant-violated",
      PAYABLES_METHODS.applySettlement,
      `openAmount mismatch on ${obligation.obligationId}: stored ${obligation.openAmount.amount} ${currency}, derived ${exactMoneyFromMinorUnits(derived, currency, scale).amount} ${currency}. Never silently corrected.`,
    );
  }
  return ok("reconciled");
}

export interface ApplySettlementOutcome {
  /** The NEW obligation version. The prior version is never mutated (LOCK-3). */
  readonly next: PayableObligation;
  readonly application: SettlementApplication;
  /** True when this application was already applied (idempotency scope 2). */
  readonly replayed: boolean;
}

export function applySettlement(
  obligation: PayableObligation,
  priorApplications: readonly SettlementApplication[],
  application: SettlementApplication,
): Result<ApplySettlementOutcome> {
  const M = PAYABLES_METHODS.applySettlement;

  // Idempotency scope 2: replayed, out-of-order and concurrent deliveries
  // converge to one application.
  const existing = priorApplications.find((a) => a.idempotencyKey === application.idempotencyKey);
  if (existing) {
    if (existing.appliedAmount.amount !== application.appliedAmount.amount || existing.kind !== application.kind) {
      return refuse(
        "invariant-violated",
        M,
        `Idempotency key '${application.idempotencyKey}' was already used for a different application. Never last-write-wins.`,
      );
    }
    return ok({ next: obligation, application: existing, replayed: true });
  }

  if (application.appliedAmount.currency !== obligation.currency) {
    return refuse(
      "currency-mismatch",
      M,
      `Cannot apply ${application.appliedAmount.currency} against a ${obligation.currency} obligation; supply an ExchangeRateRef upstream.`,
    );
  }
  if (obligation.status === "reversed" || obligation.status === "written-off") {
    return refuse(
      "invariant-violated",
      M,
      `Obligation ${obligation.obligationId} is ${obligation.status}; nothing further applies to it.`,
    );
  }
  if (application.kind === "write-off" && application.authorizationRef === undefined) {
    return refuse(
      "not-authorized",
      M,
      "A write-off requires an authorization reference. Absent means refused, not assumed.",
    );
  }

  const openUnits = exactMinorUnits(obligation.openAmount);
  const appliedUnits = exactMinorUnits(application.appliedAmount);
  if (CONSUMING.includes(application.kind) && appliedUnits > openUnits) {
    const { currency, scale } = obligation.openAmount;
    const excess = exactMoneyFromMinorUnits(appliedUnits - openUnits, currency, scale);
    return refuse(
      "invariant-violated",
      M,
      `applications would exceed openAmount by ${excess.amount} ${currency}.`,
    );
  }

  const nextOpenUnits = deriveOpenAmountUnits(
    exactMinorUnits(obligation.originalAmount),
    [...priorApplications, application],
  );
  const nextStatus: ObligationStatus =
    application.kind === "write-off"
      ? "written-off"
      : nextOpenUnits === 0n
        ? "settled"
        : "partially-settled";

  const next: PayableObligation = {
    ...obligation,
    version: obligation.version + 1,
    supersedes: `${obligation.obligationId}@v${obligation.version}`,
    status: nextStatus,
    openAmount: exactMoneyFromMinorUnits(
      nextOpenUnits,
      obligation.openAmount.currency,
      obligation.openAmount.scale,
    ),
    applications: [...obligation.applications, application.applicationId],
  };
  return ok({ next, application, replayed: false });
}

// ─────────────────────────────────────────────────────────────────────────────
// The obligation state machine — §13.4/§15. Explicit, exhaustive, total:
// every transition either exists here or is a refusal. There is no state
// without an exit (T-SM-04 walks this table, not the prose).
//
// `disputed-hold` is DELIBERATELY not a state in this implementation: its
// producer (the B-3 dispute workflow) is gated on a platform case-kit that
// does not exist. A state nothing can reach is the eight-times-shipped
// defect; it arrives with its producer.
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusTransitionRule {
  readonly from: ObligationStatus;
  readonly to: ObligationStatus;
  /** Whether a recorded Governance decision reference is required. */
  readonly requiresAuthorization: boolean;
}

export const OBLIGATION_TRANSITIONS: readonly StatusTransitionRule[] = [
  { from: "open", to: "partially-settled", requiresAuthorization: false },
  { from: "open", to: "settled", requiresAuthorization: false },
  { from: "partially-settled", to: "settled", requiresAuthorization: false },
  { from: "open", to: "held", requiresAuthorization: true },
  { from: "partially-settled", to: "held", requiresAuthorization: true },
  { from: "held", to: "open", requiresAuthorization: true },
  { from: "held", to: "partially-settled", requiresAuthorization: true },
  { from: "open", to: "written-off", requiresAuthorization: true },
  { from: "partially-settled", to: "written-off", requiresAuthorization: true },
  { from: "open", to: "reversed", requiresAuthorization: false },
  { from: "partially-settled", to: "reversed", requiresAuthorization: false },
  { from: "open", to: "escheat-candidate", requiresAuthorization: false },
  { from: "escheat-candidate", to: "open", requiresAuthorization: false },
  { from: "escheat-candidate", to: "settled", requiresAuthorization: false },
];

/** Terminal by design, and stated: settled, written-off, reversed. */
export const TERMINAL_OBLIGATION_STATUSES: readonly ObligationStatus[] = [
  "settled",
  "written-off",
  "reversed",
];
