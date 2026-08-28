import { defineConfig } from "vitest/config";
import path from "node:path";

// The suite must be verifiable from a fresh clone with no host present, so
// aliases resolve to package sources rather than any built output.
const pkg = (name: string, entry: string) =>
  path.resolve(import.meta.dirname, "packages", name, entry);

export default defineConfig({
  resolve: {
    alias: {
      // Subpaths first: an exact-match alias for the bare specifier does not
      // cover "@proworks-hub/forgeiq/demo/firepit", and falling through to the
      // exports map would resolve to dist — which defeats the point of testing
      // the sources.
      "@proworks-hub/forgeiq/demo/firepit": pkg("forgeiq", "src/demo/firepit.ts"),
      "@proworks-hub/forgeiq/demo/metalSign": pkg("forgeiq", "src/demo/metalSign.ts"),
      "@proworks-hub/forgeiq/manufacturing": pkg("forgeiq", "src/manufacturing/buildManufacturingPlan.ts"),
      "@proworks-hub/control-plane/manifests": pkg("control-plane", "src/manifests/index.ts"),
      "@proworks-hub/contracts": pkg("contracts", "src/index.ts"),
      "@proworks-hub/control-plane": pkg("control-plane", "src/core/index.ts"),
      "@proworks-hub/forgeiq": pkg("forgeiq", "src/core/index.ts"),
      "@proworks-hub/costiq": pkg("costiq", "src/index.ts"),
      "@proworks-hub/prime": pkg("prime", "src/index.ts"),
      "@proworks-hub/workorderiq": pkg("workorderiq", "src/index.ts"),
      "@proworks-hub/receiptiq": pkg("receiptiq", "src/index.ts"),
      "@proworks-hub/platform-events": pkg("platform-events", "src/index.ts"),
      "@proworks-hub/platform-runtime": pkg("platform-runtime", "src/index.ts"),
      "@proworks-hub/tracking": pkg("tracking", "src/index.ts"),
      "@proworks-hub/inventoryiq": pkg("inventoryiq", "src/index.ts"),
      "@proworks-hub/notifications": pkg("notifications", "src/index.ts"),
      "@proworks-hub/order-ingestion": pkg("order-ingestion", "src/index.ts"),
      "@proworks-hub/visioniq": pkg("visioniq", "src/index.ts"),
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
