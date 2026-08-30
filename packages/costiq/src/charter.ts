/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — CostIQ
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/costiq/src/charter.ts
 * Module:   cost-iq-engine
 * Purpose:  What CostIQ owns, what it explicitly does not, and the machine-
 *           readable form of both so the boundary can be tested.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WHY A CHARTER IS CODE AND NOT A DOCUMENT
//
// Scope creep in an engine is never a decision anybody makes. It arrives one
// reasonable request at a time: CostIQ already knows the cost, so it may as
// well know the margin; it already knows the margin, so it may as well pick
// the supplier. Each step is small and each is defensible, and the result is
// an engine that owns things it cannot be held responsible for.
//
// A document does not stop that, because nobody reads a document while writing
// a function. A test does.
//
// So the exclusions below are enumerated, exported, and asserted against the
// package's own public surface. Adding a `selectSupplier` export to CostIQ
// fails a test that names the boundary being crossed and says which engine
// owns it instead.
//
// THE LINE COSTIQ SITS ON
//
// CostIQ answers "what does this cost, why, and how sure are we". It does not
// answer "what should we charge", "should we buy this", "is this business
// healthy", or "what will the customer pay". Those are real questions with
// real owners, and the honest thing is to compute the economic evidence and
// hand it over rather than to decide.
// ─────────────────────────────────────────────────────────────────────────────

/** A responsibility CostIQ owns outright. */
export interface OwnedResponsibility {
  readonly id: string;
  readonly summary: string;
}

/** A responsibility CostIQ deliberately does not own, and who does. */
export interface ExcludedResponsibility {
  readonly id: string;
  readonly summary: string;
  /** The engine or role that owns it instead. */
  readonly ownedBy: string;
  /**
   * The plausible-sounding request that would drag it in.
   *
   * Recorded because the exclusion is only useful if the reader recognises the
   * situation. "We do not own pricing" is abstract; "somebody will ask CostIQ
   * to pick the price because it already knows the cost" is the actual moment.
   */
  readonly arrivesAs: string;
}

export const COSTIQ_CHARTER_VERSION = "costiq.charter.v1" as const;

/** CostIQ is SPECIALIZED under Finance IQ. It is not, and does not become, Core. */
export const COSTIQ_CLASSIFICATION = "SPECIALIZED" as const;

export const COSTIQ_OWNS: readonly OwnedResponsibility[] = Object.freeze([
  { id: "cost.calculation", summary: "Deterministic calculation of what something costs to make or buy." },
  { id: "cost.basis", summary: "Versioned, provenance-bearing cost bases and the rules for choosing between them." },
  { id: "cost.graph", summary: "The dependency structure of a cost: components, operations, resources and evidence." },
  { id: "cost.method", summary: "Versioned costing methods and their historical replay." },
  { id: "cost.estimate", summary: "Immutable estimates with fingerprints, and the versions they pin." },
  { id: "cost.variance", summary: "Comparison of actuals against the estimate version that was approved." },
  { id: "cost.scenario", summary: "What-if overlays and sensitivity on cost inputs, without mutating a baseline." },
  { id: "cost.explanation", summary: "Deterministic explanation of a cost: drivers, assumptions, caveats, evidence." },
  { id: "cost.evidence.quality", summary: "Deterministic assessment of how good the evidence behind a cost is." },
  { id: "cost.model.health", summary: "Findings about the costing model itself — staleness, bias, coverage gaps." },
  { id: "cost.consequence", summary: "The economic consequence of a proposed change, as evidence for another engine's decision." },
]);

/**
 * The boundaries. Every one of these is a thing CostIQ could plausibly grow
 * into, which is exactly why each is written down with the request that would
 * cause it.
 */
export const COSTIQ_DOES_NOT_OWN: readonly ExcludedResponsibility[] = Object.freeze([
  {
    id: "profitability",
    summary: "Whether a product, customer or line of business is profitable overall.",
    ownedBy: "ProfitabilityIQ",
    arrivesAs: "CostIQ knows the cost and the price, so it could just subtract them.",
  },
  {
    id: "budget",
    summary: "Budgets, forecasts against budget, and budget variance.",
    ownedBy: "BudgetIQ",
    arrivesAs: "CostIQ already does variance, so budget variance is surely the same feature.",
  },
  {
    id: "ledger",
    summary: "General ledger, journal entries, inventory valuation postings, AP and AR.",
    ownedBy: "Finance IQ and the accounting systems it coordinates",
    arrivesAs: "The standard cost changed, so CostIQ should post the inventory revaluation.",
  },
  {
    id: "procurement.decision",
    summary: "Choosing a supplier, issuing a purchase order, or committing spend.",
    ownedBy: "Procurement / VendorIQ",
    arrivesAs: "CostIQ compared three suppliers, so it may as well pick the cheapest.",
  },
  {
    id: "pricing.commercial",
    summary: "Willingness to pay, elasticity, discount strategy and competitive positioning.",
    ownedBy: "A commercial pricing function",
    arrivesAs: "CostIQ computes a cost-plus price, so it could optimise the margin too.",
  },
  {
    id: "organizational.health",
    summary: "Whether the business as a whole is doing well.",
    ownedBy: "Prime and the constitutional plane",
    arrivesAs: "CostIQ can see costs rising everywhere, so it should raise the alarm globally.",
  },
  {
    id: "decision.authority",
    summary: "Authorising an action because the economics favour it.",
    ownedBy: "Governance; orchestrated by Prime / ARIA / DecisionIQ",
    arrivesAs: "The cheaper process is obviously better, so CostIQ should just switch to it.",
  },
  {
    id: "geometry.recognition",
    summary: "Deriving manufacturing features from CAD or images.",
    ownedBy: "ForgeIQ and VisionIQ",
    arrivesAs: "Should-cost needs features, so CostIQ should read the CAD file.",
  },
  {
    id: "inventory.truth",
    summary: "What stock exists, where it is, and what is reserved.",
    ownedBy: "InventoryIQ",
    arrivesAs: "CostIQ needs quantities on hand, so it may as well track them.",
  },
]);

/**
 * Public exports that would mean a boundary has been crossed.
 *
 * Matched case-insensitively as substrings against the package's export names.
 * Deliberately blunt: a name is a weak signal, but a name is what a reviewer
 * sees, and an engine that grows a `selectSupplier` function has crossed a
 * line whatever its internals do.
 */
export const FORBIDDEN_EXPORT_FRAGMENTS: readonly string[] = Object.freeze([
  "selectsupplier",
  "choosesupplier",
  "awardsupplier",
  "issuepurchaseorder",
  "createpurchaseorder",
  "postjournal",
  "journalentry",
  "generalledger",
  "accountspayable",
  "accountsreceivable",
  "revalueinventory",
  "budgetvariance",
  "setbudget",
  "profitability",
  "elasticity",
  "willingnesstopay",
  "optimiseprice",
  "optimizeprice",
  "organizationhealth",
  "organisationhealth",
  "approvedecision",
  "authorizespend",
  "authorisespend",
]);

/** The charter as one object, for evidence packages and manual entries. */
export const COSTIQ_CHARTER = Object.freeze({
  version: COSTIQ_CHARTER_VERSION,
  classification: COSTIQ_CLASSIFICATION,
  owns: COSTIQ_OWNS,
  doesNotOwn: COSTIQ_DOES_NOT_OWN,
  forbiddenExportFragments: FORBIDDEN_EXPORT_FRAGMENTS,
});
