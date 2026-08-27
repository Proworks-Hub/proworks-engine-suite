// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/order-ingestion — turns an order from any channel into one the shop can
// actually run.
//
// An Etsy purchase, a Shopify checkout, a phone call typed into an admin form
// and a wholesale spreadsheet arrive in four different shapes. Host adapters
// know about those shapes. By the time an order reaches this engine it looks
// the same as every other one, and nothing downstream contains the word "Etsy".
//
// The same pattern ReceiptIQ uses on inbound documents: normalize once, at the
// edge, in the one place that knows about that specific mess.

export * from "./events.js";
export * from "./ports.js";
export * from "./ingest.js";
export * from "./inMemory.js";
