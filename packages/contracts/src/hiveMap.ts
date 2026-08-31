// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { hiveComponentSchema, type HiveComponent } from "./hiveArchitecture.js";

// ─────────────────────────────────────────────────────────────────────────────
// The engine map, as data.
//
// Kept here rather than only in a markdown file for one reason: a document
// drifts and nothing notices. This is imported by tests, so a package that
// exists and is missing here — or is listed here as `existing` and is not —
// fails a build.
//
// STATUS IS THE LOAD-BEARING FIELD. Most of this tree is `planned` or
// `conceptual`, and saying so is the point. An architecture diagram where the
// built and the imagined look alike is a diagram that makes the system appear
// finished, and the first person to rely on it builds against nothing.
// ─────────────────────────────────────────────────────────────────────────────

const component = (input: unknown): HiveComponent => hiveComponentSchema.parse(input);

export const HIVE_MAP: readonly HiveComponent[] = [
  // ── Neural Fabric ──────────────────────────────────────────────────────────
  //
  // Placed as `platform` because the map's tiers are prime, core, specialized,
  // industry and platform, and this is none of the engine tiers. `platform` —
  // "shared infrastructure that is not an engine at all" — is the closest
  // existing vocabulary for a transport substrate, and choosing it is NOT a
  // constitutional placement: the V3 plan (§3) reserves that for a human
  // process, and the package's own charter classifies itself
  // PROPOSED_COORDINATION_PLANE, deliberately outside HiveClassification.
  //
  // `partial` rather than `existing`, and the gap says why. The alternative
  // was to leave it out of the map entirely, which this file's own test
  // rightly calls "a component nobody has placed in the hierarchy" — the exact
  // condition it exists to catch.
  component({
    id: "neural-fabric", name: "Neural Fabric", tier: "platform", status: "partial",
    packageName: "@proworks-hub/neural-fabric",
    responsibility:
      "The governed transport substrate: topology, lane semantics, routing candidates, delivery guarantees, flow control, " +
      "degraded modes and causal tracing. Two chambers — Nexus owns what paths are valid, Pulse owns what is happening on " +
      "them. Carries signals; owns no business meaning, no authority and no identity.",
    gap:
      "Two things. First, no transport provider is bound, so nothing here has moved a message — the package is a complete " +
      "contract and flow model with no I/O. Second, and more important, its constitutional placement is UNDECIDED: the V3 " +
      "plan declines to ratify a tenth Core, and `platform` here is the nearest existing tier rather than a decision. See " +
      "UNRESOLVED_CONSTITUTIONAL_QUESTIONS in the package charter, which also records the tension with the existing note " +
      "that the Information Fabric has no single classifiable component.",
  }),

  // ── Prime ──────────────────────────────────────────────────────────────────
  component({
    id: "prime", name: "Prime", tier: "prime", status: "existing",
    packageName: "@proworks-hub/prime",
    responsibility:
      "Establishes context, decides which domain answers, and coordinates work across Cores. Executes no domain logic. " +
      "One engine, two chambers: Nexus commands authorized progression, Pulse preserves authorized continuity. " +
      "The chambers are internal structure and are deliberately NOT registered here — registering one would make them " +
      "peers, and peers in this architecture communicate through events rather than imports.",
  }),

  // ── Platform ───────────────────────────────────────────────────────────────
  component({
    id: "contracts", name: "Contracts", tier: "platform", status: "existing",
    packageName: "@proworks-hub/contracts",
    responsibility: "The shared language: event envelope, tenancy, ownership, capabilities, context.",
  }),
  component({
    id: "platform-events", name: "Platform Events", tier: "platform", status: "existing",
    packageName: "@proworks-hub/platform-events",
    responsibility: "The bus. Publish, subscribe, resilient delivery.",
  }),
  component({
    id: "platform-runtime", name: "Platform Runtime", tier: "platform", status: "existing",
    packageName: "@proworks-hub/platform-runtime",
    responsibility: "Jobs, outbox, circuit breaking, observability ports.",
  }),
  component({
    id: "simulation-lab", name: "Hive Simulation Lab", tier: "platform", status: "existing",
    packageName: "@proworks-hub/simulation-lab",
    responsibility:
      "Synthetic organizations, deterministic traffic, fault injection and an adversary harness, judged by an oracle that returns INCONCLUSIVE when the intended fault did not actually occur. Depends on no engine, so it can be used to test any of them.",
  }),
  component({
    id: "core-kit", name: "Core Kit", tier: "platform", status: "existing",
    packageName: "@proworks-hub/core-kit",
    responsibility:
      "The machinery every Core coordinator shares: registry, routing, timeouts, failure isolation, partial answers. Knows no domain.",
  }),
  component({
    id: "control-plane", name: "Hive Control Plane", tier: "platform", status: "existing",
    packageName: "@proworks-hub/control-plane",
    responsibility:
      "Observes and administers the Hive. Owns no domain knowledge and is not required for any engine to run.",
  }),

  // ── Foundation Core ────────────────────────────────────────────────────────
  component({
    id: "foundation-core", name: "Foundation Core", tier: "core", core: "foundation", status: "partial",
    packageName: "@proworks-hub/foundation-core",
    responsibility: "The universal structural language: identity, canonical references, versions, relationships, health vocabulary.",
    gap: "Baseline. The identifier and reference TYPES live in @proworks-hub/contracts, not here, because the dependency law forbids a Specialized engine importing a Core — a structural language no engine may import is not universal. Foundation holds authority over what they mean. No persistence, no relationship store, no entity registry, no schema registry.",
  }),

  // ── Communication Core ─────────────────────────────────────────────────────
  component({
    id: "communication-core", name: "Communication Core", tier: "core", core: "communication", status: "partial",
    packageName: "@proworks-hub/communication-core",
    responsibility: "The universal language of exchange: message categories, delivery expectations, acknowledgement, expiry, correlation and communication provenance.",
    gap: "Vocabulary and coordinator only. It moves nothing — no queue, no outbox, no subscription store, no delivery loop — because the charter puts transport in EventIQ, NotificationIQ and IntegrationIQ, none of which are registered as specialists yet. So a delivery expectation can be described and an acknowledgement judged, but nothing in this installation acts on either. `exactly-once` is deliberately absent from the guarantee vocabulary rather than unimplemented.",
  }),

  component({
    id: "eventiq", name: "EventIQ", tier: "platform", status: "partial",
    packageName: "@proworks-hub/eventiq",
    responsibility: "SHARED_PLATFORM. The durable, governed asynchronous event backbone. Authoritative for event envelopes, delivery and subscription state, consumer offsets, replay state and dead-letter state — never for the business facts events carry.",
    gap: "In-memory: the log, offsets and dead letters do not survive a restart, so `durable` is the contract and not yet the implementation. No ordering guarantees by key, no compaction, no cross-region replication, no transformation adapters — all four are Optional Capabilities in the charter and none is built. Backpressure is observed and announced, never applied by dropping. Governance and Sentinel are ports a host binds.",
  }),

  // ── Knowledge Core ─────────────────────────────────────────────────────────
  component({
    id: "knowledge-core", name: "Knowledge Core", tier: "core", core: "knowledge", status: "planned",
    responsibility: "What the organization knows: documents, search, memory, relationships, provenance.",
  }),

  // ── Operations Core ────────────────────────────────────────────────────────
  component({
    id: "operations-core", name: "Operations Core", tier: "core", core: "operations", status: "partial",
    packageName: "@proworks-hub/operations-core",
    responsibility: "Work: workflows, work orders, scheduling, tasks, approvals, automation.",
    gap: "ProWorks serves /api/operations with normalize_order and create_work_order, the latter bound to WorkOrderIQ's intake use case so orders are validated and events emitted. Both run against in-memory stores, so created work orders and duplicate detection do not survive a restart. Tracking is not registered: it needs production and carrier sources this host has not wired, so locate_order is refused rather than answered emptily. Nothing claims schedule_work or route_work_order. Filing a channel order needs a customer identity this installation cannot resolve — the adapter derives a channel-scoped one and refuses when the channel sent no buyer, which a resolve_customer capability would replace.",
  }),
  component({
    id: "workorderiq", name: "WorkOrderIQ", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/workorderiq",
    responsibility: "Work-order lifecycle, routing, stations, change orders, event log.",
  }),
  component({
    id: "tracking", name: "Tracking", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/tracking",
    responsibility:
      "Where an order actually is, merged across production and carrier, narrowed per audience. A projection, not an engine.",
  }),
  component({
    id: "order-ingestion", name: "Order Ingestion", tier: "specialized", core: "operations", status: "existing",
    packageName: "@proworks-hub/order-ingestion",
    responsibility: "Normalizing external orders into one internal shape. A service, not an engine.",
  }),
  component({
    id: "schedulueriq", name: "SchedulerIQ", tier: "specialized", core: "operations", status: "conceptual",
    responsibility: "Deciding when work happens against capacity and dependencies.",
  }),

  // ── Finance Core ───────────────────────────────────────────────────────────
  component({
    id: "finance-core", name: "Finance Core", tier: "core", core: "finance", status: "partial",
    packageName: "@proworks-hub/finance-core",
    responsibility: "Monetary reasoning: cost, budget, price, quote, invoice, profitability.",
    gap: "ProWorks serves /api/finance including price_job, CostIQ's canonical pricing entry point. The client still calls CostIQ directly for interactive pricing and SHOULD: a pure microsecond function behind a margin slider must not become a network call. So the Core is not the only door, and an equivalence test holds both paths to the same answer field for field. What that guarantee does not cover is a NEW consumer binding some other CostIQ function — it constrains the bindings that exist, not the ones nobody has written yet.",
  }),
  component({
    id: "costiq", name: "CostIQ", tier: "specialized", core: "finance", status: "existing",
    packageName: "@proworks-hub/costiq",
    responsibility: "Cost calculation and cost intelligence. The only place money is computed.",
  }),
  component({
    id: "receiptiq", name: "ReceiptIQ", tier: "specialized", core: "finance", status: "existing",
    packageName: "@proworks-hub/receiptiq",
    responsibility: "Receipt ingestion, extraction, normalization and purchase evidence.",
  }),
  component({
    id: "budgetiq", name: "BudgetIQ", tier: "specialized", core: "finance", status: "conceptual",
    // Narrowed 2026-08-30 (DEC-025): the earlier string claimed allocation,
    // variance and forecasting — three domains whose charters (AllocationIQ,
    // VarianceIQ, ForecastIQ) are now ratified. BudgetIQ owns the authorized
    // plan and nothing else.
    responsibility: "The authorized plan: budget structures, versions, envelopes, consumption and budget-check semantics.",
  }),
  component({
    id: "ledgeriq", name: "LedgerIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/ledgeriq",
    // Charter ratified 2026-08-30 (charter.specialized.ledgeriq, DEC-025).
    // LOCK-1: the posting monopoly — the only component permitted to create,
    // amend or reverse a journal entry.
    responsibility: "The general ledger: chart of accounts, journal, periods, debit/credit integrity, parallel books, balances, trial balance.",
    gap: "Kernel through M3 scope: the 28-gate validation ladder, exact-decimal FX conversion with visible residue lines, intercompany generation, period state machine, balance fold, trial balance, roll-forward, export projection, reference in-memory store. NOT yet: platform-events publication (posting is authoritative in the store; no ledger.entry.posted is emitted), the auditiq immutability chain, explanation levels L0-L6 (the capability refuses honestly), materialized balance cache with watermark, reporting-currency amounts, batch posting, and any durable store — hosts must bind one. Finance Core does not yet route to it (PC-5 pending).",
  }),
  component({
    id: "spendiq", name: "SpendIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/spendiq",
    // Chartered 2026-08-30 by owner ruling DEC-026, which OVERRULES the
    // package's own "module, not engine" verdict; the conflict is recorded in
    // the decision register, and the blueprint's design rules bind unchanged.
    responsibility: "Spend analysis whose integrity core is the savings claim: an amount constructible only by derivation from a by-value baseline with a required basis, an assertion generated from the claim's own fields including what it does NOT assert, and cost-avoidance structurally unreconcilable. Consumes ReceiptIQ's price-variance and ProfitabilityIQ's concentration fold rather than reimplementing them (the package's duplication findings stand as obligations).",
    gap: "Pure kernel scope: deterministic first-match classification at asOf with supplier-unresolved as a named unclassified state (never bucketed by raw string), model proposals landing in lowEvidence and structurally unable to inflate attribution (no model MappingOrigin exists — injection-proven), human confirmation requiring a principal + Governance ref and recording the human, the three-bucket cube fold with reconciliation invariant R-1 refusing with the residual (mutation-proven), ranking with a first-class excluded set, the four-definition tail with tailDefinition REQUIRED (published spread 5%-40%; GD-TAIL set-membership non-substitutability tested), OC-1 maverick classification refusing on an unbound contract register (never zero — mutation-proven), the savings-claim core (basis-required by-value baselines, deriveSavings as the amount's only constructor via a branded type, generated two-half assertion statements, realisation null-not-zero, cost-avoidance unreconcilable by kind). NOT yet: taxonomy versioning, run persistence/fingerprints, OC-2/OC-3 (need contracted rates + channel obligations no port carries), consolidation opportunity candidates, ReceiptIQ/ProfitabilityIQ consumption wiring, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "forecastiq", name: "ForecastIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/forecastiq",
    // Ratified charter row exists (hash over ForecastIQ_Charter_V1_0.docx);
    // built under DEC-026 with the CHARTER-TEXT FLAG OPEN: the docx is absent
    // from disk, and a charter document must be developed (or the original
    // located), hash-verified, and reconciled against this kernel.
    responsibility: "Statistical forecasting where seasonal naive is the permanent benchmark: FVA and its verdict are required on every published forecast and allowed to be bad; intervals carry observed coverage that is null until measured; coherence is proven post-quantization; overrides retain and are scored against the forecast they replaced; detected bias is published, never auto-corrected. Seasonality is supplied, never silently inferred.",
    gap: "Pure kernel scope: the naive family (seasonal = THE benchmark, random-walk, exact-rational drift), insufficient_history typed refusals naming what IS servable, ADI/CV-squared intermittency gating with Croston/SBA where the bias correction is a required choice, per-horizon MASE over rolling origins with degenerate denominators yielding insufficient-history-to-judge (never an infinite MASE presented as informative — mutation-proven), MAPE reported-only with a definedness count, FVA with the four verdicts (worse-than-naive visible; selection falls back to seasonal naive ITSELF with the verdict shown — mutation-proven), single-split backtests refused, selectionContaminated flagged, tracking-signal bias findings with autoCorrectionApplied false (injection-proven), intervals with required basis and not-yet-measured coverage rendering (mutation-proven), bottom-up reconciliation over grouped structures with a required residual rule and I-COH proven post-quantization (internal check documented as a tripwire — equivalent mutant F8-M4), overrides refusing without the retained pre-override forecast and scored per author once actuals exist. NOT yet: ETS/ARIMA/Theta estimation, MinT reconciliation, conformal/simulated intervals, Box-Cox, driver-based projection with certainty propagation, ensembles, re-selection cadence, persistence/events. Finance Core does not yet route to it. **CHARTER FLAG (DEC-026): charter text absent; develop or locate, hash-verify, reconcile.**",
  }),
  component({
    id: "taxiq", name: "TaxIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/taxiq",
    // Charter ratified 2026-08-30 (charter.specialized.taxiq, DEC-025).
    responsibility: "Tax determination over versioned content: an unmapped item is undetermined (both defaults are wrong in opposite directions and both silent), nexus is a function of a window whose partial history establishes but never refutes, exemptions are per-jurisdiction with evidence or nothing, rounding is the jurisdiction's versioned method, and filed periods are adjusted forward — never rewritten.",
    gap: "Pure kernel scope: taxability with item_not_classified (no default in either direction — injection-proven), the nexus asymmetry (monotone a-fortiori obligation on partial data; below-threshold-incomplete is indeterminate NEVER no-obligation, mutation-proven; over-inclusive observed sets void the monotone basis; crossing-vs-collecting as separate dates), per-jurisdiction exemption with partial exemptions explicit, expiry against taxPointDate for replay stability, single-purchase consumption, and claimed-without-evidence blocking, per-jurisdiction RoundingMethod with recorded residual allocation and the G-11 tax-inclusive golden (79.20@19% preserving gross; apparent rate stated, never presented as the rate), immutable filing aggregates with PriorPeriodAdjustments (LOCK-3, mutation-proven), ordered stacking with declared tax-on-tax bases, withholding where not-substantiated is a positive determination naming the evidence gap. NOT yet: jurisdiction resolution/sourcing hierarchies (SSUTA hierarchy blocked on RQ-01), content versioning and the 30-day reliance window, holidays/tiers, filing calendar, determination persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "financialreportingiq", name: "FinancialReportingIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/financialreportingiq",
    // Charter ratified 2026-08-30 (charter.specialized.financialreportingiq, DEC-025).
    responsibility: "Financial statements whose indirect cash flow refuses on each of its four breakers rather than plugging; the cash reconciliation invariant is PROVEN, never constructed — the FX-on-cash line is a presented item, not a residual, and a failure returns the statement with the finding. A ratio is a versioned method with no house default.",
    gap: "Pure kernel scope: the indirect derivation with the four breakers as named refusals (NON_CASH_MOVEMENTS_UNAVAILABLE / RECLASSIFICATIONS_UNIDENTIFIED / COMBINATION_EFFECTS_UNAVAILABLE / TRANSLATION_EFFECTS_UNAVAILABLE — each mutation- or test-proven), combination consideration as one investing line net of cash acquired, the balance-delta derivation labelled inseparably (derivationBasis, assumptionLoad high) and refused for statutory/regulatory runs, INV-CASH proven from independently computed sides with the residual reported and no balancing line ever inserted (always-holds mutation killed), the debt-to-equity method registry with required methodId (4.304–7.177 on one firm) and zero-equity undefined. NOT yet: statement mapping/coverage, income statement and balance sheet structure runs, direct cash flow, M-CF-IND-2 (IFRS 18 starting point, blocked on RQ-1), comparatives/restatements, MPMs/non-GAAP, tagging, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "financialcontrolsiq", name: "FinancialControlsIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/financialcontrolsiq",
    // Charter ratified 2026-08-30 (charter.specialized.financialcontrolsiq, DEC-025).
    responsibility: "Internal controls where design and operating effectiveness are separate findings, an unattested population can never test effective, SoD clean is unconstructable, thresholds carry an evidenced basis or fail to load, deficiency candidates carry NO severity, and a noisy rule is flagged but never disabled by the engine (the sentinel-neutralization line).",
    gap: "Pure kernel scope: M-1 design vs M-2 operating as separate methods (unattested population → indeterminate, mutation-proven; unsubstantiated ITGC reliance and zero evidence each indeterminate), M-4 sampling with required drivers and no defaults (expected ≥ tolerable refuses; small populations test 100%), M-6 SoD with identity-port-unbound/mapping-incomplete indeterminate and no-conflicts-in-evaluated-scope as the strongest positive verdict, the closed Threshold basis union with no guessed and expired provisionals failing to load naming the owner (mutation-proven), M-5 exception detection refusing on missing facts (never an empty result), M-8 deficiency candidates with untested compensating controls as nothing and asserted-never-inferred indicators (severity absent — injection-proven), M-9 precision intervals absent below the adjudication minimum, M-10 three-count coverage with undesignated never folded, exception budgets that flag and never suppress or disable (mutation-proven). NOT yet: control catalog/COSO principle mapping (M-11), entity-level precision specs (M-3), observed duty collisions (M-7), continuous monitoring scheduling, fraud-risk vocabulary registries, evidence-chain freshness, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "billingiq", name: "BillingIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/billingiq",
    // Charter ratified 2026-08-30 (charter.specialized.billingiq, DEC-025).
    responsibility: "Invoice generation where the convention is never the engine's to pick: proration convention AND price basis required (GP-1: six defensible answers, 6.9% spread), tier mode required (68% apart on one table), a gapless number series where every value is accounted for, a tax gate that never softens to zero, corrections as instruments — never edits. Computes NO tax: it presents a determination.",
    gap: "Pure kernel scope: EN 16931 line net with zero-base-quantity refusal, document totals where roundingAmount never absorbs a discrepancy (refuse, never balance), GP-1 proration golden exact across all six conventions with per-line half-even rounding, T-GOLD-TIER1/TIER2 exact (graduated walks bands with one final boundary; zeroQuantityBehaviour required over flat first tiers), package ceil, usage ingest with required finite windows (duplicate-suppressed counted; unknown meter never rated; the twice-counted-after-window exposure recorded as KL-03), LOCK-3 late disposition (catch-up on the next open period, material amounts flagged for human review), gapless numbering with burn-on-failed-commit VoidedNumberRecords and attestation (allocate-on-draft rejected when gapless; unbound port refuses), correction selection (void refused when payment state unknowable — credit note offered; disposition required; refunds are PaymentsIQ REQUESTs), the three-refusal tax gate mutation-proven. NOT yet: billing cycles/anchors (M-11), numbering series-break records, rebill composition, run evaluation, PostingProposal emission (M-18), persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "collectionsiq", name: "CollectionsIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/collectionsiq",
    // Charter ratified 2026-08-30 (charter.specialized.collectionsiq, DEC-025).
    responsibility: "Collections that never dun a disputed amount (suppression scoped to the disputed portion), never impute a missing priority factor as zero, evaluate every dunning exit condition at every step, count unknown contact outcomes AGAINST the cap, refuse contact on an unknown timezone, cap computation at write-off candidacy, and report action-outcome association with causalClaim none and the confounders enumerated.",
    gap: "Pure kernel scope: partial-or-refused priority with dispute suppression and authority none, the five-outcome promise model with void reasons and a keep-rate that is a COMPOSITION (barePercentage: null in the type), the dunning evaluator with E-1..E-4 at every step (each mutation-proven to zero the steps; cease terminal; exhausted lands on a human worklist), fail-closed escalation (Governance required for external consequence; models never move rungs), Reg-F-shaped frequency caps with outcome-unknown counting (H-6) and the post-conversation window started by either direction's conversation, quiet hours on the contacted party's clock with refused-unknown-locale, write-off candidacy with enumerated bases and collectabilityJudgement none, association with the five confounders named and causal claims only from pre-registered experiment designs. NOT yet: case intake/reason-code registries, worklist runs/fingerprints, sequence journals, contact-permission store, banned-phrase explanation assertion, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "creditiq", name: "CreditIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/creditiq",
    // Charter ratified 2026-08-30 (charter.specialized.creditiq, DEC-025).
    responsibility: "Credit exposure as a known floor under a per-class E1..E7 coverage manifest; the limit-test asymmetry (breach assertible on partial evidence, compliance never); mitigants that reduce only when their conditions are evaluable and satisfied; adverse action as a hard gate — regime required, reasons only from decompositions that reconcile exactly.",
    gap: "Pure kernel scope: exposure composition with all seven classes tracked and knownFloorMinor as the ONLY total (no exposure field exists — G-10 injection-proven), mitigant admissibility with indeterminate-does-not-reduce, the coverage-semantics limit test (exceeded on partial floors; within-limit only determinate; no within event exists — injection-proven; DefinedRatio utilisation with hold criteria going indeterminate never not-met), limit derivation (absent evidence yields no proposal; unresolvable overlap refuses; ceilings recorded as counteroffer reasons; expiresAt needs temporaryReason), behaviour caveats as computation (prepaid history evidences nothing; unbound dispute flag = labelled unadjusted figure), the adverse-action gate (regime required with no default; out-of-scope needs a human's written basis; trade credit owes reasons; selectMethod refuses reasonBasis none; deriveReasons refuses non-reconciling decompositions; FCRA four-factor cap with inquiries exempt), FCRA permissible-purpose matching. NOT yet: scoring method families, review scheduling, hold evaluation beyond the utilisation criterion, terms recommendation, fairness evaluation (§16.9), SR 11-7 model-risk machinery, GDPR Art. 22 intervention flow, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "expenseiq", name: "ExpenseIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/expenseiq",
    // Charter ratified 2026-08-30 (charter.specialized.expenseiq, DEC-025).
    responsibility: "Expense policy as versioned data over a closed rule vocabulary — the kernel knows threshold, effectiveFrom, jurisdiction and citation, and no US-specific identifier (the multi-jurisdiction proof). Per-diem/mileage entitlements from SUPPLIED rate tables (LOCK-4: fetches nothing). Personal-charge candidates carry reply paths, never verdicts.",
    gap: "Pure kernel scope: registration-time rule validation (bad rules never evaluate), TOTAL evaluation with no short-circuit and no accumulator access, missing-required-input → undeterminable (never pass) with undeterminable OUTRANKING blocking, fails citing their policy documents by value, order-insensitive verdict class, reimbursable amount ABSENT (not zero) over blocking/undeterminable with the capping rule recorded, per-diem with the partial-day factor on M&IE only and no guessed meal deductions (300% ceiling is a failing rule, not a clamp), mileage mid-year rate splits + cumulative tiers requiring the year-to-date snapshot (zero is not a default), ordinal R1-R4 card matching (never a float score; R4 always ambiguous; amount alone never matches), PersonalChargeCandidate with resolution paths and no verdict field (the word fraud appears nowhere — G-11b injection-proven), coding with a no-mapping refusal and no suspense default. NOT yet: aggregate-ceiling/frequency windows, accountable-plan clocks, evidence-adequacy rules, advances, approval workflow, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "invoiceiq", name: "InvoiceIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/invoiceiq",
    // Charter ratified 2026-08-30 (charter.specialized.invoiceiq, DEC-025).
    responsibility: "Invoice capture and PO matching where the TYPE carries the honesty rule: a two-way result has no goods-receipt field to read; a skipped check can never produce matched; four-way is declared and refused so three-way is visibly not the top rung. Duplicate detection computes at most review-required — a human confirms. InvoiceIQ never approves; it records that someone with authority did.",
    gap: "Pure kernel scope: the MatchResult discriminated union (two-way structurally lacks the goods-receipt leg; three-way requires it and cannot be degraded), verdictFrom with checksNotEvaluated → indeterminate as the FIRST branch (mutation-proven), required onInsufficientLegs with authorized degradation labelled at the result, EN 16931 totals reconciliation as review exceptions (conformant input raises nothing; matched anyway — arithmetic error ≠ over-billing), tolerance schemes refusing unconfigured dimensions as infinite with required combination (D-6) and explicit direction, the seven-signal duplicate model with S6 → supersession-candidate (never a duplicate), computed dispositions capped at review-required (G-9: confirmed-duplicate only via recordDuplicateDecision with a human principal + Governance ref — injection-proven), supersession resetting approval to pending with prior results stale-valid, approval readiness computed with human-only decisions. NOT yet: scheme precedence resolution (C-1), duplicate suppression persistence, AI candidate ordering, coding rule sets, remittance handling, PayablesIQ assertion handoff, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "liquidityiq", name: "LiquidityIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/liquidityiq",
    // Charter ratified 2026-08-30 (charter.specialized.liquidityiq, DEC-025).
    responsibility: "Cash positions and direct forecasts under the coverage lattice: only a complete bucket carries a closing balance, partiality propagates forward and never recovers, and a notional pool offset is a view, never a balance. Consumes TimingProfiles as labelled assumptions; never estimates one (that is ForecastIQ's).",
    gap: "Pure kernel scope: the three-variant ForecastBucket union (partial has no closing balance; insufficient has no numbers), forward-propagating lattice min, working-capital metrics with every variant axis REQUIRED and CCC refusing mixed bases, buffer evaluation typed to the balance cell (cell mismatch refuses; days-of-outflow over a partial window is undeterminable), funding gap with the two-threshold split and gapConfidence, exact-match-only in-flight dedup with the error DIRECTION stated when the port is unbound, PooledView with right-of-set-off status (multi-currency refuses without a rate set), whole-or-refused FX consolidation naming missing pairs. NOT yet: M-VAL-DATE re-dating with roll conventions, staleness evaluation, bucket profiles as versioned data (daily-28/weekly-13/monthly-18/mixed), physical pool sweep commitments, M-INTRADAY (BCBS 248 adaptation), restriction application, ports/store/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "paymentsiq", name: "PaymentsIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/paymentsiq",
    // Charter ratified 2026-08-30 (charter.specialized.paymentsiq, DEC-025).
    responsibility: "Payment instruction lifecycle: composite duplicate fingerprints, the never-re-pay-an-unknown-fate rule, neutral scheme-status mapping, deterministic risk classification, settlement reconciliation, run composition as a RECOMMEND. Payment release authority is human; the proposal type has no release().",
    gap: "Pure kernel scope: PAY-FINGERPRINT composite key with versioned payee-name normalization (no transliteration), PAY-DUPLICATION (indeterminate-state match = suspected-blocking with NO override; terminal-failed = suspected-recoverable; near matches name the differing field), PAY-STATUS-MAP with unmapped-scheme-status → review-required (code sets change quarterly; the table is tenant-supplied versioned data), PAY-RISK-CLASS ladder with recorded escalation basis and NO default amount band, PAY-SETTLE-RECON tri-state with the residual decomposition, PAY-RUN-COMPOSE deterministic grouping/netting with a composition fingerprint. NOT yet: rail semantics reference data, return-window calendar arithmetic, remittance reassociation, authorization freshness windows, screening integration, state machine persistence/events, PSD2/scheme adapters. Finance Core does not yet route to it.",
  }),
  component({
    id: "debtiq", name: "DebtIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/debtiq",
    // Charter ratified 2026-08-30 (charter.specialized.debtiq, DEC-025).
    responsibility: "Debt instruments: day-count conventions, EIR and amortized cost on exact decimals, schedules with a contractual plug, the IFRS 9 modification 10% test, covenants as attested per-agreement definitions (NO built-in ratios — a covenant is contract text). US GAAP modification methods are standard-unverified and blocked from authoritative results.",
    gap: "Pure kernel scope: six day-count conventions + ACT/ACT-ICMA with schedule required (P-2 additivity proven; 30E/360-ISDA ordered rules), EIR by deterministic bisection with eir-no-sign-change/eir-not-converged refusals (GOLD-EIR-01: 6.60326388% exact), unrounded-carry amortized cost with the terminal residual as a reported plug, GOLD-AMORT-01 level payment (94,929.92; final absorbs −0.08) with plugPolicy REQUIRED, GOLD-MOD-01 10% test with fee payee REQUIRED and third-party fees structurally excluded (G-11), covenant AST (Div → DefinedRatio, zero denominator = untestable; templates untestable G-10; undeclared terms fail validation), prepayment order required, caller-declared ladder buckets. NOT yet: floating-rate methods (five SOFR conventions, floors, spread), commitment/ticking fees, fee EIR-integral classification, covenant version resolver by test date, US GAAP arm (standard-unverified), schedules persistence, PostingProposal emission, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "investmentiq", name: "InvestmentIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/investmentiq",
    // Charter ratified 2026-08-30 (charter.specialized.investmentiq, DEC-025).
    responsibility: "Investment positions, convention-true yields, and the six ternary policy limit tests where indeterminate NEVER rounds down to compliant. Cash-equivalent candidacy reports facts and never asserts the accounting conclusion. IFRS and US GAAP classifications are carried independently — no equivalentCategory mapping may ever be added.",
    gap: "Pure kernel scope: day-count-required accrual (12,500.00 vs 12,328.77 golden), effective-interest amortization to par with the final-period residual declared, the yield convention family (discount-on-face always lowest; MMY/BEY/EAY on price), YTM by bisection returning indeterminate on non-convergence with all three assumptions recorded, the normative policy aggregation (breached > indeterminate > compliant), M-POL-2 rating floor (absent/stale/conflicting-no-tiebreak each indeterminate), M-POL-4 concentration (percent-of-market-value indeterminate TODAY with the policy resolution path named), disposal with required method over the declared (settlementDate, lotId) order, unrealized gated on evidenced fair value, M-CE-1 candidacy facts with assertion none. NOT yet: clean/dirty price reconciliation, YTW over option schedules, straight-line election, 7-day-yield intake, time/money-weighted returns, MMF mechanics, ladders/rollover, dual-standard classification model, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "financialriskiq", name: "FinancialRiskIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/financialriskiq",
    // Charter ratified 2026-08-30 (charter.specialized.financialriskiq, DEC-025).
    responsibility: "Exposure aggregation under an honest coverage manifest: an aggregate over incomplete positions is not a smaller exposure but an unknown one. Coverage is named sources, never a percentage. Leads with exact sensitivities and named stress; VaR is gated and can never be aggregated (not subadditive).",
    gap: "Pure kernel scope: the coverage manifest with the unknown/incomplete distinction (required-source-missing = unknown; partial answers and stale answers are unreachable, never contributed), partial aggregates carrying contributedExposureMinor and never exposure, the one-sided determinacy rule (monotone limits provable breached on partial data, never within-limit; undeclared monotonicity = indeterminate always; LIM-1 deficiency required; LIM-2/LIM-3 as data), FX-1 (transaction/translation never summed; cross-entity netting needs declaration; economic exposure refuses and emits the assumption set for ScenarioIQ), DV01 with the approximation block and shock-validity refusal, CP-1 settlement exposure gross always, gated historical VaR (complete coverage + named digest-identified scenario set + populated limitations), parametric refused without a documented distribution, VAR-AGG-1 (branded type; combineVar refuses), ES-AGG-1 digest equality, IFRS 7.41 disclosure conditional on the explanation, STRESS-1 contributedStressLoss over partial coverage. NOT yet: netting legal bar (§16.5), counterparty current exposure/PFE gating, hedge relationship enforcement (§16.7), concentration (§16.8), repricing gap/effective duration, stress scenario immutable store, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "budgetiq", name: "BudgetIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/budgetiq",
    // Charter ratified 2026-08-30 (charter.specialized.budgetiq, DEC-025).
    responsibility: "Budget envelopes with encumbrance accounting: released (never authorized) as the consumable base, availability that is NULLABLE in the type so an unknown channel can never read as zero, the commitment lifecycle, exact-sum allocation and phasing, transfers and carry-forward as approvable derivations — never edits.",
    gap: "Pure kernel scope: the availability equation with completeness rules (unavailable channel means NO number; a partial addition channel voids even the upper bound — sharper than the blueprint's rule 2 and stated in source), over-liquidation recorded beside the commitment with a flag and never absorbed, release restoring exactly the outstanding, carry-forward under a REQUIRED three-policy MethodRef producing lineage-carrying successors, largest-remainder allocation with I-3/I-5 exact sums, seasonal phasing only with a SUPPLIED index (deriving one is ForecastIQ's), transfer derivations with the cross-parent policy as a parameter. NOT yet: versions/approval workflow, the BudgetStorePort and events, availability-check API over live ports, L0-L6 explainers, multi-currency envelopes (blocked on TD-04). Finance Core does not yet route to it.",
  }),
  component({
    id: "scenarioiq", name: "ScenarioIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/scenarioiq",
    // Charter ratified 2026-08-30 (charter.specialized.scenarioiq, DEC-025).
    responsibility: "What-if composition over ReplayableMethods injected by the host (the contracts seam, E-SC-2): overlays on sealed frames, replay probing, sensitivity, breakpoints, stress paths. Owns the COMPOSITION and none of the arithmetic; a scenario over a method it cannot re-run is not produced.",
    gap: "Pure kernel scope: overlay application (unread path/conflict/type-and-currency mismatch refusals, maskOut to a named UnknownReason — no zero for a missing value exists), the 2-run replay probe with the seedRequired third-run check and determinismBasis recorded (a probe, not a proof), the full §16.6 bad-method table as named refusals (message only on throw, never the stack), OAT with interactionsCaptured false as a required literal, breakpoint bisection with required driver-unit tolerance and the output-resolution guard, N-way comparability refusal, complete-or-refused stress paths (severity is a label, no probability field), reverse stress that never claims no path exists, the Sobol independence gate, sequential-cumulative and Shapley-symmetric delta attribution. NOT yet: Morris and Sobol ESTIMATORS (only the independence gate ships), Monte Carlo, scenario definitions/runs persistence, DAG orchestration, freshness against moved baselines, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "varianceiq", name: "VarianceIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/varianceiq",
    // Charter ratified 2026-08-30 (charter.specialized.varianceiq, DEC-025).
    responsibility: "Exact variance decomposition where the joint term is never silently assigned: six registered conventions, NONE a default (SR-04 stays open — Steven names a house convention or it stays required forever), sensitivity bands across conventions, materiality that classifies and never filters, narrative skeletons whose caveats cannot be dropped.",
    gap: "Pure kernel scope: the multiplicative factor lattice with exact-rational arithmetic (I-1 reconciles with zero tolerance; the residual is never absorbed — the reconcile check is a tripwire, refusing rather than returning wrong), laspeyres/paasche/joint-explicit/bennet at n=2 (bennet equals shapley there and diverges at 3 — stated, and n>=3 routes to shapley), shapley to n<=6, sequential with a REQUIRED declared order, exact-sum presentation rounding AFTER reconciliation, convention sensitivity with attributionUnstable, relative variance with a required denominator (null at zero), materiality (no policy means unclassifiable — no house threshold; asymmetry requires BOTH thresholds; statistical below sampleMinimum stays unclassifiable, never falls back; below-threshold accumulation flagged), FX attributability (missing rate ref is a NAMED residual, never zero; transaction and translation never netted), the MixBasis gate (all four fields required; mix sets additiveAcrossLevels false), the deterministic narrative skeleton with convention-named ALWAYS present. NOT yet: mix/timing/market factor computation, overhead two/three/four-way forms, planning-operational split, roll-up, driver attribution links, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "allocationiq", name: "AllocationIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/allocationiq",
    // Charter ratified 2026-08-30 (charter.specialized.allocationiq, DEC-025).
    responsibility: "Cost pools, drivers, direct/step-down/reciprocal allocation, versioned runs. DERIVES the rate; CostIQ applies it — the rate crosses as a versioned contract value, never a function call.",
    gap: "Pure kernel scope: largest-remainder distribution (floor toward minus infinity — one rule for credits and debits, no sign branch; recorded ref tie-breaks; the reconciliation identity typed as literal true), reciprocal solve on EXACT RATIONALS with deterministic pivoting (never inversion, never iteration to a tolerance), structural closed-SCC singularity detection with exact leakage (refusal names every member), self-service renormalization, the circulation-ratio model-sanity guard, deterministic step-down ordering. NOT yet: rate derivation/practical capacity/death spiral, ABC and TDABC, joint products, dual-rate, run orchestration/persistence/events, PostingProposal emission. Finance Core does not yet route to it.",
  }),
  component({
    id: "profitabilityiq", name: "ProfitabilityIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/profitabilityiq",
    // Charter ratified 2026-08-30 (charter.specialized.profitabilityiq, DEC-025).
    responsibility: "Profit and margin by dimension with an unknown-propagation algebra: a hole in the cost basis is a NAMED hole, never a zero. Never recomputes a cost; never substitutes its own when CostIQ's is unavailable — it returns unknown for that dimension.",
    gap: "Pure kernel scope: the Amount algebra (known/unknown propagating to partial-with-floor-and-holes), four NAMED margin definitions differing on the same facts, the IncompletePolicy (refuse, or partial-with-coverage — the only two honest answers over a hole), ranking with a first-class EXCLUDED set (a partial never ranks), the whale curve, reconciliation to a supplied entity total with the gap NAMED and never spread. NOT yet: the sparse dimensional model and roll-up fold (M-1/M-2), tier ladders (M-4/M-5), member retirement and realignment bridges (M-11..M-13), persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "projectfinanceiq", name: "ProjectFinanceIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/projectfinanceiq",
    // Charter ratified 2026-08-30 (charter.specialized.projectfinanceiq, DEC-025).
    responsibility: "The project as a financial object: EAC/ETC/burn, earned-value measures, immutable baselines. NEVER recognises revenue — percentage-of-completion revenue is RevenueRecognitionIQ's judgement even though the input measure comes from here.",
    gap: "Pure kernel scope: the three EAC formulas as a REQUIRED argument (K-2 golden reproduced exactly: 1,100,000 / 1,250,000 / 1,437,500 — 33.75% of BAC), CPI/SPI with defined-ness traps honoured (zero AC means UNDEFINED, not infinity and not zero), method-circularity detection (cost-incurred progress with a CPI-based EAC can never signal an overrun — refused), immutable authorized baseline versions. NOT yet: commitments, progress-measurement reliability grading, burn tracking, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "revenuerecognitioniq", name: "RevenueRecognitionIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/revenuerecognitioniq",
    // Charter ratified 2026-08-30 (charter.specialized.revenuerecognitioniq, DEC-025).
    responsibility: "Performance obligations, transaction price with the variable-consideration constraint, standalone selling prices with a gated residual approach, exact relative-SSP allocation, over-time vs point-in-time. BILLING IS NOT REVENUE (BillingIQ); cash is not revenue (ReceivablesIQ); the journal is LedgerIQ's. Owns the unbilled unconditional right (B-4, ratified).",
    gap: "Pure kernel scope: M-1 contract identification (five evidenced criteria, collectibility once at inception — the only credit entry point), M-4/M-5 variable estimation with the method as the ENTITY'S selection, M-6 the constraint ladder (any absent factor finding refuses — the most consequential refusal in the engine), the IP-licence-gated royalty exception, M-7 observable SSP with a corridor that refuses rather than widening, M-10 the gated residual (implausible results refuse), M-11 exact order-independent monotone allocation, M-12/M-13 recorded fallbacks, M-14 satisfaction with NO default to ratable, M-15/M-17 cost-to-cost with uninstalled materials at zero margin, over-time recognition with cumulative catch-up. NOT yet: schedules/versioning persistence, modification accounting, contract combination and netting scope, series-provision mechanics, material rights, financing component, disclosures, events. Finance Core does not yet route to it.",
  }),
  component({
    id: "leasefinanceiq", name: "LeaseFinanceIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/leasefinanceiq",
    // Charter ratified 2026-08-30 (charter.specialized.leasefinanceiq, DEC-025).
    responsibility: "Lease classification, discount-rate selection, the lease liability and ROU asset with their unwinding. A right-of-use asset is AMORTIZED end to end here, driven by the lease term — owned-asset schedules are AssetFinanceIQ's, and neither reaches into the other.",
    gap: "Pure kernel scope: ASC 842 lessee classification with the determinacy asymmetry (any met = finance; all not-met = operating; indeterminate REFUSES naming criteria — never defaulted toward operating, the direction a preparer benefits from), policy-owned thresholds (75/90 is policy, not law), discount-rate ladder with the by-class risk-free election (LFIQ-K-1: 13.35% of the liability, invisible in operating expense) and required compounding convention (LFIQ-K-2: 0.961% of the entire liability), exact PV at a 12-decimal captured rate reproducing the G-23 goldens to the cent, amortization schedules with R6 final-absorbs / R7 cumulative-target (IDC-bearing totals) / R8 unrounded plug and exact terminal invariants. NOT yet: IFRS 16 model, lessor classification, remeasurement/modification, sublease, ROU impairment (B-7), payment composition, persistence/events. Finance Core does not yet route to it.",
  }),
  component({
    id: "assetfinanceiq", name: "AssetFinanceIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/assetfinanceiq",
    // Charter ratified 2026-08-30 (charter.specialized.assetfinanceiq, DEC-025).
    responsibility: "The financial representation of fixed assets: capitalization policy (three-valued, never silently expensing), depreciation as cumulative functions over method epochs, MACRS with a population-scoped mid-quarter determination, framework-bound impairment, disposal. NEVER the physical asset (AssetIQ, unbuilt) and never the journal (LedgerIQ).",
    gap: "Pure kernel scope: cumulative-function schedules with ONE rounding boundary (Σ charges == base exactly, 480-period building tested — the CostIQ round-per-line drift corrected), straight-line/SYD/declining-balance-with-recorded-SL-switch, MACRS 5-year tables with the G-21 mid-quarter cliff (testBasisConvention REQUIRED, the alternative reading's ratio named on the determination, indeterminate never defaults to half-year), MethodEpochs (history immutable; unauthorized/overlapping epochs refuse), s481(a) catch-up only for tax-framework method revisions, impairment with supplied recoverable amounts and US-GAAP reversal prohibition as a framework rule, disposal outcome, proposal idempotency. NOT yet: units-of-production (UsageMeterPort unbound - refuses), revaluation model, CGU allocation, component derecognition, ARO (unowned, B-1), full multi-year MACRS beyond year-1 goldens, persistence/events. report_asset_tax_basis refuses honestly - its consumer is unowned (B-17). Finance Core does not yet route to it.",
  }),
  component({
    id: "consolidationiq", name: "ConsolidationIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/consolidationiq",
    // Charter ratified 2026-08-30 (charter.specialized.consolidationiq, DEC-025).
    responsibility: "Group structure and integrated ownership (exact rationals), consolidation method as recommendation-plus-assessment, functional-to-presentation translation, CTA as a sum of causes with an independent proof, intercompany match and full elimination, goodwill, NCI. NEVER alters an entity's posted ledger to make a group number work.",
    gap: "Pure kernel scope: M-1 ownership solve (path-sum acyclic, exact-rational linear solve for cross-holdings, singular refusal), M-2 method determination refusing thresholds where an assessment is needed, M-3/M-4 translation with a REQUIRED averaging convention (K-17, spread 1.67%) and the CTA proof, M-6/M-7 match/elimination (tolerance suppresses exceptions never numbers; full elimination regardless of percentage), M-10 goodwill with bargain-purchase refusal, M-11/M-12 NCI (election immutable; NCI may go negative; parent takes the rounding residual), M-13 equity pickup lowest-tier-first with tracked unrecognised losses, M-17 idempotency. NOT yet: M-5 hyperinflation, M-8 FX residual decomposition, M-9 unrealised profit, M-14/15/16 ownership changes, run orchestration/persistence/events, submissions model. Finance Core does not yet route to it.",
  }),
  component({
    id: "closeiq", name: "CloseIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/closeiq",
    // Charter ratified 2026-08-30 (charter.specialized.closeiq, DEC-025).
    // SR-2 resolved per CloseIQ's own offer: it concedes `close_period` and
    // claims assess_close_readiness + request_period_close; LedgerIQ holds the
    // period STATE via close_ledger_period. Nobody claims bare close_period.
    responsibility: "The period-close PROCESS: evidence-gated checklist DAG, reconciliation vs substantiation vs certification (three facts, never conflated), readiness with an undeterminable verdict, waivers that never read as done, human sign-off. LedgerIQ owns the period state; CloseIQ's rung there is REQUEST.",
    gap: "Kernel scope: template validation refused at load (cycles, unreachable tasks, orphaned evidence kinds), the completed-task discriminated union (no evidence, no completion — by type), M-1 satisfaction with LOCK-2-as-arithmetic and control-evidence acyclicity, M-2 readiness (7 gates, undeterminable beats not-ready, percentComplete absent when unknown), M-3 reconciliation with unsubstantiated-unknown and rounding-indeterminate, M-4 candidates certified only under version-bound grants, M-6 cutoff with the grace window read and recorded, M-7 authorization ladder (human-only, no replay, no self-authorization), adjustment state machine with the held-state exit. NOT yet: persistence ports (state is in-memory per instance), event pub/sub, exception workflow (list_close_exceptions refuses honestly), critical-path computation, L0-L6, M-5 risk-tier recommendation. Finance Core does not yet route to it.",
  }),
  component({
    id: "receivablesiq", name: "ReceivablesIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/receivablesiq",
    // Charter ratified 2026-08-30 (charter.specialized.receivablesiq, DEC-025).
    responsibility: "The customer receivable record: open items, cash application, aging, customer balances, payment behaviour as FACT. Never credit decisions (CreditIQ), collections (CollectionsIQ), invoicing (BillingIQ) or the journal (LedgerIQ).",
    gap: "Kernel scope: append-only fact journal with replay-derived projections (I-1/I-2), the M-4 matching cascade (unique-or-refuse, bounded subset-sum, policy-ordered only when authorized), largest-remainder component allocation with the R2 tripwire, earned/unearned discount, short-pay classification with refer-not-coerce, partial-vs-residual strategy, realized FX gain/loss (rate by value; port unbound refuses), R-1-asserted aging with terms-unknown and separate credits, DSO/countback/CEI with required inputs, three-way unidentified/identified/on-account cash distinction, lockbox duplicate rule. NOT yet: M-12 allowance (draft — capability refuses honestly), M-9 netting evidence, M-10 derecognition inputs, event pub/sub wiring, dependency index, export. Finance Core does not yet route to it.",
  }),
  component({
    id: "payablesiq", name: "PayablesIQ", tier: "specialized", core: "finance", status: "partial",
    packageName: "@proworks-hub/payablesiq",
    // Charter ratified 2026-08-30 (charter.specialized.payablesiq, DEC-025).
    responsibility: "The vendor liability record: open items, terms and due dates, discounts, aging, vendor balances. What we ACTUALLY owe — never the invoice (InvoiceIQ), the payment (PaymentsIQ), or the journal (LedgerIQ).",
    gap: "Kernel scope: terms resolution with no fallback chain, four due-date rule kinds with February clamping, installment splitting with last-absorbs-residual, the three yield methods (required argument, no default — K-1), aging with registration-validated schemes and a terms-unknown bucket, per-currency vendor balance partition, settlement with derived-and-verified openAmount, deterministic PostingProposals, fingerprint dedup, tenant-scoped in-memory repositories. NOT yet: event publication/subscription (freshness map unwired), the dependency reverse index, PayablesExportV1, FX revaluation (ExchangeRatePort unbound: refuses), L2-L6 explanation, AI waves, disputes (B-3 gated on a platform case-kit that does not exist — disputed-hold deliberately absent). Finance Core does not yet route to it.",
  }),

  // ── Shared Platform engines ────────────────────────────────────────────────
  component({
    id: "auditiq", name: "AuditIQ", tier: "platform", status: "partial",
    packageName: "@proworks-hub/auditiq",
    responsibility: "SHARED_PLATFORM. Tamper-evident evidence of consequential activity. Owns evidence and its chain; owns no adjudication.",
    gap: "Baseline: append-only in-memory store with a SHA-256 hash chain, query, and verification. No durable storage, no retention or lawful-erasure path, no export-under-authority, no independent replication. Tamper-EVIDENT only — it cannot prevent a change to an underlying store, only make one visible.",
  }),

  // ── Constitutional plane ───────────────────────────────────────────────────
  // These have NO capability tier (ADR-003, approved §23.3). The map is
  // tier-based, so `platform` is recorded as the least-wrong placeholder and the
  // responsibility text says what they actually are. The authoritative
  // classification lives in charters/registry.json, not here.
  component({
    id: "governance-engine", name: "Governance Engine", tier: "platform", status: "partial",
    packageName: "@proworks-hub/governance-engine",
    responsibility: "CONSTITUTIONAL_GOVERNANCE. Determines whether consequential activity is permitted. Owns authorization decisions only.",
    gap: "Baseline evaluator: grants, Core Protections, purpose and risk matching, expiry. No delegation state, no data-use authorization, no human-approval routing, no PolicyIQ integration, no override mechanism. Charter §6 data governance and §13 external development authorization are unimplemented.",
  }),

  component({
    id: "sentineliq", name: "Sentinel IQ", tier: "platform", status: "partial",
    packageName: "@proworks-hub/sentineliq",
    responsibility: "CONSTITUTIONAL_SENTINEL. Verifies that the Hive is behaving the way it is authorized to behave. Owns its own findings, threat classifications and protective state — no business truth, no policy, no repair.",
    gap: "V1 constitutional kernel (findings, dispositions, the §6/§7 defensive ladder, fabric detectors) plus the V2 Shield+Guard architecture built under DEC-027 (Sentinel_World_Class_Security_Architecture_V2, sha256 60d7ddb1…): chamber cross-coverage with authority never assumed and evidence-gated restoration; five security condition levels where tightening is pre-approved and RELAXING always needs Governance; the 8-rung operational action ladder with least-destructive selection and bounded (TTL-or-rollback) containment records that Sentinel requests and never executes; containment succeeding even when event publication fails; the 10-step immune protocol with Guard-independent verification and forensic-preservation-before-destructive-cleanup; the deny-by-default handshake gate where a null check denies exactly like false; Guard modules (trust freshness fails closed on expiry, integrity tamper evidence, policy drift detection with remediation pointed at PolicyIQ/Governance, role-separated supply-chain thresholds with deployment authority not-sentinel); Shield modules (ATT&CK-tagged findings with authority none, fusion that never confirms by volume, §21.4 AI defense — no identity no capability, prompt injection structurally inert against control metadata, AI recommendations never executable, behavior envelopes, deception assets that never carry real data); operator protection (the last recovery authority is irremovable — the operation does not exist; recovery-authority quarantine downgrades to session pause; break-glass on separate credentials); the §21.8 upgrade chain with §21.9 Bootstrap Governance (bootstrap satisfies quorum only in the recorded state, marked for review; exit criteria; re-entry is break-glass + constitutional record); telemetry secret-screening that refuses rather than redacts; the Collective gate (raw incident content never promotable); the §16 scorecard where unevidenced dimensions never score. The 21 specialist candidates are MODULES pending individual chartering (DEC-027 point 2). STILL NOT: live sensors/monitors (detection functions evaluate supplied observations), protective-state enforcement at call sites, host security provider adapters (§9), the Security Digital Twin/ATT&CK scenario corpus (§15), condition-level wiring into Fabric routing, persistence/events. Deliberately takes no Governance dependency (§8, §15).",
  }),

  component({
    id: "aria", name: "ARIA", tier: "platform", status: "partial",
    packageName: "@proworks-hub/aria",
    responsibility: "CONSTITUTIONAL_INTELLIGENCE. Advises across the Hive and authorizes nothing. Reads observations a host hands it — Governance decisions, Sentinel findings, Foundry promotions — and returns something a reader can disregard. No authorize, permit, decide or execute on its surface.",
    gap: "The advisory SHAPE is built and enforced: no authorization surface, advice that must cite observations, a required uncertainty statement below well-supported, and an abstention that is a real answer rather than an absence. What it does not have is any actual reasoning — confidence is a count of observations, and the suggestion restates what it was given. That is deliberate for now: an advisor whose judgement is unearned is worse than one that abstains, and the shape had to be right before the content could be trusted. Nothing subscribes ARIA to the streams either; a host must hand it observations, which is the same state Sentinel was in before this week.",
  }),

  component({
    id: "repair-learning", name: "Foundry Repair Learning", tier: "platform", status: "partial",
    packageName: "@proworks-hub/repair-learning",
    responsibility: "A SUBSYSTEM OF FOUNDRY, not an engine. Turns failures into evidence, diagnoses, validated repair candidates and generalized lessons. Holds no constitutional authority of its own and has no charter, deliberately — Foundry's charter governs it.",
    gap: "All six phases exist as a loop and all five golden tests pass, including the mandatory one. What is NOT here: no RepairBot authors a candidate (the model exists, the author does not); no DriftBot, no scenario generation from real incidents, no ARIA integration, no AuditIQ or EventIQ wiring. Only five of the catalog's 26 invariants have detectors, so most assessments return NOT_ASSESSED — visible, and deliberately not HELD. Most corpus fault classes are constitutional and have no mechanical injection form, so those scenarios run INCONCLUSIVE until a host can produce the fault. Abstraction, adequacy and precondition judgements are all caller-supplied: this package refuses bad ones rather than making good ones. Production repair authority is not granted anywhere and V1 defaults to SIMULATION. The harness drives no engines — a host supplies the executor and the condition evaluators, so an unevaluated corpus condition counts as unheld rather than passed. Most corpus fault classes are constitutional (SOURCE_OF_TRUTH_THEFT) and have no mechanical injection form, so those scenarios run INCONCLUSIVE until a host can produce the fault.",
  }),

  component({
    id: "foundry-evolutioniq", name: "Foundry EvolutionIQ", tier: "platform", status: "partial",
    packageName: "@proworks-hub/foundry-evolutioniq",
    responsibility: "CONSTITUTIONAL_EVOLUTION. Owns the runtime that repair agents live inside: Mission Control, Agent Runtime with a live termination supervisor, Sandbox (which now owns workspaces), the Validation Orchestrator, and Evolution Control with the promotion wall. Holds NO production deployment authority.",
    gap: "V1 runs the loop end to end in SIMULATION and VALIDATION — diagnose, create mission, spawn agent, author candidate, mutate a sandbox, test, validate, promote to a sandbox — and refuses STAGING and PRODUCTION with no override. Both schedulers now exist: a host-agnostic supervisor scheduler that drives `supervise()` through an injected Ticker (no timer API is imported), and a cross-mission scheduler with component-overlap conflict detection, capacity limits and a starvation valve. What is absent: the TestBot and ContractBot are interfaces a host binds, so replay and regression evidence is supplied rather than produced; there is no agent-to-agent coordination; and no agent-to-agent coordination. EventIQ integration now exists: mission, agent, candidate, promotion and drift events publish through EventIQ, while every decision a caller acts on — lease checks, validation, promotion, supervision — stays a direct synchronous contract. Repair Learning remains a separate package that Foundry consumes rather than contains.",
  }),

  // ── Resources Core ─────────────────────────────────────────────────────────
  component({
    id: "resources-core", name: "Resources Core", tier: "core", core: "resources", status: "partial",
    packageName: "@proworks-hub/resources-core",
    responsibility: "What an organization has: people, equipment, inventory, capacity, locations.",
    gap: "The coordinator exists and classifies every answer as a reading or a commitment, because stock goes stale and cost does not. NO HOST BINDING, and not for want of trying: hub-server's inventory module is unmounted and has no migration creating its pw_inventory_* tables, so there is no stock to read. Its units are tenant-defined free-text codes while the engine's are a fixed enum, and there is no UOM repository to resolve one to the other — mapping them by guesswork would read three rolls as three each. locate_asset and forecast_capacity are refused by name: AssetIQ does not exist.",
  }),
  component({
    id: "inventoryiq", name: "InventoryIQ", tier: "specialized", core: "resources", status: "existing",
    packageName: "@proworks-hub/inventoryiq",
    responsibility: "What is on hand, reserved, consumed and short.",
  }),
  component({
    // CORRECTED 2026-08-28. This read `status: "conceptual"`, which was stale:
    // AssetIQ is CHARTERED in the approved library (AssetIQ_Charter_V1_0). The
    // charter is the architectural fact; `planned` here records that no code
    // exists yet. Architectural existence and implementation maturity are
    // different questions and this entry previously conflated them.
    id: "assetiq", name: "AssetIQ", tier: "specialized", core: "resources", status: "planned",
    responsibility: "Equipment and asset registry, condition and maintenance state.",
  }),

  // ── Intelligence Core ──────────────────────────────────────────────────────
  component({
    id: "intelligence-core-engine", name: "Intelligence Core", tier: "core", core: "intelligence", status: "partial",
    responsibility: "Reasoning, learning, prediction, recommendation, situational awareness.",
    gap: "intelligence-core, model-runtime and model-evals exist as an AI runtime. SenseIQ and VisionIQ sit beneath conceptually but nothing coordinates them, and no provider adapter is configured.",
  }),
  component({
    id: "intelligence-core-pkg", name: "Intelligence Core (AI contracts)", tier: "specialized",
    core: "intelligence", status: "existing",
    packageName: "@proworks-hub/intelligence-core",
    responsibility: "Provider-independent AI task contracts. Names no vendor.",
  }),
  component({
    id: "model-runtime", name: "Model Runtime", tier: "specialized", core: "intelligence", status: "partial",
    packageName: "@proworks-hub/model-runtime",
    responsibility: "Provider adapters, routing, retry, fallback, structured output, cost accounting.",
    gap: "No real vendor adapter. A stub and an unconfigured adapter prove the seam; live keys are needed to write and verify a real one.",
  }),
  component({
    id: "model-evals", name: "Model Evals", tier: "specialized", core: "intelligence", status: "existing",
    packageName: "@proworks-hub/model-evals",
    responsibility: "Measurable regression testing for models and instructions.",
  }),
  component({
    id: "senseiq", name: "SenseIQ", tier: "specialized", core: "intelligence", status: "partial",
    packageName: "@proworks-hub/senseiq",
    responsibility:
      "Physical-world intelligence: devices, spaces, observations, authorized command intents, routines.",
    gap: "Phases A–F built. No real device adapter; the digital-twin layer (Phase G) is not started.",
  }),
  component({
    id: "visioniq", name: "VisionIQ", tier: "specialized", core: "intelligence", status: "existing",
    packageName: "@proworks-hub/visioniq",
    responsibility: "Visual and manufacturing-image intelligence, artwork preparation, machine recipes.",
  }),

  // ── Communication Core ─────────────────────────────────────────────────────
  component({
    id: "communication-core", name: "Communication Core", tier: "core", core: "communication", status: "partial",
    responsibility: "Who is told what, through which channel, when.",
    gap: "A notifications service exists with delivery policy. No Core, no channel adapters beyond the port.",
  }),
  component({
    id: "notifications", name: "Notifications", tier: "specialized", core: "communication", status: "existing",
    packageName: "@proworks-hub/notifications",
    responsibility: "Deciding whether and how to notify. A service, not an engine.",
  }),

  // ── Domain Core ────────────────────────────────────────────────────────────
  component({
    id: "domain-core", name: "Domain Core", tier: "core", core: "domain", status: "partial",
    responsibility: "Which industry this is, and what the universal capabilities mean inside it.",
    gap: "Manufacturing exists as ForgeIQ, consumed directly. There is no domain-pack abstraction, so a second industry has nothing to plug into.",
  }),
  component({
    id: "forgeiq", name: "ForgeIQ", tier: "industry", core: "domain", status: "existing",
    packageName: "@proworks-hub/forgeiq",
    responsibility:
      "Manufacturing: product configuration, manufacturability, plans, BOM, nesting, cutline export.",
  }),
];

/** Everything owned by one Core, for the console and for the docs. */
export function componentsInCore(core: string): HiveComponent[] {
  return HIVE_MAP.filter((entry) => entry.core === core);
}

/** What genuinely exists today, as opposed to what is drawn. */
export function builtComponents(): HiveComponent[] {
  return HIVE_MAP.filter((entry) => entry.status === "existing");
}
