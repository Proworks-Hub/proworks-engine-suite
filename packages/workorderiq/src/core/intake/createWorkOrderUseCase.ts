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
 * PRIME Engine — createWorkOrder use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.1 (Intake Module).
 *
 * End-to-end intake: takes an `IntakeInput`, validates it, and either:
 *   (a) emits `work_order.intake.created` and returns a `WorkOrderDraft`, or
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
  WorkOrderDraft,
} from "./intakeTypes.js";
import { DEFAULT_INTAKE_PRIORITY } from "./intakeTypes.js";
import {
  conflictFor,
  fingerprintIntake,
  IDEMPOTENCY_CONFLICT,
  type IdempotencyClaim,
  type IdempotencyConflict,
  type IdempotencyStore,
} from "./idempotency.js";

// ---------- Public surface ----------

export type CreateWorkOrderResult =
  | {
      readonly ok: true;
      readonly draft: WorkOrderDraft;
      /**
       * True when this call created nothing.
       *
       * The key was already claimed by an identical payload, so the original
       * work order is returned. A caller that needs to know whether it created
       * or resolved can check; one that does not can ignore it, because the
       * draft is the same either way — which is the guarantee.
       */
      readonly replayed?: boolean;
    }
  | {
      readonly ok: false;
      readonly attemptedWorkOrderId: WorkOrderId;
      readonly errors: ReadonlyArray<IntakeValidationError>;
    }
  | {
      /**
       * The same key with a materially different payload.
       *
       * Not a validation error — the input is well-formed. It is a conflict
       * with a request that already happened, reported separately so a caller
       * can tell "you sent bad data" from "you reused a key".
       */
      readonly ok: false;
      readonly conflict: IdempotencyConflict;
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
  /**
   * Where idempotency claims live. Optional, so no existing caller changes.
   *
   * Absent means no guarantee is available — and `execute` REFUSES a claim
   * rather than ignoring it, because a caller that passed a key and silently
   * got no protection is worse off than one that got an error.
   */
  readonly idempotencyStore?: IdempotencyStore;
}

export interface CreateWorkOrderUseCase {
  /**
   * Creates a work order.
   *
   * `idempotency` is optional and additive: no existing call site changes.
   * Supplied, repeating the call with the same key and payload resolves to one
   * canonical work order rather than creating a second.
   */
  execute(
    input: IntakeInput,
    actor: EventActor,
    idempotency?: IdempotencyClaim
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

  // ── Concurrency ────────────────────────────────────────────────────────────
  //
  // Two concurrent creates with one key must not both create. The store's
  // `claim` is atomic, which handles the durable half — but the loser still has
  // to WAIT for the winner and return its draft, rather than reading a claim
  // whose work order has not been written yet.
  //
  // So an in-flight map joins concurrent callers onto the winner's promise.
  // Per-process; a multi-process host relies on the store's atomicity, where
  // the loser reads the winner's committed claim instead. Both paths end at one
  // work order, and neither double-reserves.
  const inFlight = new Map<string, Promise<CreateWorkOrderResult>>();

  const buildDraft = (
    input: IntakeInput,
    workOrderId: WorkOrderId,
    createdAt: string
  ): WorkOrderDraft =>
    Object.freeze({
      workOrderId,
      status: "draft" as const,
      customerId: input.customerId,
      customerName: input.customerName,
      source: input.source,
      priority: input.priority ?? DEFAULT_INTAKE_PRIORITY,
      lineItems: input.lineItems,
      dueDate: input.dueDate,
      customerNotes: input.customerNotes,
      shopNotes: input.shopNotes,
      attachments: input.attachments ?? [],
      discounts: input.discounts ?? [],
      surcharges: input.surcharges ?? [],
      createdAt,
    });

  /** The original path, unchanged in behaviour. */
  const createWithId = async (
    input: IntakeInput,
    actor: EventActor,
    candidateWorkOrderId: WorkOrderId
  ): Promise<CreateWorkOrderResult> => {
    const nowDate = now();
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
    const draft = buildDraft(input, candidateWorkOrderId, nowDate.toISOString());

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
  };

  /** The idempotent path: validate, claim, then create or resolve. */
  const executeIdempotent = async (
    input: IntakeInput,
    actor: EventActor,
    idempotency: IdempotencyClaim,
    store: IdempotencyStore
  ): Promise<CreateWorkOrderResult> => {
    // Validate BEFORE claiming. A rejected payload must not burn the key —
    // otherwise a caller who fixed their data and retried with the same key
    // would conflict against a work order that was never created.
    const validation = validateIntakeInput(input, now());
    if (!validation.valid) {
      return createWithId(input, actor, generateWorkOrderId());
    }

    const fingerprint = fingerprintIntake(input);
    const candidateWorkOrderId: WorkOrderId = generateWorkOrderId();

    const claim = await store.claim({
      organizationId: idempotency.organizationId,
      key: idempotency.key,
      workOrderId: candidateWorkOrderId,
      fingerprint,
      claimedAt: now().toISOString(),
    });

    if (!claim.claimed) {
      const existing = claim.existing;
      if (existing.fingerprint !== fingerprint) {
        return { ok: false, conflict: conflictFor(idempotency, existing) };
      }
      // Same key, same payload: resolve to the canonical work order. Rebuilt
      // from the input rather than stored, so this port holds identity and not
      // a second copy of the work order — a source of truth it has no business
      // owning.
      return {
        ok: true,
        draft: buildDraft(input, existing.workOrderId, existing.claimedAt),
        replayed: true,
      };
    }

    return createWithId(input, actor, candidateWorkOrderId);
  };

  return {
    async execute(input, actor, idempotency) {
      if (!idempotency) {
        return createWithId(input, actor, generateWorkOrderId());
      }

      if (!deps.idempotencyStore) {
        return {
          ok: false,
          conflict: {
            code: IDEMPOTENCY_CONFLICT,
            key: idempotency.key,
            organizationId: idempotency.organizationId,
            existingWorkOrderId: "" as WorkOrderId,
            message:
              "An idempotency key was supplied but no idempotencyStore is configured. Refusing rather than " +
              "proceeding unprotected: a caller that passed a key and silently got no guarantee is worse off " +
              "than one that got an error.",
          },
        };
      }

      const scoped = `${idempotency.organizationId}::${idempotency.key}`;
      const joined = inFlight.get(scoped);
      if (joined) return joined;

      const run = executeIdempotent(input, actor, idempotency, deps.idempotencyStore);
      inFlight.set(scoped, run);
      try {
        return await run;
      } finally {
        inFlight.delete(scoped);
      }
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
