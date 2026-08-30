/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/routingIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  One route, and a record of why it and not the others.
 */

import { classificationPermitsExport, type FabricEnvelope } from "../domain/envelope.js";
import type { CandidatePath, CandidateRoutes } from "../nexus/topologyGraph.js";
import { selectPath, type PathHealth, type CircuitState } from "../pulse/pathHealth.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE ORDER OF THE CHECKS IS THE DESIGN
//
// §12 gives it: authority, then contract compatibility, then locality, then
// health, then lane and QoS, then capacity, then policy. What matters is not
// that all seven happen but that the first four happen IN THAT ORDER, because
// the order decides what a latency optimisation is allowed to do.
//
// Checking health before authority produces a system where an unhealthy path
// makes a permission question moot — which sounds harmless until the healthy
// alternative is the one that was never authorised. Every routing system that
// has ever leaked traffic across a boundary did it by reordering these.
//
// So this module composes Nexus (which paths are permitted) with Pulse (which
// permitted path is best) and NEVER the other way round. It cannot widen a
// candidate set: the set arrives as an argument and shrinks or stays the same.
//
// A ROUTE DECISION IS EVIDENCE
//
// §19 asks the Fabric to answer where a signal went, why that route, why it
// was delayed, and why it was rejected. Those questions are asked after the
// fact, which means the answer has to be recorded at the time — a system that
// can recompute "which route would I pick now" answers a different question
// than "which did I pick then, and why".
//
// So `routeSignal` returns a decision record, not a path. The path is one
// field of it.
// ─────────────────────────────────────────────────────────────────────────────

export type RefusalStage =
  | "NO_PERMITTED_ROUTE"
  | "CLASSIFICATION_FORBIDS_EXPORT"
  | "NO_HEALTHY_ROUTE"
  | "EXPIRED";

export interface RouteDecision {
  readonly fabricMessageId: string;
  readonly correlationId: string;
  readonly lane: FabricEnvelope["lane"];
  readonly capability: string;
  /** Null when nothing could be chosen. The refusal explains which stage. */
  readonly chosen: CandidatePath | null;
  readonly refusedAt: RefusalStage | null;
  /** Paths that were permitted and not chosen, best first. */
  readonly alternatives: readonly { readonly toNodeId: string; readonly why: string }[];
  /** Paths that were not permitted at all, with the topology's reason. */
  readonly rejected: readonly { readonly toNodeId: string; readonly why: string }[];
  /** The ordered checks that ran, and what each concluded. */
  readonly checks: readonly { readonly stage: string; readonly conclusion: string }[];
  readonly explanation: string;
  readonly decidedAt: string;
}

export interface RoutingInputs {
  readonly envelope: FabricEnvelope;
  /** From Nexus. This module cannot add to it. */
  readonly candidates: CandidateRoutes;
  readonly health: ReadonlyMap<string, PathHealth>;
  readonly circuits: ReadonlyMap<string, CircuitState>;
  readonly pathKey: (path: CandidatePath) => string;
  readonly now: string;
  /** True when the signal has outlived its deadline or TTL. */
  readonly expired: boolean;
}

/**
 * Chooses a route and records why.
 *
 * The candidate set is an input and is never extended. Every refusal names the
 * stage it happened at, because "no route" and "no HEALTHY route" send an
 * operator to completely different places — the first is a topology or
 * permission question, the second is an incident.
 */
export function routeSignal(input: RoutingInputs): RouteDecision {
  const checks: { stage: string; conclusion: string }[] = [];
  const { envelope, candidates } = input;

  const base = {
    fabricMessageId: envelope.fabricMessageId,
    correlationId: envelope.correlationId,
    lane: envelope.lane,
    capability: candidates.capability,
    decidedAt: input.now,
    rejected: candidates.rejected.map((r) => ({ toNodeId: r.toNodeId, why: r.reason })),
  };

  // ── 1. Expiry, before anything else ──────────────────────────────────────
  // Cheapest check, and routing an expired signal wastes capacity on work
  // whose caller has already given up.
  if (input.expired) {
    checks.push({ stage: "expiry", conclusion: "The signal is past its deadline or TTL." });
    return {
      ...base,
      chosen: null,
      refusedAt: "EXPIRED",
      alternatives: [],
      checks,
      explanation:
        "Not routed: the signal expired before a route was chosen. Whoever was waiting has stopped waiting, and delivering now would be worse than not delivering.",
    };
  }
  checks.push({ stage: "expiry", conclusion: "Within its deadline." });

  // ── 2. Authority and permitted set, from Nexus ───────────────────────────
  // Before health, deliberately. Checking health first would let an unhealthy
  // path make a permission question moot, and the healthy alternative is
  // sometimes the one that was never authorised.
  if (candidates.permitted.length === 0) {
    checks.push({
      stage: "permitted-routes",
      conclusion: `No permitted route. ${candidates.rejected.length} provider${candidates.rejected.length === 1 ? " was" : "s were"} considered.`,
    });
    return {
      ...base,
      chosen: null,
      refusedAt: "NO_PERMITTED_ROUTE",
      alternatives: [],
      checks,
      explanation: `Not routed: nothing permits ${envelope.source.capability} to reach "${candidates.capability}" on the ${envelope.lane} lane. This is a topology or authorization question, not a health one — no amount of waiting will change it.`,
    };
  }
  checks.push({
    stage: "permitted-routes",
    conclusion: `${candidates.permitted.length} permitted route${candidates.permitted.length === 1 ? "" : "s"} from Nexus.`,
  });

  // ── 3. Classification, before locality ───────────────────────────────────
  // A tenant-private signal must not cross an instance boundary however good
  // the remote path looks. Filtering here rather than penalising in scoring is
  // the difference between a rule and a preference.
  const exportCheck = classificationPermitsExport(envelope.classification);
  let eligible = candidates.permitted;
  if (!exportCheck.permitted) {
    eligible = candidates.permitted.filter((p) => !p.crossesInstance);
    checks.push({
      stage: "classification",
      conclusion: `${envelope.classification} may not leave the instance. ${candidates.permitted.length - eligible.length} cross-instance route${candidates.permitted.length - eligible.length === 1 ? "" : "s"} removed — a rule, not a preference, so no health advantage overrides it.`,
    });
    if (eligible.length === 0) {
      return {
        ...base,
        chosen: null,
        refusedAt: "CLASSIFICATION_FORBIDS_EXPORT",
        alternatives: candidates.permitted.map((p) => ({
          toNodeId: p.toNodeId,
          why: "Permitted by topology, refused by classification: it crosses an instance boundary.",
        })),
        checks,
        explanation: `Not routed: every permitted route crosses an instance boundary and this signal is ${envelope.classification}. ${exportCheck.note}`,
      };
    }
  } else {
    checks.push({ stage: "classification", conclusion: `${envelope.classification} may cross a boundary through a gateway.` });
  }

  // ── 4. Health and capacity, from Pulse ───────────────────────────────────
  const selection = selectPath(eligible, input.health, input.circuits, input.pathKey);
  checks.push({ stage: "health", conclusion: selection.note });

  const alternatives = selection.considered
    .filter((s) => s.path !== selection.chosen)
    .map((s) => ({ toNodeId: s.path.toNodeId, why: s.explanation }));

  if (selection.chosen === null) {
    return {
      ...base,
      chosen: null,
      refusedAt: "NO_HEALTHY_ROUTE",
      alternatives,
      checks,
      explanation: `Not routed: ${eligible.length} route${eligible.length === 1 ? " was" : "s were"} permitted and none is usable. ${selection.note} This is an incident rather than a permission question — the topology is fine and the paths are not.`,
    };
  }

  return {
    ...base,
    chosen: selection.chosen,
    refusedAt: null,
    alternatives,
    checks,
    explanation: `${selection.note} Checked in order: expiry, permitted routes, classification, then health — health last, because a permission question must not be made moot by an unhealthy path.`,
  };
}

/**
 * Whether routing may ever add a path Nexus did not permit.
 *
 * Always false. A function so CI asserts it, because the pressure to relax it
 * arrives disguised as a latency improvement.
 */
export function routingMayWidenCandidates(): false {
  return false;
}

/**
 * The scheduling class a signal gets, bounded by policy.
 *
 * §6 and §11 both treat priority as a FABRIC scheduling class rather than a
 * business one. This clamps a requested priority to what the lane and policy
 * permit — a caller cannot promote its own traffic by asking, which is what
 * `EMERGENCY` would otherwise become within a week of shipping.
 */
export function effectivePriority(
  requested: FabricEnvelope["priority"],
  policyCeiling: FabricEnvelope["priority"],
): { readonly priority: FabricEnvelope["priority"]; readonly clamped: boolean; readonly note: string } {
  const rank: Record<FabricEnvelope["priority"], number> = { BULK: 0, NORMAL: 1, HIGH: 2, EMERGENCY: 3 };
  if (rank[requested] <= rank[policyCeiling]) {
    return { priority: requested, clamped: false, note: `Priority ${requested}, within the ${policyCeiling} ceiling.` };
  }
  return {
    priority: policyCeiling,
    clamped: true,
    note: `Requested ${requested} and clamped to ${policyCeiling}. A caller that could raise its own priority by asking would raise it always, and EMERGENCY would mean nothing within a week.`,
  };
}
