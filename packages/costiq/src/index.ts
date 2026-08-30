// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// CostIQ — the portable costing engine.
//
// The public boundary is `createCostIqEngine`: a ManufacturingPlan in, a
// CostResult out. Behind it sit the mature calculators migrated from ProWorks
// — the 6-layer job cost engine, margin application, job pricing, and
// finished-product recipe pricing — reached through the plan adapter.
//
// The calculators are exported directly too, because they predate the plan
// contract and cost things a plan does not describe: a shop-floor work order,
// a finished product built from a recipe, actuals captured after the fact. A
// host with its own job data can use them without ForgeIQ in the picture.

// The boundary.
export * from "./charter.js";

// ── vNext domain foundation (Wave 2) ────────────────────────────────────────
// Exact arithmetic, currency-aware money and unit-aware quantity. v1 continues
// to export unchanged below; nothing here alters existing behaviour.
export * from "./domain/decimal.js";
export * from "./domain/money.js";
export * from "./domain/quantity.js";
export * from "./domain/provenance.js";
// ── vNext cost model ────────────────────────────────────────────────────────
//
// `CostBasis` collides: v1 exports an interface of that name from
// priceObservationAdapter, and consumers may already import it. Breaking a
// public type to make room for a better one is exactly the silent break the
// directive forbids, so the vNext record is exported as `CostBasisRecord` at
// the package boundary while keeping its natural name inside the domain.
//
// The alias is the compatibility layer in its smallest possible form. When v1
// retires behind `compatibility/`, the alias goes and the names align.
export {
  costScopeSchema,
  costObjectRefSchema,
  costComponentKindSchema,
  costRateSchema,
  costBasisSchema,
  costComponentSchema,
  costPolicySchema,
  costRecommendationSchema,
  decimalStringSchema,
  currencyCodeSchema,
  type CostScope,
  type CostObjectRef,
  type CostComponentKind,
  type CostRate,
  type CostBasis as CostBasisRecord,
  type CostComponent,
  type CostPolicy,
  type CostRecommendation,
} from "./domain/costModel.js";
export * from "./domain/costEstimate.js";
export * from "./core/costGraph.js";
export * from "./core/methodRegistry.js";
export * from "./core/directJobCostMethod.js";
export * from "./core/recipeBomCostMethod.js";
export * from "./core/quantityEconomics.js";
export * from "./core/standardCostMethod.js";
export * from "./core/marginPricing.js";
export * from "./core/shouldCostAndLanded.js";
export * from "./core/varianceEngine.js";
export * from "./core/scenarioEngine.js";
export * from "./core/alternativesAndBreakEven.js";
export * from "./core/costModelHealth.js";

// Advisory only. The port is optional and nothing it returns can reach the
// arithmetic — see the header of costAiSpecialist.ts for why that is structural
// rather than a rule somebody has to remember.
export * from "./ai/costAiSpecialist.js";

// What CostIQ needs from a host, what it announces outward, and — the part
// most likely to be crossed by accident — what an announcement does NOT
// entitle a consumer to conclude.
export * from "./ports/costPorts.js";
export * from "./ports/costIntegration.js";

// Tenant isolation, redaction and resource limits, and the certification that
// turns "deterministic" from a claim into something CI checks.
export * from "./security/isolation.js";
export * from "./security/replayCertification.js";
export * from "./explanation/explanationLevels.js";
export * from "./graph/dependencyIndex.js";
export * from "./services/costBasisService.js";

// ── v1 (unchanged) ──────────────────────────────────────────────────────────
export * from "./costiqEngine.js";
export * from "./adapters/manufacturingPlanAdapter.js";

// Observed prices as a cost basis. Consumes the PriceObservation contract, so
// ReceiptIQ can supply real supplier prices without CostIQ depending on it.
export * from "./adapters/priceObservationAdapter.js";

// The depth.
export * from "./core/costCalculator.js";
export * from "./core/pricingEngine.js";
export * from "./core/marginCalculator.js";
export * from "./core/finishedProductPricingCalculator.js";

// The vocabulary those calculators speak.
export * from "./models/jobCostInputModel.js";
export * from "./models/costBreakdownModel.js";
export * from "./models/pricingResultModel.js";
export * from "./models/workstationCostModel.js";
export * from "./models/finishedProductPricingModel.js";
export * from "./models/actualCostSnapshotModel.js";

// Estimate-versus-actual tracking.
export * from "./services/actualsTrackerService.js";
export * from "./services/actualsCapturePipeline.js";
export * from "./services/jobCostInputBuilder.js";
