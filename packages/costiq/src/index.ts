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
export * from "./costiqEngine";
export * from "./adapters/manufacturingPlanAdapter";

// The depth.
export * from "./core/costCalculator";
export * from "./core/pricingEngine";
export * from "./core/marginCalculator";
export * from "./core/finishedProductPricingCalculator";

// The vocabulary those calculators speak.
export * from "./models/jobCostInputModel";
export * from "./models/costBreakdownModel";
export * from "./models/pricingResultModel";
export * from "./models/workstationCostModel";
export * from "./models/finishedProductPricingModel";
export * from "./models/actualCostSnapshotModel";

// Estimate-versus-actual tracking.
export * from "./services/actualsTrackerService";
export * from "./services/actualsCapturePipeline";
export * from "./services/jobCostInputBuilder";
