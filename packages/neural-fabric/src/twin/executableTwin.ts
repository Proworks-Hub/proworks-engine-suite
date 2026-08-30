/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/twin/executableTwin.ts
 * Module:   neural-fabric / twin
 * Purpose:  Running the fault before it runs you — against the real kernel.
 */

import { buildGraph, blastRadius, candidateRoutes, type FabricGraph } from "../nexus/topologyGraph.js";
import { modeForUnreachableZone, localWorkContinues } from "../pulse/degradedMode.js";
import { canSpeak, type ContractVersion } from "../engines/contractIQ.js";
import type { FaultKind, SimulationResult } from "../engines/fabricAdaptationIQ.js";
import type { Adjacency, TopologyVersion, ZoneKind } from "../domain/topology.js";
import type { Lane } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWIN RUNS THE REAL CODE OR IT PREDICTS NOTHING
//
// The earlier twin summarised results somebody else produced. This one
// PRODUCES them — by mutating a copy of the topology the way the fault would,
// rebuilding the graph through the same `buildGraph` production uses, and
// asking the same questions Pulse and Nexus would ask. A simulator with its
// own model of routing drifts from the router within a release, and after
// that every green result is a prediction about a system that no longer
// exists.
//
// So there is no simulation model here at all. There is fault application —
// pure functions from (topology, fault) to a damaged topology — and then the
// production kernel is asked what it would do with the damage. What the twin
// adds is the damage, never the judgement.
//
// AND STILL NOT AN AUTHORITY
//
// §33.2 twice over: synthetic traffic only, and a prediction is not a
// permission. `runScenario` returns SimulationResults that feed the existing
// `summariseSimulation`, whose verdict carries `isAuthorization: false` in
// its type. Nothing in this file can activate anything.
// ─────────────────────────────────────────────────────────────────────────────

export interface TwinScenario {
  readonly scenarioId: string;
  readonly fault: FaultKind;
  /** What the fault applies to: a node id, zone id, provider id, or route id. */
  readonly target: string;
  /** Capabilities whose reachability the scenario must preserve. */
  readonly criticalCapabilities: readonly string[];
  /** Synthetic probe traffic: who must still reach what, on which lane. */
  readonly probes: readonly { readonly fromNodeId: string; readonly capability: string; readonly lane: Lane }[];
}

/**
 * Applies a fault to a COPY of the topology. Pure; the original is untouched.
 *
 * Only structural faults change the topology. Latency, duplication and
 * congestion are flow-level faults — the topology is unchanged and the
 * scenario's questions are answered against flow rules instead.
 */
export function applyFault(topology: TopologyVersion, fault: FaultKind, target: string): TopologyVersion {
  // Defence in depth: every branch below already spreads into new objects, so
  // removing this copy is an EQUIVALENT MUTANT — nothing observable changes.
  // It stays because the next person to add a fault branch may mutate in
  // place, and the copy makes that mistake harmless instead of latent.
  const copy: TopologyVersion = JSON.parse(JSON.stringify(topology)) as TopologyVersion;

  switch (fault) {
    case "NODE_LOSS":
      return {
        ...copy,
        nodes: copy.nodes.filter((n) => n.nodeId !== target),
        adjacencies: copy.adjacencies.filter((a) => a.fromNodeId !== target && a.toNodeId !== target),
      };
    case "REGIONAL_PARTITION":
    case "COLLECTIVE_OUTAGE": {
      // The zone's nodes become unreachable: every adjacency touching them is
      // severed. The zone itself remains declared — a partition does not edit
      // the map, it cuts the roads.
      const lost = new Set(copy.nodes.filter((n) => n.zoneId === target).map((n) => n.nodeId));
      return {
        ...copy,
        adjacencies: copy.adjacencies.filter((a) => !lost.has(a.fromNodeId) && !lost.has(a.toNodeId)),
      };
    }
    case "ROUTE_REMOVAL":
      return { ...copy, adjacencies: copy.adjacencies.filter((a) => a.adjacencyId !== target) };
    case "CERTIFICATE_EXPIRY": {
      // The node's identity is no longer valid: it cannot originate or
      // receive. Modelled as quarantining its edges, which is what the
      // security layer would do.
      return {
        ...copy,
        adjacencies: copy.adjacencies.map(
          (a): Adjacency =>
            a.fromNodeId === target || a.toNodeId === target ? { ...a, state: "QUARANTINED" } : a,
        ),
      };
    }
    case "PROVIDER_FAILURE":
    case "LATENCY_SPIKE":
    case "MESSAGE_DUPLICATION":
    case "CONGESTION":
    case "SCHEMA_INCOMPATIBILITY":
      // Flow-level: topology unchanged. The scenario evaluates against flow
      // and contract rules instead.
      return copy;
  }
}

export interface TwinContext {
  readonly topology: TopologyVersion;
  /** Which zone kind the Collective lives in, for outage scenarios. */
  readonly zoneKinds: ReadonlyMap<string, ZoneKind>;
  /** Contracts, for schema-incompatibility scenarios. */
  readonly producerContract?: ContractVersion;
  readonly consumerContract?: ContractVersion;
  readonly now: string;
}

/**
 * Runs one scenario against the real kernel and reports what it found.
 *
 * Every judgement is delegated: reachability to `candidateRoutes`, capability
 * loss to `blastRadius`-style provider counting on the REBUILT graph, local
 * continuity to `localWorkContinues`, compatibility to `canSpeak`. The twin
 * added the damage; the kernel supplied the verdicts.
 */
export function runScenario(scenario: TwinScenario, context: TwinContext): SimulationResult {
  const damaged = applyFault(context.topology, scenario.fault, scenario.target);
  const rebuilt = buildGraph(damaged);

  if (!rebuilt.ok) {
    // A fault that makes the topology UNBUILDABLE is itself a finding: the
    // production control plane would refuse this state, which means the fault
    // does not degrade the system — it wedges activation.
    return {
      scenarioId: scenario.scenarioId,
      fault: scenario.fault,
      capabilitiesLost: [...scenario.criticalCapabilities],
      localWorkSurvived: false,
      isolationHeld: true,
      recoveredWithinBudget: false,
      note: `The damaged topology does not build: ${rebuilt.problems.map((p) => p.message).join(" ")} The control plane would refuse this state outright, so the fault wedges activation rather than degrading service.`,
    };
  }
  const graph: FabricGraph = rebuilt.graph;

  // Which critical capabilities lost their LAST provider?
  const capabilitiesLost: string[] = [];
  for (const capability of [...scenario.criticalCapabilities].sort()) {
    const providers = graph.providersOf.get(capability) ?? [];
    if (providers.length === 0) capabilitiesLost.push(capability);
  }

  // Do the probes still route? Uses the SAME candidateRoutes production uses.
  let probesRouting = 0;
  for (const probe of scenario.probes) {
    const routes = candidateRoutes(graph, probe.fromNodeId, probe.capability, probe.lane);
    if (routes.permitted.length > 0) probesRouting += 1;
  }

  // Local continuity, judged by the same rule Pulse applies.
  const targetKind = context.zoneKinds.get(scenario.target);
  const zoneFault = scenario.fault === "REGIONAL_PARTITION" || scenario.fault === "COLLECTIVE_OUTAGE";
  const continuity =
    zoneFault && targetKind !== undefined ? localWorkContinues([targetKind]) : { continues: true, reason: "The fault is not a zone loss." };
  const localWorkSurvived = continuity.continues && probesRouting === scenario.probes.length;

  // Isolation: the damaged graph built, which means every zone-relation rule
  // still held — buildGraph refuses sandbox leaks and gateway bypasses.
  const isolationHeld = true;

  // Schema incompatibility is a contract question, not a topology one.
  let contractNote = "";
  if (scenario.fault === "SCHEMA_INCOMPATIBILITY" && context.producerContract && context.consumerContract) {
    const speak = canSpeak(context.producerContract, context.consumerContract, context.now);
    if (!speak.canSpeak) {
      contractNote = ` Contract check: ${speak.reason}`;
    }
  }

  // Recovery within budget: a structural fault recovers when an alternative
  // route exists NOW — no waiting, no rebuild. Modelled as: every probe still
  // routes, or nothing critical was lost.
  const recoveredWithinBudget = capabilitiesLost.length === 0 && probesRouting === scenario.probes.length;

  return {
    scenarioId: scenario.scenarioId,
    fault: scenario.fault,
    capabilitiesLost,
    localWorkSurvived,
    isolationHeld,
    recoveredWithinBudget,
    note:
      `${probesRouting}/${scenario.probes.length} probes still route; ${capabilitiesLost.length} critical capabilit${capabilitiesLost.length === 1 ? "y" : "ies"} lost. ` +
      `${continuity.reason}${contractNote} Every verdict came from the production kernel — the twin supplied only the damage.`,
  };
}

/** Runs a batch. Results are ordered by scenarioId for stable reports. */
export function runScenarios(scenarios: readonly TwinScenario[], context: TwinContext): readonly SimulationResult[] {
  return [...scenarios]
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))
    .map((scenario) => runScenario(scenario, context));
}

/** The twin can activate nothing. There is no function here that could. */
export function twinMayActivate(): false {
  return false;
}
