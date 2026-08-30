/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/streamIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Ordered history that can be re-read, and the limits of re-reading it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// A PARTITION IS AN ORDERING BOUNDARY, AND THAT IS THE WHOLE TRADE
//
// A log scales by splitting into partitions and ordering within each one. The
// price is that there is no order BETWEEN partitions, and the mistake is
// always the same: a key is partitioned by something that does not match what
// the consumer assumes is ordered.
//
// Partition by message id and every message spreads evenly, which looks ideal
// until a consumer notices that two updates to the same order arrived out of
// sequence. Partition by tenant and one large tenant makes one partition hot
// while the others idle.
//
// So the partition KEY is declared, and `partitionFor` is deterministic and
// documented as such — the same key always lands in the same partition, which
// is the property the ordering guarantee is built on and the property that
// quietly breaks when somebody changes the partition count.
//
// CHANGING THE PARTITION COUNT BREAKS ORDERING. PERMANENTLY.
//
// Adding partitions reshuffles which key lands where, so a key that was in
// partition 2 may now be in partition 5, and its history is split across both.
// Every ordering guarantee that existed before the change is void for the keys
// that moved. This is well known and routinely done anyway, so `repartition`
// refuses quietly-and-carries-on and returns what will break.
//
// RETENTION IS NOT A REPLAY WINDOW
//
// A stream retains for a period; a consumer can replay within it. Those are
// different numbers and treating them as one is how a recovery procedure gets
// written that cannot work — "replay from the start of the incident" fails
// when the incident began before the retention window.
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamDefinition {
  readonly streamId: string;
  readonly partitionCount: number;
  /** What ordering is guaranteed WITHIN. Declared, so a consumer can check it. */
  readonly partitionKeyField: string;
  readonly retentionMs: number;
  /**
   * Whether older entries for a key are discarded when a newer one arrives.
   *
   * Compaction and replay pull in opposite directions: a compacted stream can
   * rebuild current state and cannot replay history, because the history is
   * what compaction removed.
   */
  readonly compacted: boolean;
}

export interface ConsumerPosition {
  readonly consumerId: string;
  readonly streamId: string;
  readonly partition: number;
  readonly offset: number;
  readonly committedAt: string;
}

/**
 * Which partition a key belongs to.
 *
 * Deterministic and stable for a fixed partition count. FNV-1a rather than
 * anything cryptographic — this is a placement decision, not a security one,
 * and using a cryptographic hash here would imply otherwise.
 */
export function partitionFor(partitionKey: string, partitionCount: number): number {
  if (partitionCount <= 0) {
    throw new RangeError(
      "A stream needs at least one partition. Zero partitions is not an unordered stream, it is a stream with nowhere to put anything.",
    );
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < partitionKey.length; i += 1) {
    hash ^= partitionKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % partitionCount;
}

export interface RepartitionImpact {
  readonly from: number;
  readonly to: number;
  /** Sample keys whose partition changes, and where they move. */
  readonly keysThatMove: readonly { readonly key: string; readonly from: number; readonly to: number }[];
  readonly movedFraction: number;
  readonly orderingBroken: boolean;
  readonly note: string;
}

/**
 * What changing the partition count would do to ordering.
 *
 * Answered against real keys rather than in the abstract, because "some keys
 * will move" is ignorable and "these 63% of your keys will move, and their
 * history splits across two partitions" is not.
 */
export function repartitionImpact(
  sampleKeys: readonly string[],
  from: number,
  to: number,
): RepartitionImpact {
  const moved: { key: string; from: number; to: number }[] = [];
  for (const key of [...sampleKeys].sort()) {
    const before = partitionFor(key, from);
    const after = partitionFor(key, to);
    if (before !== after) moved.push({ key, from: before, to: after });
  }

  const movedFraction = sampleKeys.length === 0 ? 0 : moved.length / sampleKeys.length;

  return {
    from,
    to,
    keysThatMove: moved,
    movedFraction,
    orderingBroken: moved.length > 0,
    note:
      moved.length === 0
        ? `No sampled key changes partition between ${from} and ${to}. That is unusual and worth checking the sample before relying on it.`
        : `${moved.length} of ${sampleKeys.length} sampled keys (${Math.round(movedFraction * 100)}%) change partition. For each of them the history is split across the old partition and the new one, and every ordering guarantee that held before this change is void for those keys. This is permanent — repartitioning back does not reunite the history.`,
  };
}

export type ReplayVerdict =
  | { readonly canReplay: true; readonly fromOffset: number; readonly note: string }
  | { readonly canReplay: false; readonly reason: string; readonly remedy: string };

/**
 * Whether a consumer can replay from a point in time.
 *
 * The check that turns "replay from the start of the incident" from a plan
 * into a plan that works. Retention and the replay window are the same number
 * here only because the stream says so — the point is that it is checked.
 */
export function canReplayFrom(
  stream: StreamDefinition,
  earliestRetainedAt: string,
  requestedFrom: string,
  offsetAt: (at: string) => number | null,
): ReplayVerdict {
  if (stream.compacted) {
    return {
      canReplay: false,
      reason: `Stream "${stream.streamId}" is compacted, so only the latest entry per key survives. It can rebuild current state and cannot replay history — the history is exactly what compaction removed.`,
      remedy:
        "Rebuild state from the compacted stream, or keep a separate uncompacted stream if the history itself is needed.",
    };
  }

  if (requestedFrom < earliestRetainedAt) {
    return {
      canReplay: false,
      reason: `Replay was requested from ${requestedFrom} and the earliest retained entry is ${earliestRetainedAt}. The requested point is outside the retention window, which is a different and shorter thing than "the stream has always existed".`,
      remedy: `Replay from ${earliestRetainedAt} and reconstruct the earlier period from another source, or extend retention before the next incident rather than during one.`,
    };
  }

  const offset = offsetAt(requestedFrom);
  if (offset === null) {
    return {
      canReplay: false,
      reason: `No offset corresponds to ${requestedFrom} in stream "${stream.streamId}". The timestamp is inside the retention window and no entry sits at it.`,
      remedy: "Choose a timestamp at or after an entry that exists, or replay from the earliest retained offset.",
    };
  }

  return {
    canReplay: true,
    fromOffset: offset,
    note: `Replayable from offset ${offset}. Consumers replaying a partitioned stream see order within each partition and no order between them — the same guarantee as live delivery, which is what makes a replay a faithful one.`,
  };
}

export type CommitVerdict =
  | { readonly committed: true; readonly position: ConsumerPosition; readonly note: string }
  | { readonly committed: false; readonly reason: string };

/**
 * Advances a consumer's position.
 *
 * Refuses to move backwards without an explicit reset. A backwards commit is
 * almost always a bug — two workers on the same partition, or a restart with
 * stale state — and honouring it silently reprocesses everything in between.
 */
export function commitOffset(
  current: ConsumerPosition | null,
  next: { readonly offset: number; readonly at: string },
  consumerId: string,
  streamId: string,
  partition: number,
  options: { readonly allowRewind: boolean } = { allowRewind: false },
): CommitVerdict {
  if (current === null) {
    return {
      committed: true,
      position: { consumerId, streamId, partition, offset: next.offset, committedAt: next.at },
      note: `First committed position for ${consumerId} on partition ${partition}.`,
    };
  }

  if (next.offset < current.offset && !options.allowRewind) {
    return {
      committed: false,
      reason: `Consumer ${consumerId} tried to commit offset ${next.offset} having already committed ${current.offset} on partition ${partition}. Moving backwards reprocesses everything in between, and it is almost always two workers on one partition or a restart with stale state rather than a deliberate rewind. Pass allowRewind to mean it.`,
    };
  }

  if (next.offset === current.offset) {
    return {
      committed: true,
      position: current,
      note: "Offset unchanged. Committing the same position twice is harmless and common — a consumer that processed nothing still has a heartbeat to make.",
    };
  }

  return {
    committed: true,
    position: { consumerId, streamId, partition, offset: next.offset, committedAt: next.at },
    note:
      next.offset < current.offset
        ? `Rewound from ${current.offset} to ${next.offset} deliberately. Everything between will be reprocessed, and the consumer must be idempotent for that to be safe.`
        : `Advanced from ${current.offset} to ${next.offset}.`,
  };
}

export interface ConsumerLag {
  readonly consumerId: string;
  readonly partition: number;
  /**
   * How far behind, or null when the partition's head is unknown.
   *
   * Null rather than zero. A partition whose head offset nobody supplied has
   * an UNKNOWN lag, and reporting it as caught up is the same failure Pulse
   * guards against when it refuses to read silence as health — the dashboard
   * goes green for the partition nobody is measuring.
   */
  readonly lag: number | null;
  readonly note: string;
}

/**
 * How far behind a consumer is, per partition.
 *
 * Per partition rather than in total, because a total hides the case that
 * matters: nine partitions at zero and one at four million is a stuck
 * consumer, and it averages to something that looks survivable.
 */
export function consumerLag(
  positions: readonly ConsumerPosition[],
  headOffsets: ReadonlyMap<number, number>,
): readonly ConsumerLag[] {
  return [...positions]
    .sort((a, b) => a.partition - b.partition)
    .map((position) => {
      const head = headOffsets.get(position.partition);
      if (head === undefined) {
        return {
          consumerId: position.consumerId,
          partition: position.partition,
          lag: null,
          note: `The head offset for partition ${position.partition} is unknown, so the lag is unknown. Not the same as caught up — a partition nobody is measuring is exactly the one that goes green while it falls behind.`,
        };
      }
      const lag = Math.max(0, head - position.offset);
      return {
        consumerId: position.consumerId,
        partition: position.partition,
        lag,
        note:
          lag === 0
            ? `Caught up on partition ${position.partition}.`
            : `${lag} behind on partition ${position.partition}. Reported per partition on purpose — a total average hides one stuck partition behind nine healthy ones.`,
      };
    });
}
