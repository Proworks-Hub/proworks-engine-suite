import { defineConfig } from "vitest/config";
import path from "node:path";

// The suite must be verifiable from a fresh clone with no host present, so
// aliases resolve to package sources rather than any built output.
const pkg = (name: string, entry: string) =>
  path.resolve(import.meta.dirname, "packages", name, entry);

export default defineConfig({
  resolve: {
    alias: {
      "@proworks-hub/contracts": pkg("contracts", "src/index.ts"),
      "@proworks-hub/forgeiq": pkg("forgeiq", "src/core/index.ts"),
      "@proworks-hub/costiq": pkg("costiq", "src/index.ts"),
      "@proworks-hub/prime": pkg("prime", "src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
      "packages/*/src/**/__tests__/**/*.test.ts",
    ],
    testTimeout: 20000,
  },
});
