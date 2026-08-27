/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — Replay utility
 *
 * Hydrates a projection from a persisted event log by folding every event in
 * append order through a pure reducer. Used on app boot (or projection
 * invalidation) to rebuild read models from the single source of truth.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §1 (persistent event log) and §4
 * (role-based projections).
 *
 * Contract:
 * - The reducer MUST be pure: same (state, event) -> same new state.
 * - Events are delivered in ascending `sequenceNumber` order; reducers can
 *   rely on that ordering.
 * - `replayEventLog` never appends; it is read-only.
 * - A checkpoint (`sinceSequenceNumber`) lets callers resume from a saved
 *   snapshot instead of walking the entire log.
 */

import type {
  EventLog,
  SubscribableEventLog,
  EventLogListener,
} from "./eventLog";
import type { WorkOrderEvent } from "../../models/events";

/** Pure reducer: folds one event into the running projection state. */
export interface ProjectionReducer<TState> {
  (state: TState, event: WorkOrderEvent): TState;
}

export interface ReplayOptions {
  /**
   * Start from events with `sequenceNumber > sinceSequenceNumber`.
   * Defaults to `0` (replay the entire log).
   */
  readonly sinceSequenceNumber?: number;
}

/**
 * Fold every event in `log` (above the optional checkpoint) through `reducer`,
 * starting from `initialState`, and return the final projection state.
 */
export async function replayEventLog<TState>(
  log: EventLog,
  reducer: ProjectionReducer<TState>,
  initialState: TState,
  options: ReplayOptions = {}
): Promise<TState> {
  const since = options.sinceSequenceNumber ?? 0;
  const events = await log.listSince(since);

  let state = initialState;
  for (const event of events) {
    state = reducer(state, event);
  }
  return state;
}

export interface HydratedProjection<TState> {
  /** The fully rebuilt projection state after replaying the log. */
  readonly state: TState;
  /** Highest `sequenceNumber` seen during replay; `0` if the log was empty. */
  readonly checkpoint: number;
  /**
   * Unsubscribe handle for the live listener. Callers MUST invoke this on
   * teardown to avoid leaking listeners across re-hydrations.
   */
  readonly unsubscribe: () => void;
}

/**
 * Replay the log through `reducer`, then continue applying new events via
 * subscription. The returned `state` is a snapshot at the moment of hydration;
 * fresh state for each incoming event is produced by calling `onAdvance` with
 * the reduced state.
 *
 * Typical wiring in a UI:
 *   const { state, unsubscribe } = await hydrateAndSubscribe(log, reducer, {},
 *     (next) => setStoreState(next));
 *   // on unmount: unsubscribe();
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §5 (live subscription).
 */
export async function hydrateAndSubscribe<TState>(
  log: SubscribableEventLog,
  reducer: ProjectionReducer<TState>,
  initialState: TState,
  onAdvance: (next: TState) => void
): Promise<HydratedProjection<TState>> {
  // Initial bulk replay.
  const events = await log.listSince(0);
  let state = initialState;
  let checkpoint = 0;
  for (const event of events) {
    state = reducer(state, event);
    if (event.sequenceNumber > checkpoint) {
      checkpoint = event.sequenceNumber;
    }
  }

  // Attach listener for incoming events. Guard against events we've already
  // seen (race between list and subscribe during hydration).
  const listener: EventLogListener = (event) => {
    if (event.sequenceNumber <= checkpoint) {
      return;
    }
    state = reducer(state, event);
    checkpoint = event.sequenceNumber;
    onAdvance(state);
  };
  const unsubscribe = log.subscribe(listener);

  return { state, checkpoint, unsubscribe };
}
