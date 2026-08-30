/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/pulse/degradedMode.ts
 * Module:   neural-fabric / pulse
 * Purpose:  What still works when part of the world is unreachable.
 */

import type { Lane } from "../domain/lanes.js";
import type { ZoneKind } from "../domain/topology.js";

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL FIRST, COLLECTIVE SECOND
//
// The single most consequential availability decision in the plan, stated in
// §1 and repeated in §17 and §21: each Hive Instance must retain ordinary local
// communication when the Collective or remote fabric is unavailable.
//
// It sounds obvious and it is routinely violated, because the violation is
// invisible in normal operation. A local engine calls a local engine, and
// somewhere in that path is a lookup against a shared service. Everything works
// for a year. Then the link to the Collective goes down and local order intake
// stops, in a system whose architecture diagram says it shouldn't.
//
// So degradation here is EXPLICIT: a named mode per unreachable zone kind, a
// stated list of what still works, and a stated list of what does not. Not so
// the code can consult it — so a person can read it before the outage and
// disagree with it.
//
// A DEGRADED MODE THAT NOBODY DECLARED IS AN OUTAGE
//
// The distinction this module keeps is between a degraded mode that was
// designed and one that merely happened. `UNDECLARED` exists for the second.
// If a zone kind has no defined behaviour when it is lost, that is a gap in
// the design and it should read as one — not as a default that quietly permits
// or quietly refuses.
// ─────────────────────────────────────────────────────────────────────────────

export type FabricMode =
  /** Everything reachable. */
  | "NORMAL"
  /** The Collective is unreachable. Local work continues; shared services do not. */
  | "LOCAL_ONLY"
  /** A region is unreachable. Local and other regions continue. */
  | "REGION_ISOLATED"
  /** A gateway is down. Cross-instance work stops; local continues. */
  | "GATEWAY_DOWN"
  /** The local zone itself is impaired. This is the one that is an outage. */
  | "LOCAL_IMPAIRED";

export interface ModeDefinition {
  readonly mode: FabricMode;
  readonly trigger: string;
  /** Lanes that keep working. */
  readonly lanesAvailable: readonly Lane[];
  /** Lanes that stop, and what a caller sees instead. */
  readonly lanesSuspended: readonly Lane[];
  /** Whether local engine-to-engine work continues. */
  readonly localWorkContinues: boolean;
  readonly operatorNote: string;
}

const ALL_LANES: readonly Lane[] = [
  "QUERY",
  "COMMAND",
  "EVENT",
  "STREAM",
  "WORKFLOW",
  "EVIDENCE",
  "HEALTH",
  "ARTIFACT",
];

export const MODE_DEFINITIONS: Readonly<Record<FabricMode, ModeDefinition>> = Object.freeze({
  NORMAL: {
    mode: "NORMAL",
    trigger: "Every zone the instance depends on is reachable.",
    lanesAvailable: ALL_LANES,
    lanesSuspended: [],
    localWorkContinues: true,
    operatorNote: "Nothing to do.",
  },
  LOCAL_ONLY: {
    mode: "LOCAL_ONLY",
    trigger: "The Collective is unreachable.",
    lanesAvailable: ALL_LANES,
    lanesSuspended: [],
    localWorkContinues: true,
    operatorNote:
      "Local operation is UNAFFECTED, which is the point. Collective services — generalized knowledge, shared lookups, cross-instance collaboration — are unavailable, and anything that silently depended on one will fail. Those failures are the finding: a local path that breaks here was never local.",
  },
  REGION_ISOLATED: {
    mode: "REGION_ISOLATED",
    trigger: "A regional zone is unreachable from this instance.",
    lanesAvailable: ALL_LANES,
    lanesSuspended: [],
    localWorkContinues: true,
    operatorNote:
      "Traffic that would have crossed the region is refused rather than queued indefinitely. Refusing is deliberate: an unbounded queue waiting for a region to return is how a regional fault becomes a local memory problem.",
  },
  GATEWAY_DOWN: {
    mode: "GATEWAY_DOWN",
    trigger: "The Interconnect gateway is unreachable.",
    lanesAvailable: ALL_LANES,
    lanesSuspended: [],
    localWorkContinues: true,
    operatorNote:
      "Cross-instance work stops entirely and does not reroute. There is no alternative path by design — §17 requires cross-instance routes to terminate at explicit gateways, so 'find another way' would mean going around the boundary that exists to be gone through.",
  },
  LOCAL_IMPAIRED: {
    mode: "LOCAL_IMPAIRED",
    trigger: "The local zone itself is impaired.",
    lanesAvailable: ["EVIDENCE", "HEALTH"],
    lanesSuspended: ["QUERY", "COMMAND", "EVENT", "STREAM", "WORKFLOW", "ARTIFACT"],
    localWorkContinues: false,
    operatorNote:
      "This is an outage, not a degraded mode. Evidence and health stay up so the incident is still recorded and still visible — losing the ability to see the failure is worse than the failure.",
  },
});

export type ModeResolution =
  | { readonly declared: true; readonly definition: ModeDefinition }
  | { readonly declared: false; readonly reason: string };

/**
 * The mode implied by an unreachable zone kind.
 *
 * SANDBOX returns UNDECLARED deliberately. A sandbox becoming unreachable has
 * no defined effect on production because a sandbox has no production effect
 * at all — and inventing a mode for it would imply that it does.
 */
export function modeForUnreachableZone(kind: ZoneKind): ModeResolution {
  switch (kind) {
    case "COLLECTIVE":
      return { declared: true, definition: MODE_DEFINITIONS.LOCAL_ONLY };
    case "REGIONAL":
      return { declared: true, definition: MODE_DEFINITIONS.REGION_ISOLATED };
    case "GATEWAY":
      return { declared: true, definition: MODE_DEFINITIONS.GATEWAY_DOWN };
    case "LOCAL":
      return { declared: true, definition: MODE_DEFINITIONS.LOCAL_IMPAIRED };
    case "SANDBOX":
      return {
        declared: false,
        reason:
          "A sandbox becoming unreachable has no declared effect on production, because a sandbox has no production effect to lose. Defining a mode for it would imply otherwise.",
      };
  }
}

/**
 * Whether local work should continue given a set of unreachable zone kinds.
 *
 * The hard gate from §33.6, as a function: the Fabric remains operational
 * locally during a Collective outage. This returns true for every combination
 * that does not include the local zone itself.
 */
export function localWorkContinues(unreachable: readonly ZoneKind[]): {
  readonly continues: boolean;
  readonly reason: string;
} {
  if (unreachable.includes("LOCAL")) {
    return {
      continues: false,
      reason: "The local zone itself is unreachable. This is an outage; there is no degraded mode that recovers local work when local is what is gone.",
    };
  }
  return {
    continues: true,
    reason: `Local work continues. ${unreachable.length === 0 ? "Nothing is unreachable." : `${unreachable.join(", ")} ${unreachable.length === 1 ? "is" : "are"} unreachable, and none of them is a local runtime dependency — that is the whole meaning of "local first, Collective second".`}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTITION DETECTION
// ─────────────────────────────────────────────────────────────────────────────

export interface PartitionEvidence {
  readonly zoneId: string;
  readonly zoneKind: ZoneKind;
  /** How many consecutive heartbeat windows have been missed. */
  readonly missedHeartbeats: number;
  /** Whether anything else in that zone is still answering. */
  readonly othersInZoneReachable: boolean;
}

export interface PartitionPolicy {
  /** Missed heartbeats before declaring a partition. */
  readonly missedHeartbeatThreshold: number;
}

export type PartitionVerdict =
  | { readonly partitioned: true; readonly mode: ModeResolution; readonly reason: string }
  | { readonly partitioned: false; readonly reason: string };

/**
 * Whether a zone is partitioned or merely has a sick node in it.
 *
 * The distinction is the whole value. Declaring a partition when one node is
 * down triggers a mode change across the instance for a fault that affects one
 * path — and mode changes are expensive and visible. Requiring that NOTHING in
 * the zone answers is what keeps the signal meaningful.
 */
export function detectPartition(
  evidence: PartitionEvidence,
  policy: PartitionPolicy,
): PartitionVerdict {
  if (evidence.missedHeartbeats < policy.missedHeartbeatThreshold) {
    return {
      partitioned: false,
      reason: `${evidence.missedHeartbeats} missed heartbeat${evidence.missedHeartbeats === 1 ? "" : "s"} against a threshold of ${policy.missedHeartbeatThreshold}. Not yet a partition — a threshold of one would declare a partition on ordinary jitter.`,
    };
  }

  if (evidence.othersInZoneReachable) {
    return {
      partitioned: false,
      reason: `Heartbeats are missing, and other participants in zone ${evidence.zoneId} are still answering. That is a sick node, not a partition. Changing the instance's mode for one bad path would be an expensive, visible response to a local fault.`,
    };
  }

  return {
    partitioned: true,
    mode: modeForUnreachableZone(evidence.zoneKind),
    reason: `Zone ${evidence.zoneId} has missed ${evidence.missedHeartbeats} heartbeats and nothing in it is answering. Treated as a partition.`,
  };
}

/**
 * Whether the Fabric may become MORE permissive while degraded.
 *
 * Always false. Degradation is a reason to be careful, never a reason to relax
 * — and "we could not reach the authorizer so we proceeded" is the shape of
 * the worst outage this system could have. §33.4 says the same thing about
 * Sentinel: an outage there tightens posture rather than loosening it.
 */
export function degradationMayRelaxRules(): false {
  return false;
}
