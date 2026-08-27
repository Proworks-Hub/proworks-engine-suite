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
export * from "./costiqEngine.js";
export * from "./adapters/manufacturingPlanAdapter.js";

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
