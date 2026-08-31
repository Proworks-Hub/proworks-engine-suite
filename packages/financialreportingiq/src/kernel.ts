// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { MethodRef } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// FinancialReportingIQ kernel — §16. The indirect cash flow has four
// breakers, each a REQUIRED input with a named refusal: non-cash movements,
// reclassifications, business-combination effects, translation effects.
// The cash reconciliation invariant is PROVEN, never constructed: the two
// sides are computed independently, no term is "whatever makes this
// balance", the FX-on-cash line is a presented item and not a residual, and
// a failure returns the statement WITH the finding — no balancing line is
// ever inserted (G-14). A balance-delta-only derivation exists, labelled
// inseparably, and is refused on statutory runs — the honest version of
// what most implementations do by default and never label. A ratio is a
// versioned method with a REQUIRED methodId: one firm's debt-to-equity runs
// 4.304 to 7.177 across defensible formulations.
// ─────────────────────────────────────────────────────────────────────────────

const method = (methodId: string): MethodRef => ({
  methodId,
  semanticVersion: "1.0.0",
  effectiveFrom: "2026-08-30",
});

export const REPORTING_METHODS = {
  indirectCashFlow: method("M-CF-IND-1"),
  deltaCashFlow: method("M-CF-IND-DELTA-1"),
  cashInvariant: method("INV-CASH"),
  ratio: method("ratio.registry"),
} as const satisfies Record<string, MethodRef>;

export const REPORTING_REFUSAL_KINDS = [
  "NON_CASH_MOVEMENTS_UNAVAILABLE",
  "RECLASSIFICATIONS_UNIDENTIFIED",
  "COMBINATION_EFFECTS_UNAVAILABLE",
  "TRANSLATION_EFFECTS_UNAVAILABLE",
  "DELTA_DERIVATION_NOT_PERMITTED_FOR_STATUTORY",
  "RATIO_METHOD_UNSELECTED",
] as const;
export type ReportingRefusalKind = (typeof REPORTING_REFUSAL_KINDS)[number];

export interface ReportingRefusal {
  readonly kind: ReportingRefusalKind;
  readonly methodRef: MethodRef;
  readonly detail: string;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ReportingRefusal };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const refuse = <T = never>(
  kind: ReportingRefusalKind,
  methodRef: MethodRef,
  detail: string,
): Result<T> => ({ ok: false, refusal: { kind, methodRef, detail } });

// ── §16.5 · the indirect derivation and its four breakers ───────────────────

export interface NonCashMovement {
  readonly movementType: string; // depreciation, impairment, SBP, ...
  readonly amountMinor: bigint; // sign as it affected P&L
}

export interface IndirectCashFlowInputs {
  readonly profitOrLossMinor: bigint;
  readonly nonCashMovements: readonly NonCashMovement[] | undefined;
  readonly reclassificationsIdentified: boolean;
  readonly periodContainsBusinessCombination: boolean;
  readonly combinationEffects: { readonly cashConsiderationNetOfCashAcquiredMinor: bigint } | undefined;
  readonly presentationDiffersFromFunctional: boolean;
  readonly translationEffects: { readonly effectOnCashMinor: bigint } | undefined;
  readonly workingCapitalMovementOnResidueMinor: bigint;
  readonly investingFlowsMinor: bigint;
  readonly financingFlowsMinor: bigint;
}

export interface IndirectCashFlow {
  readonly netOperatingMinor: bigint;
  readonly netInvestingMinor: bigint;
  readonly netFinancingMinor: bigint;
  /** A PRESENTED item. Not the residual. Not a plug. */
  readonly effectOfExchangeRatesMinor: bigint;
  /** Each reversal individually named in the output. */
  readonly nonCashReversals: readonly NonCashMovement[];
  readonly methodRef: MethodRef;
}

export function deriveIndirectCashFlow(inputs: IndirectCashFlowInputs): Result<IndirectCashFlow> {
  const M = REPORTING_METHODS.indirectCashFlow;
  if (inputs.nonCashMovements === undefined) {
    return refuse("NON_CASH_MOVEMENTS_UNAVAILABLE", M, "The non-cash movement register is a required input; deriving without it plugs depreciation into working capital.");
  }
  if (!inputs.reclassificationsIdentified) {
    return refuse("RECLASSIFICATIONS_UNIDENTIFIED", M, "Movements between balance-sheet lines with zero cash effect must be identified before working capital is computed.");
  }
  if (inputs.periodContainsBusinessCombination && inputs.combinationEffects === undefined) {
    return refuse("COMBINATION_EFFECTS_UNAVAILABLE", M, "Assets acquired in a combination did not flow through working capital; the effects are a required argument.");
  }
  if (inputs.presentationDiffersFromFunctional && inputs.translationEffects === undefined) {
    return refuse("TRANSLATION_EFFECTS_UNAVAILABLE", M, "Balance-sheet lines translate at closing, P&L at average; the residue is not cash.");
  }
  const nonCashTotal = inputs.nonCashMovements.reduce((a, m) => a + m.amountMinor, 0n);
  const netOperating = inputs.profitOrLossMinor - nonCashTotal + inputs.workingCapitalMovementOnResidueMinor;
  const investing =
    inputs.investingFlowsMinor -
    (inputs.combinationEffects?.cashConsiderationNetOfCashAcquiredMinor ?? 0n); // one investing line, net of cash acquired
  return ok({
    netOperatingMinor: netOperating,
    netInvestingMinor: investing,
    netFinancingMinor: inputs.financingFlowsMinor,
    effectOfExchangeRatesMinor: inputs.translationEffects?.effectOnCashMinor ?? 0n,
    nonCashReversals: inputs.nonCashMovements,
    methodRef: M,
  });
}

/** The delta-only derivation: labelled inseparably and barred from statutory
 * runs. The honest version of the unlabelled default. */
export function deriveDeltaCashFlow(
  reportKind: "statutory" | "regulatory" | "management",
  profitOrLossMinor: bigint,
  balanceDeltasMinor: bigint,
): Result<{ netOperatingMinor: bigint; derivationBasis: "balance-delta-only"; assumptionLoad: "high" }> {
  const M = REPORTING_METHODS.deltaCashFlow;
  if (reportKind !== "management") {
    return refuse("DELTA_DERIVATION_NOT_PERMITTED_FOR_STATUTORY", M, `reportKind ${reportKind}: a delta-only derivation cannot support a statutory statement.`);
  }
  return ok({ netOperatingMinor: profitOrLossMinor + balanceDeltasMinor, derivationBasis: "balance-delta-only", assumptionLoad: "high" });
}

// ── §16.6 · INV-CASH: proven, never constructed ─────────────────────────────

export type CashInvariantOutcome =
  | { readonly holds: true }
  | {
      readonly holds: false;
      readonly finding: "CASH_RECONCILIATION_FAILED";
      readonly residualMinor: bigint;
      /** The statement is RETURNED with the finding; no balancing line. */
      readonly statementReturned: true;
    };

export function proveCashInvariant(
  openingCashMinor: bigint,
  closingCashMinor: bigint,
  statement: IndirectCashFlow,
): CashInvariantOutcome {
  // Both sides computed independently: LHS from the balance sheets THIS run
  // produced; RHS from the movement classification. No term is derived from
  // the other side.
  const lhs = closingCashMinor - openingCashMinor;
  const rhs =
    statement.netOperatingMinor +
    statement.netInvestingMinor +
    statement.netFinancingMinor +
    statement.effectOfExchangeRatesMinor;
  if (lhs === rhs) return { holds: true };
  return { holds: false, finding: "CASH_RECONCILIATION_FAILED", residualMinor: lhs - rhs, statementReturned: true };
}

// ── §16.7 · ratios: a registry of versioned methods, no default ─────────────

export interface RatioInputs {
  readonly totalLiabilitiesMinor: bigint;
  readonly interestBearingDebtMinor: bigint;
  readonly longTermDebtMinor: bigint;
  readonly cashAndEquivalentsMinor: bigint;
  readonly totalEquityMinor: bigint;
}

export const DEBT_TO_EQUITY_METHODS = [
  "ratio.debt-to-equity.total-liabilities",
  "ratio.debt-to-equity.interest-bearing",
  "ratio.debt-to-equity.long-term-only",
  "ratio.debt-to-equity.net-debt",
] as const;
export type DebtToEquityMethodId = (typeof DEBT_TO_EQUITY_METHODS)[number];

export type RatioValue =
  | { readonly defined: true; readonly numeratorMinor: bigint; readonly denominatorMinor: bigint; readonly methodId: DebtToEquityMethodId }
  | { readonly defined: false; readonly reason: string; readonly methodId: DebtToEquityMethodId };

/** methodId is REQUIRED with no default: one firm's debt-to-equity runs
 * 4.304 to 7.177 across defensible formulations, and there is no house
 * default and none will be added (the yieldMethod precedent, D-1). */
export function debtToEquity(inputs: RatioInputs, methodId: DebtToEquityMethodId | undefined): Result<RatioValue> {
  const M = REPORTING_METHODS.ratio;
  if (methodId === undefined) {
    return refuse("RATIO_METHOD_UNSELECTED", M, "Debt-to-equity has at least seven registered formulations spanning 4.304 to 7.177 on one firm; the caller names one.");
  }
  const numerator =
    methodId === "ratio.debt-to-equity.total-liabilities"
      ? inputs.totalLiabilitiesMinor
      : methodId === "ratio.debt-to-equity.interest-bearing"
        ? inputs.interestBearingDebtMinor
        : methodId === "ratio.debt-to-equity.long-term-only"
          ? inputs.longTermDebtMinor
          : inputs.interestBearingDebtMinor - inputs.cashAndEquivalentsMinor;
  if (inputs.totalEquityMinor === 0n) {
    // Null at a zero denominator — never 0, never Infinity.
    return ok({ defined: false, reason: "zero-equity", methodId });
  }
  return ok({ defined: true, numeratorMinor: numerator, denominatorMinor: inputs.totalEquityMinor, methodId });
}
