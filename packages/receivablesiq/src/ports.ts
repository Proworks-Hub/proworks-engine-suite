// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ReceivableJournalEntry } from "./model.js";

// ─────────────────────────────────────────────────────────────────────────────
// ReceivableStorePort — the ONLY persistence surface (§21). No table, no ORM,
// no schema inside the engine. Unbound behaviour: every query refuses with
// `store-port-unbound` — never an empty aging, because an empty aging and an
// unbound store are indistinguishable to a caller and one of them is a
// disaster. Append is atomic and ordered per tenant; a partial append is a
// failure, not a partial success. There is no update and no delete: the
// journal is append-only, and corrections are new entries.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceivableStorePort {
  /** Atomic per tenant, ordered by sequence. */
  append(entries: readonly ReceivableJournalEntry[]): Promise<void>;
  hasIdempotencyKey(tenantRef: string, key: string): Promise<boolean>;
  readJournal(tenantRef: string): Promise<readonly ReceivableJournalEntry[]>;
  /** The next monotonic sequence for a tenant, consumed on append. */
  nextSequence(tenantRef: string): Promise<number>;
}

export function createInMemoryReceivableStore(): ReceivableStorePort {
  const journals = new Map<string, ReceivableJournalEntry[]>();
  const keys = new Set<string>();
  const sequences = new Map<string, number>();
  return {
    async append(entries) {
      // Atomic in memory: validate everything, then write everything.
      for (const entry of entries) {
        if (keys.has(`${entry.tenantRef}::${entry.idempotencyKey}`)) {
          throw new Error(`Duplicate idempotency key ${entry.idempotencyKey}; append is refused whole.`);
        }
      }
      for (const entry of entries) {
        const journal = journals.get(entry.tenantRef) ?? [];
        journal.push(entry);
        journals.set(entry.tenantRef, journal);
        keys.add(`${entry.tenantRef}::${entry.idempotencyKey}`);
      }
    },
    async hasIdempotencyKey(tenantRef, key) {
      return keys.has(`${tenantRef}::${key}`);
    },
    async readJournal(tenantRef) {
      return journals.get(tenantRef) ?? [];
    },
    async nextSequence(tenantRef) {
      const next = (sequences.get(tenantRef) ?? 0) + 1;
      sequences.set(tenantRef, next);
      return next;
    },
  };
}
