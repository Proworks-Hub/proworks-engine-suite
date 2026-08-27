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
 * PRIME Engine — Change Order use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.6.
 *
 * Factory producing a use case with three methods: `create`, `approve`,
 * `reject`. All three emit exactly one `work_order.change_order.*` event
 * and return the updated `ChangeOrder`. The use case is stateless — the
 * caller persists the change order record; this module only validates
 * transitions, builds the next state, and appends the event.
 *
 * Transition rules:
 *  - `create`  — builds a fresh change order in `pending` state.
 *  - `approve` — only valid when `status === "pending"`; moves to `approved`.
 *  - `reject`  — only valid when `status === "pending"`; requires a non-empty
 *                `rejectionReason`; moves to `rejected`.
 *
 * Failure path returns `{ ok: false, error }` and emits NO event, matching
 * the philosophy established in Template / Routing / Priority / Task Flow:
 * a failed transition must not show up in the event log.
 */

import type {
  EventActor,
  WorkOrderEventType,
} from "../../models/events";
import type {
  Clock,
  EventLog,
} from "../logging/eventLog";
import type {
  ApproveChangeOrderInput,
  ChangeError,
  ChangeOrder,
  ChangeOrderApprovedPayload,
  ChangeOrderCreatedPayload,
  ChangeOrderRejectedPayload,
  CreateChangeOrderInput,
  RejectChangeOrderInput,
} from "./changeOrderTypes";

// ---------- Public surface ----------

export type ChangeOrderResult =
  | { readonly ok: true; readonly changeOrder: ChangeOrder }
  | { readonly ok: false; readonly error: ChangeError };

export interface ChangeOrderUseCaseDeps {
  readonly eventLog: EventLog;
  /** Injected for deterministic tests. Defaults to wall clock. */
  readonly clock?: Clock;
}

export interface ChangeOrderUseCase {
  create(
    input: CreateChangeOrderInput,
    actor: EventActor
  ): Promise<ChangeOrderResult>;

  approve(
    input: ApproveChangeOrderInput,
    actor: EventActor
  ): Promise<ChangeOrderResult>;

  reject(
    input: RejectChangeOrderInput,
    actor: EventActor
  ): Promise<ChangeOrderResult>;
}

// ---------- Factory ----------

export function createChangeOrderUseCase(
  deps: ChangeOrderUseCaseDeps
): ChangeOrderUseCase {
  const { eventLog } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async create(input, actor) {
      const fieldError = validateCreate(input);
      if (fieldError) {
        return { ok: false, error: fieldError };
      }

      const now = clock();
      const changeOrder: ChangeOrder = Object.freeze({
        id: input.id,
        workOrderId: input.workOrderId,
        kind: input.kind,
        description: input.description,
        requestedBy: input.requestedBy,
        requestedAt: now,
        status: "pending" as const,
      });

      await appendChangeEvent(
        eventLog,
        changeOrder,
        "work_order.change_order.created",
        actor,
        {
          changeOrderId: changeOrder.id,
          kind: changeOrder.kind,
          description: changeOrder.description,
          requestedBy: changeOrder.requestedBy,
        } satisfies ChangeOrderCreatedPayload
      );

      return { ok: true, changeOrder };
    },

    async approve(input, actor) {
      const guardError = guardDecision(input.changeOrder, input.reviewer);
      if (guardError) {
        return { ok: false, error: guardError };
      }

      const now = clock();
      const changeOrder: ChangeOrder = Object.freeze({
        ...input.changeOrder,
        status: "approved" as const,
        reviewer: input.reviewer,
        decisionAt: now,
      });

      await appendChangeEvent(
        eventLog,
        changeOrder,
        "work_order.change_order.approved",
        actor,
        {
          changeOrderId: changeOrder.id,
          kind: changeOrder.kind,
          reviewer: input.reviewer,
        } satisfies ChangeOrderApprovedPayload
      );

      return { ok: true, changeOrder };
    },

    async reject(input, actor) {
      const guardError = guardDecision(input.changeOrder, input.reviewer);
      if (guardError) {
        return { ok: false, error: guardError };
      }
      if (!input.rejectionReason || input.rejectionReason.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "invalid_command",
            message: "reject: rejectionReason must be a non-empty string",
          },
        };
      }

      const now = clock();
      const changeOrder: ChangeOrder = Object.freeze({
        ...input.changeOrder,
        status: "rejected" as const,
        reviewer: input.reviewer,
        decisionAt: now,
        rejectionReason: input.rejectionReason,
      });

      await appendChangeEvent(
        eventLog,
        changeOrder,
        "work_order.change_order.rejected",
        actor,
        {
          changeOrderId: changeOrder.id,
          kind: changeOrder.kind,
          reviewer: input.reviewer,
          rejectionReason: input.rejectionReason,
        } satisfies ChangeOrderRejectedPayload
      );

      return { ok: true, changeOrder };
    },
  };
}

// ---------- Validation helpers ----------

function validateCreate(input: CreateChangeOrderInput): ChangeError | null {
  if (!input.id || input.id.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "create: id must be a non-empty string",
    };
  }
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "create: workOrderId must be a non-empty string",
    };
  }
  if (!input.description || input.description.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "create: description must be a non-empty string",
    };
  }
  if (!input.requestedBy || input.requestedBy.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "create: requestedBy must be a non-empty string",
    };
  }
  return null;
}

function guardDecision(
  changeOrder: ChangeOrder,
  reviewer: string
): ChangeError | null {
  if (!reviewer || reviewer.trim().length === 0) {
    return {
      code: "invalid_command",
      message: "reviewer must be a non-empty string",
    };
  }
  if (changeOrder.status !== "pending") {
    return {
      code: "already_decided",
      message: `Change order '${changeOrder.id}' is already '${changeOrder.status}' and cannot be re-decided`,
    };
  }
  return null;
}

// ---------- Event emission ----------

async function appendChangeEvent<T>(
  eventLog: EventLog,
  changeOrder: ChangeOrder,
  type: WorkOrderEventType,
  actor: EventActor,
  payload: T
): Promise<void> {
  await eventLog.append<T>({
    workOrderId: changeOrder.workOrderId,
    type,
    actor,
    payload,
  });
}
