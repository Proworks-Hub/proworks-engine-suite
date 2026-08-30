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
    gap: "Findings, dispositions and the defensive ladder exist; nothing detects. There is no monitor, no sensor and no correlation engine, so every finding must be handed in by a caller — Charter §5's fourteen monitoring capabilities are all unimplemented. Protective state is described but not enforced: a restriction is a record, and nothing in this installation stops a quarantined engine from being called. Emergency Protective State can be declared and decays correctly, and activates nothing. Deliberately takes no Governance dependency (§8, §15) — oversight that must ask permission from the system it oversees is not oversight.",
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
