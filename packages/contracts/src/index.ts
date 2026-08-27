// @proworks/contracts — the normalized contracts the engines exchange.
//
// This package depends on nothing but zod. ForgeIQ produces a
// ManufacturingPlan; CostIQ consumes it and produces a CostResult; Prime
// consumes normalized outputs and produces a DecisionResult. Any system that
// can build a valid plan can be costed, and any system that can assemble a
// decision context can be evaluated — no engine owns another's contract.
//
// Each contract carries an explicit version marker so it can evolve
// deliberately: planVersion, resultVersion, contextVersion.
export * from "./manufacturingPlan";
export * from "./cost";
export * from "./decision";
