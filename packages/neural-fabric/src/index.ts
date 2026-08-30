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
