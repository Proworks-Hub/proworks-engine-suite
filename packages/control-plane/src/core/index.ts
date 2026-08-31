// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// @proworks-hub/control-plane — the engine control centre's portable core.
//
// Manifests, operational state, internal console authorization, the hive
// topology, and the telemetry-to-visualization adapter.
//
// It OBSERVES the engines. It never runs them, and nothing here is imported by
// an engine. If this package disappeared, every engine would keep working —
// which is the requirement, not a side effect.

export * from "./manifest.js";
export * from "./registry.js";
export * from "./health.js";
export * from "./access.js";
export * from "./visualization.js";
export * from "./topology.js";
export * from "./intelligence.js";
export * from "./brand.js";
export * from "./motionLanguage.js";
export * from "./systemHealth.js";
export * from "./heartbeat.js";
export * from "./operationalState.js";
export * from "./alerts.js";
export * from "./tracing.js";
export * from "./release.js";
export * from "./recovery.js";
export * from "./diagnostics.js";
export * from "./incident.js";
export * from "./validationLab.js";
export * from "./architecture.js";
