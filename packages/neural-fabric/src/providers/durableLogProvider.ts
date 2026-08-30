/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/providers/durableLogProvider.ts
 * Module:   neural-fabric / providers
 * Purpose:  A Kafka-shaped reference transport: partitioned, ordered, remembers.
 */

import { partitionFor } from "../engines/streamIQ.js";
import type { ProviderCapability, TransportProviderPort } from "../ports/providers.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE OPPOSITE PROVIDER, ON PURPOSE
//
// Where the subject bus forgets, this remembers everything within retention.
// Where the bus fans out to whoever is listening NOW, this appends to a
// partitioned log that consumers read at their own pace, from their own
// committed positions. The two adapters disagree about every interesting
// semantic — durability, ordering, redelivery, replay — which is exactly what
// makes them together a proof of provider neutrality: the runtime drives both
// through the same port, and nothing above the port can tell.
//
// PARTITION BY THE ENVELOPE'S KEY FIELDS, DETERMINISTICALLY
//
// The partition key is idempotencyKey when present (a command's retries land
// in the same partition, preserving per-key order), else the correlation id.
// This reuses StreamIQ's `partitionFor` — the same hash the repartition-impact
// analysis reasons about, so what the analysis predicts is what the transport
// does.
//
// CONSUMERS PULL. THE LOG NEVER PUSHES.
//
// A pull model is what makes "a slow consumer does not slow the producer"
// true, and it is why lag is observable at all: the gap between the head and
// a committed position IS the lag, and StreamIQ's consumerLag reads exactly
// that shape from this provider.
// ─────────────────────────────────────────────────────────────────────────────

export interface LogEntry {
  readonly offset: number;
  readonly appendedAt: string;
  readonly envelopeJson: string;
}

export interface DurableLog extends TransportProviderPort {
  /** Reads from a partition at an offset. Pull; the log never pushes. */
  read(topic: string, partition: number, fromOffset: number, max: number): readonly LogEntry[];
  /** The next offset each partition would append at. */
  headOffsets(topic: string): ReadonlyMap<number, number>;
  readonly injectOutage: (down: boolean) => void;
  /** Drops entries older than the retention horizon. A real log does this on time. */
  compactBefore(topic: string, offset: number): void;
}

const CAPABILITY: ProviderCapability = {
  providerId: "durable-log",
  family: "kafka-like",
  // The durable lanes. Deliberately NOT QUERY or HEALTH: a query appended to
  // a log is a question whose asker stopped waiting, answered forever, and a
  // durable heartbeat is the largest table in the system.
  lanesOffered: ["COMMAND", "EVENT", "STREAM", "WORKFLOW", "EVIDENCE", "ARTIFACT"],
  durable: true,
  redelivers: true,
  orderingScopes: ["PER_KEY", "PER_PARTITION"],
  replayable: true,
  mutualTlsCapable: false,
};

export function createDurableLog(partitionCount = 4, clock: () => string = () => new Date(0).toISOString()): DurableLog {
  // topic -> partition -> entries. Offsets are per-partition and monotonic.
  const topics = new Map<string, Map<number, LogEntry[]>>();
  let down = false;

  const partitionsOf = (topic: string): Map<number, LogEntry[]> => {
    let partitions = topics.get(topic);
    if (!partitions) {
      partitions = new Map();
      for (let i = 0; i < partitionCount; i += 1) partitions.set(i, []);
      topics.set(topic, partitions);
    }
    return partitions;
  };

  return {
    capability: CAPABILITY,

    send: async ({ lane, envelopeJson }) => {
      if (down) throw new Error("durable-log: transport unavailable");
      if (!CAPABILITY.lanesOffered.includes(lane)) {
        throw new Error(`durable-log: the ${lane} lane was never offered.`);
      }
      const envelope = JSON.parse(envelopeJson) as {
        destination?: { capability?: string };
        idempotencyKey?: string;
        correlationId?: string;
      };
      const topic = `${lane}.${envelope.destination?.capability ?? "unknown"}`;
      const key = envelope.idempotencyKey ?? envelope.correlationId ?? "unkeyed";
      const partition = partitionFor(key, partitionCount);
      const entries = partitionsOf(topic).get(partition)!;
      // The offset is the entry count PLUS whatever compaction removed, held as
      // a base on the array. Simplest honest model: store base in a symbol-free
      // way — first entry's offset tells the base.
      const base = entries.length > 0 ? entries[entries.length - 1]!.offset + 1 : baseOf(entries);
      entries.push({ offset: base, appendedAt: clock(), envelopeJson });
    },

    probe: async () => (down ? { healthy: false, detail: "outage injected" } : { healthy: true, detail: `durable-log: ${topics.size} topics` }),

    read: (topic, partition, fromOffset, max) => {
      const entries = topics.get(topic)?.get(partition) ?? [];
      return entries.filter((e) => e.offset >= fromOffset).slice(0, max);
    },

    headOffsets: (topic) => {
      const heads = new Map<number, number>();
      const partitions = topics.get(topic);
      if (partitions) {
        for (const [p, entries] of partitions) {
          heads.set(p, entries.length > 0 ? entries[entries.length - 1]!.offset + 1 : baseOf(entries));
        }
      }
      return heads;
    },

    injectOutage: (state) => {
      down = state;
    },

    compactBefore: (topic, offset) => {
      const partitions = topics.get(topic);
      if (!partitions) return;
      for (const [p, entries] of partitions) {
        const kept = entries.filter((e) => e.offset >= offset);
        // Preserve the base for offset continuity: an empty partition after
        // compaction must still know where its next offset is. Model it by
        // keeping at least a tombstone-free base via the kept array — when
        // everything is removed, remember the head in a synthetic base entry.
        if (kept.length === 0 && entries.length > 0) {
          const head = entries[entries.length - 1]!.offset + 1;
          partitions.set(p, withBase([], head));
        } else {
          partitions.set(p, withBase(kept, kept.length > 0 ? kept[0]!.offset : 0));
        }
      }
    },
  };
}

// Offset bases for empty partitions, kept in a WeakMap so LogEntry[] stays a
// plain array. An empty partition still knows its next offset after
// compaction — otherwise offsets would restart at zero and every consumer
// position would silently point at the wrong entries.
const bases = new WeakMap<LogEntry[], number>();
function baseOf(entries: LogEntry[]): number {
  return bases.get(entries) ?? 0;
}
function withBase(entries: LogEntry[], base: number): LogEntry[] {
  bases.set(entries, base);
  return entries;
}

/** The topic a lane+capability pair maps to. Mirrors the subject convention. */
export function topicFor(lane: string, capability: string): string {
  return `${lane}.${capability}`;
}
