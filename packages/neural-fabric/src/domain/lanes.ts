/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/domain/lanes.ts
 * Module:   neural-fabric / domain
 * Purpose:  Eight kinds of traffic, and the guarantees each one actually gets.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// ONE BUS FOR EVERYTHING IS THE MISTAKE THIS MODULE EXISTS TO PREVENT
//
// The usual path is a single message bus that everything goes through. It
// works, briefly. Then a health heartbeat is persisted to durable storage
// because that is what the bus does; a command is retried three times because
// events are retried three times, and it was not idempotent; a request/reply
// query blocks on a durable write it never needed.
//
// None of those look like bugs. Each is the bus behaving exactly as designed,
// applied to traffic that needed something else.
//
// So the lane is a first-class part of the envelope, and each lane declares
// its own delivery, ordering, persistence and TTL semantics. A component
// asking "will this be retried?" gets an answer from a table rather than from
// whatever the transport happens to do.
//
// EXACTLY-ONCE IS NOT OFFERED
//
// §13 is explicit and the distributed-systems literature agrees: exactly-once
// delivery across arbitrary boundaries is not available. What is available is
// at-least-once delivery plus an idempotent consumer, which produces
// exactly-once EFFECT. The distinction matters enormously in practice and the
// vocabulary here refuses to blur it — there is no `EXACTLY_ONCE` member to
// select, so nobody can promise it in a contract.
// ─────────────────────────────────────────────────────────────────────────────

export const laneSchema = z.enum([
  /** Need an answer now. No state change from the question itself. */
  "QUERY",
  /** Request an authorized state-changing action. */
  "COMMAND",
  /** Something already happened. */
  "EVENT",
  /** High-volume ordered observations or history. */
  "STREAM",
  /** Long-running coordination with durable history. */
  "WORKFLOW",
  /** Governance, audit, security or decision evidence. */
  "EVIDENCE",
  /** Ephemeral liveness and topology health. */
  "HEALTH",
  /** Large files, models, documents — by reference, not by value. */
  "ARTIFACT",
]);
export type Lane = z.infer<typeof laneSchema>;

export const LANES: readonly Lane[] = laneSchema.options;

/**
 * What a lane promises about delivery.
 *
 * Deliberately no `EXACTLY_ONCE`. See the header.
 */
export const deliverySemanticSchema = z.enum([
  /** Sent once. Loss is acceptable and expected. */
  "AT_MOST_ONCE",
  /** Redelivered until acknowledged. The consumer MUST be idempotent. */
  "AT_LEAST_ONCE",
  /** Sender waits for a reply or a timeout. Neither is durable. */
  "REQUEST_REPLY",
]);
export type DeliverySemantic = z.infer<typeof deliverySemanticSchema>;

/** How much ordering a lane guarantees, and over what. */
export const orderingScopeSchema = z.enum([
  /** None. Messages may arrive in any order. */
  "NONE",
  /** Ordered within one key — one entity, one aggregate. */
  "PER_KEY",
  /** Ordered between one sender and one receiver. */
  "PER_PAIR",
  /** Ordered within a partition, which is how a log scales. */
  "PER_PARTITION",
  /** Strictly sequential. The most expensive guarantee there is. */
  "STRICT_SEQUENCE",
]);
export type OrderingScope = z.infer<typeof orderingScopeSchema>;

export interface LaneSemantics {
  readonly lane: Lane;
  readonly purpose: string;
  readonly delivery: DeliverySemantic;
  readonly ordering: OrderingScope;
  /** Whether the lane's traffic is written to durable storage. */
  readonly durable: boolean;
  /** Whether a consumer MUST be idempotent for this lane to be safe. */
  readonly requiresIdempotentConsumer: boolean;
  /** Whether the lane may be replayed from history. */
  readonly replayable: boolean;
  /** Whether a signal on this lane must carry authorization evidence. */
  readonly requiresAuthorizationEvidence: boolean;
  /** Whether the payload travels inline or as a reference. */
  readonly payloadCarriage: "INLINE" | "REFERENCE_ONLY";
  /**
   * What goes wrong when this lane is treated like the others.
   *
   * The reason the table exists rather than a default. Written as the failure
   * because that is what a reader recognises.
   */
  readonly misuseFailure: string;
}

export const LANE_SEMANTICS: Readonly<Record<Lane, LaneSemantics>> = Object.freeze({
  QUERY: {
    lane: "QUERY",
    purpose: "Ask a qualified responder a question and get an answer, without changing anything.",
    delivery: "REQUEST_REPLY",
    ordering: "NONE",
    durable: false,
    requiresIdempotentConsumer: false,
    replayable: false,
    requiresAuthorizationEvidence: false,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Made durable, a query pays for a write nobody will ever read. Retried like an event, a 'read' that quietly had a side effect happens twice.",
  },
  COMMAND: {
    lane: "COMMAND",
    purpose: "Ask for an authorized state change at a named destination or capability.",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_KEY",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: false,
    requiresAuthorizationEvidence: true,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Without idempotency, at-least-once delivery charges the customer twice. Without durability, an accepted command is lost on a restart and nobody knows which ones.",
  },
  EVENT: {
    lane: "EVENT",
    purpose: "Announce that something already happened, to whoever is subscribed.",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_KEY",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: true,
    requiresAuthorizationEvidence: false,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Treated as a command, an event acquires an expectation of a response that no publisher is waiting for, and subscribers start refusing work they were only told about.",
  },
  STREAM: {
    lane: "STREAM",
    purpose: "Carry high-volume ordered observations with independent consumer positions.",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_PARTITION",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: true,
    requiresAuthorizationEvidence: false,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Given strict global ordering, a stream stops scaling, because strict order means one partition means one consumer.",
  },
  WORKFLOW: {
    lane: "WORKFLOW",
    purpose: "Carry long-running coordination that must survive process failure and resume.",
    delivery: "AT_LEAST_ONCE",
    ordering: "STRICT_SEQUENCE",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: true,
    requiresAuthorizationEvidence: true,
    payloadCarriage: "INLINE",
    misuseFailure:
      "A bus is not a workflow engine. Without durable history and resumability, a long-running process restarts from nothing and repeats side effects it already performed.",
  },
  EVIDENCE: {
    lane: "EVIDENCE",
    purpose: "Carry governance, audit, security and decision evidence with provenance intact.",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_PAIR",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: true,
    requiresAuthorizationEvidence: true,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Dropped under load like health traffic, evidence goes missing exactly during the incident it was recording. Load shedding must never reach this lane.",
  },
  HEALTH: {
    lane: "HEALTH",
    purpose: "Carry ephemeral liveness and topology health where the newest value supersedes the last.",
    delivery: "AT_MOST_ONCE",
    ordering: "NONE",
    durable: false,
    requiresIdempotentConsumer: false,
    replayable: false,
    requiresAuthorizationEvidence: false,
    payloadCarriage: "INLINE",
    misuseFailure:
      "Made durable, heartbeats become the largest table in the system and drown the storage that real work depends on. A superseded heartbeat has no value at all.",
  },
  ARTIFACT: {
    lane: "ARTIFACT",
    purpose: "Carry a REFERENCE to a large file, model or document. Never the bytes.",
    delivery: "AT_LEAST_ONCE",
    ordering: "NONE",
    durable: true,
    requiresIdempotentConsumer: true,
    replayable: false,
    requiresAuthorizationEvidence: true,
    payloadCarriage: "REFERENCE_ONLY",
    misuseFailure:
      "Carrying the bytes inline puts a 400MB model through a message broker sized for kilobytes, and one send stalls every other lane sharing the transport.",
  },
});

export function semanticsFor(lane: Lane): LaneSemantics {
  return LANE_SEMANTICS[lane];
}

/**
 * Whether a lane may be shed under load.
 *
 * EVIDENCE and COMMAND never may. Shedding evidence loses the record of the
 * incident that caused the load; shedding an accepted command loses work
 * somebody was told would happen. HEALTH is the lane load shedding is FOR —
 * it is expendable by construction.
 */
export function mayBeShed(lane: Lane): boolean {
  return lane === "HEALTH" || lane === "STREAM";
}

/**
 * Whether exactly-once EFFECT is achievable on a lane.
 *
 * True when the lane is at-least-once AND requires an idempotent consumer,
 * which together produce the property people mean when they ask for
 * exactly-once delivery. Named `Effect` so the difference stays visible.
 */
export function exactlyOnceEffectAchievable(lane: Lane): boolean {
  const s = LANE_SEMANTICS[lane];
  return s.delivery === "AT_LEAST_ONCE" && s.requiresIdempotentConsumer;
}

/**
 * Whether the Fabric will ever promise exactly-once DELIVERY.
 *
 * Always false. A function so a test asserts it, because this is the promise
 * most likely to be made by somebody being helpful in a contract review.
 */
export function exactlyOnceDeliveryOffered(): false {
  return false;
}

export interface LaneMismatch {
  readonly problem: string;
  readonly consequence: string;
}

/**
 * Whether a declared handling matches what the lane actually guarantees.
 *
 * Called when a participant registers a consumer. A consumer that says it is
 * not idempotent, on a lane that redelivers, is a duplicate-processing incident
 * that has not happened yet — and it is far cheaper to refuse the registration
 * than to find it in the data three weeks later.
 */
export function checkConsumerFit(
  lane: Lane,
  declared: { readonly idempotent: boolean; readonly durableStorage: boolean },
): readonly LaneMismatch[] {
  const semantics = LANE_SEMANTICS[lane];
  const problems: LaneMismatch[] = [];

  if (semantics.requiresIdempotentConsumer && !declared.idempotent) {
    problems.push({
      problem: `The ${lane} lane delivers at least once, and this consumer declares it is not idempotent.`,
      consequence:
        "A redelivery after a timeout or a restart will be processed as a second, separate request. Nothing will report an error.",
    });
  }

  if (!semantics.durable && declared.durableStorage) {
    problems.push({
      problem: `The ${lane} lane is not durable, and this consumer expects to persist what it receives.`,
      consequence:
        "The consumer will store values that supersede each other within seconds, and the store will grow without bound for no reader.",
    });
  }

  if (semantics.payloadCarriage === "REFERENCE_ONLY" && declared.durableStorage) {
    problems.push({
      problem: `The ${lane} lane carries a reference, not content.`,
      consequence:
        "A consumer persisting what arrives will store the pointer and believe it has the artifact. Resolve the reference through FileIQ instead.",
    });
  }

  return problems;
}
