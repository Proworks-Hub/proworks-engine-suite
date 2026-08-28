// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { EngineVisualizationEvent, VisualizationEffect } from "../core/visualization.js";
import { useMotion } from "./motion.js";

// ─────────────────────────────────────────────────────────────────────────────
// What each engine is doing right now.
//
// One subscription for the whole console, not one per card. Nine components
// each opening their own stream is nine connections, nine reconnect loops and
// nine chances to leak one.
//
// The distinction that matters throughout: COUNTS are information and PULSES
// are decoration. Pausing or reducing motion removes the pulses and keeps the
// counts, so an operator who cannot tolerate movement still sees exactly what
// an operator who can sees — §9, do not sacrifice system information.
// ─────────────────────────────────────────────────────────────────────────────

/** One animation in flight. */
export interface ActivityPulse {
  readonly key: string;
  readonly effect: VisualizationEffect;
  readonly intensity: number;
  readonly startedAt: number;
  readonly destination?: string;
  readonly visualHint?: string;
}

export interface EngineActivity {
  /** In flight. Always empty when paused or under reduced motion. */
  readonly pulses: readonly ActivityPulse[];
  /** Events seen in the rolling window. Counted whether or not they are drawn. */
  readonly recentCount: number;
  /** 0..1, for how brightly the scene should burn. */
  readonly level: number;
  readonly lastEventAt?: number;
  readonly lastEventType?: string;
}

const EMPTY: EngineActivity = { pulses: [], recentCount: 0, level: 0 };

interface ActivityStore {
  readonly byEngine: Readonly<Record<string, EngineActivity>>;
  /** Packets currently crossing the hive. */
  readonly inFlight: readonly (ActivityPulse & { engineId: string })[];
}

const ActivityContext = createContext<ActivityStore>({ byEngine: {}, inFlight: [] });

export interface EngineActivityProviderProps {
  children: ReactNode;
  /**
   * The host's subscription. It hands over translated visualization events and
   * returns an unsubscribe.
   *
   * A function rather than a bus instance: the console must work against a
   * websocket in production, a polling adapter in a restricted network, and an
   * array in a test, and none of those belong in this package.
   */
  subscribe(onEvent: (event: EngineVisualizationEvent) => void): () => void;
  /** How long a pulse stays on screen. */
  pulseDurationMs?: number;
  /** The window `recentCount` and `level` are measured over. */
  windowMs?: number;
  /** Events per second in the window that counts as fully busy. */
  saturationPerSecond?: number;
  now?: () => number;
}

export function EngineActivityProvider({
  children,
  subscribe,
  pulseDurationMs = 1_600,
  windowMs = 10_000,
  saturationPerSecond = 6,
  now = () => Date.now(),
}: EngineActivityProviderProps) {
  const motion = useMotion();
  const [store, setStore] = useState<ActivityStore>({ byEngine: {}, inFlight: [] });

  // Read through a ref so a change of pause state does not tear down and
  // rebuild the subscription. Reconnecting a websocket because somebody pressed
  // pause is a real bug, and an easy one to write.
  const animateRef = useRef(motion.animate);
  animateRef.current = motion.animate;

  const timestamps = useRef(new Map<string, number[]>());
  const sequence = useRef(0);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      const at = now();

      const seen = timestamps.current.get(event.engineId) ?? [];
      seen.push(at);
      const cutoff = at - windowMs;
      while (seen.length > 0 && seen[0]! < cutoff) seen.shift();
      timestamps.current.set(event.engineId, seen);

      sequence.current += 1;
      const pulse: ActivityPulse = {
        // The event id is not unique enough on its own: an at-least-once bus
        // redelivers, and two pulses sharing a React key collapse into one.
        key: `${event.eventId}:${sequence.current}`,
        effect: event.effect,
        intensity: event.intensity,
        startedAt: at,
        destination: event.destination,
        visualHint: event.visualHint,
      };

      setStore((previous) => {
        const drawing = animateRef.current;
        const existing = previous.byEngine[event.engineId] ?? EMPTY;
        const level = Math.min(1, seen.length / ((windowMs / 1000) * saturationPerSecond));

        return {
          byEngine: {
            ...previous.byEngine,
            [event.engineId]: {
              pulses: drawing ? [...existing.pulses, pulse] : [],
              recentCount: seen.length,
              level,
              lastEventAt: at,
              lastEventType: event.eventType,
            },
          },
          inFlight:
            drawing && event.destination
              ? [...previous.inFlight, { ...pulse, engineId: event.engineId }]
              : previous.inFlight,
        };
      });
    });

    return unsubscribe;
    // `subscribe` is the host's; re-running on a new one is correct.
  }, [subscribe, now, windowMs, saturationPerSecond]);

  // Expire finished pulses on one timer for the whole console rather than a
  // timeout per event. At a few thousand events a minute the per-event version
  // is a few thousand timers, and the browser notices.
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = now() - pulseDurationMs;
      setStore((previous) => {
        let changed = false;
        const byEngine: Record<string, EngineActivity> = {};
        for (const [engineId, activity] of Object.entries(previous.byEngine)) {
          const pulses = activity.pulses.filter((p) => p.startedAt > cutoff);
          if (pulses.length !== activity.pulses.length) changed = true;
          byEngine[engineId] = pulses === activity.pulses ? activity : { ...activity, pulses };
        }
        const inFlight = previous.inFlight.filter((p) => p.startedAt > cutoff);
        if (inFlight.length !== previous.inFlight.length) changed = true;
        return changed ? { byEngine, inFlight } : previous;
      });
    }, 250);
    return () => clearInterval(interval);
  }, [pulseDurationMs, now]);

  // Pressing pause must stop the motion that is already on screen, not just
  // prevent the next. Clearing here is what makes it feel immediate.
  useEffect(() => {
    if (motion.animate) return;
    setStore((previous) => ({
      byEngine: Object.fromEntries(
        Object.entries(previous.byEngine).map(([id, activity]) => [id, { ...activity, pulses: [] }]),
      ),
      inFlight: [],
    }));
  }, [motion.animate]);

  return <ActivityContext.Provider value={store}>{children}</ActivityContext.Provider>;
}

export function useEngineActivity(engineId: string): EngineActivity {
  return useContext(ActivityContext).byEngine[engineId] ?? EMPTY;
}

/** Packets crossing the hive, for the architecture view. */
export function useInFlightPackets(): readonly (ActivityPulse & { engineId: string })[] {
  return useContext(ActivityContext).inFlight;
}
