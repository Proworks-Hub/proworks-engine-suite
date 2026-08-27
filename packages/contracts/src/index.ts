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
export * from "./trace.js";

export * from "./manufacturingPlan.js";
export * from "./cost.js";
export * from "./decision.js";
export * from "./receipt.js";
