// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { HiveMessage } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Where EventIQ's state actually lives.
//
// Until now: five module-local `Map`s and an array inside `createEventIq`.
// That is a correct engine with no durability, and the distinction matters
// because every guarantee EventIQ makes — offsets survive a crash, a dead
// letter is not lost, a replay is auditable afterwards — is a guarantee about
// state that did not survive the process.
//
// So the state moves behind a port and the engine keeps its logic. A host binds
// SQLite; a test binds the deterministic in-memory adapter below and gets the
// behaviour it had before.
//
// WHY THIS PORT IS SYNCHRONOUS
//
// Deliberate, and a real constraint rather than an oversight. EventIQ's public
// surface is synchronous — `publish`, `poll`, `acknowledge` all return values,
// not promises — and thirty-two existing tests plus every caller depend on
// that. Making the store async would make the engine async, which is a breaking
// change to an engine at 0.19.0 for a benefit nothing needs yet.
//
// It is implementable durably: `better-sqlite3` is synchronous, and the Hub
// already runs a synchronous SQLite event log. What this port CANNOT back is a
// network-latency store — Postgres over a socket, a remote broker. That is
// named in the Phase 2 report as debt rather than discovered later by whoever
// tries it.
//
// WHY ONE PORT AND NOT SIX
//
// The five concerns (log, offsets, delivery attempts, replay sessions, inbox)
// are written together inside one acknowledgement and read together inside one
// poll. Six ports would be six things a host must bind consistently, and a host
// that bound five of six would have a fabric whose durability depended on which
// method was called. One store, one binding, one transactional boundary for an
// adapter that wants one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One accepted event.
 *
 * `origin` is bound by EventIQ at acceptance from its own configuration, never
 * copied from the message. `message.origin` is what the producer CLAIMED; this
 * is where it was actually accepted, and the two are kept apart so they can be
 * compared rather than conflated.
 */
export interface StoredEvent {
  readonly message: HiveMessage;
  readonly sequence: number;
  readonly acceptedAt: string;
  /** The instance that accepted it. Authoritative. */
  readonly globalInstanceId: string;
}

export type DeliveryState =
  | "pending"
  | "delivered"
  | "acknowledged"
  | "retrying"
  | "dead_lettered"
  | "expired";

export interface DeliveryAttempt {
  readonly messageId: string;
  readonly subscriptionId: string;
  /** Which instance accepted the event. Part of the identity of the attempt. */
  readonly globalInstanceId: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly firstAttemptedAt: string;
  readonly lastAttemptedAt: string;
  readonly lastReason: string;
  readonly deadLetteredAt: string | null;
}

/**
 * A replay, recorded.
 *
 * Charter: replay must be auditable. An engine event announcing a replay
 * started is a signal somebody may have been listening for; this is the record
 * that exists afterwards, when the question is who replayed what and under
 * which decision.
 */
export interface ReplaySession {
  readonly replaySessionId: string;
  readonly subscriptionId: string;
  readonly requestedBy: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  /** The Governance decision that permitted it. Never absent on a session. */
  readonly decisionId: string;
  readonly startedAt: string;
  readonly delivered: number;
}

/**
 * Proof a consumer already performed the business effect.
 *
 * Keyed by instance + operation + consumer group, not by message id. Two
 * messages can describe one operation — a producer retried and minted a new id
 * — and a consumer deduplicating on message id would perform the effect twice
 * while believing it had not.
 *
 * The instance is in the key because event ids are unique within the instance
 * that minted them. When messages eventually arrive from another instance, two
 * instances that independently chose the same key must not silently look like
 * one operation already done.
 */
export interface InboxRecord {
  readonly globalInstanceId: string;
  readonly idempotencyKey: string;
  readonly consumerGroup: string;
  readonly messageId: string;
  readonly processedAt: string;
}

export interface EventIqStore {
  /** How the store persists. `durable` is a claim a host makes and tests read. */
  readonly durability: "in-memory" | "durable";

  // ── The log ────────────────────────────────────────────────────────────
  append(event: StoredEvent): void;
  /** Total accepted. The head a new subscription starts from. */
  count(): number;
  /** From a sequence forward, oldest first. Ordering within the log is not optional. */
  from(sequence: number): readonly StoredEvent[];
  /** Between two sequences inclusive, for replay. */
  range(fromSequence: number, toSequence: number): readonly StoredEvent[];
  /**
   * Finds an accepted event by message id.
   *
   * A method rather than a scan at the call site, because the in-memory
   * adapter's index is what stops publish and acknowledge being linear in the
   * length of the log — which they both were.
   */
  byMessageId(messageId: string): StoredEvent | null;

  // ── Consumer offsets ───────────────────────────────────────────────────
  offsetOf(consumerGroup: string): number | null;
  setOffset(consumerGroup: string, sequence: number): void;

  // ── Delivery attempts and dead letters ─────────────────────────────────
  attemptOf(messageId: string, subscriptionId: string): DeliveryAttempt | null;
  putAttempt(attempt: DeliveryAttempt): void;
  attempts(): readonly DeliveryAttempt[];

  // ── Replay sessions ────────────────────────────────────────────────────
  recordReplay(session: ReplaySession): void;
  replaySessions(): readonly ReplaySession[];

  // ── Consumer inbox ─────────────────────────────────────────────────────
  hasProcessed(key: Omit<InboxRecord, "processedAt" | "messageId">): boolean;
  markProcessed(record: InboxRecord): void;
}

/**
 * The deterministic in-memory adapter.
 *
 * Not a stub: it is the behaviour the engine had before the port existed, and
 * it says `durability: "in-memory"` so nothing can mistake it for the durable
 * one. A store that lied about that would let a host believe its offsets
 * survived a restart.
 */
export function createInMemoryEventIqStore(): EventIqStore {
  const log: StoredEvent[] = [];
  const byId = new Map<string, StoredEvent>();
  const offsets = new Map<string, number>();
  const attempts = new Map<string, DeliveryAttempt>();
  const replays: ReplaySession[] = [];
  const inbox = new Set<string>();

  const attemptKey = (messageId: string, subscriptionId: string) =>
    `${messageId}|${subscriptionId}`;
  const inboxKey = (k: { globalInstanceId: string; idempotencyKey: string; consumerGroup: string }) =>
    `${k.globalInstanceId}|${k.idempotencyKey}|${k.consumerGroup}`;

  return {
    durability: "in-memory",

    append(event) {
      log.push(event);
      byId.set(event.message.messageId, event);
    },
    count: () => log.length,
    from: (sequence) => log.slice(Math.max(0, sequence)),
    range: (fromSequence, toSequence) =>
      log.slice(Math.max(0, fromSequence), toSequence + 1),
    byMessageId: (messageId) => byId.get(messageId) ?? null,

    // `null`, not 0. A group that has never been seen has no checkpoint, and
    // returning 0 would replay the entire history into it — which is a replay,
    // and replays are authorized separately.
    offsetOf: (consumerGroup) => offsets.get(consumerGroup) ?? null,
    setOffset: (consumerGroup, sequence) => {
      offsets.set(consumerGroup, sequence);
    },

    attemptOf: (messageId, subscriptionId) =>
      attempts.get(attemptKey(messageId, subscriptionId)) ?? null,
    putAttempt: (attempt) => {
      attempts.set(attemptKey(attempt.messageId, attempt.subscriptionId), attempt);
    },
    attempts: () => [...attempts.values()],

    recordReplay: (session) => {
      replays.push(session);
    },
    replaySessions: () => [...replays],

    hasProcessed: (key) => inbox.has(inboxKey(key)),
    markProcessed: (record) => {
      inbox.add(inboxKey(record));
    },
  };
}
