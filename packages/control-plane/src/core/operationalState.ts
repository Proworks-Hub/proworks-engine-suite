// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

import type { EngineHealth } from "./health.js";
import type { EngineManifest, EventMapping } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// What an engine is doing right now.
//
// Distinct from health, and the distinction is the point. Health answers "is it
// alright?"; this answers "what is it busy with?" — and an engine can be
// perfectly healthy and idle, or perfectly healthy and flat out.
//
// Two vocabularies, deliberately:
//
//   NORMALIZED — a small shared set, so the observability table has a column
//   that sorts, filters and means the same thing across nine engines.
//
//   DOMAIN — the engine's own word. `generating_plan`, `reserving`,
//   `awaiting_review`. This is what an engineer actually wants to read, and
//   flattening it into the shared set is how a console becomes useless
//   precisely when someone is debugging.
//
// Both come from the manifest's event mappings, so they are real: an engine is
// `generating_plan` because it published the event that says so, not because a
// timer decided it was time to look busy.
// ─────────────────────────────────────────────────────────────────────────────

export const normalizedActivitySchema = z.enum([
  "idle",
  "receiving",
  "processing",
  "calculating",
  "updating",
  "monitoring",
  "waiting",
  /** These four come from health, not from activity. */
  "degraded",
  "failed",
  "maintenance",
  "unknown",
]);
export type NormalizedActivity = z.infer<typeof normalizedActivitySchema>;

/** Activity implied by an event's visual effect, when a manifest does not say. */
const EFFECT_ACTIVITY: Readonly<Record<EventMapping["effect"], NormalizedActivity>> = {
  receive: "receiving",
  activate: "processing",
  emit: "processing",
  // An alert says something is wrong, not what the engine is doing. Health
  // decides this one, so it is never read from here.
  alert: "processing",
};

export interface OperationalState {
  readonly engineId: string;
  readonly normalized: NormalizedActivity;
  /** The engine's own word for it, when the mapping supplied one. */
  readonly activity?: string;
  /** What to show in the table: the domain word if there is one, else the shared one. */
  readonly label: string;
  /** The event this was read from. */
  readonly eventType?: string;
  readonly since?: string;
  /**
   * True when this came from health rather than from activity — the engine is
   * not "doing" anything, it is in trouble.
   */
  readonly fromHealth: boolean;
}

export interface DeriveOperationalStateInput {
  manifest: EngineManifest;
  health: EngineHealth;
  /** The last event seen from this engine, if any. */
  lastEvent?: { eventType: string; at: string };
  now: number;
  /**
   * How long an activity stays current after its event.
   *
   * Without a decay, an engine that generated a plan an hour ago still reads
   * `generating_plan` — a console frozen at whatever happened last, which is
   * indistinguishable from a console that has stopped updating.
   */
  activityWindowMs?: number;
}

const DEFAULT_ACTIVITY_WINDOW_MS = 30_000;

/**
 * Works out what to show in the state column.
 *
 * Health wins whenever it is bad. An engine that is failing is not
 * `calculating`, whatever its last event said — and showing a busy-looking
 * activity beside a red status is how a dashboard sends someone looking in the
 * wrong place.
 */
export function deriveOperationalState(input: DeriveOperationalStateInput): OperationalState {
  const { manifest, health, lastEvent, now } = input;
  const windowMs = input.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS;

  if (health.state === "failed" || health.state === "degraded" || health.state === "maintenance" || health.state === "unknown") {
    return {
      engineId: manifest.id,
      normalized: health.state,
      label: health.descriptor.label,
      fromHealth: true,
    };
  }

  if (lastEvent) {
    const at = Date.parse(lastEvent.at);
    const fresh = !Number.isNaN(at) && now - at <= windowMs && at <= now + 1_000;
    if (fresh) {
      const mapping = manifest.eventMappings.find((m) => m.eventType === lastEvent.eventType);
      if (mapping) {
        const normalized = mapping.normalizedActivity ?? EFFECT_ACTIVITY[mapping.effect];
        return {
          engineId: manifest.id,
          normalized,
          activity: mapping.activity,
          label: mapping.activity ? humanise(mapping.activity) : humanise(normalized),
          eventType: lastEvent.eventType,
          since: lastEvent.at,
          fromHealth: false,
        };
      }
    }
  }

  // Healthy and quiet. Idle is a real state and a good one; it is not the same
  // as `unknown`, which is the console admitting it does not know.
  return {
    engineId: manifest.id,
    normalized: "idle",
    label: "Idle",
    fromHealth: false,
  };
}

/** `generating_plan` → `Generating plan`. */
function humanise(slug: string): string {
  const words = slug.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Every domain activity an engine can report, from its own manifest.
 *
 * For the filter dropdown on the events page. Derived rather than listed, so a
 * new mapping appears in the filter without anybody remembering to add it —
 * the version where it is a second list is the version where the filter
 * silently cannot find half the states.
 */
export function activitiesFor(manifest: EngineManifest): string[] {
  const activities = new Set<string>();
  for (const mapping of manifest.eventMappings) {
    if (mapping.activity) activities.add(mapping.activity);
  }
  return [...activities].sort();
}
