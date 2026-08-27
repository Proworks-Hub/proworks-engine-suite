// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/tracking — where an order actually is.
//
// A service, not an engine: it owns no state and decides nothing about
// manufacturing. It asks sources, picks between their answers, merges what the
// carrier knows, and narrows the result to whoever is looking.
//
// It depends on `contracts` and nothing else. WorkOrderIQ implements its source
// port rather than being imported by it, so a host can show a customer where
// their order is without installing a production engine to do it.

export * from "./ports.js";
export * from "./trackingService.js";
