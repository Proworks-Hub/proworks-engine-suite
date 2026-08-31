// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { EngineManifest } from "../core/manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The Finance Core engine program, described for the console.
//
// Twenty-nine specialized engines built under DEC-025 and DEC-026, authored
// here by the session that built them rather than inferred later by the
// console — an inferred manifest guesses at topology, and a guessed edge is
// indistinguishable from a real one once it is drawn.
//
// NOT WIRED INTO `SUITE_MANIFESTS`, deliberately.
//
// `registry.test.ts` asserts the console counts exactly eight engines, and
// that number encodes a real decision ("8 of 8 engines online has to mean
// engines"). Adding twenty-nine here would change what the console counts,
// what the layout draws and what the fleet-health denominator divides by —
// console questions, owned by the console session. These are exported as
// their own array so that integration is a deliberate act with its own test
// updates, not a side effect of authoring metadata.
//
// THREE THINGS EVERY MANIFEST BELOW DECLARES EMPTY, AND WHY:
//
//   eventMappings: []   Every one of these engines is kernel-scope: platform-
//                       events publication is in each one's stated gap. Zero
//                       edges is the TRUE topology. A mapping added before its
//                       emitter draws a connection that does not exist, and
//                       CC-ADR-002 makes event mappings the only source of
//                       DATA edges — so an invented mapping is an invented
//                       edge. Each gains its mappings in the same commit as
//                       the emitter, never ahead of it.
//
//   metrics: []         A metric declares a number the engine REPORTS. These
//                       report nothing — no runtime, no persistence, no
//                       telemetry. A declared metric would be a permanently
//                       empty tile, which reads as "zero" rather than as "not
//                       measured": the exact confusion the whole program is
//                       built to avoid.
//
//   capabilities: []    Except LedgerIQ. Only its nine names are registered in
//                       `financeCapabilitySchema` (PC-5); the other twenty-
//                       eight engines' capabilities are declared locally in
//                       their own specialists and are NOT in the shared
//                       contracts. The schema says these names come from the
//                       shared contracts, so listing an unregistered one would
//                       populate an entitlement view with entitlements nobody
//                       can grant.
//
// Scenes: `visualizationType` values below are not yet built. The schema's
// stated behaviour for an unknown scene is a generic fallback, which is the
// honest rendering for an engine with nothing to animate. The names are a
// target list for whoever builds them, grouped by family so one scene can
// serve several engines.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shape every finance manifest shares. Written once so a per-engine
 * difference is visible as a difference rather than lost in repetition.
 */
const financeBase = {
  manifestVersion: 2,
  kind: "engine",
  layer: "specialized",
  coreDomain: "finance",
  // Deprecated since v2 and superseded by `layer`; present only because the
  // parsed type requires it. Not read by new code.
  hivePlacement: "ring",
  visualizationConfig: {},
  capabilities: [],
  metrics: [],
  // Only `overview` can show anything today: name, description, package,
  // layer. Claiming `events` would open a permanently empty tab on an engine
  // that publishes nothing, and `diagnostics`/`performance` would promise
  // telemetry that does not exist.
  supportedAdminPanels: ["overview"],
  eventMappings: [],
} as const satisfies Partial<EngineManifest>;

const engine = (
  id: string,
  name: string,
  description: string,
  colorToken: string,
  icon: string,
  visualizationType: string,
): EngineManifest => ({
  ...financeBase,
  id,
  name,
  description,
  packageName: `@proworks-hub/${id}`,
  colorToken,
  icon,
  visualizationType,
});

// ── Family 1 · Accounting / record-to-report ────────────────────────────────

/** The one engine here with registered capabilities: PC-5 put its nine names
 * in `financeCapabilitySchema`, so the entitlement view has something real to
 * show. LOCK-1: the only component permitted to post a journal entry. */
export const ledgerIqManifest: EngineManifest = {
  ...engine(
    "ledgeriq",
    "LedgerIQ",
    "The general ledger: chart of accounts, journal, periods, debit/credit integrity, balances",
    "engine-gold",
    "ledger-book",
    "ledger-columns",
  ),
  capabilities: [
    "post_accounting_entry",
    "validate_posting_proposal",
    "reverse_accounting_entry",
    "read_account_balance",
    "produce_trial_balance",
    "read_chart_of_accounts",
    "close_ledger_period",
    "reopen_ledger_period",
    "explain_posting_decision",
  ],
};

export const payablesIqManifest = engine(
  "payablesiq",
  "PayablesIQ",
  "What is owed to suppliers: terms, discount yield, aging, settlement",
  "engine-orange",
  "invoice-out",
  "ledger-columns",
);

export const receivablesIqManifest = engine(
  "receivablesiq",
  "ReceivablesIQ",
  "What customers owe: cash application, allocation, short-pay, aging, DSO",
  "engine-green",
  "invoice-in",
  "ledger-columns",
);

export const closeIqManifest = engine(
  "closeiq",
  "CloseIQ",
  "The period close as evidenced work: tasks, reconciliation, readiness, certification",
  "engine-violet",
  "checklist-seal",
  "close-board",
);

export const consolidationIqManifest = engine(
  "consolidationiq",
  "ConsolidationIQ",
  "Group reporting: ownership solve, translation, elimination, non-controlling interests",
  "engine-purple",
  "group-tree",
  "consolidation-tree",
);

export const assetFinanceIqManifest = engine(
  "assetfinanceiq",
  "AssetFinanceIQ",
  "Owned assets: capitalization, depreciation schedules, impairment, tax basis",
  "engine-aqua",
  "asset-block",
  "schedule-ladder",
);

export const leaseFinanceIqManifest = engine(
  "leasefinanceiq",
  "LeaseFinanceIQ",
  "Leases: classification determinacy, discount rate selection, right-of-use schedules",
  "engine-aqua",
  "lease-key",
  "schedule-ladder",
);

export const revenueRecognitionIqManifest = engine(
  "revenuerecognitioniq",
  "RevenueRecognitionIQ",
  "Performance obligations, transaction price, standalone selling price allocation, satisfaction",
  "engine-green",
  "contract-split",
  "obligation-flow",
);

// ── Family 2 · Cost management ──────────────────────────────────────────────

export const allocationIqManifest = engine(
  "allocationiq",
  "AllocationIQ",
  "Cost pools and drivers: direct, step-down and reciprocal allocation on exact rationals",
  "engine-cyan",
  "allocation-fan",
  "allocation-fan",
);

export const profitabilityIqManifest = engine(
  "profitabilityiq",
  "ProfitabilityIQ",
  "Profit and margin by dimension, where a hole in the cost basis is a named hole",
  "engine-green",
  "margin-bars",
  "margin-bars",
);

export const projectFinanceIqManifest = engine(
  "projectfinanceiq",
  "ProjectFinanceIQ",
  "The project as a financial object: earned value, estimate at completion, immutable baselines",
  "engine-blue",
  "project-track",
  "burn-curve",
);

// ── Family 3 · Planning and FP&A ────────────────────────────────────────────

export const budgetIqManifest = engine(
  "budgetiq",
  "BudgetIQ",
  "Budget envelopes with encumbrance accounting: released base, availability, carry-forward",
  "engine-gold",
  "envelope-stack",
  "envelope-stack",
);

export const forecastIqManifest = engine(
  "forecastiq",
  "ForecastIQ",
  "Statistical forecasting where seasonal naive is the permanent benchmark and FVA is required",
  "engine-cyan",
  "forecast-fan",
  "forecast-fan",
);

export const scenarioIqManifest = engine(
  "scenarioiq",
  "ScenarioIQ",
  "What-if composition over replayable methods it never imports: overlays, sensitivity, stress",
  "engine-violet",
  "scenario-branch",
  "scenario-branch",
);

export const varianceIqManifest = engine(
  "varianceiq",
  "VarianceIQ",
  "Exact variance decomposition where the joint term is never silently assigned",
  "engine-magenta",
  "variance-bridge",
  "variance-bridge",
);

// ── Family 4 · Treasury ─────────────────────────────────────────────────────

export const liquidityIqManifest = engine(
  "liquidityiq",
  "LiquidityIQ",
  "Cash positions and direct forecasts under a coverage lattice that never recovers from a hole",
  "engine-aqua",
  "cash-ladder",
  "cash-ladder",
);

export const paymentsIqManifest = engine(
  "paymentsiq",
  "PaymentsIQ",
  "Payment instruction lifecycle: duplicate fingerprints, rail semantics, settlement reconciliation",
  "engine-orange",
  "payment-rail",
  "payment-rail",
);

export const debtIqManifest = engine(
  "debtiq",
  "DebtIQ",
  "Debt instruments: day counts, effective interest, amortization schedules, covenants",
  "engine-purple",
  "debt-curve",
  "schedule-ladder",
);

export const investmentIqManifest = engine(
  "investmentiq",
  "InvestmentIQ",
  "Investment positions, convention-true yields, and ternary policy limit tests",
  "engine-blue",
  "portfolio-grid",
  "portfolio-grid",
);

export const financialRiskIqManifest = engine(
  "financialriskiq",
  "FinancialRiskIQ",
  "Exposure aggregation under an honest coverage manifest: FX, rates, counterparty, stress",
  "engine-magenta",
  "risk-radar",
  "risk-radar",
);

// ── Family 5 · Spend and procure-to-pay ─────────────────────────────────────

export const expenseIqManifest = engine(
  "expenseiq",
  "ExpenseIQ",
  "Expense policy as versioned data: per-diem, mileage, card matching, evidenced verdicts",
  "engine-gold",
  "receipt-stack",
  "policy-grid",
);

export const invoiceIqManifest = engine(
  "invoiceiq",
  "InvoiceIQ",
  "Invoice capture and PO matching where the type carries the honesty rule",
  "engine-orange",
  "match-three",
  "match-grid",
);

export const spendIqManifest = engine(
  "spendiq",
  "SpendIQ",
  "Spend classification, cube and savings claims whose amounts derive from by-value baselines",
  "engine-cyan",
  "spend-cube",
  "spend-cube",
);

// ── Family 6 · Order-to-cash ────────────────────────────────────────────────

export const billingIqManifest = engine(
  "billingiq",
  "BillingIQ",
  "Invoice generation: proration, tiered rating, usage windows, gapless numbering, corrections",
  "engine-green",
  "billing-meter",
  "billing-meter",
);

export const collectionsIqManifest = engine(
  "collectionsiq",
  "CollectionsIQ",
  "Collections worklist, promises, dunning sequences and contact permission",
  "engine-orange",
  "dunning-steps",
  "dunning-steps",
);

export const creditIqManifest = engine(
  "creditiq",
  "CreditIQ",
  "Credit exposure as a known floor, limits, and adverse action as a hard gate",
  "engine-magenta",
  "credit-gauge",
  "credit-gauge",
);

// ── Family 7 · Tax and control ──────────────────────────────────────────────

export const taxIqManifest = engine(
  "taxiq",
  "TaxIQ",
  "Tax determination: taxability, nexus, exemptions, per-jurisdiction rounding, filing aggregates",
  "engine-violet",
  "tax-jurisdiction",
  "jurisdiction-map",
);

export const financialReportingIqManifest = engine(
  "financialreportingiq",
  "FinancialReportingIQ",
  "Statements whose cash reconciliation is proven rather than constructed",
  "engine-blue",
  "statement-sheet",
  "statement-sheet",
);

export const financialControlsIqManifest = engine(
  "financialcontrolsiq",
  "FinancialControlsIQ",
  "Internal controls: design vs operating effectiveness, sampling, segregation of duties",
  "engine-purple",
  "control-matrix",
  "control-matrix",
);

/**
 * The twenty-nine, in family order — the order they were built and the order
 * the program record lists them.
 */
export const FINANCE_MANIFESTS: readonly EngineManifest[] = [
  // Family 1 — accounting / R2R
  ledgerIqManifest,
  payablesIqManifest,
  receivablesIqManifest,
  closeIqManifest,
  consolidationIqManifest,
  assetFinanceIqManifest,
  leaseFinanceIqManifest,
  revenueRecognitionIqManifest,
  // Family 2 — cost management
  allocationIqManifest,
  profitabilityIqManifest,
  projectFinanceIqManifest,
  // Family 3 — planning / FP&A
  budgetIqManifest,
  forecastIqManifest,
  scenarioIqManifest,
  varianceIqManifest,
  // Family 4 — treasury
  liquidityIqManifest,
  paymentsIqManifest,
  debtIqManifest,
  investmentIqManifest,
  financialRiskIqManifest,
  // Family 5 — spend / P2P
  expenseIqManifest,
  invoiceIqManifest,
  spendIqManifest,
  // Family 6 — order-to-cash
  billingIqManifest,
  collectionsIqManifest,
  creditIqManifest,
  // Family 7 — tax / control
  taxIqManifest,
  financialReportingIqManifest,
  financialControlsIqManifest,
];
