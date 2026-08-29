// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { createHash } from "node:crypto";

import {
  AUDIT_CHAIN_GENESIS,
  auditRecordSchema,
  type AuditRecord,
  type InstanceIdentity,
  type SealedAuditRecord,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// AuditIQ: tamper-evident evidence of consequential activity.
//
// Charter: "What happened, who or what acted, under what authority, and what
// result followed?" — and it owns "audit event structures, accepted audit
// records, tamper-evidence metadata, retention state, evidence-chain
// references", explicitly NOT "constitutional guilt, security adjudication,
// domain source records, or the authority decisions that produced the recorded
// action."
//
// So this engine records and proves. It does not judge, and it stores no
// domain record — only references to them.
//
// APPEND-ONLY, AND WHY THE INTERFACE HAS NO UPDATE
//
// There is no `update`, no `delete`, no `redact`. Not "they throw" — they do not
// exist. A mutable audit store is one where the most interesting entry is the
// one that can be changed, and an interface offering the method invites somebody
// to reach for it during an incident, which is the worst possible moment.
//
// Retention and lawful erasure are real requirements and are NOT solved by
// exposing a delete here. They need a separate, separately authorized
// compensating operation with its own evidence — recorded, not silent.
//
// TAMPER-EVIDENT, NOT TAMPER-PROOF
//
// Each record's hash covers its content AND the previous hash, so altering any
// entry invalidates every later one. Nothing here can PREVENT a change to the
// underlying store. What it guarantees is that a change cannot be made without
// becoming visible, which is the honest claim — and the Decision Record's Core
// Protection against destroying evidence is what makes altering it prohibited.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditQuery {
  tenant?: string;
  actorId?: string;
  component?: string;
  action?: string;
  outcome?: AuditRecord["outcome"];
  executionId?: string;
  correlationId?: string;
  limit?: number;
}

export interface ChainVerification {
  readonly intact: boolean;
  /** Sequence of the first record whose hash does not agree with the chain. */
  readonly brokenAt?: number;
  readonly reason?: string;
  readonly recordsChecked: number;
}

export interface AuditIq {
  /**
   * Records evidence.
   *
   * Rejects rather than throws: an engine whose audit write throws will
   * eventually be wrapped in a try/catch that swallows it, and silently
   * unrecorded evidence is worse than a visible refusal.
   */
  record(input: unknown): { accepted: true; sealed: SealedAuditRecord } | { accepted: false; reason: string };

  query(filter?: AuditQuery): readonly SealedAuditRecord[];

  /** Walks the chain and reports where it first disagrees, if anywhere. */
  verify(): ChainVerification;

  /** How many records are held. */
  count(): number;

  /** Whether the bound store survives a restart. */
  durability(): "in-memory" | "durable";
}

/**
 * Where sealed evidence lives.
 *
 * A port, and the reason is blunt: every guarantee this engine makes — the
 * chain is intact, the dead entry is still there, nothing was removed — is a
 * guarantee about state, and until now that state was a module-local array
 * that did not survive the process. An append-only store nobody can persist is
 * append-only for the lifetime of a node process.
 *
 * SYNCHRONOUS, deliberately, for the reason EventIQ's store is: `record` and
 * `verify` return values rather than promises and every caller depends on
 * that. `better-sqlite3` is synchronous and is what a host binds. A
 * network-latency store would need an async variant of this engine, which is
 * named as debt rather than discovered by whoever tries it.
 *
 * NO `delete` AND NO `update`, here as in the engine above. A port that
 * offered them would put the method back within reach of somebody during an
 * incident, which is the worst possible moment.
 */
export interface AuditStore {
  /** Whether entries survive a restart. A claim tests read. */
  readonly durability: "in-memory" | "durable";
  append(entry: SealedAuditRecord): void;
  /** Every entry, in sequence order. Ordering is not optional for a chain. */
  all(): readonly SealedAuditRecord[];
  count(): number;
  /** The last hash, so a restarted engine continues the chain rather than restarting it. */
  lastHash(): string | null;
}

/** The in-memory adapter. Honest about being in-memory. */
export function createInMemoryAuditStore(): AuditStore {
  const entries: SealedAuditRecord[] = [];
  return {
    durability: "in-memory",
    append: (entry) => {
      entries.push(entry);
    },
    all: () => entries,
    count: () => entries.length,
    lastHash: () => entries[entries.length - 1]?.hash ?? null,
  };
}

export interface AuditIqOptions {
  /**
   * Which Hive instance is sealing this evidence. REQUIRED, never defaulted.
   *
   * Bound here rather than accepted on the record, for the reason EventIQ
   * binds its own and the admission gate binds principals': a writer that
   * names its own instance has asserted an origin, not established one.
   *
   * It is inside the seal, so it is covered by the hash — an instance
   * attribution that could be edited without breaking the chain would be a
   * label rather than evidence.
   */
  instance: InstanceIdentity;
  /**
   * Where evidence is kept. Defaults to the in-memory adapter.
   *
   * A default rather than a requirement, because in-memory is correct for a
   * test — but `durability()` says which is bound, so a host cannot believe
   * its audit chain survived a restart when it did not.
   */
  store?: AuditStore;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  generateId?: () => string;
  /**
   * Called when a record is refused.
   *
   * Refused evidence is itself worth noticing — a run of rejected writes means
   * something is emitting malformed evidence, and nobody would otherwise see it.
   */
  onRejected?: (reason: string, input: unknown) => void;
}

/** Stable hash input. Key order is sorted, or the same record hashes two ways. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

function sealHash(
  record: AuditRecord,
  globalInstanceId: string,
  sequence: number,
  previousHash: string,
): string {
  // The instance is INSIDE the hash. Outside it, the attribution could be
  // rewritten without the chain noticing, and "which instance sealed this" is
  // precisely the claim a collective ledger will later have to rely on.
  //
  // The separator is a character no component can contain, so no combination
  // of values can forge another's preimage. Written as an escape rather than a
  // raw byte: identical bytes, and legible in review.
  return createHash("sha256")
    .update(
      `${sequence}\u0000${globalInstanceId}\u0000${previousHash}\u0000${canonical(record)}`,
    )
    .digest("hex");
}

export function createAuditIq(options: AuditIqOptions): AuditIq {
  const now = options.now ?? (() => new Date());
  const instanceId = options.instance.globalInstanceId;
  const newId =
    options.generateId ??
    (() => `aud_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`);

  // Behind a port now. Still not exposed and still not handed out by
  // reference: an append-only store that returns its array is append-only by
  // convention.
  const store = options.store ?? createInMemoryAuditStore();

  return {
    record(input) {
      const withDefaults =
        typeof input === "object" && input !== null
          ? {
              auditEventId: newId(),
              occurredAt: now().toISOString(),
              ...(input as Record<string, unknown>),
            }
          : input;

      const parsed = auditRecordSchema.safeParse(withDefaults);
      if (!parsed.success) {
        const reason = `Not valid audit evidence: ${JSON.stringify(parsed.error.flatten())}`;
        options.onRejected?.(reason, input);
        return { accepted: false, reason };
      }

      const sequence = store.count();
      // From the STORE, not from a local variable. A restarted engine continues
      // the chain it inherited rather than starting a second one from genesis —
      // and two chains in one store is a break that `verify` would report at
      // the seam, correctly but confusingly.
      const previousHash = store.lastHash() ?? AUDIT_CHAIN_GENESIS;
      const sealed: SealedAuditRecord = {
        record: parsed.data,
        globalInstanceId: instanceId,
        sequence,
        previousHash,
        hash: sealHash(parsed.data, instanceId, sequence, previousHash),
      };

      store.append(sealed);
      // Frozen on the way out. A caller holding a reference it can mutate is a
      // caller that can alter evidence without the chain noticing, because the
      // hash was computed before the mutation.
      return { accepted: true, sealed: Object.freeze(structuredClone(sealed)) };
    },

    query(filter = {}) {
      const matches = store.all().filter((e) => {
        const r = e.record;
        if (filter.tenant && r.tenant.organizationId !== filter.tenant) return false;
        if (filter.actorId && r.actor.actorId !== filter.actorId) return false;
        if (filter.component && r.component !== filter.component) return false;
        if (filter.action && r.action !== filter.action) return false;
        if (filter.outcome && r.outcome !== filter.outcome) return false;
        if (filter.executionId && r.executionId !== filter.executionId) return false;
        if (filter.correlationId && r.trace.correlationId !== filter.correlationId) return false;
        return true;
      });

      // Copies, deeply. Returning the stored objects would let a caller mutate
      // the store through the query result.
      const limited = filter.limit === undefined ? matches : matches.slice(0, filter.limit);
      return limited.map((e) => Object.freeze(structuredClone(e)));
    },

    verify() {
      let previousHash = AUDIT_CHAIN_GENESIS;

      let expectedSequence = 0;

      for (const entry of store.all()) {
        // ── Sequence, checked separately from the hash chain ──────────────
        //
        // The hash covers the sequence, so a tampered sequence produces a
        // tampered hash and is caught below — but only if the ORIGINAL was
        // written correctly. A writer that stamped every entry with sequence 0
        // produces a store that is internally consistent and chains perfectly,
        // and the chain check passes it.
        //
        // Found by a surviving mutation. The error message here has always
        // claimed to detect a record "removed, reordered or inserted"; without
        // this, it detected only the ones that broke the linking.
        if (entry.sequence !== expectedSequence) {
          return {
            intact: false,
            brokenAt: entry.sequence,
            reason: `Record at position ${expectedSequence} claims sequence ${entry.sequence}. Sequences must be consecutive from zero; a gap or a repeat means a record was removed, inserted, or written by something that was not counting.`,
            recordsChecked: expectedSequence,
          };
        }
        expectedSequence += 1;

        if (entry.previousHash !== previousHash) {
          return {
            intact: false,
            brokenAt: entry.sequence,
            reason: `Record ${entry.sequence} expects previous hash ${previousHash} but claims ${entry.previousHash}. A record was removed, reordered or inserted.`,
            recordsChecked: entry.sequence,
          };
        }

        const expected = sealHash(
          entry.record,
          entry.globalInstanceId,
          entry.sequence,
          entry.previousHash,
        );
        if (expected !== entry.hash) {
          return {
            intact: false,
            brokenAt: entry.sequence,
            reason: `Record ${entry.sequence} does not match its own hash. Its content was altered after it was sealed.`,
            recordsChecked: entry.sequence,
          };
        }

        previousHash = entry.hash;
      }

      return { intact: true, recordsChecked: store.count() };
    },

    count: () => store.count(),
    durability: () => store.durability,
  };
}
