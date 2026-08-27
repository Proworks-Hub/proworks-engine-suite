// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Outbox, OutboxEntry } from "@proworks-hub/contracts";
import { outboxEntrySchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// An outbox held in memory.
//
// Useful for tests and for proving the ordering rules hold — and NOT a real
// outbox, for a reason worth stating plainly rather than burying: an outbox
// exists to survive a crash, and this one does not. A host binds something
// durable, in the same transaction as its own writes. That transactional part
// is the whole mechanism, and it cannot live in a pure package.
// ─────────────────────────────────────────────────────────────────────────────

export interface InMemoryOutbox extends Outbox {
  record(
    entry: Omit<OutboxEntry, "entryId" | "status" | "attempts" | "sequence" | "recordedAt">,
  ): OutboxEntry;
  pending(limit?: number): OutboxEntry[];
  markPublished(entryId: string): void;
  markFailed(entryId: string, error: string): void;
  pendingCount(): number;
  /** Everything ever recorded, for assertions. */
  all(): OutboxEntry[];
  clear(): void;
}

export function createInMemoryOutbox(
  options: { now?: () => Date; generateId?: () => string } = {},
): InMemoryOutbox {
  const now = options.now ?? (() => new Date());
  const generateId =
    options.generateId ??
    (() => {
      const g = globalThis as { crypto?: { randomUUID?: () => string } };
      return typeof g.crypto?.randomUUID === "function"
        ? `obx_${g.crypto.randomUUID()}`
        : `obx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const entries: OutboxEntry[] = [];
  let sequence = 0;

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

  return {
    record(entry) {
      const recorded = outboxEntrySchema.parse({
        ...entry,
        entryId: generateId(),
        status: "pending",
        attempts: 0,
        // Assigned here, not by the caller. A caller-supplied sequence is a
        // caller who can get ordering wrong, and ordering is the one thing
        // this structure exists to preserve.
        sequence: sequence++,
        recordedAt: now().toISOString(),
      });
      entries.push(recorded);
      return clone(recorded);
    },

    pending(limit = 100) {
      return entries
        .filter((e) => e.status === "pending")
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, limit)
        .map(clone);
    },

    markPublished(entryId) {
      const entry = entries.find((e) => e.entryId === entryId);
      if (!entry) return;
      entry.status = "published";
      entry.publishedAt = now().toISOString();
    },

    markFailed(entryId, error) {
      const entry = entries.find((e) => e.entryId === entryId);
      if (!entry) return;
      // Stays pending deliberately. Marking it failed and moving on would lose
      // the event, which is the failure this whole structure exists to prevent.
      entry.attempts += 1;
      entry.lastError = error;
    },

    pendingCount: () => entries.filter((e) => e.status === "pending").length,
    all: () => entries.map(clone),
    clear: () => {
      entries.length = 0;
      sequence = 0;
    },
  };
}
