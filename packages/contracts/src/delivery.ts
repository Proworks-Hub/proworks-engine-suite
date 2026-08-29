// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery vocabulary: what a sender is promised, and what a recipient says.
//
// WHY THIS LIVES IN `contracts` AND NOT IN COMMUNICATION CORE
//
// It was written in Communication Core (Wave G), which is where it conceptually
// belongs — Communication owns what these words MEAN. But the dependency law
// says `platform: []`: a Shared Platform engine may import nothing in the tier
// system, and EventIQ is a Shared Platform engine whose charter names
// Communication Core as a required dependency ("Communication Core defines
// event primitives; EventIQ operationalizes them").
//
// A vocabulary that the engine implementing it may not import is not a
// vocabulary. So the TYPES moved here, exactly as the identifier and reference
// types did in Wave B for the same collision, and for the same reason.
//
// Communication Core keeps AUTHORITY over the semantics and re-exports these.
// What moved is where the shapes are declared, not who owns their meaning.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the sender is promised about delivery.
 *
 * `exactly-once` is deliberately absent. Almost nothing can honestly provide it
 * across a real boundary, and a system that claims it stops building the
 * idempotent consumers that make at-least-once safe. Naming the guarantee you
 * can keep is worth more than naming the one you would like.
 */
export const deliveryGuaranteeSchema = z.enum([
  /** Fire and forget. May be lost. For signals whose loss costs nothing. */
  "at-most-once",
  /** Retried until acknowledged. MAY ARRIVE TWICE — consumers must be idempotent. */
  "at-least-once",
]);
export type DeliveryGuarantee = z.infer<typeof deliveryGuaranteeSchema>;

/**
 * How much order is promised.
 *
 * Scoped rather than global, because global ordering across a distributed
 * fabric costs more than it is worth and is usually not what anyone needed —
 * what they needed was "these two messages about THIS work order in order".
 */
export const orderingScopeSchema = z.enum(["none", "per-entity", "per-tenant", "per-workflow"]);
export type OrderingScope = z.infer<typeof orderingScopeSchema>;

export const deliveryExpectationSchema = z
  .object({
    guarantee: deliveryGuaranteeSchema,
    ordering: orderingScopeSchema.default("none"),
    /** Attempts before the message is dead-lettered. */
    maxAttempts: z.number().int().positive().default(1),
    /** After this, delivery stops being useful and the message is expired. */
    expiresAt: z.string().min(1).optional(),
    /**
     * Whether losing this message matters.
     *
     * Drives escalation. Charter: failures should be "isolated, queued,
     * retried, expired, or escalated according to consequence rather than
     * silently losing critical messages."
     */
    consequenceIfLost: z.enum(["none", "degraded", "material", "critical"]).default("degraded"),
  })
  .strict()
  .refine((d) => d.guarantee !== "at-most-once" || d.maxAttempts === 1, {
    message:
      "at-most-once cannot retry. An expectation that says deliver-once and then retries is describing at-least-once under a safer-sounding name.",
    path: ["maxAttempts"],
  })
  .refine((d) => d.consequenceIfLost !== "critical" || d.guarantee === "at-least-once", {
    message:
      "A message whose loss is critical may not be sent at-most-once. That combination is a decision to sometimes lose something that matters.",
    path: ["guarantee"],
  });
export type DeliveryExpectation = z.infer<typeof deliveryExpectationSchema>;

/** What a recipient says back. */
export const acknowledgementSchema = z
  .object({
    messageId: z.string().min(1),
    by: z.string().min(1),
    at: z.string().min(1),
    outcome: z.enum([
      /** Received and processed. */
      "accepted",
      /** Received and already processed — a duplicate. Not a failure. */
      "duplicate",
      /** Received, cannot process, do not retry. */
      "rejected",
      /** Received, could not process now, retry is worthwhile. */
      "deferred",
    ]),
    /** Required for anything other than acceptance. */
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((a) => a.outcome === "accepted" || Boolean(a.reason), {
    message:
      "A rejection, deferral or duplicate must say why. An unexplained rejection is indistinguishable from a bug in the sender.",
    path: ["reason"],
  });
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

/** True when the sender should try again. */
export function shouldRetry(ack: Acknowledgement, expectation: DeliveryExpectation, attempts: number): boolean {
  if (ack.outcome !== "deferred") return false;
  if (expectation.guarantee === "at-most-once") return false;
  return attempts < expectation.maxAttempts;
}

/** True when delivery is no longer worth attempting. */
export function hasExpired(expectation: DeliveryExpectation, now: Date): boolean {
  return Boolean(expectation.expiresAt) && now >= new Date(expectation.expiresAt!);
}
