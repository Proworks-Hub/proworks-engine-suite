/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/communicationIntent.ts
 * Module:   neural-fabric / interop
 * Purpose:  Saying what must be true of a conversation, without naming a wire.
 */

import { z } from "zod";

import { classificationSchema } from "../domain/envelope.js";
import { laneSchema } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// AN INTENT DESCRIBES REQUIREMENTS, NOT MECHANISM
//
// The whole point of Phase 3 (§7) is that a developer states what must
// communicate and what must be guaranteed, and the Fabric works out a
// permitted, testable, explainable way to do it. That only holds if the intent
// is genuinely free of mechanism: the moment an intent can say "use Kafka" or
// "POST to this URL", the planner has nothing left to decide and every caller
// has quietly re-acquired the ability to pick a transport the topology never
// approved.
//
// So this schema is `.strict()` and contains no provider, no broker, no URL,
// no protocol and no adapter. What it contains is the set of properties a
// pattern must satisfy — durability, ordering, replay, latency, offline
// tolerance — plus the scope the traffic belongs to. If a requirement cannot
// be expressed here, that is a gap in the vocabulary and it gets added here,
// deliberately, rather than smuggled through as a free-text hint.
//
// AUTHORIZATION IS A REFERENCE, NEVER A CLAIM (§9)
//
// `authorizationEvidenceRef` points at a decision somebody else made. It is
// the same discipline as the envelope's field of the same name: holding a
// reference is not holding permission, and nothing in this package resolves
// one. An intent that carries a reference is asking to be checked, not
// announcing that it passed.
// ─────────────────────────────────────────────────────────────────────────────

/** What the caller is trying to do, in terms the Fabric can reason about. */
export const operationKindSchema = z.enum([
  /** Read something. No state change anywhere. */
  "QUERY",
  /** Ask for an authorized state change. */
  "COMMAND",
  /** Announce something that already happened. */
  "NOTIFY",
  /** Carry a continuous flow of observations. */
  "STREAM",
  /** Move a large artifact by reference. */
  "TRANSFER",
  /** Long-running coordination that must survive a restart. */
  "COORDINATE",
]);
export type OperationKind = z.infer<typeof operationKindSchema>;

/** How much the caller can tolerate losing. Ordered weakest to strongest. */
export const deliveryRequirementSchema = z.enum([
  /** Loss is acceptable. Health beacons and cache warms live here. */
  "BEST_EFFORT",
  /** Must arrive; duplicates are the consumer's problem to absorb. */
  "AT_LEAST_ONCE",
  /**
   * Must arrive, and the EFFECT must happen once.
   *
   * Deliberately not called EXACTLY_ONCE — no transport in this package
   * offers that, because none honestly can. This requirement is satisfiable
   * only by at-least-once delivery plus an idempotent consumer, and the
   * planner enforces exactly that pairing rather than pretending.
   */
  "EFFECTIVELY_ONCE",
]);
export type DeliveryRequirement = z.infer<typeof deliveryRequirementSchema>;

/** What order the receiver must observe. */
export const orderingRequirementSchema = z.enum([
  "NONE",
  /** Messages sharing a key arrive in send order. */
  "PER_KEY",
  /** One sender's messages to one receiver arrive in send order. */
  "PER_PAIR",
  /** Every message in the conversation arrives in one global order. */
  "STRICT_SEQUENCE",
]);
export type OrderingRequirement = z.infer<typeof orderingRequirementSchema>;

/**
 * What the caller may lose when conditions degrade.
 *
 * §16 draws the line this enum encodes: degradation may reduce features or
 * availability, and may NEVER widen trust or data scope. There is therefore
 * no member here that relaxes a classification, skips authorization or
 * reaches further than the healthy path would — those would not be
 * degradations, they would be a different, larger permission granted at the
 * worst possible moment.
 */
export const degradationAllowanceSchema = z.enum([
  /** Nothing may be given up. If the guarantees cannot be met, refuse. */
  "NONE",
  /** Latency may grow: queue it, retry it, deliver it late. */
  "DELAY_PERMITTED",
  /** Ordering may be relaxed while degraded. */
  "REORDER_PERMITTED",
  /** The message may be dropped entirely. Only honest for observability. */
  "DROP_PERMITTED",
]);
export type DegradationAllowance = z.infer<typeof degradationAllowanceSchema>;

/** Where the participants are, which decides whether a gateway is involved. */
export const localitySchema = z
  .object({
    /** The instance the caller is in. */
    sourceInstanceId: z.string().min(1),
    /**
     * The instance the destination is in. When it differs from the source,
     * the plan MUST terminate at an Interconnect gateway — the planner has
     * no branch that produces a direct cross-instance path.
     */
    destinationInstanceId: z.string().min(1),
    /**
     * True when the caller may be disconnected at send time.
     *
     * This is the mobile/edge case (§6 B, §10.12). It does not loosen any
     * guarantee; it says the plan must survive the sender being offline,
     * which rules out every synchronous pattern.
     */
    senderMayBeOffline: z.boolean(),
    /** True when the receiver may be disconnected. Same reasoning. */
    receiverMayBeOffline: z.boolean(),
    /** Constrained links refuse patterns that assume a fat pipe. */
    constrainedBandwidth: z.boolean(),
  })
  .strict();
export type Locality = z.infer<typeof localitySchema>;

export const communicationIntentSchema = z
  .object({
    intentId: z.string().min(1),
    /** Free text for humans. Never parsed, never matched on. */
    purpose: z.string().min(1),

    /** The capability being addressed — never a node, host or URL. */
    sourceCapability: z.string().min(1),
    destinationCapability: z.string().min(1),

    operation: operationKindSchema,

    /**
     * A lane the caller insists on, when it already knows.
     *
     * Optional on purpose: the ordinary path is to state requirements and let
     * the planner choose. When present, the planner still checks that the
     * lane's own semantics satisfy the stated requirements, so naming a lane
     * cannot be used to acquire one whose guarantees are weaker than the
     * caller asked for.
     */
    requiredLane: laneSchema.optional(),

    delivery: deliveryRequirementSchema,
    ordering: orderingRequirementSchema,
    /**
     * True when the receiver deduplicates by idempotency key.
     *
     * This is a property of the CONSUMER, which is why the caller must
     * declare it rather than the Fabric inferring it. EFFECTIVELY_ONCE
     * without it is refused: the pairing is the only honest implementation,
     * and a planner that silently accepted the requirement anyway would be
     * issuing a guarantee the consumer cannot keep.
     */
    consumerIsIdempotent: z.boolean(),
    /** True when a late subscriber must be able to read history. */
    requiresReplay: z.boolean(),
    /** True when the conversation must survive a process restart. */
    requiresDurability: z.boolean(),

    /**
     * How long the result is useful, in milliseconds. Null means no deadline.
     *
     * A deadline is a requirement on the PATTERN (a store-and-forward queue
     * cannot promise 50ms), not a timeout the runtime enforces here.
     */
    deadlineMs: z.number().int().positive().nullable(),
    /** How long the signal stays valid in a queue. Null means no expiry. */
    timeToLiveMs: z.number().int().positive().nullable(),

    /** Roughly how big one message is. Drives artifact-reference selection. */
    approximatePayloadBytes: z.number().int().nonnegative(),
    /** True when the conversation is a continuous flow, not discrete messages. */
    continuous: z.boolean(),
    /** True when the caller sends in batches rather than one at a time. */
    batched: z.boolean(),

    classification: classificationSchema,
    tenantId: z.string().min(1).nullable(),
    locality: localitySchema,

    /**
     * A reference to the governance decision permitting this conversation.
     *
     * Null is legitimate for unconsequential traffic. It is NOT legitimate
     * for a COMMAND or a TRANSFER, and the refinement below refuses those —
     * the same rule the envelope applies, applied one layer earlier so the
     * developer finds out at planning time instead of at send time.
     */
    authorizationEvidenceRef: z.string().min(1).nullable(),

    degradation: degradationAllowanceSchema,

    /** Test traffic. Required, no default — see the envelope's field. */
    isTest: z.boolean(),
  })
  .strict()
  .refine((i) => i.delivery !== "EFFECTIVELY_ONCE" || i.consumerIsIdempotent, {
    message:
      "EFFECTIVELY_ONCE requires an idempotent consumer. No transport in this package delivers exactly once, so the only honest implementation is at-least-once plus deduplication at the receiver. Declaring the requirement without the consumer property asks the Fabric to promise something nothing can keep.",
    path: ["consumerIsIdempotent"],
  })
  .refine((i) => (i.operation !== "COMMAND" && i.operation !== "TRANSFER") || i.authorizationEvidenceRef !== null, {
    message:
      "A COMMAND or TRANSFER needs an authorization evidence reference. Both change something or move something out, and 'the caller was able to ask' has never been a reason to permit either.",
    path: ["authorizationEvidenceRef"],
  })
  .refine((i) => i.classification !== "TENANT_PRIVATE" || i.tenantId !== null, {
    message:
      "Tenant-private traffic must name its tenant. Without one there is nothing to scope the privacy to, and a leak cannot even be described afterwards.",
    path: ["tenantId"],
  })
  .refine((i) => i.deadlineMs === null || i.timeToLiveMs === null || i.timeToLiveMs >= i.deadlineMs, {
    message:
      "A time-to-live shorter than the deadline expires the signal before its own deadline arrives, which produces a timeout whose real cause is a configuration mistake nobody will find.",
    path: ["timeToLiveMs"],
  })
  .refine((i) => !i.requiresReplay || i.requiresDurability, {
    message:
      "Replay requires durability. A pattern that cannot survive a restart has nothing left to replay from, so asking for one without the other describes a system that only works until it doesn't.",
    path: ["requiresDurability"],
  });
export type CommunicationIntent = z.infer<typeof communicationIntentSchema>;

/** True when the intent crosses an instance boundary and needs a gateway. */
export function crossesInstance(intent: CommunicationIntent): boolean {
  return intent.locality.sourceInstanceId !== intent.locality.destinationInstanceId;
}

/**
 * An intent grants nothing. It is a description of a need.
 *
 * Assertable because §9's list of things the Fabric may never do begins with
 * granting authority, and the most natural place for that to erode is here —
 * an intent is the first object a developer touches, and the temptation to
 * let a well-formed one mean "approved" is exactly the mistake.
 */
export function intentGrantsAuthority(): false {
  return false;
}
