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
 * PRIME Engine — WorkOrderSummary projection factory
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7 (Tracking / Projection).
 *
 * A lazy, read-through cache over the event log. Consumers call `get(woId)`;
 * the projection replays that work order's events into a `WorkOrderSummary`
 * and caches the result keyed by `lastEventSequence`. Subsequent calls fetch
 * only the tail of new events and fold them onto the cached summary — no
 * full replay unless the cache is cold or explicitly invalidated.
 *
 * Phase 1 `EventLog` has no subscribe API, so there's no push/live update
 * channel yet. Callers that want fresh data should call `refresh(woId)` or
 * rely on cache invalidation hooks that the hosting adapter supplies
 * (e.g. a hub-server writer that invalidates after it appends).
 *
 * The projection is a narrow port: consumers depend on the interface, not the
 * factory. Adapters can replace it with a server-backed implementation later
 * without changing callers.
 */

import type { EventLog } from "../core/logging/eventLog.js";
import type {
  WorkOrderEvent,
  WorkOrderId,
} from "../models/events.js";

import type { WorkOrderSummary } from "./workOrderSummaryTypes.js";
import {
  foldEvents,
  reduceWorkOrderSummary,
} from "./workOrderSummaryReducer.js";

// ---------- Port ----------

export interface WorkOrderSummaryProjection {
  /**
   * Return the current summary for a WO, building / catching up the cache
   * as needed. `null` means "no intake.created yet for this WO".
   */
  get(workOrderId: WorkOrderId): Promise<WorkOrderSummary | null>;

  /**
   * Drop cache for a WO and rebuild from the log on next `get`. Equivalent
   * to invalidate + get.
   */
  refresh(workOrderId: WorkOrderId): Promise<WorkOrderSummary | null>;

  /**
   * Drop cache for a WO without rebuilding. Next `get` will full-replay.
   * Writers should call this after appending events for the WO so readers
   * pick up the tail on their next access.
   */
  invalidate(workOrderId: WorkOrderId): void;

  /**
   * Snapshot of all currently-cached summaries. Does NOT trigger replays for
   * WOs that haven't been fetched yet — this is a view of the cache, not the
   * log. For a shop-wide scan, iterate WO ids first and call `get` per id.
   */
  getAll(): ReadonlyMap<WorkOrderId, WorkOrderSummary>;
}

// ---------- Deps / options ----------

export interface CreateWorkOrderSummaryProjectionDeps {
  readonly eventLog: EventLog;
}

// ---------- Factory ----------

export function createWorkOrderSummaryProjection(
  deps: CreateWorkOrderSummaryProjectionDeps
): WorkOrderSummaryProjection {
  const { eventLog } = deps;
  const cache = new Map<WorkOrderId, WorkOrderSummary>();

  async function buildFromScratch(
    workOrderId: WorkOrderId
  ): Promise<WorkOrderSummary | null> {
    const events = await eventLog.listByWorkOrder(workOrderId);
    if (events.length === 0) return null;
    const { summary } = foldEvents(events);
    if (summary !== null) cache.set(workOrderId, summary);
    return summary;
  }

  async function catchUp(
    workOrderId: WorkOrderId,
    cached: WorkOrderSummary
  ): Promise<WorkOrderSummary> {
    // Pull the WO's full event list and keep only the tail past our pointer.
    // A listByWorkOrderSince API would be cheaper, but the current EventLog
    // port doesn't expose one; listByWorkOrder is still O(wo-events) which
    // is bounded per-WO, not per-shop.
    const events = await eventLog.listByWorkOrder(workOrderId);
    const tail = events.filter(
      (e: WorkOrderEvent) => e.sequenceNumber > cached.lastEventSequence
    );
    if (tail.length === 0) return cached;
    let next: WorkOrderSummary | null = cached;
    for (const event of tail) {
      next = reduceWorkOrderSummary(next, event);
    }
    // reducer can't drop a non-null summary back to null, but narrow the type
    const result = next ?? cached;
    cache.set(workOrderId, result);
    return result;
  }

  return Object.freeze<WorkOrderSummaryProjection>({
    async get(workOrderId) {
      const cached = cache.get(workOrderId);
      if (!cached) return buildFromScratch(workOrderId);
      return catchUp(workOrderId, cached);
    },

    async refresh(workOrderId) {
      cache.delete(workOrderId);
      return buildFromScratch(workOrderId);
    },

    invalidate(workOrderId) {
      cache.delete(workOrderId);
    },

    getAll() {
      // Defensive copy so callers can't mutate the internal cache.
      return new Map(cache);
    },
  });
}
