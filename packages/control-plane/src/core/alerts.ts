// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { EngineHealth } from "./health.js";
import type { ObservedHeartbeat } from "./heartbeat.js";

// ─────────────────────────────────────────────────────────────────────────────
// Telling somebody, without telling them so often that they stop listening.
//
// Alarm fatigue is the failure mode here, and it is not a UI problem — it is an
// identity problem. An alert derived fresh from each health snapshot is a NEW
// alert every few seconds, so the same degraded engine produces four hundred
// notifications an hour and the whole system gets muted. After that the console
// is worse than nothing, because now nobody is watching AND everybody believes
// somebody is.
//
// So alerts have stable identity and a lifecycle:
//
//   Same engine, same problem  →  the SAME alert, with an updated last-seen.
//   Briefly bad               →  no alert at all. Real problems persist.
//   Briefly good again        →  still open. One good sample is not a recovery.
//
// The two delays are the whole design. Everything else is bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

export const alertSeveritySchema = z.enum(["info", "warning", "critical"]);
export type AlertSeverity = z.infer<typeof alertSeveritySchema>;

export const alertKindSchema = z.enum([
  "engine.unknown",
  "engine.degraded",
  "engine.failed",
  "engine.circuit.open",
  "engine.latency",
  "engine.error.rate",
  "engine.queue.backlog",
  "inventory.shortage",
  "model.provider.degraded",
  "model.fallback.repeated",
]);
export type AlertKind = z.infer<typeof alertKindSchema>;

export interface Alert {
  /** `engineId:kind`. Stable, so the same problem is the same alert. */
  readonly alertId: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** Which engine or service. */
  readonly source: string;
  /** In numbers, not adjectives. What an operator acts on. */
  readonly reason: string;
  /** When the condition was first seen — not when the alert opened. */
  readonly firstSeenAt: string;
  readonly openedAt: string;
  readonly lastSeenAt: string;
  readonly resolvedAt?: string;
  /** How many snapshots have shown it. A long-running alert is worth escalating. */
  readonly occurrences: number;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: string;
  readonly correlationId?: string;
}

export interface AlertPolicy {
  /** A condition must persist this long before it becomes an alert. */
  openAfterMs: number;
  /** It must be clear this long before the alert resolves. */
  resolveAfterMs: number;
  latencyThresholdMs: number;
  queueBacklogThreshold: number;
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  // Long enough that a deploy, a restart or one slow batch does not page
  // anybody; short enough that a real outage is announced within a minute.
  openAfterMs: 60_000,
  // Deliberately longer than `openAfterMs`. A flapping engine that recovers for
  // four seconds should not close and immediately reopen its alert — the
  // resulting sawtooth is indistinguishable from a broken console.
  resolveAfterMs: 180_000,
  latencyThresholdMs: 5_000,
  queueBacklogThreshold: 500,
};

interface Candidate {
  kind: AlertKind;
  severity: AlertSeverity;
  reason: string;
}

/** Conditions visible in one snapshot, before any lifecycle is applied. */
function candidatesFor(
  health: EngineHealth,
  heartbeat: ObservedHeartbeat | undefined,
  policy: AlertPolicy,
): Candidate[] {
  const found: Candidate[] = [];

  if (health.state === "failed") {
    found.push({ kind: "engine.failed", severity: "critical", reason: health.reason });
  } else if (health.state === "degraded") {
    found.push({ kind: "engine.degraded", severity: "warning", reason: health.reason });
  } else if (health.state === "unknown") {
    // Not knowing is a problem in its own right, and a quieter one than a
    // failure — which is exactly why it needs an alert. Nobody notices silence.
    found.push({ kind: "engine.unknown", severity: "warning", reason: health.reason });
  }

  // Maintenance suppresses everything below. An engine somebody deliberately
  // took down should not generate the alerts that follow from it being down.
  if (health.state === "maintenance") return [];

  if (heartbeat) {
    if (heartbeat.openCircuits.length > 0) {
      found.push({
        kind: "engine.circuit.open",
        severity: "critical",
        reason: `Circuit open: ${heartbeat.openCircuits.join(", ")}.`,
      });
    }

    const latency = heartbeat.p95LatencyMs ?? heartbeat.avgLatencyMs;
    if (latency !== undefined && latency > policy.latencyThresholdMs) {
      found.push({
        kind: "engine.latency",
        severity: "warning",
        reason: `${Math.round(latency)}ms against a ${policy.latencyThresholdMs}ms threshold.`,
      });
    }

    if (heartbeat.queueDepth !== undefined && heartbeat.queueDepth > policy.queueBacklogThreshold) {
      found.push({
        kind: "engine.queue.backlog",
        severity: "warning",
        reason: `${heartbeat.queueDepth} jobs queued.`,
      });
    }
  }

  return found;
}

export interface AlertRegistry {
  /**
   * Applies one snapshot and returns what changed.
   *
   * Transitions rather than the whole list, because a notification should fire
   * when something becomes true — not on every evaluation of something that has
   * been true for an hour.
   */
  apply(
    healths: readonly EngineHealth[],
    heartbeats: Readonly<Record<string, ObservedHeartbeat | undefined>>,
    now: number,
  ): { opened: Alert[]; resolved: Alert[] };
  /** Everything currently open, worst first. */
  active(): Alert[];
  acknowledge(alertId: string, by: string, now: number): Alert | undefined;
  /** Resolved alerts, most recent first. History, for the alerts page. */
  history(limit?: number): Alert[];
}

interface Tracked {
  alert: Alert;
  /** When the condition was first continuously seen. */
  seenSince: number;
  /** When it was last seen. Absence for long enough is a resolution. */
  lastSeen: number;
  open: boolean;
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 2, warning: 1, info: 0 };

export function createAlertRegistry(policy: AlertPolicy = DEFAULT_ALERT_POLICY): AlertRegistry {
  const tracked = new Map<string, Tracked>();
  const resolved: Alert[] = [];

  return {
    apply(healths, heartbeats, now) {
      const opened: Alert[] = [];
      const justResolved: Alert[] = [];
      const present = new Set<string>();

      for (const health of healths) {
        const heartbeat = heartbeats[health.engineId];
        for (const candidate of candidatesFor(health, heartbeat, policy)) {
          const alertId = `${health.engineId}:${candidate.kind}`;
          present.add(alertId);

          const existing = tracked.get(alertId);
          if (!existing) {
            tracked.set(alertId, {
              seenSince: now,
              lastSeen: now,
              open: false,
              alert: {
                alertId,
                kind: candidate.kind,
                severity: candidate.severity,
                source: health.engineId,
                reason: candidate.reason,
                firstSeenAt: new Date(now).toISOString(),
                openedAt: new Date(now).toISOString(),
                lastSeenAt: new Date(now).toISOString(),
                occurrences: 1,
              },
            });
            continue;
          }

          existing.lastSeen = now;
          existing.alert = {
            ...existing.alert,
            // The reason is refreshed while the alert stays the same. An
            // operator reading it should see the current numbers, not the ones
            // from whenever it first fired.
            reason: candidate.reason,
            severity: candidate.severity,
            lastSeenAt: new Date(now).toISOString(),
            occurrences: existing.alert.occurrences + 1,
          };

          if (!existing.open && now - existing.seenSince >= policy.openAfterMs) {
            existing.open = true;
            existing.alert = { ...existing.alert, openedAt: new Date(now).toISOString(), resolvedAt: undefined };
            opened.push(existing.alert);
          }
        }
      }

      for (const [alertId, entry] of [...tracked]) {
        if (present.has(alertId)) continue;
        if (now - entry.lastSeen < policy.resolveAfterMs) continue;

        if (entry.open) {
          const closed = { ...entry.alert, resolvedAt: new Date(now).toISOString() };
          resolved.unshift(closed);
          justResolved.push(closed);
        }
        tracked.delete(alertId);
      }

      return { opened, resolved: justResolved };
    },

    active() {
      return [...tracked.values()]
        .filter((entry) => entry.open)
        .map((entry) => entry.alert)
        .sort(
          (a, b) =>
            SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
            Date.parse(b.openedAt) - Date.parse(a.openedAt),
        );
    },

    acknowledge(alertId, by, now) {
      const entry = tracked.get(alertId);
      // Acknowledging silences a notification; it does not make the problem
      // untrue. The alert stays open and stays in the list.
      if (!entry || !entry.open) return undefined;
      entry.alert = {
        ...entry.alert,
        acknowledgedBy: by,
        acknowledgedAt: new Date(now).toISOString(),
      };
      return entry.alert;
    },

    history(limit = 50) {
      return resolved.slice(0, limit);
    },
  };
}
