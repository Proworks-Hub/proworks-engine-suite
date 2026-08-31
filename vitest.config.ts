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
      "@proworks-hub/hive-runtime": pkg("hive-runtime", "src/index.ts"),
      "@proworks-hub/architecture-engine": pkg("architecture-engine", "src/index.ts"),
      "@proworks-hub/control-plane/manifests": pkg("control-plane", "src/manifests/index.ts"),
      "@proworks-hub/contracts": pkg("contracts", "src/index.ts"),
      "@proworks-hub/ledgeriq": pkg("ledgeriq", "src/index.ts"),
      "@proworks-hub/payablesiq": pkg("payablesiq", "src/index.ts"),
      "@proworks-hub/receivablesiq": pkg("receivablesiq", "src/index.ts"),
      "@proworks-hub/closeiq": pkg("closeiq", "src/index.ts"),
      "@proworks-hub/consolidationiq": pkg("consolidationiq", "src/index.ts"),
      "@proworks-hub/assetfinanceiq": pkg("assetfinanceiq", "src/index.ts"),
      "@proworks-hub/leasefinanceiq": pkg("leasefinanceiq", "src/index.ts"),
      "@proworks-hub/revenuerecognitioniq": pkg("revenuerecognitioniq", "src/index.ts"),
      "@proworks-hub/allocationiq": pkg("allocationiq", "src/index.ts"),
      "@proworks-hub/profitabilityiq": pkg("profitabilityiq", "src/index.ts"),
      "@proworks-hub/budgetiq": pkg("budgetiq", "src/index.ts"),
      "@proworks-hub/scenarioiq": pkg("scenarioiq", "src/index.ts"),
      "@proworks-hub/varianceiq": pkg("varianceiq", "src/index.ts"),
      "@proworks-hub/liquidityiq": pkg("liquidityiq", "src/index.ts"),
      "@proworks-hub/paymentsiq": pkg("paymentsiq", "src/index.ts"),
      "@proworks-hub/debtiq": pkg("debtiq", "src/index.ts"),
      "@proworks-hub/investmentiq": pkg("investmentiq", "src/index.ts"),
      "@proworks-hub/financialriskiq": pkg("financialriskiq", "src/index.ts"),
      "@proworks-hub/expenseiq": pkg("expenseiq", "src/index.ts"),
      "@proworks-hub/invoiceiq": pkg("invoiceiq", "src/index.ts"),
      "@proworks-hub/billingiq": pkg("billingiq", "src/index.ts"),
      "@proworks-hub/collectionsiq": pkg("collectionsiq", "src/index.ts"),
      "@proworks-hub/creditiq": pkg("creditiq", "src/index.ts"),
      "@proworks-hub/taxiq": pkg("taxiq", "src/index.ts"),
      "@proworks-hub/financialreportingiq": pkg("financialreportingiq", "src/index.ts"),
      "@proworks-hub/financialcontrolsiq": pkg("financialcontrolsiq", "src/index.ts"),
      "@proworks-hub/spendiq": pkg("spendiq", "src/index.ts"),
      "@proworks-hub/forecastiq": pkg("forecastiq", "src/index.ts"),
      "@proworks-hub/projectfinanceiq": pkg("projectfinanceiq", "src/index.ts"),
      "@proworks-hub/simulation-lab": pkg("simulation-lab", "src/index.ts"),
      "@proworks-hub/senseiq": pkg("senseiq", "src/index.ts"),
      "@proworks-hub/finance-core": pkg("finance-core", "src/index.ts"),
      "@proworks-hub/core-kit": pkg("core-kit", "src/index.ts"),
      "@proworks-hub/operations-core": pkg("operations-core", "src/index.ts"),
      "@proworks-hub/resources-core": pkg("resources-core", "src/index.ts"),
      "@proworks-hub/governance-engine": pkg("governance-engine", "src/index.ts"),
      "@proworks-hub/foundation-core": pkg("foundation-core", "src/index.ts"),
      "@proworks-hub/communication-core": pkg("communication-core", "src/index.ts"),
      "@proworks-hub/eventiq": pkg("eventiq", "src/index.ts"),
      "@proworks-hub/sentineliq": pkg("sentineliq", "src/index.ts"),
      "@proworks-hub/aria": pkg("aria", "src/index.ts"),
      "@proworks-hub/repair-learning": pkg("repair-learning", "src/index.ts"),
      "@proworks-hub/foundry-evolutioniq": pkg("foundry-evolutioniq", "src/index.ts"),
      "@proworks-hub/auditiq": pkg("auditiq", "src/index.ts"),
      "@proworks-hub/intelligence-core": pkg("intelligence-core", "src/index.ts"),
      "@proworks-hub/model-runtime": pkg("model-runtime", "src/index.ts"),
      "@proworks-hub/model-evals": pkg("model-evals", "src/index.ts"),
      "@proworks-hub/control-plane": pkg("control-plane", "src/core/index.ts"),
      "@proworks-hub/forgeiq": pkg("forgeiq", "src/core/index.ts"),
      "@proworks-hub/costiq": pkg("costiq", "src/index.ts"),
      "@proworks-hub/neural-fabric": pkg("neural-fabric", "src/index.ts"),
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
    // Wall-clock perf gates are excluded here and run in their own pass. They
    // compare a RATIO between two workload sizes, and what corrupts a ratio is
    // not noise but noise that lands harder on one size than the other --
    // which is exactly what happens when 260 test files compete for memory and
    // the larger workload takes the brunt. Interleaved best-of-five still
    // failed roughly one run in three.
    //
    // They are not dropped: `npm run verify` runs `test:perf` straight after
    // this, sequentially. The gate keeps its full reach and stops reporting
    // machine load as a complexity regression.
    exclude: ["**/node_modules/**", "**/dist/**", "packages/*/src/perf/__tests__/**"],
    testTimeout: 20000,
  },
});
