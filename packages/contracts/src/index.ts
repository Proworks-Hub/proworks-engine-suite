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
export * from "./manufacturingPlan.js";
export * from "./cost.js";
export * from "./decision.js";
export * from "./receipt.js";
