/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/fabricAdaptationIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Proposing a better topology, and never being allowed to apply one.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// PLASTICITY IN OUTCOME WITHOUT A SELF-AUTHORIZING NERVOUS SYSTEM
//
// §14 is the most delicate thing in the plan. The Fabric should strengthen
// useful paths, reroute around damage and prune dead links — behaviour that
// sounds like learning — while remaining explicit, inspectable, testable and
// governed. The line it draws is between OUTCOME and AUTHORITY: the shape of
// the network may improve from evidence; the network may not grant itself the
// right to change its own shape.
//
// The distinction lives in this file. Adaptation observes and PROPOSES. What it
// produces is a candidate: a described change with its evidence, its predicted
// effect and its rollback condition. There is no function here that applies
// one, and the digital twin — which is the thing that could most plausibly
// become an approver — returns a prediction and explicitly says it is not one.
//
// TWO KINDS OF CHANGE, AND ONLY ONE IS AUTOMATIC
//
// §27 splits them. Choosing among ALREADY APPROVED routes is runtime behaviour
// and needs no approval; creating a new relation, or widening what may reach
// what, is a governed act. `classifyCandidate` decides which a proposal is, and
// it errs toward governed — a candidate it cannot classify is treated as
// material, because the failure of guessing wrong in that direction is a
// delayed improvement and in the other direction is an ungoverned change.
//
// A SIMULATION IS EVIDENCE, NOT PERMISSION
//
// §18 says it outright and §33.2 repeats it for the twin: "The twin predicts
// operational consequences; it does not authorize a topology change." That is
// worth stating in code because a green simulation is the most persuasive thing
// in the room, and a system that auto-applied anything the twin liked would
// have moved the authority to whoever writes the simulation.
// ─────────────────────────────────────────────────────────────────────────────

export const candidateKindSchema = z.enum([
  /** Prefer one already-approved route over another. Runtime, within policy. */
  "REWEIGHT_APPROVED_ROUTES",
  /** Retire a route nothing has used. Narrowing. */
  "PRUNE_UNUSED_ROUTE",
  /** Create a relation that does not exist. Material. */
  "ADD_ADJACENCY",
  /** Let a node answer for something new. Material. */
  "ADD_CAPABILITY",
  /** Move a workload to a different zone. Material — it changes isolation. */
  "RELOCATE_NODE",
  /** Change how many partitions or replicas. Material at scale. */
  "CHANGE_CAPACITY",
]);
export type CandidateKind = z.infer<typeof candidateKindSchema>;

export const improvementCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    kind: candidateKindSchema,
    /** What is being proposed, in words a reviewer can argue with. */
    proposal: z.string().min(1).max(2000),
    /** Why. The observation that produced it. */
    observedEvidence: z.array(z.string().min(1)).min(1).max(50),
    /** What is expected to improve, and by how much. */
    predictedEffect: z.string().min(1).max(1000),
    /** What would make this a mistake. Required — see below. */
    rollbackCondition: z.string().min(1).max(1000),
    /** Which engine or analysis produced it. */
    proposedBy: z.string().min(1),
    proposedAt: z.string().min(1),
  })
  .strict();
export type ImprovementCandidate = z.infer<typeof improvementCandidateSchema>;

export type CandidateClassification = {
  readonly material: boolean;
  readonly requiresGovernance: boolean;
  readonly reason: string;
};

/**
 * Whether a candidate is a runtime adjustment or a material change.
 *
 * Errs toward material. Guessing wrong in that direction delays an
 * improvement; guessing wrong the other way makes an ungoverned change to what
 * can reach what, and only one of those is recoverable by noticing later.
 */
export function classifyCandidate(kind: CandidateKind): CandidateClassification {
  switch (kind) {
    case "REWEIGHT_APPROVED_ROUTES":
      return {
        material: false,
        requiresGovernance: false,
        reason:
          "Choosing among routes that are already approved is runtime behaviour within policy (§27). It creates no relation and grants no authority — the same set of things can reach the same set of things afterwards.",
      };
    case "PRUNE_UNUSED_ROUTE":
      return {
        material: false,
        requiresGovernance: true,
        reason:
          "Pruning only narrows, so it cannot grant anything — but a route that looks unused may be a chartered continuity path used once a quarter, and §27 requires approval where it is part of a required capability. Not material, and still governed.",
      };
    case "ADD_ADJACENCY":
    case "ADD_CAPABILITY":
      return {
        material: true,
        requiresGovernance: true,
        reason:
          "This creates a new material topology relation: something can reach something it could not before. §27 reserves that for governed approval, and no amount of supporting evidence changes who decides it.",
      };
    case "RELOCATE_NODE":
      return {
        material: true,
        requiresGovernance: true,
        reason:
          "Moving a node between zones changes its isolation boundary, which changes what it may relate to. It reads as an operational move and is a permission change.",
      };
    case "CHANGE_CAPACITY":
      return {
        material: true,
        requiresGovernance: true,
        reason:
          "Capacity changes look purely operational and are not: repartitioning breaks ordering guarantees permanently for the keys that move, and replica changes alter failure domains.",
      };
  }
}

/**
 * Whether adaptation may apply its own candidate.
 *
 * Always false, and there is no function in this module that applies one. §33.1
 * puts it plainly: FabricAdaptationIQ "never self-deploys."
 */
export function adaptationMayApply(): false {
  return false;
}

export type ProposalOutcome =
  | { readonly accepted: true; readonly candidate: ImprovementCandidate; readonly classification: CandidateClassification }
  | { readonly accepted: false; readonly reason: string; readonly issues: readonly string[] };

/**
 * Validates a proposal before anybody spends time reviewing it.
 *
 * The rollback condition is required by the schema, which is the unusual part.
 * A proposal that cannot say what would make it a mistake has not been thought
 * through far enough to review — and asking for it at proposal time is far
 * cheaper than asking for it at 3am.
 */
export function proposeImprovement(raw: unknown): ProposalOutcome {
  const parsed = improvementCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      accepted: false,
      reason: "This is not a valid improvement candidate and was not queued for review.",
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { accepted: true, candidate: parsed.data, classification: classifyCandidate(parsed.data.kind) };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DIGITAL TWIN
// ─────────────────────────────────────────────────────────────────────────────

export const faultKindSchema = z.enum([
  "NODE_LOSS",
  "REGIONAL_PARTITION",
  "PROVIDER_FAILURE",
  "LATENCY_SPIKE",
  "MESSAGE_DUPLICATION",
  "CONGESTION",
  "SCHEMA_INCOMPATIBILITY",
  "CERTIFICATE_EXPIRY",
  "ROUTE_REMOVAL",
  "COLLECTIVE_OUTAGE",
]);
export type FaultKind = z.infer<typeof faultKindSchema>;

export interface SimulationScenario {
  readonly scenarioId: string;
  readonly fault: FaultKind;
  /** What the fault is applied to. */
  readonly target: string;
  /** Whether the traffic shape is synthetic or a privacy-safe sample. */
  readonly trafficSource: "SYNTHETIC" | "PRIVACY_SAFE_SAMPLE";
}

export interface SimulationResult {
  readonly scenarioId: string;
  readonly fault: FaultKind;
  /** Capabilities with no provider left under this fault. */
  readonly capabilitiesLost: readonly string[];
  /** Whether local instance work continued. */
  readonly localWorkSurvived: boolean;
  /** Whether isolation boundaries held. */
  readonly isolationHeld: boolean;
  readonly recoveredWithinBudget: boolean;
  readonly note: string;
}

export type TwinVerdict = {
  readonly wouldSurvive: boolean;
  readonly failures: readonly string[];
  readonly isAuthorization: false;
  readonly note: string;
};

/**
 * What the twin concluded, and what that does and does not permit.
 *
 * `isAuthorization` is the literal `false` in the return type. A green
 * simulation is the most persuasive thing in the room, and a system that
 * auto-applied anything the twin liked would have moved the authority to
 * whoever writes the simulations.
 */
export function summariseSimulation(results: readonly SimulationResult[]): TwinVerdict {
  const failures: string[] = [];

  for (const result of [...results].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))) {
    if (!result.localWorkSurvived) {
      failures.push(
        `${result.scenarioId} (${result.fault}): local work stopped. §33.6 requires the Fabric to remain operational locally, and this scenario breaks that — it is a hard gate rather than a performance concern.`,
      );
    }
    if (!result.isolationHeld) {
      failures.push(
        `${result.scenarioId} (${result.fault}): an isolation boundary did not hold. A fault that leaks across a tenant or instance boundary is a security finding, not a resilience one.`,
      );
    }
    if (result.capabilitiesLost.length > 0) {
      failures.push(
        `${result.scenarioId} (${result.fault}): ${result.capabilitiesLost.join(", ")} had no provider left. Whether that is acceptable depends on the capability, and the simulation cannot decide it.`,
      );
    }
    if (!result.recoveredWithinBudget) {
      failures.push(`${result.scenarioId} (${result.fault}): recovery took longer than its budget.`);
    }
  }

  return {
    wouldSurvive: failures.length === 0,
    failures,
    isAuthorization: false,
    note:
      failures.length === 0
        ? `All ${results.length} scenarios passed. This is EVIDENCE that the change is survivable, and it is not permission to apply it — the twin predicts consequences and does not authorize anything (§33.2).`
        : `${failures.length} finding${failures.length === 1 ? "" : "s"} across ${results.length} scenarios. A candidate with an unresolved hard-gate failure should not reach a governance review at all; fix it or withdraw it.`,
  };
}

/**
 * Whether production payloads may be copied into the twin.
 *
 * False. §33.2: "Do not copy production private payloads into a shared
 * simulator by default." A simulator holding real customer data is a second
 * copy of the data with none of the controls, and it is the copy nobody
 * remembers to include in a retention policy.
 */
export function twinMayUseProductionPayloads(): false {
  return false;
}

/**
 * The scenarios a material candidate must pass before review.
 *
 * Derived from the kind, so a proposal cannot arrive with a convenient short
 * list. §33.2 requires stress-testing against resilience, security,
 * performance, isolation and rollback.
 */
export function requiredScenarios(kind: CandidateKind): readonly FaultKind[] {
  const base: FaultKind[] = ["NODE_LOSS", "LATENCY_SPIKE", "CONGESTION"];
  switch (kind) {
    case "ADD_ADJACENCY":
    case "ADD_CAPABILITY":
      return [...base, "SCHEMA_INCOMPATIBILITY", "CERTIFICATE_EXPIRY", "COLLECTIVE_OUTAGE"];
    case "RELOCATE_NODE":
      return [...base, "REGIONAL_PARTITION", "COLLECTIVE_OUTAGE"];
    case "CHANGE_CAPACITY":
      return [...base, "PROVIDER_FAILURE", "MESSAGE_DUPLICATION"];
    case "PRUNE_UNUSED_ROUTE":
      return [...base, "ROUTE_REMOVAL"];
    case "REWEIGHT_APPROVED_ROUTES":
      return base;
  }
}

export type ReadinessVerdict =
  | { readonly ready: true; readonly note: string }
  | { readonly ready: false; readonly missing: readonly FaultKind[]; readonly note: string };

/** Whether a candidate has been simulated against everything its kind requires. */
export function readyForReview(
  candidate: ImprovementCandidate,
  simulated: readonly FaultKind[],
): ReadinessVerdict {
  const required = requiredScenarios(candidate.kind);
  const missing = required.filter((f) => !simulated.includes(f));

  if (missing.length > 0) {
    return {
      ready: false,
      missing,
      note: `"${candidate.candidateId}" has not been simulated against ${missing.join(", ")}. The list is derived from the kind of change rather than chosen by the proposer, so a candidate cannot arrive with a convenient short list of scenarios it happens to pass.`,
    };
  }

  return {
    ready: true,
    note: `"${candidate.candidateId}" has been simulated against all ${required.length} scenarios its kind requires. Ready for a governance review — which is a different thing from approved.`,
  };
}
