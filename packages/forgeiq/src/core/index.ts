// ForgeIQ Engine core — portable and host-independent.
// Pure and isomorphic: imports only zod and the shared contracts.
export * from "./schemas/productDefinition";
export * from "./schemas/configuration";
export * from "./schemas/machineProfile";
export * from "./schemas/materialProfile";
export * from "./resolve";
export * from "./pricing/pricingEngine";
export * from "./pricing/quantity";
export * from "./validation/validationEngine";
export { elementBounds } from "./validation/geometry";
export * from "./export/cutlineSvg";
export * from "./export/bridges";
export * from "./export/workOrder";
export * from "./repair/designRepair";
export * from "./production/bom";
export * from "./production/nesting";
export * from "./ai/types";
export * from "./ai/conceptPrompt";
export * from "./ai/conceptService";
export * from "./ai/mockProvider";

// The shared contracts, re-exported so a host that already depends on ForgeIQ
// does not need a second import for the types it produces.
export * from "@proworks/contracts";
// ForgeIQ's producer for the ManufacturingPlan contract.
export * from "../manufacturing/buildManufacturingPlan";
