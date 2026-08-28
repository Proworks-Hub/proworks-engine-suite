// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PlatformEvent } from "@proworks-hub/contracts";

import type { EngineHeartbeat } from "./health.js";
import type { EngineManifest } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Where health information actually comes from.
//
// The obvious design is for each engine to expose a health endpoint. That is
// the wrong one here: it would put an HTTP server, a clock and a metrics
// dependency inside packages whose entire value is that they have none of
// those. An engine that must be deployed as a service to be monitored is no
// longer portable.
//
// So heartbeats are assembled at the ADAPTER layer, from two sources, and the
// difference between them is recorded rather than smoothed over:
//
//   REPORTED — a host that runs an engine knows its version, its uptime and its
//   queue depth, and hands a heartbeat over. Strong evidence.
//
//   DERIVED — nobody reported anything, but the engine has been publishing
//   events, so it is demonstrably alive and demonstrably doing work. Weaker
//   evidence, and weaker in a specific way worth naming: an engine can publish
//   events happily while the path that matters is broken.
//
// The distinction is carried on the heartbeat itself, because a console that
// presents inference and measurement identically is a console that will
// eventually be trusted about the wrong one.
// ─────────────────────────────────────────────────────────────────────────────

/** How a heartbeat was obtained. Never inferred from the data. */
export type HeartbeatSource = "reported" | "derived";

export interface ObservedHeartbeat extends EngineHeartbeat {
  readonly source: HeartbeatSource;
  /** Events seen in the window. Zero with `derived` means nothing was observed. */
  readonly observedEvents: number;
}

export interface HeartbeatCollectorOptions {
  manifests: readonly EngineManifest[];
  /** The window throughput and failures are counted over. */
  windowMs?: number;
  now?: () => number;
  /**
   * Versions the host knows about, by engine id.
   *
   * A derived heartbeat cannot discover a version — events do not carry one,
   * and inventing "unknown" as though it were observed would put a lie in the
   * versions panel. The host supplies what it knows; the rest reads as unknown
   * and says so.
   */
  versions?: Readonly<Record<string, string>>;
}

export interface HeartbeatCollector {
  /** Feed one platform event. Safe to call with anything. */
  observe(event: unknown): void;
  /** A host that runs an engine hands over what it actually knows. */
  report(heartbeat: EngineHeartbeat): void;
  /** The current picture for one engine, or undefined if nothing is known. */
  get(engineId: string): ObservedHeartbeat | undefined;
  /** Everything known, for the dashboard. */
  snapshot(): ObservedHeartbeat[];
}

interface Window {
  timestamps: number[];
  failures: number[];
  lastEventType?: string;
}

/**
 * Assembles heartbeats from whatever evidence exists.
 *
 * A reported heartbeat always wins over a derived one for the fields it
 * carries: a host that runs the engine knows its queue depth, and no amount of
 * event-watching will.
 *
 * Failures are counted from the manifest's own `alert` mappings rather than
 * from a naming convention. Guessing that anything ending in `.failed` is a
 * failure works until an engine publishes `retry.failed.recovered`, and then
 * the dashboard reports an incident that did not happen.
 */
export function createHeartbeatCollector(
  options: HeartbeatCollectorOptions,
): HeartbeatCollector {
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());

  const alertTypes = new Map<string, Set<string>>();
  for (const manifest of options.manifests) {
    const types = new Set<string>();
    for (const mapping of manifest.eventMappings) {
      if (mapping.effect === "alert") types.add(mapping.eventType);
    }
    alertTypes.set(manifest.id, types);
  }

  const windows = new Map<string, Window>();
  const reported = new Map<string, EngineHeartbeat>();

  const trim = (values: number[], cutoff: number): void => {
    while (values.length > 0 && values[0]! < cutoff) values.shift();
  };

  return {
    observe(input: unknown): void {
      if (input === null || typeof input !== "object") return;
      const event = input as Partial<PlatformEvent>;
      const engineId = event.source?.service;
      const eventType = event.eventType;
      if (typeof engineId !== "string" || typeof eventType !== "string") return;

      const at = Date.parse(
        typeof event.occurredAt === "string" ? event.occurredAt : String(event.publishedAt),
      );
      const stamp = Number.isNaN(at) ? now() : at;

      const window = windows.get(engineId) ?? { timestamps: [], failures: [] };
      window.timestamps.push(stamp);
      window.lastEventType = eventType;
      if (alertTypes.get(engineId)?.has(eventType)) window.failures.push(stamp);
      windows.set(engineId, window);
    },

    report(heartbeat: EngineHeartbeat): void {
      reported.set(heartbeat.engineId, heartbeat);
    },

    get(engineId: string): ObservedHeartbeat | undefined {
      const at = now();
      const cutoff = at - windowMs;
      const window = windows.get(engineId);
      if (window) {
        trim(window.timestamps, cutoff);
        trim(window.failures, cutoff);
      }

      const direct = reported.get(engineId);
      if (direct) {
        return {
          ...direct,
          source: "reported",
          observedEvents: window?.timestamps.length ?? 0,
        };
      }

      if (!window || window.timestamps.length === 0) return undefined;

      // The MAXIMUM, not the last one appended. Events do not arrive in
      // chronological order — an at-least-once bus reorders them, and a host
      // batching a minute of reports may send newest-first. Taking the last
      // inserted made a busy engine read as silent for as long as its own
      // batch spanned, which is the worst possible direction for this error:
      // it invents an outage.
      const lastSeen = Math.max(...window.timestamps);
      return {
        engineId,
        // Not "unknown" dressed as a version string — the versions panel shows
        // this verbatim, and it should read as an absence.
        version: options.versions?.[engineId] ?? "unreported",
        observedAt: new Date(lastSeen).toISOString(),
        jobsProcessed: window.timestamps.length,
        jobsFailed: window.failures.length,
        // Neither of these is observable from an event stream. Omitted rather
        // than defaulted: a queue depth of 0 on an engine with a backlog is
        // worse than no queue depth at all.
        openCircuits: [],
        maintenance: false,
        source: "derived",
        observedEvents: window.timestamps.length,
      };
    },

    snapshot(): ObservedHeartbeat[] {
      const ids = new Set([...windows.keys(), ...reported.keys()]);
      const out: ObservedHeartbeat[] = [];
      for (const id of ids) {
        const heartbeat = this.get(id);
        if (heartbeat) out.push(heartbeat);
      }
      return out;
    },
  };
}

/**
 * What a derived heartbeat cannot tell you.
 *
 * An idle engine publishes nothing, and so does a stopped one. Silence is
 * therefore ambiguous under derivation in a way it is not under reporting, and
 * the console must say which kind of not-knowing it has — otherwise an operator
 * reads "No telemetry" on a perfectly healthy engine that simply had no work,
 * and learns to ignore the state.
 */
export function heartbeatCaveat(heartbeat: ObservedHeartbeat | undefined): string | undefined {
  if (!heartbeat) return undefined;
  if (heartbeat.source === "reported") return undefined;
  return (
    "Derived from published events; this engine does not report health directly. " +
    "An idle engine and a stopped one look the same from here."
  );
}
