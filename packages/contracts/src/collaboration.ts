// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { tenantContextSchema } from "./tenancy.js";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// One shop subcontracting another.
//
// A screen printer needs DTF transfers. A fabricator needs powder coating. The
// network exists so they can find each other — and the moment they transact,
// the interesting question is not connectivity, it is **what crosses**.
//
// The failure to design against is the tempting one: give Shop B a login to
// Shop A's system. It works immediately and it is wrong. Shop B now sees
// margins, the customer list, every unrelated job, and what Shop A's machines
// are doing. None of that is required to press fifty shirts.
//
// So a collaboration is a CONTRACT, not an account. Shop B receives a request
// built field by field from what the work actually needs, and nothing else
// crosses because nothing else was put in.
//
// This is the same boundary ReceiptIQ already runs between a household and a
// shop, applied between two businesses. It worked there for the same reason: a
// strict schema plus a guard, rather than a policy somebody has to remember.
// ─────────────────────────────────────────────────────────────────────────────

/** Fields that must never cross an organizational boundary. */
export const PRIVATE_TO_ORIGINATOR: ReadonlySet<string> = new Set([
  "margin", "marginpct", "cost", "totalcost", "unitcost", "internalcost",
  "costbreakdown", "pricing", "profit", "markup",
  "customerid", "customername", "customeremail", "customerphone", "customer",
  "shopnotes", "internalnotes", "privatenotes",
  "machineutilization", "capacity", "queuedepth",
  "vendorpricing", "supplierterms",
]);

function fieldWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Refuses anything a subcontractor has no business seeing.
 *
 * Descends, because the realistic leak is not a top-level `margin` — nobody
 * writes that. It is a `lineItems[0].meta.internalCost` that arrived because
 * somebody spread an object instead of naming its fields.
 */
export function assertNothingPrivateCrosses(value: unknown, path = "request"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNothingPrivateCrosses(entry, `${path}[${i}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const words = fieldWords(key);
    if (PRIVATE_TO_ORIGINATOR.has(words.join("")) || words.some((w) => PRIVATE_TO_ORIGINATOR.has(w))) {
      throw new Error(
        `"${key}" at ${path} is private to the originating shop and must not cross to a ` +
          `subcontractor. Send what the work requires, not the record it came from.`,
      );
    }
    assertNothingPrivateCrosses(entry, `${path}.${key}`);
  }
}

export const collaborationItemSchema = z
  .object({
    /** What is being asked for, in terms the receiving shop understands. */
    description: z.string().min(1),
    quantity: z.number().int().positive(),
    /** Sizes, colours, materials, placement — whatever the work needs. */
    specifications: z.record(z.string(), z.string()).default({}),
    /** Artifact references. The bytes travel by their own route, not in here. */
    fileRefs: z.array(z.string()).default([]),
  })
  .strict();
export type CollaborationItem = z.infer<typeof collaborationItemSchema>;

export const COLLABORATION_REQUEST_VERSION = 1;

/**
 * What actually crosses.
 *
 * `.strict()` matters more here than almost anywhere else in the suite: it is
 * what turns "we did not mean to send that" into a parse failure at the
 * boundary rather than a discovery six months later.
 */
export const collaborationRequestSchema = z
  .object({
    requestVersion: z.literal(COLLABORATION_REQUEST_VERSION).default(COLLABORATION_REQUEST_VERSION),
    collaborationId: z.string().min(1),

    /**
     * Who is asking — a name and an id, not a tenant context.
     *
     * Deliberately not `TenantContext`: that carries roles and a user, which
     * describe the originator's internal permissions and are meaningless and
     * revealing to anybody else.
     */
    from: z.object({ organizationId: z.string().min(1), displayName: z.string().min(1) }).strict(),
    to: z.object({ organizationId: z.string().min(1) }).strict(),

    /**
     * The originator's own reference, so replies can be matched up.
     *
     * An opaque string. The receiving shop cannot resolve it to anything, and
     * that is intentional — it is a correlation handle, not a key into a
     * database it does not own.
     */
    originatorRef: z.string().min(1),

    items: z.array(collaborationItemSchema).min(1),
    /** When it is needed. Not the originator's internal schedule. */
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Instructions for the work itself. Not shop notes. */
    instructions: z.string().optional(),

    trace: traceContextSchema,
    createdAt: z.string().min(1),
  })
  .strict();
export type CollaborationRequest = z.infer<typeof collaborationRequestSchema>;

export const collaborationResponseSchema = z
  .object({
    collaborationId: z.string().min(1),
    from: z.object({ organizationId: z.string().min(1) }).strict(),
    status: z.enum(["accepted", "declined", "quoted", "completed"]),
    /**
     * What the receiving shop will charge. Their price, not their cost —
     * the boundary protects them exactly as it protects the originator.
     */
    quotedPrice: z.object({ cents: z.number().int(), currency: z.string() }).strict().optional(),
    /** When they can do it by. */
    committedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    message: z.string().optional(),
    /** Finished goods, proofs, whatever the work produced. */
    fileRefs: z.array(z.string()).default([]),
    trace: traceContextSchema,
    respondedAt: z.string().min(1),
  })
  .strict();
export type CollaborationResponse = z.infer<typeof collaborationResponseSchema>;

/**
 * Where collaborations live for a host.
 *
 * Every read is scoped to the asking organization, and there is deliberately no
 * "list all" — an API that cannot express a cross-organization query cannot
 * accidentally answer one.
 */
export interface CollaborationRepository {
  send(request: CollaborationRequest): Promise<void> | void;
  /** Requests this organization has RECEIVED. */
  inbox(organizationId: string): Promise<CollaborationRequest[]> | CollaborationRequest[];
  /** Requests this organization has SENT. */
  outbox(organizationId: string): Promise<CollaborationRequest[]> | CollaborationRequest[];
  respond(response: CollaborationResponse): Promise<void> | void;
  responsesFor(collaborationId: string): Promise<CollaborationResponse[]> | CollaborationResponse[];
}

/**
 * Checks that a request is safe to send, and says why when it is not.
 *
 * Both halves matter. The schema catches a field that should not exist; the
 * guard catches one that is nested where a schema is not looking, and names it
 * so the fix is obvious rather than a hunt.
 */
export function validateCollaborationRequest(request: unknown): CollaborationRequest {
  const parsed = collaborationRequestSchema.parse(request);
  assertNothingPrivateCrosses(parsed);
  return parsed;
}
