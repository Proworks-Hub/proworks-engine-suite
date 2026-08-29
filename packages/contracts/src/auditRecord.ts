// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { identifierSchema } from "./identifiers.js";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constitutional audit evidence.
//
// AuditIQ's charter states the question this shape must answer:
//
//   "What happened, who or what acted, under what authority, and what result
//    followed?"
//
// AUDIT EVIDENCE IS NOT A LOG. An operational log answers "what is the software
// doing" and may be sampled, rotated and dropped. This answers "what
// consequential action occurred, under whose authority, and with what result",
// and may not. They are separate types here so no call site can send one where
// the other belongs — a log line that ages out cannot answer a question asked
// months later, usually when money is involved.
//
// THIS IS NOT THE OTHER `AuditEntry`
//
// `observability.ts` already has one. It records a DOMAIN CHANGE — before,
// after, which entity — and is the right shape for "who overrode this cost".
// This records a CONSEQUENTIAL ACTION and its authority. Both are legitimate
// and neither subsumes the other: a denied action changes nothing and must
// still be recorded, which a before/after shape cannot express.
//
// WHAT MAY NOT GO IN
//
// The charter's non-ownership list includes "the authority decisions that
// produced the recorded action". So this carries a REFERENCE to a Governance
// decision, never a copy of it. Governance owns decisions; copying one here
// would create a second version that could disagree with the first.
// ─────────────────────────────────────────────────────────────────────────────

/** What happened to the attempted action. */
export const auditOutcomeSchema = z.enum([
  /** It happened. */
  "succeeded",
  /** It was attempted and failed. */
  "failed",
  /** Governance refused it. Nothing happened, and that is worth recording. */
  "denied",
  /** It began and did not finish. The state is one nobody chose. */
  "partial",
]);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

/** Who or what acted. */
export const auditActorSchema = z
  .object({
    actorId: identifierSchema,
    kind: z.enum(["human", "service", "engine", "agent", "host", "external"]),
    /** Present when acting as a delegate. */
    onBehalfOf: identifierSchema.optional(),
  })
  .strict();
export type AuditActor = z.infer<typeof auditActorSchema>;

/**
 * One piece of constitutional evidence.
 *
 * `.strict()`, because an unknown field in evidence is a claim nobody defined,
 * and evidence that accepts arbitrary content is evidence anybody can shape.
 */
export const auditRecordSchema = z
  .object({
    auditEventId: identifierSchema,
    occurredAt: z.string().min(1),

    actor: auditActorSchema,
    tenant: tenantContextSchema,

    /** Which engine performed or refused the action. */
    component: identifierSchema,
    componentVersion: z.string().min(1).optional(),

    /** Past tense, like an event: `material.reserved`, `job.priced`. */
    action: z.string().min(1),
    /** What it acted on. Absent when the action names no single object. */
    target: z
      .object({ type: z.string().min(1), id: identifierSchema })
      .strict()
      .optional(),

    /**
     * The Governance decision that permitted or refused this.
     *
     * A REFERENCE. The charter excludes "the authority decisions that produced
     * the recorded action" from AuditIQ's ownership — copying a decision here
     * would create a second version able to disagree with Governance's.
     */
    governanceDecisionId: identifierSchema.optional(),
    policyId: identifierSchema.optional(),
    policyVersion: z.string().min(1).optional(),

    /** Ties this to a coordinated execution and to what caused it. */
    executionId: identifierSchema.optional(),
    trace: traceContextSchema,

    outcome: auditOutcomeSchema,
    /**
     * Why, in words a person can act on.
     *
     * Required on every outcome including success. Evidence that records only
     * failures answers "what went wrong" and not "what happened".
     */
    reason: z.string().min(1),

    /**
     * Small, non-sensitive facts worth keeping.
     *
     * Deliberately narrow: strings, numbers and booleans only. No nested
     * objects, because a nested object is where a payload gets attached, and
     * the charter's own guidance is to reference rather than copy protected
     * content into evidence.
     */
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict()
  .refine((r) => r.outcome !== "denied" || Boolean(r.governanceDecisionId), {
    message:
      "A denied action must reference the Governance decision that denied it. A denial with no traceable decision cannot be reviewed, appealed, or distinguished from a fault.",
    path: ["governanceDecisionId"],
  });
export type AuditRecord = z.infer<typeof auditRecordSchema>;

/**
 * A record as stored: the evidence plus its place in the chain.
 *
 * `hash` covers the record AND `previousHash`, so altering any earlier entry
 * invalidates every later one. That is what makes the evidence tamper-EVIDENT
 * rather than tamper-proof — it cannot stop a change, and it cannot be changed
 * without the change being visible.
 */
export const sealedAuditRecordSchema = z
  .object({
    record: auditRecordSchema,
    sequence: z.number().int().nonnegative(),
    previousHash: z.string().min(1),
    hash: z.string().min(1),
  })
  .strict();
export type SealedAuditRecord = z.infer<typeof sealedAuditRecordSchema>;

/** The first link. A fixed, known value so the chain has a verifiable start. */
export const AUDIT_CHAIN_GENESIS = "genesis";
