// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

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
 * PRIME Engine — Event Log port
 *
 * The append-only event log for a single shop. Implementations can be in-memory
 * (for tests + dev), IndexedDB-backed (browser persistence), or hub-server-backed
 * (durable on-prem storage). Consumers depend on this interface only.
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.9 (Logging & Event Module), §13 (Data model).
 *
 * Contract:
 * - `append` is the ONLY way to add events. It assigns id, sequenceNumber,
 *   and timestamp.
 * - Events, once appended, are immutable. Implementations MUST NOT mutate
 *   or allow mutation of returned event records.
 * - `sequenceNumber` is monotonically increasing within a log instance.
 *   Consumers can rely on `listSince(n)` to catch up from a checkpoint.
 * - List queries return events in append order (ascending sequenceNumber).
 */

import type {
  AppendEventInput,
  WorkOrderEvent,
  WorkOrderEventType,
  WorkOrderId,
} from "../../models/events.js";

export interface EventLog {
  /**
   * Append a new event to the log.
   *
   * @returns the stored event with id, sequenceNumber, and timestamp assigned.
   * @throws if the input is malformed (empty workOrderId, missing type, etc.).
   */
  append<TPayload = unknown>(
    input: AppendEventInput<TPayload>
  ): Promise<WorkOrderEvent<TPayload>>;

  /**
   * All events for a single work order, in append order.
   */
  listByWorkOrder(
    workOrderId: WorkOrderId
  ): Promise<ReadonlyArray<WorkOrderEvent>>;

  /**
   * All events of a given type across the log, in append order.
   * Useful for projection rebuilds and learning-layer scans.
   */
  listByType(
    type: WorkOrderEventType
  ): Promise<ReadonlyArray<WorkOrderEvent>>;

  /**
   * All events with `sequenceNumber > sinceSequenceNumber`, in append order.
   * Use `0` to fetch the full log. Intended for checkpointed catch-up.
   */
  listSince(
    sinceSequenceNumber: number
  ): Promise<ReadonlyArray<WorkOrderEvent>>;

  /**
   * Total number of events in the log.
   */
  size(): Promise<number>;
}

/**
 * Optional supporting ports — keep narrow and inject at adapter construction.
 */
export interface IdGenerator {
  (): string;
}

export interface Clock {
  (): Date;
}

/**
 * Listener callback for live event subscription. Invoked synchronously
 * after the event is durably persisted by the adapter.
 */
export interface EventLogListener {
  (event: WorkOrderEvent): void;
}

/**
 * Capability extension for adapters that can notify listeners when new
 * events land. Projections, live kiosks, and the master tablet subscribe
 * through this interface.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §5 (live subscription).
 *
 * Contract:
 * - `subscribe` returns an unsubscribe function. Callers MUST invoke it
 *   on teardown; adapters will not clean up dangling listeners.
 * - Listeners are invoked in subscription order, once per event.
 * - Listener errors must not break the dispatch loop; adapters catch and
 *   isolate them (see IdbEventLog implementation).
 */
export interface SubscribableEventLog extends EventLog {
  subscribe(listener: EventLogListener): () => void;
}
