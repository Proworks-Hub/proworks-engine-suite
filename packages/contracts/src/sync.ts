// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";
import { traceContextSchema } from "./trace.js";

// ─────────────────────────────────────────────────────────────────────────────
// A shop that keeps working when the internet does not.
//
// This is not a nice-to-have for a production floor. The connection drops, and
// the operator at the press still has fifty shirts to finish. If the software
// stops, the shop stops — and a shop that stops because of a router is a shop
// that goes back to paper, permanently.
//
// The engines already survive this by construction: they are pure, hold no
// connections, and run against whatever storage a host binds. What was missing
// is the other half — what happens to work RECORDED during the outage.
//
// The answer is an outbox, and it exists to close one specific gap: a local
// state change that succeeds while publishing it fails. Without it, the shop
// floor believes an operation completed and the rest of the system never hears.
// ─────────────────────────────────────────────────────────────────────────────

export const outboxEntryStatusSchema = z.enum(["pending", "published", "failed"]);
export type OutboxEntryStatus = z.infer<typeof outboxEntryStatusSchema>;

export const outboxEntrySchema = z
  .object({
    entryId: z.string().min(1),
    /**
     * Written in the SAME transaction as the state change it describes.
     *
     * That is the entire mechanism. Either both the change and this row commit,
     * or neither does — so there is no window where the shop believes something
     * happened and nobody else will ever be told.
     */
    eventType: z.string().min(1),
    payload: z.unknown(),
    /** Whose work this was. */
    organizationId: z.string().min(1),
    trace: traceContextSchema,

    status: outboxEntryStatusSchema.default("pending"),
    attempts: z.number().int().min(0).default(0),
    /**
     * Ordering within one origin.
     *
     * Events must reach the far side in the order the shop produced them: a
     * step cannot complete before it started. Monotonic per origin rather than
     * globally, because two shops working offline cannot coordinate a counter.
     */
    sequence: z.number().int().min(0),
    recordedAt: z.string().min(1),
    publishedAt: z.string().optional(),
    lastError: z.string().optional(),
  })
  .strict();
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

/**
 * Holds what has happened locally but has not yet been told to anyone.
 *
 * A port: ProWorks would back this with its local database and Family Table
 * with IndexedDB. What matters is that it is durable — an outbox in memory is
 * an outbox that loses exactly the events an outage produced.
 */
export interface Outbox {
  /** Records an entry. A host calls this inside its own transaction. */
  record(
    entry: Omit<OutboxEntry, "entryId" | "status" | "attempts" | "sequence" | "recordedAt">,
  ): Promise<OutboxEntry> | OutboxEntry;

  /** The next entries to publish, oldest first. Ordering is not optional. */
  pending(limit?: number): Promise<OutboxEntry[]> | OutboxEntry[];

  markPublished(entryId: string): Promise<void> | void;

  /**
   * Records a failed attempt. The entry stays PENDING — an outbox that drops
   * an entry after a few failures has reintroduced the data loss it exists to
   * prevent. Persistent failures need a human, not a deletion.
   */
  markFailed(entryId: string, error: string): Promise<void> | void;

  /** How far behind the shop is. The number that says an outage is ongoing. */
  pendingCount(): Promise<number> | number;
}

export const connectivitySchema = z.enum(["online", "offline", "reconnecting"]);
export type Connectivity = z.infer<typeof connectivitySchema>;

export interface SyncResult {
  published: number;
  failed: number;
  remaining: number;
  /**
   * True when publishing stopped at the first failure rather than continuing.
   *
   * It always does, and that is deliberate: entries from one origin must arrive
   * in order, so skipping a stuck entry to publish the next would deliver a
   * completion before the start it depends on.
   */
  haltedOnFailure: boolean;
}

/**
 * Drains the outbox when connectivity returns.
 *
 * Stops at the first failure. Continuing past it would publish later events
 * before an earlier one that has not arrived — which is worse than being
 * behind, because a consumer cannot tell a gap from an ordering error.
 */
export async function drainOutbox(
  outbox: Outbox,
  publish: (entry: OutboxEntry) => Promise<void> | void,
  options: { limit?: number } = {},
): Promise<SyncResult> {
  const entries = await outbox.pending(options.limit ?? 100);
  let published = 0;

  for (const entry of entries) {
    try {
      await publish(entry);
      await outbox.markPublished(entry.entryId);
      published += 1;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      await outbox.markFailed(entry.entryId, error.message);
      return {
        published,
        failed: 1,
        remaining: await outbox.pendingCount(),
        haltedOnFailure: true,
      };
    }
  }

  return {
    published,
    failed: 0,
    remaining: await outbox.pendingCount(),
    haltedOnFailure: false,
  };
}
