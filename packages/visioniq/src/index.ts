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

// The seam extraction required. Three modules persisted preferences to browser
// storage directly; they now share one port, wired once by the host:
//   setVisionStorage(window.localStorage)
export * from "./core/storage.js";

// The preparation vocabulary — background, cleanup, colour, halftone, vector
// and export settings. Declared here rather than imported from a generated API
// client, because an HTTP schema should not be the source of truth for what
// "cleanup" means.
export * from "./core/prepSettings.js";

// Machine targeting, presets, templates, and the recipe operating system that
// resolves process + machine + material into a recipe.
export * from "./machines/machinePresets.js";
export * from "./machines/machineTargeting.js";
export * from "./machines/machineTemplateEngine.js";
export * from "./machines/recipeOperatingSystem.js";

// The raster seam. ImageData satisfies PixelBuffer structurally, so a browser
// host passes its own objects straight in.
export * from "./core/pixelBuffer.js";

// Preparation algorithms — halftone, vector, spot channels, accent layers,
// background removal, quality scoring, preflight, action packs.
export * from "./prep/accentLayerPrep.js";
export * from "./prep/actionPacks.js";
export * from "./prep/artworkTypes.js";
export * from "./prep/autoTunePreset.js";
export * from "./prep/backgroundRemoval.js";
export * from "./prep/halftonePrep.js";
export * from "./prep/printModeRules.js";
export * from "./prep/qaChecklist.js";
export * from "./prep/qualityScore.js";
export * from "./prep/recipeTypes.js";
export * from "./prep/recipesPrep.js";
export * from "./prep/runPreflightChecks.js";
export * from "./prep/spotChannelPrep.js";
export * from "./prep/studioSettingsPrep.js";
export * from "./prep/validateTiffExport.js";
export * from "./prep/vectorPrep.js";
export * from "./prep/workflowMapping.js";

// THREE MODULES ARE NAMESPACED RATHER THAN FLATTENED, because extracting them
// into one package surfaced name collisions that separate module scopes had
// been hiding:
//
//   MACHINE_PRESETS   machines/machinePresets  vs  prep/quickPrepConstants
//   CHANNEL_LABELS    prep/printModeRules      vs  prep/spotChannels
//   PRINT_MODE_RULES  prep/printModeRules      vs  prep/spotChannels
//   PreflightResult   prep/runPreflightChecks  vs  prep/spotChannelValidator
//
// The MACHINE_PRESETS pair is the instructive one: they are DIFFERENT CONCEPTS
// sharing a name. One is machine preset config keyed by uppercase preset
// (routing identity); the other is quick-prep tuning keyed lowercase
// (cleanupAggression, targetDpi, sharpen). Picking a winner would silently drop
// a real thing, so both are exported and the ambiguity is made explicit.
export * as quickPrep from "./prep/quickPrepConstants.js";
export * as spotChannels from "./prep/spotChannels.js";
export * as spotChannelValidation from "./prep/spotChannelValidator.js";

// Process capabilities. Namespaced because a capability is a coherent unit,
// and because flattening 19 more modules into the root barrel is how the
// MACHINE_PRESETS collision happened.
export * as laser from "./capabilities/laser/index.js";
