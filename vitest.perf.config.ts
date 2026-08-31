// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// Wall-clock performance gates, run alone.
//
// `fileParallelism: false` is the entire point of this file. A scaling
// exponent is only meaningful when the two measurements it divides were taken
// under comparable conditions, and nothing guarantees that while the rest of
// the suite is competing for the same memory and cores.
//
// The alias map is reused from the default config rather than restated -- two
// alias tables would drift, and the drift would show up as a perf gate testing
// a different build than the suite does. `mergeConfig` is deliberately NOT
// used: it concatenates `include` rather than replacing it, which quietly
// pulled the whole suite back in.

import { defineConfig } from "vitest/config";

import base from "./vitest.config.js";

export default defineConfig({
  resolve: base.resolve,
  test: {
    environment: "node",
    include: ["packages/*/src/perf/__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    testTimeout: 180000,
  },
});
