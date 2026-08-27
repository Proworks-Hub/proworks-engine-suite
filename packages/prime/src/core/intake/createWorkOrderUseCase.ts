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
 * PRIME Engine — createWorkOrder use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.1 (Intake Module).
 *
 * End-to-end intake: takes an `IntakeInput`, validates it, and either:
 *   (a) emits `work_order.intake.created` and returns a `PrimeWorkOrderDraft`, or
 *   (b) emits `work_order.intake.validation_failed` and returns the errors.
 *
 * The event log is the source of truth — the returned draft is a
 * convenience projection the caller can hand straight to the next module
 * (Template Resolver, §3.2) without having to rebuild from the log.
 *
 * Design notes:
 * - A candidate `workOrderId` is generated BEFORE validation and is used
 *   as the `workOrderId` on the validation_failed event as well. This keeps
 *   every intake attempt traceable by id (dashboard can show rejected
 *   attempts alongside accepted ones) and satisfies the event log's
 *   invariant that every event has a non-empty workOrderId.
 * - No storage here. PRIME's append-only event log IS the state. A future
 *   projection layer will materialize drafts into a read model.
 */

import type {
  EventActor,
  WorkOrderId,
} from "../../models/events.js";
import type {
  Clock,
  EventLog,
  IdGenerator,
} from "../logging/eventLog.js";
import { validateIntakeInput } from "./intakeValidator.js";
import type {
  IntakeCreatedPayload,
  IntakeInput,
  IntakeValidationError,
  IntakeValidationFailedPayload,
  PrimeWorkOrderDraft,
} from "./intakeTypes.js";
import { DEFAULT_INTAKE_PRIORITY } from "./intakeTypes.js";

// ---------- Public surface ----------

export type CreateWorkOrderResult =
  | { readonly ok: true; readonly draft: PrimeWorkOrderDraft }
  | {
      readonly ok: false;
      readonly attemptedWorkOrderId: WorkOrderId;
      readonly errors: ReadonlyArray<IntakeValidationError>;
    };

export interface CreateWorkOrderUseCaseDeps {
  readonly eventLog: EventLog;
  /**
   * Generates the WorkOrder id. Optional — defaults to crypto.randomUUID
   * with a prefix. Inject in tests for deterministic ids.
   */
  readonly workOrderIdGenerator?: IdGenerator;
  /** Inject in tests for deterministic timestamps. Defaults to `() => new Date()`. */
  readonly clock?: Clock;
}

export interface CreateWorkOrderUseCase {
  execute(
    input: IntakeInput,
    actor: EventActor
  ): Promise<CreateWorkOrderResult>;
}

// ---------- Factory ----------

export function createCreateWorkOrderUseCase(
  deps: CreateWorkOrderUseCaseDeps
): CreateWorkOrderUseCase {
  const { eventLog } = deps;
  const generateWorkOrderId: IdGenerator =
    deps.workOrderIdGenerator ?? defaultWorkOrderIdGenerator;
  const now: Clock = deps.clock ?? (() => new Date());

  return {
    async execute(input, actor) {
      const nowDate = now();
      const candidateWorkOrderId: WorkOrderId = generateWorkOrderId();
      const validation = validateIntakeInput(input, nowDate);

      if (!validation.valid) {
        await eventLog.append<IntakeValidationFailedPayload>({
          workOrderId: candidateWorkOrderId,
          type: "work_order.intake.validation_failed",
          actor,
          payload: {
            source: input.source,
            errors: validation.errors,
            attemptedCustomerId:
              typeof input.customerId === "string" && input.customerId.length > 0
                ? input.customerId
                : undefined,
          },
        });
        return {
          ok: false,
          attemptedWorkOrderId: candidateWorkOrderId,
          errors: validation.errors,
        };
      }

      const priority = input.priority ?? DEFAULT_INTAKE_PRIORITY;
      const draft: PrimeWorkOrderDraft = Object.freeze({
        workOrderId: candidateWorkOrderId,
        status: "draft",
        customerId: input.customerId,
        customerName: input.customerName,
        source: input.source,
        priority,
        lineItems: input.lineItems,
        dueDate: input.dueDate,
        customerNotes: input.customerNotes,
        shopNotes: input.shopNotes,
        attachments: input.attachments ?? [],
        discounts: input.discounts ?? [],
        surcharges: input.surcharges ?? [],
        createdAt: nowDate.toISOString(),
      });

      await eventLog.append<IntakeCreatedPayload>({
        workOrderId: candidateWorkOrderId,
        type: "work_order.intake.created",
        actor,
        payload: {
          source: input.source,
          customerId: input.customerId,
          customerName: input.customerName,
          priority,
          lineItemCount: input.lineItems.length,
          dueDate: input.dueDate,
        },
      });

      return { ok: true, draft };
    },
  };
}

// ---------- Defaults ----------

function defaultWorkOrderIdGenerator(): string {
  // `wo_` prefix makes ids self-describing in logs and UIs.
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `wo_${globalThis.crypto.randomUUID()}`;
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `wo_${time}_${rand}`;
}
