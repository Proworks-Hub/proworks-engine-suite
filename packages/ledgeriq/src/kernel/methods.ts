// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The versioned method registry — blueprint §16.1. Every consequential rule
// carries { methodId, semanticVersion, effectiveFrom }. A result-changing
// modification REQUIRES a new semantic version; every posted entry records the
// postingMethodRefs[] that produced it, so a historical figure stays
// reproducible after a rule changes.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const LEDGER_METHODS = {
  /** The ordered validation ladder (§16.2) and which refusal wins. */
  proposalValidation: method("LEDGER-PROPOSAL-VALIDATION"),
  /** Σ functional debits = Σ functional credits per entry, statistical excluded. */
  balanceIntegrity: method("LEDGER-BALANCE-INTEGRITY"),
  /** Balance within each value of each balancing dimension. */
  dimensionBalance: method("LEDGER-DIMENSION-BALANCE"),
  /** Generation of due-to/due-from lines when a book declares the rule. */
  intercompanyBalancing: method("LEDGER-INTERCOMPANY-BALANCING"),
  /** transaction → functional conversion: rate selection, rounding mode, boundary. */
  fxConversion: method("LEDGER-FX-CONVERSION"),
  /** Where the entry-level rounding difference goes. */
  roundingResidue: method("LEDGER-ROUNDING-RESIDUE"),
  /** Legal period transitions and their authorization floors. */
  periodState: method("LEDGER-PERIOD-STATE"),
  /** How a reversal is constructed and dated. */
  reversal: method("LEDGER-REVERSAL"),
  /** Which sources may post to a reserved account. */
  controlAccount: method("LEDGER-CONTROL-ACCOUNT"),
  /** Year-end roll-forward and retained-earnings close. */
  openingBalance: method("LEDGER-OPENING-BALANCE"),
  /** How a proposal targeting multiple books is split (it is not — one proposal per book). */
  parallelBookProjection: method("LEDGER-PARALLEL-BOOK-PROJECTION"),
  /** The fold, its grouping and its as-of semantics. */
  trialBalance: method("LEDGER-TRIAL-BALANCE"),
  /** The canonical statutory field projection (§21.4). */
  exportProjection: method("LEDGER-EXPORT-PROJECTION"),
} as const satisfies Record<string, MethodRef>;

export type LedgerMethodKey = keyof typeof LEDGER_METHODS;
