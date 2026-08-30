/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/index.ts
 * Module:   neural-fabric
 * Purpose:  The public surface. Read charter.ts before adding to it.
 */

// What this is, what it refuses to be, and the ratification it has not had.
export * from "./charter.js";

// The two contracts everything else rests on.
export * from "./domain/lanes.js";
export * from "./domain/envelope.js";

// Nexus: the living topology, and the questions only structure can answer.
export * from "./domain/topology.js";
export * from "./nexus/topologyGraph.js";

// Pulse: what is happening on the permitted paths, and what still works when
// part of the world is unreachable.
export * from "./pulse/pathHealth.js";
export * from "./pulse/flowControl.js";
export * from "./pulse/degradedMode.js";

// The specialist layer. Candidates under §8, implemented as modules so the
// capability exists and the chartering decision stays open.
export * from "./engines/deliveryIQ.js";
export * from "./engines/contractIQ.js";
export * from "./engines/routingIQ.js";
export * from "./engines/streamIQ.js";
export * from "./engines/fabricObservabilityIQ.js";
export * from "./engines/fabricAdaptationIQ.js";
export * from "./engines/topologyIQ.js";
export * from "./engines/flowIQ.js";

// Transports are replaceable, and this is where that is checked rather than
// asserted.
export * from "./ports/providers.js";

// Security posture, containment, immune signalling and governed upgrade.
// Neural Fabric consumes these controls; it does not own the security system.
export * from "./security/posture.js";
export * from "./security/quarantine.js";
export * from "./security/governedUpgrade.js";
