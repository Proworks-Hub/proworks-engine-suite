/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/distributed/activationConsensus.ts
 * Module:   neural-fabric / distributed
 * Purpose:  One topology active at a time, across replicas that can disagree.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS STRONGLY CONSISTENT, AND WHY SO LITTLE
//
// §21 requires Nexus and Pulse to be replicated, and replication forces the
// question every distributed system answers badly by default: which state
// needs every replica to agree BEFORE acting, and which merely needs them to
// converge EVENTUALLY?
//
// The strong set is deliberately tiny, because strong consistency is paid for
// in availability, and this system's first availability rule is that local
// work continues through partitions:
//
//   STRONG      topology activation, security-sensitive provider bindings,
//               governed upgrade state, cross-instance gateway grants.
//               These change what is PERMITTED. Two replicas acting on
//               different permissions is two different security systems
//               wearing one name.
//
//   EVENTUAL    path latency, health summaries, saturation, advisory routing
//               scores. These change what is PREFERRED. Two replicas briefly
//               preferring different healthy routes is load balancing.
//
// The rule of thumb the split falls out of: anything a compromise could
// exploit must be strong; anything a delay merely makes suboptimal may be
// eventual.
//
// EPOCHS AND QUORUMS, AS PURE STATE MACHINES
//
// This module implements the agreement logic as deterministic functions over
// explicit state — no network, no timers, no threads. That is not a toy
// simplification: the LOGIC is where split-brain bugs live, and logic that is
// pure can be driven through every interleaving a test can imagine, which no
// amount of integration testing against real replicas achieves. A host wires
// the message-passing; the decisions come from here.
//
// SPLIT-BRAIN PREVENTION IS ARITHMETIC
//
// A quorum is a strict majority of the CONFIGURED replica set — not of the
// replicas currently reachable. Counting only the reachable ones is the
// classic self-inflicted split brain: both sides of a partition see "all
// replicas I can reach agree" and both proceed. The majority of a fixed
// denominator can, by arithmetic, exist on at most one side of any partition.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplicaSet {
  /** The CONFIGURED membership. The quorum denominator, always. */
  readonly replicaIds: readonly string[];
}

export function quorumSize(replicas: ReplicaSet): number {
  return Math.floor(replicas.replicaIds.length / 2) + 1;
}

export interface ActivationProposal {
  readonly topologyVersionId: string;
  /** Monotonic. A higher epoch supersedes a lower one, always. */
  readonly epoch: number;
  readonly proposedBy: string;
  readonly activationDecisionRef: string;
}

export interface ReplicaVote {
  readonly replicaId: string;
  readonly epoch: number;
  readonly topologyVersionId: string;
  readonly granted: boolean;
  readonly reason: string;
}

export interface ReplicaState {
  readonly replicaId: string;
  /** The highest epoch this replica has promised or accepted. */
  readonly highestEpochSeen: number;
  /** The activation this replica currently holds as active. */
  readonly activeVersionId: string | null;
  readonly activeEpoch: number;
}

/**
 * How one replica answers a proposal. Pure.
 *
 * The promise rule is the whole safety argument: once a replica has seen
 * epoch N it refuses everything below N forever. Two proposals in the same
 * epoch cannot both gather a quorum, because each replica votes at most once
 * per epoch — and epochs from rival proposers are distinct by construction
 * when allocated through `nextEpoch`.
 */
export function vote(state: ReplicaState, proposal: ActivationProposal): {
  readonly vote: ReplicaVote;
  readonly newState: ReplicaState;
} {
  if (proposal.epoch <= state.highestEpochSeen) {
    return {
      vote: {
        replicaId: state.replicaId,
        epoch: proposal.epoch,
        topologyVersionId: proposal.topologyVersionId,
        granted: false,
        reason: `Epoch ${proposal.epoch} is not above ${state.highestEpochSeen}, which this replica has already promised. A replica that voted twice in one epoch is how two activations both believe they won.`,
      },
      newState: state,
    };
  }

  return {
    vote: {
      replicaId: state.replicaId,
      epoch: proposal.epoch,
      topologyVersionId: proposal.topologyVersionId,
      granted: true,
      reason: `Granted for epoch ${proposal.epoch}. This replica now refuses every epoch at or below it, permanently.`,
    },
    newState: { ...state, highestEpochSeen: proposal.epoch },
  };
}

export type ConsensusOutcome =
  | { readonly committed: true; readonly versionId: string; readonly epoch: number; readonly note: string }
  | { readonly committed: false; readonly reason: string };

/**
 * Whether a proposal gathered a quorum.
 *
 * The denominator is the CONFIGURED set. §21's split-brain rule, as
 * arithmetic: a majority of a fixed denominator exists on at most one side of
 * any partition.
 */
export function tally(
  replicas: ReplicaSet,
  proposal: ActivationProposal,
  votes: readonly ReplicaVote[],
): ConsensusOutcome {
  const needed = quorumSize(replicas);

  // Only votes FOR this proposal's epoch and version, from CONFIGURED
  // replicas, counted once each. A vote from an unknown replica is an
  // attacker's vote or a misconfiguration, and both are refused.
  const valid = new Set<string>();
  for (const v of votes) {
    if (!v.granted) continue;
    if (v.epoch !== proposal.epoch || v.topologyVersionId !== proposal.topologyVersionId) continue;
    if (!replicas.replicaIds.includes(v.replicaId)) continue;
    valid.add(v.replicaId);
  }

  if (valid.size < needed) {
    return {
      committed: false,
      reason: `${valid.size} of ${needed} required votes (from ${replicas.replicaIds.length} configured replicas). The denominator is the CONFIGURED set, not the reachable one — counting only reachable replicas is how both sides of a partition convince themselves they have a majority.`,
    };
  }

  return {
    committed: true,
    versionId: proposal.topologyVersionId,
    epoch: proposal.epoch,
    note: `Committed at epoch ${proposal.epoch} with ${valid.size}/${replicas.replicaIds.length} votes. At most one proposal per epoch can reach this line.`,
  };
}

/**
 * Applies a committed activation to a replica. Pure.
 *
 * A replica applies only commitments at or above its own epoch — a commitment
 * from the past is a message that took the long way round, and applying it
 * would roll the replica backwards without anybody deciding to roll back.
 */
export function applyCommit(
  state: ReplicaState,
  outcome: ConsensusOutcome,
): { readonly applied: boolean; readonly newState: ReplicaState; readonly reason: string } {
  if (!outcome.committed) {
    return { applied: false, newState: state, reason: "Nothing was committed; nothing applies." };
  }
  if (outcome.epoch < state.activeEpoch) {
    return {
      applied: false,
      newState: state,
      reason: `Commitment at epoch ${outcome.epoch} is older than the active epoch ${state.activeEpoch}. A late-arriving commitment is a message that took the long way round, and applying it would be a rollback nobody decided.`,
    };
  }
  return {
    applied: true,
    newState: {
      ...state,
      activeVersionId: outcome.versionId,
      activeEpoch: outcome.epoch,
      highestEpochSeen: Math.max(state.highestEpochSeen, outcome.epoch),
    },
    reason: `Active topology is now ${outcome.versionId} at epoch ${outcome.epoch}.`,
  };
}

/**
 * A deliberate rollback IS an activation — of the older version, at a NEW epoch.
 *
 * There is no "undo" primitive, on purpose. Undoing by decrementing state
 * would race every in-flight message; rolling back by activating the previous
 * version at a higher epoch reuses the one safety argument this module has,
 * and leaves the rollback in the history as what it is: a decision.
 */
export function rollbackProposal(
  toVersionId: string,
  currentEpoch: number,
  proposedBy: string,
  activationDecisionRef: string,
): ActivationProposal {
  return {
    topologyVersionId: toVersionId,
    epoch: currentEpoch + 1,
    proposedBy,
    activationDecisionRef,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STALE REPLICAS AND RECOVERY
// ─────────────────────────────────────────────────────────────────────────────

export type ReplicaAssessment =
  | { readonly status: "CURRENT"; readonly note: string }
  | { readonly status: "BEHIND"; readonly note: string; readonly mustCatchUpTo: number }
  | { readonly status: "AHEAD"; readonly note: string };

/**
 * Where a recovering replica stands against the committed majority.
 *
 * AHEAD is the interesting one: a replica claiming an epoch the quorum never
 * committed has state from a proposal that FAILED — it voted, applied
 * optimistically, and the commit never came. It must discard, not negotiate:
 * its state describes a world that was proposed and did not happen.
 */
export function assessReplica(state: ReplicaState, committedEpoch: number, committedVersionId: string | null): ReplicaAssessment {
  if (state.activeEpoch === committedEpoch && state.activeVersionId === committedVersionId) {
    return { status: "CURRENT", note: `In agreement at epoch ${committedEpoch}.` };
  }
  if (state.activeEpoch < committedEpoch) {
    return {
      status: "BEHIND",
      mustCatchUpTo: committedEpoch,
      note: `At epoch ${state.activeEpoch} against a committed ${committedEpoch}. Catch up by applying the committed activations in order — a behind replica serves STALE topology, which is safe within the data plane's grace rules and must not vote as if current.`,
    };
  }
  return {
    status: "AHEAD",
    note: `Claims epoch ${state.activeEpoch} above the committed ${committedEpoch}. This replica applied a proposal that never gathered a quorum — its state describes a world that was proposed and did not happen. It discards and re-syncs; it does not negotiate, because 'the failed proposal was probably fine' is exactly the reasoning consensus exists to forbid.`,
  };
}

/**
 * Whether the eventual-consistency set may diverge during a partition.
 *
 * Yes, and stating it is the point: health summaries, latency and scores are
 * ALLOWED to differ between replicas, converging when the partition heals.
 * Pulse's convergence rule is last-observation-wins per path, which loses
 * nothing that matters — a superseded health reading has no value at all.
 */
export function mayDivergeDuringPartition(
  kind: "TOPOLOGY_ACTIVATION" | "PROVIDER_BINDING" | "UPGRADE_STATE" | "GATEWAY_GRANT" | "PATH_HEALTH" | "LATENCY" | "SATURATION" | "ROUTING_SCORE",
): { readonly mayDiverge: boolean; readonly reason: string } {
  switch (kind) {
    case "TOPOLOGY_ACTIVATION":
    case "PROVIDER_BINDING":
    case "UPGRADE_STATE":
    case "GATEWAY_GRANT":
      return {
        mayDiverge: false,
        reason: `${kind} changes what is PERMITTED. Two replicas acting on different permissions is two different security systems wearing one name — this state moves only by quorum.`,
      };
    case "PATH_HEALTH":
    case "LATENCY":
    case "SATURATION":
    case "ROUTING_SCORE":
      return {
        mayDiverge: true,
        reason: `${kind} changes what is PREFERRED. Two replicas briefly preferring different healthy routes is load balancing, and converges by last-observation-wins when the partition heals.`,
      };
  }
}

/** Pulse convergence after a partition heals: last observation per path wins. */
export function convergeHealth(
  a: ReadonlyMap<string, { readonly health: string; readonly observedAt: string }>,
  b: ReadonlyMap<string, { readonly health: string; readonly observedAt: string }>,
): ReadonlyMap<string, { readonly health: string; readonly observedAt: string }> {
  const merged = new Map(a);
  for (const [key, observation] of b) {
    const existing = merged.get(key);
    if (!existing || observation.observedAt > existing.observedAt) {
      merged.set(key, observation);
    }
  }
  return merged;
}
