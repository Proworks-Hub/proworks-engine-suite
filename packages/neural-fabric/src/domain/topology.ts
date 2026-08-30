/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/domain/topology.ts
 * Module:   neural-fabric / domain
 * Purpose:  What is connected to what, on which lane, and by whose decision.
 */

import { z } from "zod";

import { laneSchema } from "./lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT DENY, AND THE ADJACENCY IS THE UNIT
//
// §33.3 requires default-deny lane and route relationships: only explicitly
// admitted identities and capabilities may communicate. That single decision
// shapes this whole model.
//
// The consequence is that an ADJACENCY — one directed, lane-scoped permission
// from one node to another — is the unit of topology, not the node. A node
// existing in the graph grants it nothing. Two nodes in the same zone still
// cannot speak. Every path a signal can take is the composition of adjacencies
// somebody decided to create.
//
// It is more verbose than a zone-level allow, and that verbosity is the point:
// a zone-level allow is a decision made once about traffic nobody has imagined
// yet, and it is discovered later as "how did those two ever get connected?".
//
// LANE-SCOPED, BECAUSE "CONNECTED" IS NOT ONE THING
//
// An adjacency permits a lane, not a relationship. Ordering may send commands
// to manufacturing; that does not mean manufacturing may send commands back,
// and it does not mean ordering may subscribe to manufacturing's evidence
// lane. Modelling connectivity as a single boolean is how an audit trail
// becomes readable by the system it audits.
//
// A TOPOLOGY VERSION IS IMMUTABLE
//
// §15 requires snapshots, diff, simulation, rollback and retirement. All of
// those need the old version to still exist. So a version is never edited —
// a change produces a new version with a parent, and activation is a separate
// act from creation. That separation is what makes "propose, simulate,
// approve, apply, verify" (§14) expressible rather than aspirational.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a node sits, which decides what it may reach. */
export const zoneKindSchema = z.enum([
  /** Inside one Hive Instance. The default, and the only one that must always work. */
  "LOCAL",
  /** A routing region grouping several local zones. */
  "REGIONAL",
  /** Shared Collective services. Never a mandatory local dependency. */
  "COLLECTIVE",
  /** An isolated simulation domain. Cannot reach production, ever. */
  "SANDBOX",
  /** The bounded interface to hosts, external systems and other Instances. */
  "GATEWAY",
]);
export type ZoneKind = z.infer<typeof zoneKindSchema>;

export const zoneSchema = z
  .object({
    zoneId: z.string().min(1),
    kind: zoneKindSchema,
    instanceId: z.string().min(1),
    /** The region a regional zone belongs to, for locality preference. */
    regionId: z.string().min(1).optional(),
  })
  .strict();
export type Zone = z.infer<typeof zoneSchema>;

/** What kind of participant a node is. Affects nothing but explains much. */
export const nodeKindSchema = z.enum([
  "ENGINE",
  "HOST_APPLICATION",
  "AGENT",
  "AI_WORKLOAD",
  "EXTERNAL_SYSTEM",
  "GATEWAY",
  "PROVIDER_ADAPTER",
]);
export type NodeKind = z.infer<typeof nodeKindSchema>;

export const fabricNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    kind: nodeKindSchema,
    zoneId: z.string().min(1),
    /** What this node can answer for. Addressing is by capability, not by node. */
    capabilities: z.array(z.string().min(1)).min(1).max(200),
    /**
     * The identity Security IQ issued, as a reference.
     *
     * A reference and not a credential. The Fabric does not verify identity —
     * it records which verified identity a node was admitted under, so a
     * revocation elsewhere can be matched to the nodes it affects.
     */
    workloadIdentityRef: z.string().min(1),
    /** Whether this node exists only for a test run. */
    isTest: z.boolean(),
  })
  .strict();
export type FabricNode = z.infer<typeof fabricNodeSchema>;

/**
 * One directed, lane-scoped permission to communicate.
 *
 * Directed because "A may command B" is not "B may command A", and modelling
 * it undirected is how a downstream service acquires the ability to drive its
 * caller.
 */
export const adjacencySchema = z
  .object({
    adjacencyId: z.string().min(1),
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    lane: laneSchema,
    /** The specific capability this permits addressing. */
    capability: z.string().min(1),
    /**
     * The Governance decision that created this.
     *
     * Required. An adjacency with no decision behind it is a connection
     * nobody approved, and §27 reserves new material topology relations for
     * governed approval. There is no path in this package that creates one
     * without a decision reference.
     */
    authorizingDecisionRef: z.string().min(1),
    /** Whether this edge is currently usable, without deleting the history. */
    state: z.enum(["ACTIVE", "QUARANTINED", "RETIRED"]),
  })
  .strict();
export type Adjacency = z.infer<typeof adjacencySchema>;

export const topologyVersionSchema = z
  .object({
    versionId: z.string().min(1),
    /** The version this was derived from. Null only for the first. */
    parentVersionId: z.string().min(1).nullable(),
    instanceId: z.string().min(1),
    zones: z.array(zoneSchema),
    nodes: z.array(fabricNodeSchema),
    adjacencies: z.array(adjacencySchema),
    /** Why this version exists, in the words of whoever proposed it. */
    rationale: z.string().min(1).max(2000),
    createdAt: z.string().min(1),
    /**
     * Activation is separate from creation, and this is how.
     *
     * A version is a proposal until something activates it. §14's sequence —
     * observe, propose, simulate, approve, apply, verify — needs a state in
     * which the topology exists and is not in force.
     */
    state: z.enum(["DRAFT", "SIMULATED", "APPROVED", "ACTIVE", "SUPERSEDED", "ROLLED_BACK"]),
    /** The Governance decision that approved activation. Null until approved. */
    activationDecisionRef: z.string().min(1).nullable(),
  })
  .strict();
export type TopologyVersion = z.infer<typeof topologyVersionSchema>;

/**
 * Which state transitions a topology version may make.
 *
 * DRAFT and SIMULATED can go backwards to DRAFT — editing a proposal is
 * normal. ACTIVE cannot: an active topology is what traffic is flowing over,
 * and "edit it back to draft" would mean changing the rules under signals
 * already in flight. Correcting an active topology means a new version, which
 * keeps the old one available to roll back to.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TopologyVersion["state"], readonly TopologyVersion["state"][]>> =
  Object.freeze({
    DRAFT: ["SIMULATED", "APPROVED"],
    SIMULATED: ["DRAFT", "APPROVED"],
    APPROVED: ["ACTIVE", "DRAFT"],
    ACTIVE: ["SUPERSEDED", "ROLLED_BACK"],
    SUPERSEDED: [],
    ROLLED_BACK: [],
  });

export type TransitionOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function transitionAllowed(
  from: TopologyVersion["state"],
  to: TopologyVersion["state"],
): TransitionOutcome {
  if (ALLOWED_TRANSITIONS[from].includes(to)) return { allowed: true };

  if (from === "ACTIVE" && to === "DRAFT") {
    return {
      allowed: false,
      reason:
        "An active topology cannot be edited back to a draft. Traffic is flowing over it, and changing it in place would alter the rules under signals already in flight. Create a new version instead — the active one stays available to roll back to.",
    };
  }
  if (from === "SUPERSEDED" || from === "ROLLED_BACK") {
    return {
      allowed: false,
      reason: `A ${from} version is history. Reviving it would rewrite what a past routing decision was made under; derive a new version from it instead.`,
    };
  }
  if (from === "DRAFT" && to === "ACTIVE") {
    return {
      allowed: false,
      reason:
        "A draft cannot become active directly. Approval is a separate act from creation, which is what makes propose-simulate-approve-apply a sequence rather than a description of one step.",
    };
  }
  return {
    allowed: false,
    reason: `${from} cannot become ${to}.`,
  };
}

/**
 * Whether a zone may hold a route to another zone AT ALL.
 *
 * The coarse check, before any adjacency is considered. Both must pass: this
 * says the zones are permitted to relate, and an adjacency says these two
 * specific nodes are, on this specific lane.
 *
 * SANDBOX is the sharp one. §18 gives each sandbox an isolated namespace, and
 * a sandbox that could reach production would make every simulation a
 * potential production incident. It is refused in both directions — a
 * production node reaching INTO a sandbox is how test data becomes real data.
 */
export function zonesMayRelate(
  from: Zone,
  to: Zone,
): { readonly permitted: boolean; readonly reason: string } {
  if (from.kind === "SANDBOX" || to.kind === "SANDBOX") {
    if (from.kind === "SANDBOX" && to.kind === "SANDBOX" && from.instanceId === to.instanceId) {
      return { permitted: true, reason: "Both zones are sandboxes in the same instance." };
    }
    return {
      permitted: false,
      reason:
        "A sandbox zone is isolated in both directions. Reaching out would make every simulation a potential production incident; reaching in is how test data becomes real data.",
    };
  }

  if (from.instanceId !== to.instanceId) {
    if (from.kind !== "GATEWAY" && to.kind !== "GATEWAY") {
      return {
        permitted: false,
        reason:
          "A route between instances must terminate at a gateway zone. §17 does not permit the Fabric to traverse another instance directly — that would be shared private-store access with extra steps.",
      };
    }
    return { permitted: true, reason: "Cross-instance route terminating at a gateway zone." };
  }

  return { permitted: true, reason: `Both zones are in instance ${from.instanceId}.` };
}

/**
 * Whether losing this zone should stop local work.
 *
 * COLLECTIVE is false, and that is the whole "local first, Collective second"
 * principle in one function. §17: Collective connectivity must not be a
 * mandatory local runtime dependency.
 */
export function zoneLossStopsLocalWork(kind: ZoneKind): boolean {
  return kind === "LOCAL";
}
