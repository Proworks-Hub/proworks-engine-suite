/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 *
 * Project:  ProWorks Engine Suite — Neural Fabric
 * Owner:    Steven Kreutzer (Interaxys Solutions)
 * License:  Proprietary — UNLICENSED.
 *
 * File:     packages/neural-fabric/src/interop/edgeProfiles.ts
 * Module:   neural-fabric / interop
 * Purpose:  Talking to something that is usually not connected, and honest about the OS.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// THE EDGE IS NOT A WEAK SERVER
//
// A phone is not a small datacentre and an MQTT sensor is not a slow one. The
// difference that matters is agency: the OS decides when your process runs,
// and it does not consult you. iOS suspends a backgrounded app within seconds
// and may never wake it; Android's Doze batches everything into maintenance
// windows. §22 already concedes this — "mobile background behavior is
// constrained by OS policy" — and every profile here is built around it
// rather than around a retry loop that assumes the process is alive.
//
// The practical consequence is that an edge client must ACCEPT work locally
// and forward it later, which is why STORE_AND_FORWARD_EDGE is the only
// pattern most of these profiles can use. A profile that promised anything
// synchronous would be promising on behalf of an operating system that has
// not agreed.
//
// OFFLINE MUST NOT WIDEN ANYTHING (§16)
//
// A queued message is a message whose authorization was checked at enqueue
// time and must be checked again at send time, because the world moved on
// while the device was in a pocket. `outboxAdmissionCheck` refuses to treat
// an old decision as a current one — the deliberate opposite of the
// convenient behaviour, which is why it exists as its own function with its
// own test rather than as a flag on the drain loop.
// ─────────────────────────────────────────────────────────────────────────────

export const edgePlatformSchema = z.enum(["IOS", "ANDROID", "BROWSER", "IOT_CONSTRAINED", "DESKTOP"]);
export type EdgePlatform = z.infer<typeof edgePlatformSchema>;

export interface EdgeProfile {
  readonly platform: EdgePlatform;
  /** How long the OS reliably lets a backgrounded process work, in ms. */
  readonly backgroundExecutionBudgetMs: number;
  /** True when the OS may kill the process without warning. */
  readonly mayBeSuspendedWithoutNotice: boolean;
  /** Messages the local outbox may hold before it must shed or refuse. */
  readonly maxOutboxEntries: number;
  /** Largest single message worth attempting on this link. */
  readonly maxMessageBytes: number;
  /** Reconnect backoff ceiling, in ms. */
  readonly reconnectBackoffCeilingMs: number;
  /** True when the platform can hold durable local storage. */
  readonly hasDurableLocalStorage: boolean;
  /** What this profile genuinely cannot promise. Stated, not discovered. */
  readonly limitations: readonly string[];
}

const profile = (p: EdgeProfile): EdgeProfile => Object.freeze(p);

export const EDGE_PROFILES: Readonly<Record<EdgePlatform, EdgeProfile>> = Object.freeze({
  IOS: profile({
    platform: "IOS",
    backgroundExecutionBudgetMs: 30_000,
    mayBeSuspendedWithoutNotice: true,
    maxOutboxEntries: 10_000,
    maxMessageBytes: 4_000_000,
    reconnectBackoffCeilingMs: 300_000,
    hasDurableLocalStorage: true,
    limitations: [
      "The OS may suspend the app seconds after backgrounding and is under no obligation to wake it. A drain that has not finished by then resumes whenever the user next opens the app — which may be days.",
      "Background delivery cannot be scheduled by the Fabric. Anything time-critical needs a push, which is a different system with its own permissions.",
    ],
  }),
  ANDROID: profile({
    platform: "ANDROID",
    backgroundExecutionBudgetMs: 60_000,
    mayBeSuspendedWithoutNotice: true,
    maxOutboxEntries: 10_000,
    maxMessageBytes: 4_000_000,
    reconnectBackoffCeilingMs: 300_000,
    hasDurableLocalStorage: true,
    limitations: [
      "Doze batches background work into maintenance windows, so drain latency is set by the OS and not by the backoff configured here.",
      "Aggressive vendor battery managers kill background work earlier than the platform documents, and they differ by manufacturer.",
    ],
  }),
  BROWSER: profile({
    platform: "BROWSER",
    backgroundExecutionBudgetMs: 0,
    mayBeSuspendedWithoutNotice: true,
    maxOutboxEntries: 1_000,
    maxMessageBytes: 1_000_000,
    reconnectBackoffCeilingMs: 60_000,
    hasDurableLocalStorage: true,
    limitations: [
      "Closing the tab ends execution immediately. There is no background budget at all — a queued message survives only because storage does, and only until the user clears site data.",
      "Storage quotas are per-origin and the browser may evict without asking.",
    ],
  }),
  IOT_CONSTRAINED: profile({
    platform: "IOT_CONSTRAINED",
    backgroundExecutionBudgetMs: 1_000,
    mayBeSuspendedWithoutNotice: false,
    maxOutboxEntries: 100,
    maxMessageBytes: 64_000,
    reconnectBackoffCeilingMs: 600_000,
    hasDurableLocalStorage: false,
    limitations: [
      "Usually no durable storage, so a power cycle loses the outbox. Anything that must not be lost has to be acknowledged before the device forgets it.",
      "A hundred-entry outbox on a constrained device fills in seconds during an outage; shedding is the expected behaviour, not an error.",
    ],
  }),
  DESKTOP: profile({
    platform: "DESKTOP",
    backgroundExecutionBudgetMs: 3_600_000,
    mayBeSuspendedWithoutNotice: false,
    maxOutboxEntries: 100_000,
    maxMessageBytes: 16_000_000,
    reconnectBackoffCeilingMs: 60_000,
    hasDurableLocalStorage: true,
    limitations: ["Sleep suspends the process; the drain resumes on wake with whatever the clock skew turns out to be."],
  }),
});

/** One entry waiting in a local outbox. */
export interface OutboxEntry {
  readonly entryId: string;
  /** Assigned by the outbox, never by the caller. */
  readonly sequence: number;
  readonly envelopeJson: string;
  readonly idempotencyKey: string;
  /** The authorization reference as it stood at enqueue time. */
  readonly authorizationEvidenceRef: string | null;
  readonly enqueuedAt: string;
  /** When the message stops being worth sending. Null means no expiry. */
  readonly expiresAt: string | null;
  readonly attempts: number;
}

export type OutboxAdmission =
  | { readonly admitted: true; readonly reason: string }
  | { readonly admitted: false; readonly discard: boolean; readonly reason: string };

/**
 * Whether a queued entry may still be sent, now that `now` has arrived.
 *
 * The rule that matters: an authorization reference checked at enqueue time
 * is NOT a current authorization. The device was offline for six hours; the
 * grant may have been revoked, the shift may have ended, the employee may
 * have left. Draining an outbox is therefore not "finish what we started" —
 * every entry is re-presented for a fresh decision, and this function refuses
 * to make that decision itself. It reports what must be re-checked.
 */
export function outboxAdmissionCheck(
  entry: OutboxEntry,
  profileUsed: EdgeProfile,
  now: string,
  maxAttempts: number,
): OutboxAdmission {
  if (entry.expiresAt !== null && now >= entry.expiresAt) {
    return {
      admitted: false,
      discard: true,
      reason: `Expired at ${entry.expiresAt}. Delivering an expired instruction to a machine that has moved on is worse than delivering nothing — this is the failure store-and-forward is most prone to.`,
    };
  }
  if (entry.attempts >= maxAttempts) {
    return {
      admitted: false,
      discard: false,
      reason: `${entry.attempts} attempts made against a ceiling of ${maxAttempts}. Held rather than discarded: discarding after N attempts is silent data loss on a device nobody is watching, and the entry is the only remaining record that the work was accepted.`,
    };
  }
  if (entry.authorizationEvidenceRef !== null) {
    return {
      admitted: true,
      reason: `Eligible. The authorization reference ${entry.authorizationEvidenceRef} was current at ${entry.enqueuedAt} and MUST be re-verified now — the device may have been offline for hours, and a stale yes is the one an attacker waits for. ${profileUsed.platform} may have been suspended for an unbounded period.`,
    };
  }
  return { admitted: true, reason: "Eligible; the entry carries no authorization reference to re-verify." };
}

/**
 * Drains in sequence order, stopping at the first entry that cannot go.
 *
 * Stopping is deliberate and matches the WorkOrder engine's outbox rule:
 * continuing past a blocked entry publishes a completion before its start,
 * and a consumer cannot distinguish a gap from a reordering. A held entry
 * blocks the queue, which is visible; a skipped one is silent.
 */
export function drainOutbox(
  entries: readonly OutboxEntry[],
  profileUsed: EdgeProfile,
  now: string,
  maxAttempts: number,
): {
  readonly sendable: readonly OutboxEntry[];
  readonly discarded: readonly { readonly entry: OutboxEntry; readonly reason: string }[];
  readonly blockedAt: OutboxEntry | null;
  readonly note: string;
} {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  const sendable: OutboxEntry[] = [];
  const discarded: { entry: OutboxEntry; reason: string }[] = [];
  let blockedAt: OutboxEntry | null = null;

  for (const entry of ordered) {
    const verdict = outboxAdmissionCheck(entry, profileUsed, now, maxAttempts);
    if (verdict.admitted) {
      sendable.push(entry);
      continue;
    }
    if (verdict.discard) {
      // An expired entry is skipped rather than blocking: it was allowed to
      // die, and holding the queue behind a message the sender already
      // agreed to abandon helps nobody.
      discarded.push({ entry, reason: verdict.reason });
      continue;
    }
    blockedAt = entry;
    break;
  }

  return {
    sendable,
    discarded,
    blockedAt,
    note:
      blockedAt === null
        ? `${sendable.length} entr${sendable.length === 1 ? "y" : "ies"} ready, ${discarded.length} expired. Every authorization reference still needs re-verification at send time.`
        : `Drain stopped at sequence ${blockedAt.sequence}. Ordering is preserved by stopping rather than skipping — a consumer cannot tell a skipped message from a reordered one.`,
  };
}

/** Bounded exponential backoff. Deterministic: no jitter read from a clock. */
export function reconnectDelayMs(attempt: number, profileUsed: EdgeProfile): number {
  const base = 1_000;
  const raw = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(raw, profileUsed.reconnectBackoffCeilingMs);
}

/** Being offline never widens what may be sent. */
export function offlineModeMayWidenScope(): false {
  return false;
}
