// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import { authorityReferenceSchema, identifierSchema } from "./identifiers.js";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// The universal Hive message envelope.
//
// Common transport and context metadata for every consequential message, so
// tenancy, authority provenance and correlation survive a hop without every
// engine having to understand every payload.
//
// FOUR CATEGORIES, AND NO MANDATORY PIPE
//
//   COMMAND  do this
//   EVENT    this happened
//   QUERY    tell me
//   RESULT   here is the answer
//
// Constitution §2.3: "Prime shall coordinate the Hive without unnecessarily
// becoming the mandatory execution path for every interaction." This envelope
// is a SHAPE, not a bus. A COMMAND may go direct to an engine; an EVENT may go
// through EventIQ; neither is required to pass through Prime, and nothing here
// routes anything.
//
// IT DOES NOT REPLACE `platformEventSchema`
//
// That one has eight consumers including the live in-memory bus, and it is a
// good event shape. This is the wider envelope: it adds authority provenance,
// data classification, payload references and integrity metadata, and covers
// commands, queries and results as well. An EVENT message may carry a platform
// event as its payload. Replacing the bus's schema was never the goal —
// giving the whole fabric one context shape was.
// ─────────────────────────────────────────────────────────────────────────────

export const messageCategorySchema = z.enum(["COMMAND", "EVENT", "QUERY", "RESULT"]);
export type MessageCategory = z.infer<typeof messageCategorySchema>;

/**
 * How protected the payload is.
 *
 * Drives a real rule below rather than being documentation: `restricted` and
 * `secret` content may not travel inline. Constitution §1.8 limits access to
 * protected material to authorized purposes, and a payload copied into every
 * hop of a fabric has left that boundary long before anybody notices.
 */
export const dataClassificationSchema = z.enum([
  /** No restriction. */
  "public",
  /** Ordinary business data. The default. */
  "internal",
  /** Tenant-owned. Must not cross a tenant boundary. */
  "tenant-confidential",
  /** Protected: credentials, personal data, proprietary material. */
  "restricted",
  /** Secrets. Never inline, never logged, never learned from. */
  "secret",
]);
export type DataClassification = z.infer<typeof dataClassificationSchema>;

/** Classifications that may not travel as an inline payload. */
const REFERENCE_ONLY: ReadonlySet<DataClassification> = new Set(["restricted", "secret"]);

/**
 * Where the payload actually lives, when it is not inline.
 *
 * A reference rather than the content: large payloads should not be copied
 * through every hop, and protected payloads must not be.
 */
export const payloadReferenceSchema = z
  .object({
    /** How to fetch it. A URI, a FileIQ id, a storage key. */
    locator: z.string().min(1),
    /** What the fetched thing is. */
    contentType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().optional(),
    /** Verifiable, so a fetched payload can be checked against the message. */
    integrityHash: z.string().min(1).optional(),
  })
  .strict();
export type PayloadReference = z.infer<typeof payloadReferenceSchema>;

/** Evidence the message arrived as sent. */
export const integrityMetadataSchema = z
  .object({
    algorithm: z.string().min(1),
    /** Digest of the payload or its reference. */
    digest: z.string().min(1),
    /** Who computed it. */
    sealedBy: identifierSchema.optional(),
  })
  .strict();
export type IntegrityMetadata = z.infer<typeof integrityMetadataSchema>;

/**
 * WHERE a message came from.
 *
 * OPTIONAL on the envelope and that is deliberate, because the field is not
 * how origin is established. A producer writing `globalInstanceId: "ksix"`
 * into its own message has asserted an origin, not proved one — the same
 * mistake as a request naming its own tenant.
 *
 * The authoritative origin is bound by the runtime that ACCEPTS the message,
 * from its own configuration. This field is what a message CLAIMS, kept
 * separately so the two can be compared: a claim that disagrees with the
 * accepting instance is refused rather than reconciled.
 *
 * It exists now, before the Interconnect, for one reason. When instance A
 * eventually hands a message to instance B, B must be able to see what A said
 * about itself and check it against a governed relationship. A field added
 * then would be a field every existing producer predates.
 */
export const messageOriginSchema = z
  .object({
    /**
     * The Hive instance the producer says it ran in.
     *
     * Never `tenantId`. A tenant may operate several instances and an instance
     * may serve several tenant contexts; collapsing them would make isolation
     * depend on today's deployment shape.
     */
    globalInstanceId: identifierSchema,
    /**
     * Which build produced it.
     *
     * Events outlive the code that wrote them. Without this, a consumer that
     * finds a malformed payload cannot tell whether the producer was a version
     * with a known defect or a version it has never seen.
     */
    producerVersion: z.string().min(1).optional(),
  })
  .strict();
export type MessageOrigin = z.infer<typeof messageOriginSchema>;

export const HIVE_MESSAGE_SCHEMA_VERSION = 1;

/**
 * The envelope.
 *
 * `.strict()` — an unrecognized field on a message that crosses engine
 * boundaries is one that some engines act on and others drop, which is how two
 * halves of a workflow come to disagree about what was sent.
 */
export const hiveMessageSchema = z
  .object({
    messageId: identifierSchema,
    category: messageCategorySchema,
    /** What KIND of command/event/query it is. `material.reserve`, `order.created`. */
    messageType: z.string().min(1),
    schemaVersion: z.literal(HIVE_MESSAGE_SCHEMA_VERSION),

    /** The engine or component that produced it. */
    producerId: identifierSchema,

    /**
     * Whose data this concerns.
     *
     * MANDATORY unless explicitly system-scoped. Optional tenancy is how a
     * message loses its scope one hop in and nobody notices until it is read
     * under the wrong one.
     */
    tenant: tenantContextSchema.optional(),
    /**
     * True only for messages that genuinely belong to no tenant — a health
     * heartbeat, an engine registration. Must be stated, never inferred from a
     * missing tenant, because a missing tenant is far more often a bug.
     */
    systemScoped: z.boolean().default(false),

    /** The broader coordinated execution, when part of one. */
    executionId: identifierSchema.optional(),
    trace: traceContextSchema,

    timestamp: z.string().min(1),

    /**
     * The authority under which this message was PRODUCED.
     *
     * Provenance, never a grant to the recipient. A consumer that treats an
     * inbound authority reference as its own authority has made the §7 mistake
     * one layer out: the sender was authorized to send, which says nothing
     * about what the receiver may do.
     */
    producedUnderAuthority: authorityReferenceSchema.optional(),

    dataClassification: dataClassificationSchema.default("internal"),

    /**
     * What the producer claims about where it ran. Compared, never trusted.
     * See `messageOriginSchema`.
     */
    origin: messageOriginSchema.optional(),

    /**
     * The stream this message must stay in order within.
     *
     * Absent means this message needs no ordering, which is the common case and
     * the honest default: promising global ordering would make every unrelated
     * workflow share one queue, and across instances it would be a promise
     * nothing could keep.
     *
     * Present, it names ONE thing whose messages must arrive in sequence — one
     * work order, one proposal, one transfer, one execution. Ordering is a
     * guarantee somebody asks for per stream, not a property of the fabric.
     */
    orderingKey: z.string().min(1).optional(),

    /**
     * The business operation this message represents, for consumers that must
     * not perform an effect twice.
     *
     * Distinct from `messageId`, which identifies the MESSAGE: two different
     * messages can describe one operation (a producer retried and generated a
     * new id), and deduplicating on message id alone would let that through.
     */
    idempotencyKey: z.string().min(1).optional(),

    payload: z.unknown().optional(),
    payloadReference: payloadReferenceSchema.optional(),
    integrity: integrityMetadataSchema.optional(),
  })
  .strict()
  .refine((m) => Boolean(m.tenant) !== m.systemScoped, {
    message:
      "A message carries a tenant or declares itself system-scoped, never both and never neither. A missing tenant is far more often a bug than a system message.",
    path: ["tenant"],
  })
  .refine((m) => (m.payload !== undefined) !== (m.payloadReference !== undefined), {
    message:
      "A message carries exactly one of payload or payloadReference. Both is two versions of the truth; neither is a message with nothing in it.",
    path: ["payload"],
  })
  .refine((m) => !REFERENCE_ONLY.has(m.dataClassification) || m.payloadReference !== undefined, {
    message:
      "Restricted and secret content must travel by reference, never inline. A protected payload copied through every hop of the fabric has left its authorized boundary long before anybody notices (Constitution §1.8).",
    path: ["payload"],
  })
  .refine((m) => m.category !== "RESULT" || Boolean(m.trace.causationId), {
    message:
      "A RESULT must name the message it answers. A result nobody can tie to a request is an answer to an unknown question.",
    path: ["trace"],
  })
  .refine((m) => m.category !== "COMMAND" || Boolean(m.producedUnderAuthority), {
    message:
      "A COMMAND must carry the authority it was produced under. Commands are consequential by definition, and one with no traceable authority cannot be audited afterwards.",
    path: ["producedUnderAuthority"],
  });
export type HiveMessage = z.infer<typeof hiveMessageSchema>;

export type MessageParseResult =
  | { readonly ok: true; readonly message: HiveMessage }
  | { readonly ok: false; readonly reason: string };

/** Parses a message, returning the failure rather than throwing. */
export function parseHiveMessage(input: unknown): MessageParseResult {
  const parsed = hiveMessageSchema.safeParse(input);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, reason: JSON.stringify(parsed.error.flatten()) };
}

/**
 * Whether a message may be delivered to a consumer in a given tenant.
 *
 * The tenant boundary, as a function rather than a convention repeated at every
 * subscriber. System-scoped messages reach anyone; everything else reaches only
 * its own tenant.
 */
export function deliverableTo(message: HiveMessage, consumerTenant: string): boolean {
  if (message.systemScoped) return true;
  return message.tenant?.organizationId === consumerTenant;
}

/**
 * Builds a reply that is correctly tied to its request.
 *
 * A helper because getting this wrong is easy and silent: the reply must carry
 * the SAME correlationId and set causationId to the request's messageId. Hand-
 * wiring it at each call site is how a trace ends up with two unrelated halves.
 */
export function replyTo(
  request: HiveMessage,
  reply: {
    messageId: string;
    messageType: string;
    producerId: string;
    timestamp: string;
    payload?: unknown;
    payloadReference?: PayloadReference;
    dataClassification?: DataClassification;
  },
): HiveMessage {
  return hiveMessageSchema.parse({
    ...reply,
    category: "RESULT",
    schemaVersion: HIVE_MESSAGE_SCHEMA_VERSION,
    ...(request.tenant ? { tenant: request.tenant } : {}),
    systemScoped: request.systemScoped,
    ...(request.executionId ? { executionId: request.executionId } : {}),
    trace: {
      ...request.trace,
      correlationId: request.trace.correlationId,
      causationId: request.messageId,
    },
  });
}
