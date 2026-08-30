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

// The seven hard gates, checked against the code rather than promised.
export * from "./certification.js";

// The runtime: the pipeline that runs a signal through every gate in order,
// and the wall between what decides and what follows. The runtime orchestrates
// existing modules and holds no authority of its own.
export * from "./ports/securityPorts.js";
export * from "./runtime/fabricRuntime.js";
export * from "./runtime/controlPlane.js";

// Reference transport adapters — two providers with opposite semantics, so
// neutrality is demonstrated rather than declared. Outside the kernel: the
// kernel never imports them; hosts bind them.
export * from "./providers/subjectBusProvider.js";
export * from "./providers/durableLogProvider.js";

// The one door between instances. Everything is re-checked on both sides.
export * from "./interconnect/gateway.js";
