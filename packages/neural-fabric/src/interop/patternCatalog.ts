/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/patternCatalog.ts
 * Module:   neural-fabric / interop
 * Purpose:  Eleven ways to hold a conversation, each honest about what it costs.
 */

import type { Lane } from "../domain/lanes.js";
import type { DeliveryRequirement, OrderingRequirement } from "./communicationIntent.js";

// ─────────────────────────────────────────────────────────────────────────────
// A BOUNDED CATALOG, AND WHY IT IS BOUNDED
//
// The build prompt asks for a "bounded Communication Pattern Catalog", and the
// bound is the feature. An open catalog — one where a caller can describe a
// bespoke pattern inline — is a scripting language for transports, and every
// property the planner is supposed to guarantee becomes unverifiable the first
// time somebody invents a twelfth pattern in a config file. Eleven named
// patterns can each be tested, certified and refused. An arbitrary pattern
// can only be trusted.
//
// Each entry declares what it CAN do, and the planner's entire job is
// comparing those declarations against what an intent NEEDS. That is why
// every field here is a fact about mechanism rather than a preference: a
// pattern that "prefers" low latency tells the planner nothing it can check.
//
// The Camel/EIP vocabulary (public, §5) is the ancestor of the naming. The
// properties are ours, because the question we ask of a pattern — can it keep
// this specific promise — is not one an EIP catalog answers.
// ─────────────────────────────────────────────────────────────────────────────

export type PatternId =
  | "SYNC_REQUEST_REPLY"
  | "TYPED_RPC"
  | "ASYNC_COMMAND_QUEUE"
  | "PUBLISH_SUBSCRIBE"
  | "DURABLE_LOG_STREAM"
  | "BIDIRECTIONAL_STREAM"
  | "WEBHOOK_CALLBACK"
  | "STORE_AND_FORWARD_EDGE"
  | "BATCH_PIPELINE"
  | "ARTIFACT_REFERENCE"
  | "INTERCONNECT_GATEWAY_HANDOFF";

export interface CommunicationPattern {
  readonly patternId: PatternId;
  readonly summary: string;
  /** The lane this pattern rides. A pattern does not get to invent a lane. */
  readonly lane: Lane;
  /** The strongest delivery guarantee it can honestly offer. */
  readonly delivery: DeliveryRequirement;
  /** The strongest ordering it can offer. */
  readonly ordering: OrderingRequirement;
  readonly durable: boolean;
  readonly replayable: boolean;
  /** True when the receiver must deduplicate for the guarantee to hold. */
  readonly requiresIdempotentConsumer: boolean;
  /**
   * Rough latency floor in milliseconds — what the pattern costs before any
   * work happens. Used to refuse deadlines the mechanism cannot meet, never
   * to promise one it can.
   */
  readonly typicalLatencyFloorMs: number;
  /** True when the sender may be disconnected when it sends. */
  readonly toleratesOfflineSender: boolean;
  /** True when the receiver may be disconnected when it is sent to. */
  readonly toleratesOfflineReceiver: boolean;
  /** True when the pattern is workable on a constrained link. */
  readonly suitableForConstrainedBandwidth: boolean;
  /** True when the pattern carries a large payload by reference, not inline. */
  readonly carriesPayloadByReference: boolean;
  /** True when this pattern is the cross-instance path. Exactly one is. */
  readonly crossInstance: boolean;
  /** Provider capabilities an adapter must have to serve this pattern. */
  readonly requiredProviderCapabilities: readonly string[];
  /** What goes wrong when this pattern is chosen for the wrong job. */
  readonly misuseFailure: string;
}

const pattern = (p: CommunicationPattern): CommunicationPattern => Object.freeze(p);

export const PATTERN_CATALOG: Readonly<Record<PatternId, CommunicationPattern>> = Object.freeze({
  SYNC_REQUEST_REPLY: pattern({
    patternId: "SYNC_REQUEST_REPLY",
    summary: "Ask a question and wait on the connection for the answer.",
    lane: "QUERY",
    delivery: "BEST_EFFORT",
    ordering: "NONE",
    durable: false,
    replayable: false,
    requiresIdempotentConsumer: false,
    typicalLatencyFloorMs: 1,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: false,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["request-reply"],
    misuseFailure:
      "Used for a state change, it turns a network timeout into an unanswerable question: the caller cannot tell whether the work happened, and the safe retry it wants is the double-charge it fears.",
  }),
  TYPED_RPC: pattern({
    patternId: "TYPED_RPC",
    summary: "Call a typed remote procedure against a generated interface.",
    lane: "COMMAND",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_PAIR",
    durable: false,
    replayable: false,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 1,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: false,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["request-reply", "typed-schema"],
    misuseFailure:
      "Chosen for a long job, the call outlives its connection and the client retries work that is still running.",
  }),
  ASYNC_COMMAND_QUEUE: pattern({
    patternId: "ASYNC_COMMAND_QUEUE",
    summary: "Hand an authorized state change to a durable queue and let the worker take it.",
    lane: "COMMAND",
    delivery: "EFFECTIVELY_ONCE",
    ordering: "PER_KEY",
    durable: true,
    replayable: false,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 5,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["durable-queue", "acknowledgement"],
    misuseFailure:
      "Given a non-idempotent worker, at-least-once redelivery performs the command twice and the queue's reliability becomes the mechanism of the damage.",
  }),
  PUBLISH_SUBSCRIBE: pattern({
    patternId: "PUBLISH_SUBSCRIBE",
    summary: "Announce something that happened to whoever subscribed.",
    lane: "EVENT",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_KEY",
    durable: true,
    replayable: true,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 5,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["publish-subscribe", "durable-subscription"],
    misuseFailure:
      "Used to request work, it produces either nobody doing the job or everybody doing it, and the publisher cannot tell which.",
  }),
  DURABLE_LOG_STREAM: pattern({
    patternId: "DURABLE_LOG_STREAM",
    summary: "Append to a partitioned log that consumers read at their own position.",
    lane: "STREAM",
    delivery: "AT_LEAST_ONCE",
    ordering: "PER_KEY",
    durable: true,
    replayable: true,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 5,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: false,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["durable-log", "partitioning", "consumer-offsets"],
    misuseFailure:
      "Asked for one global order, it collapses to a single partition, and the throughput it was chosen for disappears.",
  }),
  BIDIRECTIONAL_STREAM: pattern({
    patternId: "BIDIRECTIONAL_STREAM",
    summary: "Hold a live two-way channel open for continuous exchange.",
    lane: "STREAM",
    delivery: "BEST_EFFORT",
    ordering: "PER_PAIR",
    durable: false,
    replayable: false,
    requiresIdempotentConsumer: false,
    typicalLatencyFloorMs: 1,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: false,
    suitableForConstrainedBandwidth: false,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["bidirectional-stream", "long-lived-connection"],
    misuseFailure:
      "Trusted with consequential traffic, a dropped socket loses whatever was in flight with no record that it existed.",
  }),
  WEBHOOK_CALLBACK: pattern({
    patternId: "WEBHOOK_CALLBACK",
    summary: "Call an external endpoint when something happens, and retry on failure.",
    lane: "EVENT",
    delivery: "AT_LEAST_ONCE",
    ordering: "NONE",
    durable: true,
    replayable: true,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 50,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["outbound-http", "signed-delivery", "retry-schedule"],
    misuseFailure:
      "Given ordering expectations it cannot keep, retries deliver yesterday's state after today's and the receiver silently regresses.",
  }),
  STORE_AND_FORWARD_EDGE: pattern({
    patternId: "STORE_AND_FORWARD_EDGE",
    summary: "Accept on a device that is offline, hold it locally, forward when the link returns.",
    lane: "COMMAND",
    delivery: "EFFECTIVELY_ONCE",
    ordering: "PER_KEY",
    durable: true,
    replayable: false,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 1_000,
    toleratesOfflineSender: true,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["local-durable-queue", "reconnect", "idempotency-key"],
    misuseFailure:
      "Chosen where a deadline matters, it cheerfully delivers a two-hour-old instruction to a machine that moved on.",
  }),
  BATCH_PIPELINE: pattern({
    patternId: "BATCH_PIPELINE",
    summary: "Accumulate many messages and move them as one governed unit.",
    lane: "WORKFLOW",
    delivery: "AT_LEAST_ONCE",
    ordering: "STRICT_SEQUENCE",
    durable: true,
    replayable: true,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 10_000,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: false,
    requiredProviderCapabilities: ["durable-queue", "ordered-delivery", "batch-commit"],
    misuseFailure:
      "Used for interactive traffic, the batch window becomes the latency, and every caller experiences the system as broken.",
  }),
  ARTIFACT_REFERENCE: pattern({
    patternId: "ARTIFACT_REFERENCE",
    summary: "Put the bytes in a store and move only the reference.",
    lane: "ARTIFACT",
    delivery: "AT_LEAST_ONCE",
    ordering: "NONE",
    durable: true,
    replayable: true,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 20,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: true,
    crossInstance: false,
    requiredProviderCapabilities: ["artifact-store", "reference-addressing"],
    misuseFailure:
      "Used without lifetime rules, the reference outlives the artifact and every consumer reads a 404 as an empty result.",
  }),
  INTERCONNECT_GATEWAY_HANDOFF: pattern({
    patternId: "INTERCONNECT_GATEWAY_HANDOFF",
    summary: "Hand a minimized signal to another instance through the governed doorway.",
    lane: "EVENT",
    delivery: "AT_LEAST_ONCE",
    ordering: "NONE",
    durable: true,
    replayable: false,
    requiresIdempotentConsumer: true,
    typicalLatencyFloorMs: 50,
    toleratesOfflineSender: false,
    toleratesOfflineReceiver: true,
    suitableForConstrainedBandwidth: true,
    carriesPayloadByReference: false,
    crossInstance: true,
    requiredProviderCapabilities: ["mutual-tls", "durable-queue", "signed-delivery"],
    misuseFailure:
      "Bypassed for a 'quick' direct connection, it turns two governed instances into one shared database with no record of the moment it happened.",
  }),
});

export const PATTERN_IDS: readonly PatternId[] = Object.freeze(Object.keys(PATTERN_CATALOG) as PatternId[]);

/** Ranks delivery guarantees so "at least as strong as" is a comparison. */
export const DELIVERY_STRENGTH: Readonly<Record<DeliveryRequirement, number>> = Object.freeze({
  BEST_EFFORT: 0,
  AT_LEAST_ONCE: 1,
  EFFECTIVELY_ONCE: 2,
});

/**
 * Ranks ordering guarantees.
 *
 * PER_KEY and PER_PAIR are genuinely incomparable — one orders by entity, the
 * other by conversation, and neither implies the other. Giving them the same
 * rank would let the planner substitute one for the other silently, so
 * `orderingSatisfies` below treats them as distinct rather than ranked, and
 * this table exists only for the cases where the comparison is real.
 */
export const ORDERING_STRENGTH: Readonly<Record<OrderingRequirement, number>> = Object.freeze({
  NONE: 0,
  PER_KEY: 1,
  PER_PAIR: 1,
  STRICT_SEQUENCE: 2,
});

/** True when `offered` keeps every promise `required` asks for. */
export function orderingSatisfies(offered: OrderingRequirement, required: OrderingRequirement): boolean {
  if (required === "NONE") return true;
  if (offered === "STRICT_SEQUENCE") return true;
  // PER_KEY does not satisfy PER_PAIR and vice versa: ordering by entity and
  // ordering by conversation are different promises, and a planner that
  // swapped them would produce a system that is correct in testing and
  // reorders in production the first time one sender touches two entities.
  return offered === required;
}

/** True when `offered` is at least as strong as `required`. */
export function deliverySatisfies(offered: DeliveryRequirement, required: DeliveryRequirement): boolean {
  return DELIVERY_STRENGTH[offered] >= DELIVERY_STRENGTH[required];
}

/**
 * The catalog is closed. Nothing in this package adds a pattern at runtime.
 *
 * Assertable because "bounded" is the property the planner's guarantees rest
 * on: every promise the planner makes is a promise some pattern in this table
 * was certified to keep, and a runtime-extensible catalog would make that
 * sentence false without changing a line of the planner.
 */
export function catalogIsExtensibleAtRuntime(): false {
  return false;
}
