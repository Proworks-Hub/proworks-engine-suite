// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/contracts — the normalized contracts the engines exchange.
//
// This package depends on nothing but zod. ForgeIQ produces a
// ManufacturingPlan; CostIQ consumes it and produces a CostResult; Prime
// consumes normalized outputs and produces a DecisionResult. Any system that
// can build a valid plan can be costed, and any system that can assemble a
// decision context can be evaluated — no engine owns another's contract.
//
// ReceiptIQ sits alongside them on the input side: it turns receipts into
// normalized purchases and canonical price observations, which CostIQ can
// consume as a real material cost basis instead of a configured rate.
//
// Each contract carries an explicit version marker so it can evolve
// deliberately: planVersion, resultVersion, contextVersion, receiptVersion.
// Who data belongs to, and how one unit of work is followed across engines.
// Both are prerequisites for the event bus, and both are far cheaper to add
// before hosts depend on the contracts than after.
export * from "./tenancy.js";
// The event seam. Engines publish facts and never learn who listens; without
// this they end up importing each other, and each arrow is a package that can
// no longer be lifted out alone.
export * from "./events.js";
export * from "./domainEvents.js";
// What happens when delivery goes wrong: retry policy, the transient/permanent
// distinction that decides whether retrying is even sensible, and dead letters.
export * from "./resilience.js";
// Workflow state that outlives the process running it. PRIME owns the state
// machine; a host owns the storage, which is what keeps PRIME pure.
export * from "./workflow.js";
// Background work, and being able to answer "what happened?" months later.
export * from "./jobs.js";
export * from "./observability.js";
// The boundary a request crosses on its way in, following it across engines,
// and the services every engine would otherwise reinvent.
// What a consumer is ALLOWED to do. A capability is built once and exposed in
// different amounts to different products, rather than forking the engine.
// Two organizations transacting without sharing systems, and a shop that keeps
// working when the connection does not.
export * from "./collaboration.js";
export * from "./sync.js";
export * from "./capabilities.js";
export * from "./gateway.js";
export * from "./tracing.js";
export * from "./platformServices.js";
export * from "./trace.js";

export * from "./manufacturingPlan.js";
export * from "./cost.js";
export * from "./decision.js";
export * from "./receipt.js";

// Where an order actually is, normalized across production and the carrier,
// and narrowed to what each audience may see.
export * from "./tracking.js";

// Asking an engine to do something, as distinct from being told it happened.
export * from "./commands.js";

// The SKU spine: one identifier created in the catalogue and pushed into every
// channel, so an order coming back is matched on an id rather than on a title.
export * from "./catalog.js";

// An order that arrived from somewhere else. The channel does not matter; the
// contract does.
export * from "./externalOrder.js";

// The files that reach a machine, and what each one is FOR — declared by
// whatever produced it, so nothing downstream infers purpose from a filename.
export * from "./productionAsset.js";

// What a preparation run produced — promoted from the shape KSix Prep Studio
// and ProWorks had already converged on independently.
export * from "./prepResult.js";
export * from "./hiveArchitecture.js";
export * from "./hiveClassification.js";
export * from "./charterRegistry.js";
export * from "./governance.js";
export * from "./identifiers.js";
export * from "./runtimeManifest.js";
export * from "./engineRegistry.js";
export * from "./auditRecord.js";
export * from "./hiveMessage.js";
export * from "./hiveMap.js";
