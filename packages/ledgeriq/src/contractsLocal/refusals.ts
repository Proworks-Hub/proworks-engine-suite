// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The typed refusal taxonomy — blueprint §19.4. The complete CLOSED set of 48.
//
// A refusal is RETURNED, never thrown. Thrown exceptions are reserved for
// programmer error and are never part of the contract. Every refusal names the
// rule that refused (`methodRef`), the offending element, and a remediation a
// human can act on.
//
// Deliberate absences: there is no `PROPOSER_NOT_RECOGNISED` code, and adding
// one would be a regression — LedgerIQ validates proposals on their merits and
// on the target account's own reservations, never against a roster of engines
// (§16.2). There is no code that means "force flag rejected", because there is
// no force flag.
//
// Adding a code is a MINOR version change (consumers fall back to "refused,
// reason unrecognised"). Removing or repurposing one is MAJOR.
// ─────────────────────────────────────────────────────────────────────────────

export const LEDGER_REFUSAL_CODES = [
  // Structural
  "PROPOSAL_MALFORMED",
  "ENTRY_TOO_FEW_LINES",
  "LINE_NUMBERING_INVALID",
  "RECORD_TIME_MISSING",
  // Book / period
  "UNKNOWN_BOOK",
  "BOOK_INACTIVE",
  "PERIOD_NOT_FOUND",
  "PERIOD_FUTURE",
  "PERIOD_PENDING_CLOSE",
  "PERIOD_CLOSED",
  "PERIOD_PERMANENTLY_CLOSED",
  "EFFECTIVE_DATE_OUTSIDE_PERIOD",
  "EARLIER_PERIOD_OPEN",
  "PROPOSAL_IN_FLIGHT",
  // Idempotency
  "IDEMPOTENCY_KEY_MISSING",
  "IDEMPOTENCY_KEY_CONFLICT",
  // Account / chart
  "ACCOUNT_UNKNOWN",
  "ACCOUNT_NOT_POSTABLE",
  "ACCOUNT_BLOCKED_AT_DATE",
  "ACCOUNT_CONTROL_RESERVED",
  "CURRENCY_NOT_PERMITTED_ON_ACCOUNT",
  // Dimensions
  "DIMENSION_REQUIRED_MISSING",
  "DIMENSION_VALUE_UNKNOWN",
  "DIMENSION_COMBINATION_INVALID",
  // Money / FX
  "SCALE_VIOLATION",
  "MIXED_CURRENCY_ARITHMETIC",
  "FX_PORT_UNBOUND",
  "FX_RATE_TYPE_UNDECLARED",
  "FX_RATE_UNAVAILABLE",
  "FX_RATE_STALE",
  "ROUNDING_RESIDUE_UNASSIGNED",
  "ROUNDING_RESIDUE_EXCEEDS_TOLERANCE",
  // Integrity
  "UNBALANCED_ENTRY",
  "UNBALANCED_BY_BALANCING_DIMENSION",
  "STATISTICAL_ON_MONETARY_ACCOUNT",
  "MONETARY_ON_STATISTICAL_ACCOUNT",
  "TRIAL_BALANCE_DOES_NOT_FOOT",
  // Reversal
  "REVERSAL_TARGET_NOT_FOUND",
  "REVERSAL_TARGET_ALREADY_REVERSED",
  "REVERSAL_PERIOD_CLOSED",
  // Authority / identity
  "NOT_AUTHORIZED",
  "GOVERNANCE_UNAVAILABLE",
  "IDENTITY_UNRESOLVED",
  "AI_CANDIDATE_SOLE_BASIS",
  // Ownership
  "CAPABILITY_NOT_OWNED",
  "CROSS_BOOK_DERIVATION_NOT_OWNED",
  // Infrastructure
  "STORE_UNAVAILABLE",
  "CONCURRENT_MODIFICATION",
] as const;

export type LedgerRefusalCode = (typeof LEDGER_REFUSAL_CODES)[number];

/**
 * One refusal. `offending` points at what failed — a line number, an account
 * code, a dimension, a period — so the proposer fixes the right thing on the
 * first try instead of the third.
 */
export interface LedgerRefusal {
  readonly code: LedgerRefusalCode;
  /** The versioned rule that refused. A refusal that cannot name its rule is a string. */
  readonly methodRef: MethodRef;
  readonly offending?: string;
  /** What would make the proposal acceptable. */
  readonly remediation: string;
}

export function refusal(
  code: LedgerRefusalCode,
  methodRef: MethodRef,
  remediation: string,
  offending?: string,
): LedgerRefusal {
  return offending === undefined
    ? { code, methodRef, remediation }
    : { code, methodRef, remediation, offending };
}
