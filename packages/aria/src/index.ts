// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ARIA — constitutional intelligence.
//
// Advises across the Hive and authorizes nothing. It reads what a host hands
// it and returns something a person can disregard; there is no `authorize`,
// `permit`, `decide` or `execute` on its surface, and a test asserts their
// absence rather than trusting the intent.
//
// Depends on contracts and zod. It imports no engine, because an advisor that
// could reach into Governance or Sentinel on its own initiative would be
// choosing what to look at, and that is most of a judgement.

export * from "./advice.js";
export * from "./aria.js";
