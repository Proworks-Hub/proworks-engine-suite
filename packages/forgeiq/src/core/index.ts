// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ForgeIQ Engine core — portable and host-independent.
// Pure and isomorphic: imports only zod and the shared contracts.
export * from "./schemas/productDefinition.js";
export * from "./schemas/configuration.js";
export * from "./schemas/machineProfile.js";
export * from "./schemas/materialProfile.js";
export * from "./resolve.js";
export * from "./pricing/pricingEngine.js";
export * from "./pricing/quantity.js";
export * from "./validation/validationEngine.js";
export { elementBounds } from "./validation/geometry.js";
export * from "./export/cutlineSvg.js";
export * from "./export/bridges.js";
export * from "./export/workOrder.js";
export * from "./repair/designRepair.js";
export * from "./production/bom.js";
export * from "./production/nesting.js";
export * from "./ai/types.js";
export * from "./ai/conceptPrompt.js";
export * from "./ai/conceptService.js";
export * from "./ai/mockProvider.js";

// The shared contracts, re-exported so a host that already depends on ForgeIQ
// does not need a second import for the types it produces.
export * from "@proworks/contracts";
// ForgeIQ's producer for the ManufacturingPlan contract.
export * from "../manufacturing/buildManufacturingPlan.js";
