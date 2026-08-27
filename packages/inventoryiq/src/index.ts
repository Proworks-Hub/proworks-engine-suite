// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/inventoryiq — what is on hand, what is spoken for, and what is
// about to run out.
//
// The engine answers one question the rest of the suite keeps needing and
// nobody owned: can this job actually be made right now. ForgeIQ says how to
// make it, CostIQ says what it costs, WorkOrderIQ tracks the doing of it — and
// all three assume material that may not be there.
//
// It holds no cost. What a shop paid for a roll belongs to CostIQ and
// ReceiptIQ; a price here would be a second answer that quietly diverges.

export * from "./models.js";
export * from "./availability.js";
export * from "./events.js";
export * from "./ports.js";
export * from "./reservations.js";
export * from "./inMemory.js";

// The producer for a decision-context block that has had none: Prime has been
// asking whether there is material and getting silence.
export * from "./decisionSignal.js";

// One engine, two tiers. What a maker gets and what a shop gets, expressed as
// capabilities rather than as two codebases that eventually disagree.
export * from "./capabilities.js";
