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
 * PRIME Engine — replay utility tests
 *
 * Covers `replayEventLog` (bulk fold) and `hydrateAndSubscribe`
 * (bulk fold + live catch-up).
 */

import { describe, it, expect, vi } from "vitest";
import { createInMemoryEventLog } from "../inMemoryEventLog.js";
import {
  replayEventLog,
  hydrateAndSubscribe,
  type ProjectionReducer,
} from "../replay.js";
import type { WorkOrderEvent } from "../../../models/events.js";
import type {
  EventLog,
  SubscribableEventLog,
  EventLogListener,
} from "../eventLog.js";

/** Minimal counter projection: tally how many events per workOrderId. */
interface CounterState {
  readonly total: number;
  readonly byWorkOrder: Readonly<Record<string, number>>;
}

const initialCounter: CounterState = { total: 0, byWorkOrder: {} };

const counterReducer: ProjectionReducer<CounterState> = (state, event) => ({
  total: state.total + 1,
  byWorkOrder: {
    ...state.byWorkOrder,
    [event.workOrderId]: (state.byWorkOrder[event.workOrderId] ?? 0) + 1,
  },
});

async function seed(
  log: EventLog,
  rows: Array<{ workOrderId: string }>
): Promise<void> {
  for (const row of rows) {
    await log.append({
      workOrderId: row.workOrderId,
      type: "work_order.intake.created",
      actor: { kind: "system", source: "test" },
      payload: {},
    });
  }
}

describe("replayEventLog", () => {
  it("returns the initial state for an empty log", async () => {
    const log = createInMemoryEventLog();
    const state = await replayEventLog(log, counterReducer, initialCounter);
    expect(state).toEqual(initialCounter);
  });

  it("folds all events in append order", async () => {
    const log = createInMemoryEventLog();
    await seed(log, [
      { workOrderId: "wo-1" },
      { workOrderId: "wo-2" },
      { workOrderId: "wo-1" },
    ]);

    const state = await replayEventLog(log, counterReducer, initialCounter);
    expect(state.total).toBe(3);
    expect(state.byWorkOrder["wo-1"]).toBe(2);
    expect(state.byWorkOrder["wo-2"]).toBe(1);
  });

  it("respects the sinceSequenceNumber checkpoint", async () => {
    const log = createInMemoryEventLog();
    await seed(log, [
      { workOrderId: "wo-1" },
      { workOrderId: "wo-2" },
      { workOrderId: "wo-3" },
    ]);

    // Skip the first two events.
    const state = await replayEventLog(log, counterReducer, initialCounter, {
      sinceSequenceNumber: 2,
    });
    expect(state.total).toBe(1);
    expect(state.byWorkOrder["wo-3"]).toBe(1);
    expect(state.byWorkOrder["wo-1"]).toBeUndefined();
    expect(state.byWorkOrder["wo-2"]).toBeUndefined();
  });

  it("invokes the reducer exactly once per event", async () => {
    const log = createInMemoryEventLog();
    await seed(log, [{ workOrderId: "wo-1" }, { workOrderId: "wo-2" }]);

    const reducer = vi.fn(counterReducer);
    await replayEventLog(log, reducer, initialCounter);
    expect(reducer).toHaveBeenCalledTimes(2);
  });
});

/** Build a minimal `SubscribableEventLog` on top of a fresh in-memory log. */
function createSubscribableMemLog(): SubscribableEventLog {
  const base = createInMemoryEventLog();
  const listeners = new Set<EventLogListener>();
  const originalAppend = base.append.bind(base);
  const wrapped: SubscribableEventLog = {
    ...base,
    async append(input) {
      const stored = await originalAppend(input);
      // Re-cast for listener dispatch — listeners receive the base event type.
      for (const listener of Array.from(listeners)) {
        listener(stored as unknown as WorkOrderEvent);
      }
      return stored;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return wrapped;
}

describe("hydrateAndSubscribe", () => {
  it("replays existing events and then receives live ones", async () => {
    const log = createSubscribableMemLog();
    await seed(log, [{ workOrderId: "wo-1" }, { workOrderId: "wo-2" }]);

    const advances: CounterState[] = [];
    const hydrated = await hydrateAndSubscribe(
      log,
      counterReducer,
      initialCounter,
      (next) => {
        advances.push(next);
      }
    );

    expect(hydrated.state.total).toBe(2);
    expect(hydrated.checkpoint).toBe(2);

    // A new event after hydration should fire the advance callback.
    await log.append({
      workOrderId: "wo-3",
      type: "work_order.intake.created",
      actor: { kind: "system", source: "test" },
      payload: {},
    });

    expect(advances).toHaveLength(1);
    expect(advances[0]?.total).toBe(3);
    expect(advances[0]?.byWorkOrder["wo-3"]).toBe(1);

    hydrated.unsubscribe();

    // After unsubscribe, further appends should NOT produce more advances.
    await log.append({
      workOrderId: "wo-4",
      type: "work_order.intake.created",
      actor: { kind: "system", source: "test" },
      payload: {},
    });
    expect(advances).toHaveLength(1);
  });

  it("sets checkpoint to 0 for an empty log", async () => {
    const log = createSubscribableMemLog();
    const hydrated = await hydrateAndSubscribe(
      log,
      counterReducer,
      initialCounter,
      () => undefined
    );
    expect(hydrated.checkpoint).toBe(0);
    expect(hydrated.state).toEqual(initialCounter);
    hydrated.unsubscribe();
  });
});
