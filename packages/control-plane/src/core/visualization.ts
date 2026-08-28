// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { eventTypeMatches, type PlatformEvent } from "@proworks-hub/contracts";

import type { EngineManifest, EventMapping } from "./manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// Turning something that happened into something you can see.
//
// The whole point of the console is that the movement is TRUE. A scene that
// pulses on a timer looks identical to a scene that pulses because ForgeIQ
// generated a plan, right up until the moment someone trusts it — and then it
// is worse than a static picture, because a static picture never told anyone
// the system was fine.
//
// So: no event, no motion. Everything below either maps a real domain event to
// a real visual instruction, or returns nothing.
//
// The translation lives HERE and not on the event. A domain event is a business
// fact with consumers who are not this console; giving it an `intensity` field
// would make an animation's brightness part of a contract that ForgeIQ, CostIQ
// and three projections all have to honour.
// ─────────────────────────────────────────────────────────────────────────────

export type VisualizationEffect = "receive" | "activate" | "emit" | "alert";

/**
 * One instruction for the visual layer.
 *
 * Contains no payload. A console that renders event payloads into a scene has
 * put customer data on a wallboard, and the wallboard is in an office.
 * Inspecting a payload is a deliberate click in the trace view, gated by
 * diagnostics permission — never something that happens because a box lit up.
 */
export interface EngineVisualizationEvent {
  /** Which scene reacts. */
  readonly engineId: string;
  /** The domain event that caused this, for the trace view. */
  readonly eventType: string;
  readonly eventId: string;
  readonly effect: VisualizationEffect;
  /** 0..1. */
  readonly intensity: number;
  /** Which engine published it. */
  readonly source: string;
  /** Where a packet flies, for the architecture view. */
  readonly destination?: string;
  readonly timestamp: string;
  /** Ties the packet to the rest of its trace. */
  readonly correlationId?: string;
  /** Scene-specific: which station, which lens, which shelf. */
  readonly visualHint?: string;
}

/**
 * Picks the mapping that should win.
 *
 * Exact beats prefix beats wildcard. Without this an audit-style `*` mapping
 * silently outranks the specific one somebody wrote for
 * `manufacturing.plan.generated`, and the scene shows a generic pulse forever
 * while the mapping that was meant to fire sits there looking correct.
 */
function bestMapping(mappings: readonly EventMapping[], eventType: string): EventMapping | undefined {
  let best: EventMapping | undefined;
  let bestScore = -1;
  for (const mapping of mappings) {
    if (!eventTypeMatches(mapping.eventType, eventType)) continue;
    const score = mapping.eventType === eventType ? 2 : mapping.eventType === "*" ? 0 : 1;
    if (score > bestScore) {
      best = mapping;
      bestScore = score;
    }
  }
  return best;
}

export interface VisualizationAdapter {
  /**
   * Translates one platform event, or returns null.
   *
   * Null means "nothing to show" and is the common case — most events are not
   * interesting to look at, and inventing a pulse for them would make the
   * console lie by volume.
   */
  translate(event: unknown): EngineVisualizationEvent | null;
}

/**
 * Builds the adapter from the manifests.
 *
 * The console's motion is therefore configured by metadata, not coded: adding
 * an engine adds its animations, and changing which event lights up a scene is
 * a manifest edit rather than a component edit.
 */
export function createVisualizationAdapter(
  manifests: readonly EngineManifest[],
): VisualizationAdapter {
  return {
    translate(input: unknown): EngineVisualizationEvent | null {
      // Telemetry is the one input the console cannot validate at the source:
      // it arrives from a broker, possibly from an engine newer than this
      // build. A console that throws on a malformed event is a console that
      // goes blank during the incident that produced the malformed event.
      if (input === null || typeof input !== "object") return null;
      const event = input as Partial<PlatformEvent>;

      const eventType = event.eventType;
      const service = event.source?.service;
      if (typeof eventType !== "string" || typeof service !== "string") return null;

      const eventId = typeof event.eventId === "string" ? event.eventId : null;
      if (!eventId) return null;

      // The scene that reacts is the one whose manifest claims the event, which
      // is usually — but not always — the publisher. Prime's routing events name
      // a destination engine, and that engine's own manifest is what says how it
      // should look when work arrives.
      for (const manifest of manifests) {
        const mapping = bestMapping(manifest.eventMappings, eventType);
        if (!mapping) continue;

        // A manifest only claims events it publishes or receives. Without this
        // check, two engines mapping `*` would both light up for everything.
        const claimedBySource = manifest.id === service;
        const claimedAsDestination = mapping.to === manifest.id;
        if (!claimedBySource && !claimedAsDestination) continue;

        const intensity = clamp01(mapping.intensity);
        const timestamp =
          typeof event.occurredAt === "string"
            ? event.occurredAt
            : typeof event.publishedAt === "string"
              ? event.publishedAt
              : new Date(0).toISOString();

        return {
          engineId: manifest.id,
          eventType,
          eventId,
          effect: mapping.effect,
          intensity,
          source: service,
          destination: mapping.to,
          timestamp,
          correlationId:
            typeof event.trace?.correlationId === "string" ? event.trace.correlationId : undefined,
          visualHint: mapping.visualHint,
        };
      }

      return null;
    },
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ── Keeping the console cheap ────────────────────────────────────────────────

export interface VisualizationBudgetOptions {
  /**
   * Animations started per engine per second. Beyond this, events are counted
   * but not drawn.
   *
   * §20: the console must not cost the platform anything. It also must not cost
   * the operator's machine anything — an engine doing 5,000 jobs a minute would
   * otherwise queue 5,000 animations, and the browser that tries is the browser
   * that stops responding during the incident.
   */
  maxEffectsPerEnginePerSecond?: number;
  now?: () => number;
}

export interface VisualizationBudget {
  /** Returns the event if it should be drawn, or null if it was dropped. */
  admit(event: EngineVisualizationEvent): EngineVisualizationEvent | null;
  /** How many were dropped per engine, so the UI can say "+412 more". */
  droppedFor(engineId: string): number;
  reset(): void;
}

/**
 * Rate-limits animation without hiding anything that matters.
 *
 * `alert` effects are never dropped. Sampling throughput is fine — one pulse
 * looks much like the next — but an alert dropped to stay inside an animation
 * budget is a failure the operator was not shown, and the budget existed for
 * the benefit of a graphics card.
 *
 * Dropped counts are kept rather than discarded, because "throughput so high we
 * stopped drawing it" is itself information.
 */
export function createVisualizationBudget(
  options: VisualizationBudgetOptions = {},
): VisualizationBudget {
  const limit = options.maxEffectsPerEnginePerSecond ?? 12;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, { startedAt: number; count: number }>();
  const dropped = new Map<string, number>();

  return {
    admit(event) {
      if (event.effect === "alert") return event;

      const at = now();
      const window = windows.get(event.engineId);
      if (!window || at - window.startedAt >= 1000) {
        windows.set(event.engineId, { startedAt: at, count: 1 });
        return event;
      }
      if (window.count < limit) {
        window.count += 1;
        return event;
      }
      dropped.set(event.engineId, (dropped.get(event.engineId) ?? 0) + 1);
      return null;
    },
    droppedFor(engineId) {
      return dropped.get(engineId) ?? 0;
    },
    reset() {
      windows.clear();
      dropped.clear();
    },
  };
}
