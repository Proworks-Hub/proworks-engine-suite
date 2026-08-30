/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — Neural Fabric
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  EDGE_PROFILES,
  drainOutbox,
  offlineModeMayWidenScope,
  outboxAdmissionCheck,
  reconnectDelayMs,
  type OutboxEntry,
} from "../edgeProfiles.js";

const T0 = "2026-08-30T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  entryId: "e-1",
  sequence: 1,
  envelopeJson: JSON.stringify({ id: 1 }),
  idempotencyKey: "idem-1",
  authorizationEvidenceRef: "dec-1",
  enqueuedAt: T0,
  expiresAt: null,
  attempts: 0,
  ...over,
});

describe("edge profiles are honest about the operating system", () => {
  it("covers the five platforms and states real limitations for each", () => {
    for (const platform of ["IOS", "ANDROID", "BROWSER", "IOT_CONSTRAINED", "DESKTOP"] as const) {
      expect(EDGE_PROFILES[platform].limitations.length).toBeGreaterThan(0);
    }
  });

  it("gives the browser no background budget, because it has none", () => {
    expect(EDGE_PROFILES.BROWSER.backgroundExecutionBudgetMs).toBe(0);
    expect(EDGE_PROFILES.BROWSER.limitations[0]).toContain("Closing the tab");
  });

  it("does not claim durable storage on a constrained device", () => {
    expect(EDGE_PROFILES.IOT_CONSTRAINED.hasDurableLocalStorage).toBe(false);
    expect(EDGE_PROFILES.IOT_CONSTRAINED.maxOutboxEntries).toBeLessThan(EDGE_PROFILES.DESKTOP.maxOutboxEntries);
  });

  it("backs off exponentially and stops at the profile ceiling", () => {
    const p = EDGE_PROFILES.ANDROID;
    expect(reconnectDelayMs(1, p)).toBe(1_000);
    expect(reconnectDelayMs(3, p)).toBe(4_000);
    expect(reconnectDelayMs(50, p)).toBe(p.reconnectBackoffCeilingMs);
  });
});

describe("a queued authorization is not a current authorization", () => {
  it("admits an entry but demands the reference be re-verified at send time", () => {
    const verdict = outboxAdmissionCheck(entry(), EDGE_PROFILES.IOS, at(360), 5);
    expect(verdict.admitted).toBe(true);
    expect(verdict.reason).toContain("MUST be re-verified now");
    expect(verdict.reason).toContain("stale yes");
  });

  it("discards an expired entry rather than delivering a stale instruction", () => {
    const verdict = outboxAdmissionCheck(entry({ expiresAt: at(10) }), EDGE_PROFILES.IOS, at(60), 5);
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.discard).toBe(true);
      expect(verdict.reason).toContain("moved on");
    }
  });

  it("holds — never discards — an entry that exhausted its attempts", () => {
    const verdict = outboxAdmissionCheck(entry({ attempts: 5 }), EDGE_PROFILES.IOS, T0, 5);
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.discard).toBe(false);
      expect(verdict.reason).toContain("silent data loss");
    }
  });

  it("widens nothing by being offline", () => {
    expect(offlineModeMayWidenScope()).toBe(false);
  });
});

describe("draining preserves order by stopping, not skipping", () => {
  it("stops at the first blocked entry and leaves the rest queued", () => {
    const result = drainOutbox(
      [
        entry({ entryId: "a", sequence: 1 }),
        entry({ entryId: "b", sequence: 2, attempts: 9 }),
        entry({ entryId: "c", sequence: 3 }),
      ],
      EDGE_PROFILES.ANDROID,
      T0,
      5,
    );
    expect(result.sendable.map((e) => e.entryId)).toEqual(["a"]);
    expect(result.blockedAt?.entryId).toBe("b");
    expect(result.note).toContain("skipped message from a reordered one");
  });

  it("skips an expired entry without blocking the queue behind it", () => {
    const result = drainOutbox(
      [
        entry({ entryId: "a", sequence: 1, expiresAt: at(5) }),
        entry({ entryId: "b", sequence: 2 }),
      ],
      EDGE_PROFILES.ANDROID,
      at(60),
      5,
    );
    expect(result.discarded.map((d) => d.entry.entryId)).toEqual(["a"]);
    expect(result.sendable.map((e) => e.entryId)).toEqual(["b"]);
    expect(result.blockedAt).toBeNull();
  });

  it("drains in sequence order regardless of the order it was handed", () => {
    const result = drainOutbox(
      [entry({ entryId: "c", sequence: 3 }), entry({ entryId: "a", sequence: 1 }), entry({ entryId: "b", sequence: 2 })],
      EDGE_PROFILES.DESKTOP,
      T0,
      5,
    );
    expect(result.sendable.map((e) => e.entryId)).toEqual(["a", "b", "c"]);
  });
});
