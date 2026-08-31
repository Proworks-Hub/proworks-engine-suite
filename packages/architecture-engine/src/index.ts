// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// The Architecture Engine. Two chambers: a Golden Reference that shows what
// conformance looks like, and a Conformance chamber that evaluates whether
// anything else matches. It reports; it never authorizes.

export * from "./rules.js";
export * from "./chambers/conformance.js";
export * from "./chambers/goldenReference.js";
export * from "./modules/collector.js";
export * from "./traceability/index.js";
export * from "./modules/migration.js";
