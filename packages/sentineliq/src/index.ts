// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

export * from "./finding.js";
export * from "./defense.js";
export * from "./sentinel.js";

export * from "./fabricSecurity.js";

// Sentinel V2 (DEC-027): Shield + Guard chambers, condition levels, the
// operational action ladder, assurance and threat modules, human/bootstrap
// governance, telemetry minimization and the scorecard. Specialist
// candidates are MODULES pending individual chartering (V2 doc §4/§5).
export * from "./v2/chambers.js";
export * from "./v2/actions.js";
export * from "./v2/assurance.js";
export * from "./v2/threat.js";
export * from "./v2/governance.js";
export * from "./v2/telemetry.js";

// Security Observation Plane (DEC-028 increment 1, directive §9-§13): the
// canonical normalized observation record, Hive security semantic
// conventions, provider-neutral sensor ports, and Hive-native producers.
export * from "./v2/securityConventions.js";
export * from "./v2/observation.js";
export * from "./v2/providers.js";
export * from "./v2/hiveSensors.js";

// Detection methods and the exposure/attack-surface graph (DEC-028 increment
// 2, directive §15-§16).
export * from "./v2/detection.js";
export * from "./v2/exposure.js";

// Incident correlation and SOC read models (DEC-028 increment 3, §20-§21).
export * from "./v2/incident.js";
export * from "./v2/readModels.js";
