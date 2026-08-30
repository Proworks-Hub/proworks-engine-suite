/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/patternPlanner.ts
 * Module:   neural-fabric / interop
 * Purpose:  Choosing how to talk, and being able to say why every other way was refused.
 */

import {
  PATTERN_CATALOG,
  PATTERN_IDS,
  deliverySatisfies,
  orderingSatisfies,
  type CommunicationPattern,
  type PatternId,
} from "./patternCatalog.js";
import { crossesInstance, type CommunicationIntent } from "./communicationIntent.js";

// ─────────────────────────────────────────────────────────────────────────────
// A PLAN THAT CANNOT EXPLAIN ITS REJECTIONS IS AN ORACLE
//
// §21 lists what a developer must be able to find out, and most of it is about
// the paths NOT taken: which patterns were eligible, which were rejected, and
// what would have to change. That requirement drives the shape of this file
// more than the selection itself does — it is why the planner evaluates all
// eleven patterns even after it has a winner, and why every rejection carries
// a sentence rather than a code.
//
// DETERMINISM IS A SECURITY PROPERTY, NOT A CONVENIENCE
//
// The same intent must always produce the same plan. If it did not, a
// certification result would describe one run rather than the system, an
// operator could not reproduce a failure, and — worst — a caller could retry
// until it got a pattern it preferred. So there is no clock read, no random
// tie-break, no map iteration order dependency and no scoring by measured
// health. Ranking is a total order over declared facts, computed the same way
// on every machine.
//
// Live health belongs to Pulse and enters at provider selection, one layer
// down. Keeping it out of pattern choice is what lets the same plan be
// re-verified tomorrow.
//
// WHAT A PLAN IS NOT
//
// It is not permission (§9). `authorizationEvidenceRef` is carried through so
// the runtime can have it checked; nothing here resolves it. A plan says "this
// is a way that would work", never "you may".
// ─────────────────────────────────────────────────────────────────────────────

export interface PatternRejection {
  readonly patternId: PatternId;
  /** The requirement it could not meet, in a sentence a developer can act on. */
  readonly reason: string;
  /**
   * What the caller would have to change for this pattern to become eligible.
   * Null when nothing reasonable would — a synchronous pattern will never
   * serve an offline sender, and pretending otherwise is worse than silence.
   */
  readonly remedy: string | null;
}

export interface PatternPlan {
  readonly intentId: string;
  readonly chosen: PatternId;
  readonly lane: CommunicationPattern["lane"];
  /** Eligible patterns in rank order, best first. Includes `chosen`. */
  readonly alternatives: readonly PatternId[];
  readonly rejected: readonly PatternRejection[];
  /** Provider capabilities an adapter must prove before it may serve this plan. */
  readonly requiredProviderCapabilities: readonly string[];
  /** Carried through untouched. A reference, never a permission. */
  readonly authorizationEvidenceRef: string | null;
  /** True when this plan terminates at an Interconnect gateway. */
  readonly crossInstance: boolean;
  /** Versions this plan was computed against, so it can be re-verified. */
  readonly versions: PlanVersions;
  readonly explanation: string;
}

/**
 * Everything whose change could invalidate the plan.
 *
 * §11 requires plans to record contract, topology, adapter and policy
 * versions. The reason is replay: a plan produced against one topology and
 * executed against another is a decision made with facts that no longer hold,
 * and without these fields nobody can tell that happened.
 */
export interface PlanVersions {
  readonly catalogVersion: string;
  readonly topologyVersionId: string;
  readonly policyVersionId: string | null;
  /**
   * Whether a model participated, and how.
   *
   * §11 asks for AI participation provenance on every plan. This planner is
   * deterministic and never consults one, so it always records NONE — but the
   * field exists because ARIA may draft the INTENT (§13), and a plan derived
   * from a drafted intent must carry that fact to whoever reviews it.
   */
  readonly aiParticipation: "NONE" | "INTENT_DRAFTED_BY_MODEL" | "MAPPING_SUGGESTED_BY_MODEL";
}

/** The catalog's version. Bumped whenever a pattern's declared facts change. */
export const PATTERN_CATALOG_VERSION = "1.0.0";

export type PlanOutcome =
  | { readonly planned: true; readonly plan: PatternPlan }
  | {
      readonly planned: false;
      readonly rejected: readonly PatternRejection[];
      /** Why nothing worked, stated as the conflict rather than a list. */
      readonly reason: string;
    };

/**
 * Checks one pattern against one intent.
 *
 * Returns null when the pattern is eligible. The order of the checks is the
 * order a developer would want to hear them: the structural impossibilities
 * first (wrong side of an instance boundary), then the guarantees, then the
 * physics.
 */
function evaluate(pattern: CommunicationPattern, intent: CommunicationIntent): PatternRejection | null {
  const reject = (reason: string, remedy: string | null): PatternRejection => ({
    patternId: pattern.patternId,
    reason,
    remedy,
  });

  const crossing = crossesInstance(intent);

  // ── Instance boundary. Non-negotiable in both directions. ────────────────
  //
  // §9 and the constitutional gate: cross-instance traffic terminates at a
  // governed gateway. The reverse check matters just as much — a gateway
  // pattern used for local traffic drags every local message through an
  // egress minimizer and a peer verification that has no peer, which is not
  // "extra safety" but a path nobody tested.
  if (crossing && !pattern.crossInstance) {
    return reject(
      `This conversation crosses from instance "${intent.locality.sourceInstanceId}" to "${intent.locality.destinationInstanceId}", and ${pattern.patternId} is a local pattern. Cross-instance traffic terminates at a governed Interconnect gateway; there is no direct path, and adding one would make two governed instances into one shared store.`,
      "Nothing to change here — INTERCONNECT_GATEWAY_HANDOFF is the cross-instance pattern, and it needs a grant from the receiving instance.",
    );
  }
  if (!crossing && pattern.crossInstance) {
    return reject(
      "This conversation stays inside one instance, and the gateway pattern is for traffic that leaves it.",
      null,
    );
  }

  // ── An explicitly required lane. ─────────────────────────────────────────
  if (intent.requiredLane !== undefined && pattern.lane !== intent.requiredLane) {
    return reject(
      `The intent requires the ${intent.requiredLane} lane and this pattern rides ${pattern.lane}.`,
      `Drop \`requiredLane\` and let the planner choose, unless the ${intent.requiredLane} lane is a genuine constraint.`,
    );
  }

  // ── Guarantees. Each is "at least as strong as", never "equal to". ───────
  if (!deliverySatisfies(pattern.delivery, intent.delivery)) {
    return reject(
      `The intent needs ${intent.delivery} delivery and this pattern offers ${pattern.delivery}.`,
      intent.delivery === "EFFECTIVELY_ONCE"
        ? "Effectively-once needs a durable pattern plus an idempotent consumer; a best-effort transport cannot be made to keep that promise by configuration."
        : "Weaken the delivery requirement only if losing a message is genuinely acceptable here.",
    );
  }
  if (!orderingSatisfies(pattern.ordering, intent.ordering)) {
    return reject(
      `The intent needs ${intent.ordering} ordering and this pattern offers ${pattern.ordering}.`,
      intent.ordering === "STRICT_SEQUENCE"
        ? "Strict sequence means one ordered path, which costs throughput. If the real requirement is 'per entity', PER_KEY is both weaker and faster."
        : "PER_KEY and PER_PAIR are different promises — ordering by entity is not ordering by conversation — so one cannot stand in for the other.",
    );
  }
  if (intent.requiresDurability && !pattern.durable) {
    return reject(
      "The intent requires durability and this pattern does not survive a restart.",
      "Durability is a property of the mechanism. If the traffic genuinely tolerates loss on restart, say so by clearing `requiresDurability`.",
    );
  }
  if (intent.requiresReplay && !pattern.replayable) {
    return reject(
      "The intent requires replay and this pattern keeps no history to replay from.",
      "Only the durable log and the event lane retain history. A queue is consumed, not read.",
    );
  }
  if (pattern.requiresIdempotentConsumer && !intent.consumerIsIdempotent) {
    return reject(
      `${pattern.patternId} redelivers until acknowledged, so it requires a consumer that deduplicates. The intent declares the consumer is not idempotent.`,
      "Make the consumer idempotent on the idempotency key, then declare `consumerIsIdempotent`. This is the one property the Fabric cannot verify for you, which is why it must be declared rather than assumed.",
    );
  }

  // ── Physics: offline, bandwidth, deadline, size. ─────────────────────────
  if (intent.locality.senderMayBeOffline && !pattern.toleratesOfflineSender) {
    return reject(
      "The sender may be offline when it sends, and this pattern needs a live connection at send time.",
      "Store-and-forward accepts locally and delivers when the link returns. That is the only honest way to send from a device that is not connected.",
    );
  }
  if (intent.locality.receiverMayBeOffline && !pattern.toleratesOfflineReceiver) {
    return reject(
      "The receiver may be offline, and this pattern needs it reachable at send time.",
      "A durable pattern holds the signal until the receiver returns.",
    );
  }
  if (intent.locality.constrainedBandwidth && !pattern.suitableForConstrainedBandwidth) {
    return reject(
      "The link is bandwidth-constrained and this pattern assumes a fat pipe.",
      null,
    );
  }
  if (intent.deadlineMs !== null && pattern.typicalLatencyFloorMs > intent.deadlineMs) {
    return reject(
      `The intent's deadline is ${intent.deadlineMs}ms and this pattern costs at least ${pattern.typicalLatencyFloorMs}ms before any work happens.`,
      "Either the deadline is optimistic for this mechanism, or the work does not actually need to be synchronous.",
    );
  }

  // ── Large payloads. ──────────────────────────────────────────────────────
  //
  // A megabyte inline is not an error the transport reports; it is a slow
  // degradation that shows up as broker pressure weeks later. The threshold
  // is deliberately conservative and stated rather than tuned.
  const LARGE_PAYLOAD_BYTES = 1_000_000;
  if (intent.approximatePayloadBytes >= LARGE_PAYLOAD_BYTES && !pattern.carriesPayloadByReference) {
    return reject(
      `The payload is about ${intent.approximatePayloadBytes} bytes, and this pattern carries payloads inline. Large messages inline do not fail cleanly — they saturate a broker and the symptom appears somewhere else entirely.`,
      "Put the bytes in an artifact store and move the reference.",
    );
  }
  if (intent.approximatePayloadBytes < LARGE_PAYLOAD_BYTES && pattern.carriesPayloadByReference) {
    return reject(
      "The payload is small enough to carry inline, and moving it by reference would add a store round-trip plus a lifetime problem for nothing.",
      null,
    );
  }

  // ── Continuous flows. ────────────────────────────────────────────────────
  if (intent.continuous && pattern.lane !== "STREAM") {
    return reject(
      "The intent describes a continuous flow, and this pattern carries discrete messages.",
      "A continuous flow belongs on the STREAM lane, as a durable log or a live bidirectional channel.",
    );
  }

  return null;
}

/**
 * Ranks eligible patterns. Lower sorts first.
 *
 * The preference order encodes one judgement: prefer the cheapest mechanism
 * that keeps every promise. Since eligibility has already established that
 * every candidate keeps them, what is left to compare is cost — latency
 * floor first, then a stable tie-break on catalog position so the result is
 * identical on every machine and every run.
 */
function rank(pattern: CommunicationPattern): readonly [number, number] {
  return [pattern.typicalLatencyFloorMs, PATTERN_IDS.indexOf(pattern.patternId)];
}

/**
 * Plans a pattern for one intent.
 *
 * Pure and deterministic: no clock, no randomness, no health. Given the same
 * intent and versions it returns the same plan forever, which is what makes a
 * plan reviewable and a certification meaningful.
 */
export function planPattern(intent: CommunicationIntent, versions: PlanVersions): PlanOutcome {
  const eligible: CommunicationPattern[] = [];
  const rejected: PatternRejection[] = [];

  // Every pattern is evaluated, including after a winner exists. The rejected
  // list IS the developer diagnostic (§21), and computing it lazily would
  // make the explanation depend on evaluation order.
  for (const patternId of PATTERN_IDS) {
    const pattern = PATTERN_CATALOG[patternId];
    const rejection = evaluate(pattern, intent);
    if (rejection === null) eligible.push(pattern);
    else rejected.push(rejection);
  }

  if (eligible.length === 0) {
    return {
      planned: false,
      rejected,
      reason: `No pattern in the catalog satisfies this intent. ${describeConflict(intent)} A refusal here is the correct outcome: the alternative is a plan that quietly keeps fewer promises than the caller asked for.`,
    };
  }

  const ordered = [...eligible].sort((a, b) => {
    const [latencyA, indexA] = rank(a);
    const [latencyB, indexB] = rank(b);
    return latencyA === latencyB ? indexA - indexB : latencyA - latencyB;
  });

  const chosen = ordered[0]!;

  return {
    planned: true,
    plan: {
      intentId: intent.intentId,
      chosen: chosen.patternId,
      lane: chosen.lane,
      alternatives: ordered.map((p) => p.patternId),
      rejected,
      requiredProviderCapabilities: chosen.requiredProviderCapabilities,
      authorizationEvidenceRef: intent.authorizationEvidenceRef,
      crossInstance: chosen.crossInstance,
      versions,
      explanation: explain(intent, chosen, ordered),
    },
  };
}

/** Names the tightest constraint, so "nothing worked" has a cause. */
function describeConflict(intent: CommunicationIntent): string {
  if (intent.locality.senderMayBeOffline && intent.deadlineMs !== null) {
    return `The binding conflict is an offline sender with a ${intent.deadlineMs}ms deadline: a device that is not connected cannot promise when it will deliver, and no mechanism resolves that.`;
  }
  if (intent.delivery === "EFFECTIVELY_ONCE" && intent.continuous) {
    return "The binding conflict is effectively-once delivery on a continuous flow: live streams do not acknowledge individual messages, which is what effectively-once is built on.";
  }
  if (intent.ordering === "STRICT_SEQUENCE" && intent.continuous) {
    return "The binding conflict is strict global ordering on a continuous flow: one order means one path, which is the opposite of what a stream is for.";
  }
  if (intent.requiresReplay && intent.deadlineMs !== null && intent.deadlineMs < 5) {
    return "The binding conflict is replayability with a sub-5ms deadline: retaining history costs a durable write, and a durable write costs more than the deadline allows.";
  }
  return "Check the rejection list — each entry names the single requirement that pattern could not meet.";
}

function explain(
  intent: CommunicationIntent,
  chosen: CommunicationPattern,
  ordered: readonly CommunicationPattern[],
): string {
  const runnerUp = ordered[1];
  const because =
    runnerUp === undefined
      ? "It was the only pattern that satisfied every requirement."
      : `It was preferred over ${runnerUp.patternId} because it costs less latency (${chosen.typicalLatencyFloorMs}ms against ${runnerUp.typicalLatencyFloorMs}ms) while keeping the same promises.`;

  const gateway = chosen.crossInstance
    ? " This plan leaves the instance, so it terminates at the Interconnect gateway and the receiving instance's grant governs whether it arrives."
    : "";

  return (
    `${intent.sourceCapability} → ${intent.destinationCapability}: ${chosen.patternId} on the ${chosen.lane} lane. ` +
    `${because} It offers ${chosen.delivery} delivery with ${chosen.ordering} ordering` +
    `${chosen.durable ? ", survives a restart" : ", does not survive a restart"}` +
    `${chosen.replayable ? " and can be replayed" : ""}. ` +
    `An adapter must prove ${chosen.requiredProviderCapabilities.join(", ")} before it may serve this plan.${gateway} ` +
    "This plan describes a permitted mechanism; it is not authorization, and the authorization reference it carries still has to be checked by whoever owns that decision."
  );
}

/**
 * Planning never widens what is reachable.
 *
 * The planner selects among patterns; it does not create adjacencies, grants
 * or capabilities. Nexus decides what may be reached and the runtime checks
 * trust before routing — a plan that could widen either would let a caller
 * acquire reach by describing a need, which is the whole failure mode §9
 * exists to name.
 */
export function planningMayWidenReachability(): false {
  return false;
}
