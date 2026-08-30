/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/engines/deliveryIQ.ts
 * Module:   neural-fabric / engines
 * Purpose:  Delivered once in effect, on a transport that delivers twice.
 */

import { LANE_SEMANTICS, type Lane, type OrderingScope } from "../domain/lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// A DUPLICATE MUST RETURN THE ORIGINAL ANSWER, NOT A NEW ONE
//
// The usual idempotency implementation remembers which keys it has seen and
// drops repeats. That prevents the double side effect and creates a subtler
// problem: the caller that retried because it never saw the first response now
// gets nothing, or gets an error, for an operation that in fact succeeded.
//
// It then retries again.
//
// So the ledger here stores the OUTCOME against the key, and a duplicate
// replays it. The caller gets the same answer it would have got the first
// time, which is what "exactly-once effect" has to mean from where the caller
// is standing. §13's at-least-once-plus-idempotency only works if the second
// delivery is genuinely indistinguishable from the first.
//
// AND A KEY IN FLIGHT IS NOT A KEY COMPLETED
//
// Between accepting a command and finishing it there is a window, and a
// retry arriving inside that window is the common case rather than the exotic
// one — it is exactly what a timeout produces. Returning "already done" would
// be a lie; reprocessing would double the effect. IN_FLIGHT is a third answer,
// and the caller is told to wait rather than told anything false.
//
// ORDERING IS PER SCOPE, AND THE SCOPE IS THE LANE'S
//
// Sequence checking is meaningless without knowing what it is sequencing. A
// stream is ordered per partition and a workflow is strictly ordered, and
// applying either rule to the other produces a system that either drops valid
// work or scales to exactly one consumer.
// ─────────────────────────────────────────────────────────────────────────────

export type DeliveryState = "IN_FLIGHT" | "COMPLETED" | "FAILED";

export interface DeliveryRecord {
  readonly idempotencyKey: string;
  readonly lane: Lane;
  readonly state: DeliveryState;
  /** The outcome to replay on a duplicate. Null while in flight. */
  readonly outcomeRef: string | null;
  readonly attempts: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** When this record may be forgotten. A ledger that never forgets is a leak. */
  readonly expiresAt: string;
}

export type AcceptanceOutcome =
  | { readonly disposition: "PROCESS"; readonly record: DeliveryRecord; readonly reason: string }
  | {
      readonly disposition: "REPLAY_OUTCOME";
      readonly outcomeRef: string;
      readonly reason: string;
    }
  | { readonly disposition: "WAIT"; readonly reason: string }
  | { readonly disposition: "REFUSE"; readonly reason: string };

export interface DeliveryPolicy {
  /** How long a completed key is remembered. */
  readonly retentionMs: number;
  /** How long an in-flight key may stay in flight before it is presumed dead. */
  readonly inFlightTimeoutMs: number;
}

/**
 * Decides what to do with an arriving delivery.
 *
 * Pure. Takes the existing record rather than a store, so the decision can be
 * tested and replayed without infrastructure — and so a host is free to hold
 * the ledger wherever it likes.
 */
export function acceptDelivery(
  existing: DeliveryRecord | null,
  input: {
    readonly idempotencyKey: string | undefined;
    readonly lane: Lane;
    readonly now: string;
  },
  policy: DeliveryPolicy,
): AcceptanceOutcome {
  const semantics = LANE_SEMANTICS[input.lane];

  if (input.idempotencyKey === undefined) {
    if (semantics.requiresIdempotentConsumer) {
      return {
        disposition: "REFUSE",
        reason: `The ${input.lane} lane redelivers until acknowledged, and this delivery has no idempotency key. Without one there is nothing to recognise a redelivery BY, so the second copy would be processed as a separate request.`,
      };
    }
    return {
      disposition: "PROCESS",
      record: {
        idempotencyKey: `transient:${input.now}`,
        lane: input.lane,
        state: "IN_FLIGHT",
        outcomeRef: null,
        attempts: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        expiresAt: input.now,
      },
      reason: `The ${input.lane} lane does not redeliver, so no key is needed and nothing is remembered.`,
    };
  }

  if (existing === null) {
    return {
      disposition: "PROCESS",
      record: {
        idempotencyKey: input.idempotencyKey,
        lane: input.lane,
        state: "IN_FLIGHT",
        outcomeRef: null,
        attempts: 1,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        expiresAt: addMs(input.now, policy.retentionMs),
      },
      reason: "First time this key has been seen.",
    };
  }

  if (existing.lane !== input.lane) {
    // The same key arriving on a different lane is either a collision or a
    // caller reusing a key it should not. Both are refused, because replaying
    // a command's outcome for an event would be answering a question nobody
    // asked.
    return {
      disposition: "REFUSE",
      reason: `Idempotency key "${input.idempotencyKey}" was first seen on the ${existing.lane} lane and has now arrived on ${input.lane}. Either two senders collided on a key or one is reusing it; replaying the first outcome would answer a question nobody asked.`,
    };
  }

  if (existing.state === "COMPLETED") {
    if (existing.outcomeRef === null) {
      return {
        disposition: "REFUSE",
        reason: `Key "${input.idempotencyKey}" is recorded complete with no outcome to replay. The ledger is inconsistent, and processing again would risk a second side effect — refusing is the safe direction.`,
      };
    }
    return {
      disposition: "REPLAY_OUTCOME",
      outcomeRef: existing.outcomeRef,
      reason:
        "This key completed already. The original outcome is returned rather than a 'duplicate' error — the caller retried because it never saw the first answer, and giving it the answer is what ends the retry.",
    };
  }

  if (existing.state === "FAILED") {
    return {
      disposition: "PROCESS",
      record: {
        ...existing,
        state: "IN_FLIGHT",
        attempts: existing.attempts + 1,
        lastSeenAt: input.now,
      },
      reason: `The previous attempt failed, so this is a genuine retry rather than a duplicate. Attempt ${existing.attempts + 1}.`,
    };
  }

  const inFlightFor = Date.parse(input.now) - Date.parse(existing.lastSeenAt);
  if (Number.isFinite(inFlightFor) && inFlightFor >= policy.inFlightTimeoutMs) {
    return {
      disposition: "PROCESS",
      record: {
        ...existing,
        attempts: existing.attempts + 1,
        lastSeenAt: input.now,
      },
      reason: `The previous attempt has been in flight for ${inFlightFor}ms, past the ${policy.inFlightTimeoutMs}ms timeout, and is presumed dead. Reprocessing risks a double effect and never processing risks losing the work — the timeout is where that trade-off is made explicit.`,
    };
  }

  return {
    disposition: "WAIT",
    reason: `Key "${input.idempotencyKey}" is still in flight after ${inFlightFor}ms. Not complete, so there is no outcome to replay; not dead, so reprocessing would double the effect. The honest answer is to wait.`,
  };
}

/** Records a completed delivery, so a duplicate can replay its outcome. */
export function completeDelivery(
  record: DeliveryRecord,
  outcomeRef: string,
  now: string,
  policy: DeliveryPolicy,
): DeliveryRecord {
  return {
    ...record,
    state: "COMPLETED",
    outcomeRef,
    lastSeenAt: now,
    expiresAt: addMs(now, policy.retentionMs),
  };
}

export function failDelivery(record: DeliveryRecord, now: string): DeliveryRecord {
  return { ...record, state: "FAILED", lastSeenAt: now };
}

/**
 * Whether a ledger entry may be forgotten.
 *
 * A ledger that never forgets is a leak; one that forgets too early turns a
 * late retry into a second execution. The expiry has to outlive the longest
 * retry the sender could make, which is why it is policy rather than a
 * constant here.
 */
export function mayForget(record: DeliveryRecord, now: string): boolean {
  return now >= record.expiresAt;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDERING
// ─────────────────────────────────────────────────────────────────────────────

export interface SequencePosition {
  /** What the ordering applies to — an entity, a partition, a pair. */
  readonly scopeKey: string;
  readonly lastSequence: number;
}

export type SequenceVerdict =
  | { readonly accept: true; readonly reason: string }
  | { readonly accept: false; readonly action: "BUFFER" | "DISCARD"; readonly reason: string };

/**
 * Whether a message may be delivered given what has already been delivered.
 *
 * The distinction that matters is BUFFER versus DISCARD. A message from the
 * future has to be held — the one before it is presumably in flight. A message
 * from the past is a redelivery of something already applied, and holding it
 * would mean waiting forever for a gap that has already been filled.
 */
export function checkSequence(
  lane: Lane,
  position: SequencePosition | null,
  incomingSequence: number,
): SequenceVerdict {
  const scope: OrderingScope = LANE_SEMANTICS[lane].ordering;

  if (scope === "NONE") {
    return {
      accept: true,
      reason: `The ${lane} lane declares no ordering, so sequence is not checked. Checking it would impose a guarantee the lane does not offer and callers have not been promised.`,
    };
  }

  if (position === null) {
    return { accept: true, reason: `First message in this ${scope} scope.` };
  }

  const expected = position.lastSequence + 1;

  if (incomingSequence === expected) {
    return { accept: true, reason: `Sequence ${incomingSequence} follows ${position.lastSequence} in scope "${position.scopeKey}".` };
  }

  if (incomingSequence <= position.lastSequence) {
    return {
      accept: false,
      action: "DISCARD",
      reason: `Sequence ${incomingSequence} was already applied in scope "${position.scopeKey}" (at ${position.lastSequence}). This is a redelivery of the past, and buffering it would wait forever for a gap that is already filled.`,
    };
  }

  return {
    accept: false,
    action: "BUFFER",
    reason: `Sequence ${incomingSequence} arrived before ${expected} in scope "${position.scopeKey}". Held rather than delivered — the missing message is presumably still in flight, and delivering out of order on a ${scope} lane breaks the guarantee the consumer was given.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RECEIPTS
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryReceipt {
  readonly fabricMessageId: string;
  readonly idempotencyKey: string | null;
  readonly lane: Lane;
  readonly acknowledgedAt: string;
  readonly attempts: number;
  /** True when this acknowledgement is for a message that had been seen before. */
  readonly wasDuplicate: boolean;
  readonly note: string;
}

/**
 * The receipt a sender gets back.
 *
 * `wasDuplicate` is on the receipt rather than hidden, because a sender seeing
 * a rising duplicate rate is seeing its own retry behaviour, and that is
 * actionable at the sender in a way it never is at the receiver.
 */
export function receipt(input: {
  readonly fabricMessageId: string;
  readonly idempotencyKey: string | null;
  readonly lane: Lane;
  readonly acknowledgedAt: string;
  readonly attempts: number;
  readonly wasDuplicate: boolean;
}): DeliveryReceipt {
  return {
    ...input,
    note: input.wasDuplicate
      ? `Acknowledged as a duplicate after ${input.attempts} attempts. The original outcome was returned. A rising duplicate rate here is the sender's retry behaviour, visible where it can be changed.`
      : `Acknowledged on attempt ${input.attempts}.`,
  };
}

function addMs(iso: string, ms: number): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + ms).toISOString() : iso;
}
