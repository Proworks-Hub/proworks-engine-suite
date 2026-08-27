// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/platform-events — the development and test binding for the
// platform event port.
//
// The port itself lives in @proworks-hub/contracts, because that is what the
// engines share. This package is one implementation of it: synchronous,
// in-process, deliberately strict, and not durable. A host swaps a real broker
// in behind the same interface without an engine noticing.

export * from "./inMemoryEventBus.js";
export * from "./resilientDelivery.js";
