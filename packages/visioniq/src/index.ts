// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/visioniq — how a digital asset should be prepared for a given
// process, machine and material.
//
// ForgeIQ answers "what are we making, and can we make it".
// VisionIQ answers "what should the production asset LOOK LIKE".
//
// EXTRACTED, NOT WRITTEN. This engine's core is KSix Prep Studio's core, moved
// without behavioural change. Prep Studio had already built a recipe engine, a
// recipe operating system, a profile engine and a preflight engine, and had
// already kept them free of React and the DOM — 0 of 16 files in that directory
// touched either. What was missing was not the intelligence. It was a package
// boundary that let anything other than one Studio use it.
//
// The Prep Studio UI stays where it is and becomes a consumer. Nothing was
// deleted to make room for this.

export * from "./core/types.js";
export * from "./core/profileEngine.js";
export * from "./core/sharedChecks.js";
export * from "./core/colorEngine.js";
export * from "./core/recipeEngine.js";
export * from "./core/preflightEngine.js";

// sharedPrepEngine is the facade over the four engines above, and it re-declares
// aliases of types they already export — SharedPreflightPlan, SharedPrepDomain,
// SharedRecipePreset and their getters. Those are the same types under a second
// name, so the barrel takes them from the leaf that defines them and exports
// only what this module genuinely owns.
//
// Named rather than `export *` on purpose: a published package's surface should
// be a decision, not whatever happens to be exported today.
export {
  validateExportFormatForDomain,
  getSharedProfile,
  getSharedColorPlan,
  getSharedExportPlan,
  runSharedWorkflowPrep,
  type SharedProfile,
  type SharedExportPlan,
  type SharedPrepOverrides,
} from "./core/sharedPrepEngine.js";

// The one seam extraction required: operator recipe variants persisted through
// a host-supplied store rather than ambient browser storage.
export { setRecipeVariantStore, type RecipeVariantStore } from "./core/recipeEngine.js";
