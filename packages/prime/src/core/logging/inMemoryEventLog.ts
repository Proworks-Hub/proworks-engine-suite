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
 * PRIME Engine — In-memory Event Log adapter
 *
 * Reference implementation of the `EventLog` port. Backed by a plain array;
 * safe for tests and local dev; not durable. A persistent adapter (IndexedDB,
 * hub-server, SQLite) will replace this at runtime without consumers changing.
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.9.
 *
 * Contract reminders:
 * - Append-only. Returned event records are shallow-frozen to catch accidental
 *   mutation during development.
 * - `sequenceNumber` starts at 1 and increments on each append.
 * - `id`, `sequenceNumber`, and `timestamp` are assigned by the log; callers
 *   must not supply them (the `AppendEventInput` type doesn't allow it).
 */

import type {
  AppendEventInput,
  WorkOrderEvent,
  WorkOrderEventType,
  WorkOrderId,
} from "../../models/events";
import type {
  Clock,
  EventLog,
  IdGenerator,
} from "./eventLog";

export interface InMemoryEventLogOptions {
  /** Override for deterministic ids in tests. Defaults to crypto.randomUUID(). */
  readonly idGenerator?: IdGenerator;
  /** Override for deterministic timestamps in tests. Defaults to `() => new Date()`. */
  readonly clock?: Clock;
}

/**
 * Create a new in-memory event log. Each call returns an independent log;
 * `sequenceNumber` resets for each instance.
 */
export function createInMemoryEventLog(
  options: InMemoryEventLogOptions = {}
): EventLog {
  const events: WorkOrderEvent[] = [];
  let sequence = 0;

  const generateId: IdGenerator = options.idGenerator ?? defaultIdGenerator;
  const now: Clock = options.clock ?? (() => new Date());

  return {
    async append<TPayload>(
      input: AppendEventInput<TPayload>
    ): Promise<WorkOrderEvent<TPayload>> {
      validateInput(input);

      sequence += 1;
      const event: WorkOrderEvent<TPayload> = Object.freeze({
        id: generateId(),
        sequenceNumber: sequence,
        timestamp: now().toISOString(),
        workOrderId: input.workOrderId,
        stepId: input.stepId,
        type: input.type,
        actor: input.actor,
        payload: input.payload,
      });

      events.push(event as WorkOrderEvent);
      return event;
    },

    async listByWorkOrder(
      workOrderId: WorkOrderId
    ): Promise<ReadonlyArray<WorkOrderEvent>> {
      return events.filter((e) => e.workOrderId === workOrderId);
    },

    async listByType(
      type: WorkOrderEventType
    ): Promise<ReadonlyArray<WorkOrderEvent>> {
      return events.filter((e) => e.type === type);
    },

    async listSince(
      sinceSequenceNumber: number
    ): Promise<ReadonlyArray<WorkOrderEvent>> {
      return events.filter((e) => e.sequenceNumber > sinceSequenceNumber);
    },

    async size(): Promise<number> {
      return events.length;
    },
  };
}

function validateInput(input: AppendEventInput<unknown>): void {
  if (!input.workOrderId || typeof input.workOrderId !== "string") {
    throw new Error("EventLog.append: workOrderId must be a non-empty string");
  }
  if (!input.type) {
    throw new Error("EventLog.append: type is required");
  }
  if (!input.actor || typeof input.actor !== "object") {
    throw new Error("EventLog.append: actor is required");
  }
}

function defaultIdGenerator(): string {
  // Modern browsers + Node 20+ expose crypto.randomUUID globally.
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `evt_${time}_${rand}`;
}
