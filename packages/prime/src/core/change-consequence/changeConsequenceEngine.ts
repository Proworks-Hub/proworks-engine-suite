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
 * PRIME Engine — Change-order consequence engine.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §3.
 *
 * Cascades an approved change order into downstream operational state. Runs
 * these pure effects in order, each of which decides whether to emit:
 *
 *   1. Routing  — if the change touches machines/stations/workflow template,
 *                 emit `work_order.routing.recomputed`.
 *   2. Tasks    — if routing was invalidated or the caller passed explicit
 *                 step ids, emit `work_order.tasks.regenerated`.
 *   3. ETA      — always recompute; emit `work_order.eta.recalculated` only
 *                 when |Δ| exceeds the configured epsilon.
 *   4. Priority — inline: if the change kind is `expedite` (or the hints ask
 *                 for escalation), emit `work_order.priority.escalated`.
 *
 * Finally the engine emits a single `work_order.change.applied` envelope that
 * lists every downstream event id it fired, so projections can correlate
 * cause (this change order) with effect (cascade fan-out).
 *
 * This module is a **subscriber**. It does not own change-order lifecycle —
 * that stays in `core/change/changeOrderUseCase.ts`. The caller invokes this
 * engine after its own `approve()` succeeds.
 *
 * Stateless: no hidden state, no persistence. Events are the persistent
 * artifact; projections rebuild from them.
 */

import type {
  Clock,
  EventLog,
  IdGenerator,
} from "../logging/eventLog";
import type {
  EventActor,
  WorkOrderEvent,
} from "../../models/events";
import type { ChangeOrder } from "../change/changeOrderTypes";
import {
  evaluateRoutingEffect,
  type ChangeConsequenceHints,
  type RoutingRecomputedPayload,
} from "./effects/routingEffect";
import {
  evaluateTasksEffect,
  type TasksRegeneratedPayload,
} from "./effects/tasksEffect";
import {
  evaluateEtaEffect,
  type EtaRecalculatedPayload,
} from "./effects/etaEffect";

// ---------- Public payloads ----------

export interface PriorityEscalatedByChangePayload {
  readonly changeOrderId: string;
  /** "expedite" kind, or "hint" when the caller forced it via hints. */
  readonly reason: "expedite_kind" | "hint";
}

export interface ChangeAppliedPayload {
  readonly changeOrderId: string;
  /** Event ids emitted by this cascade, in emission order. */
  readonly downstreamEventIds: ReadonlyArray<string>;
  /** Which effects actually fired (parallel summary to downstreamEventIds). */
  readonly effectsFired: ReadonlyArray<ChangeConsequenceEffectKind>;
}

export type ChangeConsequenceEffectKind =
  | "routing"
  | "tasks"
  | "eta"
  | "priority";

// ---------- Engine deps + interface ----------

export interface ChangeConsequenceHintsExt extends ChangeConsequenceHints {
  /**
   * When true, emit a priority escalation even if the change kind isn't
   * `expedite`. Use when the caller has separately determined that urgency
   * changed (e.g. customer re-asserted a deadline).
   */
  readonly forcePriorityEscalate?: boolean;
}

export interface ApplyChangeOrderEffectsInput {
  readonly changeOrder: ChangeOrder;
  readonly actor: EventActor;
  readonly hints?: ChangeConsequenceHintsExt;
}

export type ChangeConsequenceErrorCode =
  | "not_approved"
  | "work_order_mismatch"
  | "invalid_command";

export interface ChangeConsequenceError {
  readonly code: ChangeConsequenceErrorCode;
  readonly message: string;
}

export interface ChangeConsequenceCascade {
  readonly routingEvent?: WorkOrderEvent<RoutingRecomputedPayload>;
  readonly tasksEvent?: WorkOrderEvent<TasksRegeneratedPayload>;
  readonly etaEvent?: WorkOrderEvent<EtaRecalculatedPayload>;
  readonly priorityEvent?: WorkOrderEvent<PriorityEscalatedByChangePayload>;
  readonly appliedEvent: WorkOrderEvent<ChangeAppliedPayload>;
}

export type ApplyChangeOrderEffectsResult =
  | { readonly ok: true; readonly cascade: ChangeConsequenceCascade }
  | { readonly ok: false; readonly error: ChangeConsequenceError };

export interface ChangeConsequenceEngineDeps {
  readonly eventLog: EventLog;
  readonly idGenerator?: IdGenerator;
  readonly clock?: Clock;
}

export interface ChangeConsequenceEngine {
  applyChangeOrderEffects(
    input: ApplyChangeOrderEffectsInput
  ): Promise<ApplyChangeOrderEffectsResult>;
}

// ---------- Factory ----------

export function createChangeConsequenceEngine(
  deps: ChangeConsequenceEngineDeps
): ChangeConsequenceEngine {
  const { eventLog } = deps;
  // The engine currently derives all timestamps/ids from the event log itself
  // (log.append() assigns them). The optional idGenerator/clock deps are kept
  // for forward-compat with callers that want to pre-stamp effect events.
  void deps.idGenerator;
  void deps.clock;

  return {
    async applyChangeOrderEffects(input) {
      const { changeOrder, actor, hints } = input;

      if (changeOrder.status !== "approved") {
        return {
          ok: false,
          error: {
            code: "not_approved",
            message: `applyChangeOrderEffects: change order '${changeOrder.id}' is in status '${changeOrder.status}'; only 'approved' is valid`,
          },
        };
      }
      if (!changeOrder.workOrderId || changeOrder.workOrderId.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "invalid_command",
            message: "applyChangeOrderEffects: changeOrder.workOrderId is required",
          },
        };
      }

      const workOrderId = changeOrder.workOrderId;
      const downstreamEventIds: string[] = [];
      const effectsFired: ChangeConsequenceEffectKind[] = [];

      // 1) Routing
      const routingDecision = evaluateRoutingEffect(changeOrder, hints);
      let routingEvent: WorkOrderEvent<RoutingRecomputedPayload> | undefined;
      if (routingDecision.applies) {
        routingEvent = await eventLog.append<RoutingRecomputedPayload>({
          workOrderId,
          type: "work_order.routing.recomputed",
          actor,
          payload: routingDecision.payload,
        });
        downstreamEventIds.push(routingEvent.id);
        effectsFired.push("routing");
      }

      // 2) Tasks
      const tasksDecision = evaluateTasksEffect(changeOrder, routingDecision, hints);
      let tasksEvent: WorkOrderEvent<TasksRegeneratedPayload> | undefined;
      if (tasksDecision.applies) {
        tasksEvent = await eventLog.append<TasksRegeneratedPayload>({
          workOrderId,
          type: "work_order.tasks.regenerated",
          actor,
          payload: tasksDecision.payload,
        });
        downstreamEventIds.push(tasksEvent.id);
        effectsFired.push("tasks");
      }

      // 3) ETA
      const etaDecision = evaluateEtaEffect(changeOrder, hints);
      let etaEvent: WorkOrderEvent<EtaRecalculatedPayload> | undefined;
      if (etaDecision.applies) {
        etaEvent = await eventLog.append<EtaRecalculatedPayload>({
          workOrderId,
          type: "work_order.eta.recalculated",
          actor,
          payload: etaDecision.payload,
        });
        downstreamEventIds.push(etaEvent.id);
        effectsFired.push("eta");
      }

      // 4) Priority (inline — simple enough not to warrant its own file).
      let priorityEvent: WorkOrderEvent<PriorityEscalatedByChangePayload> | undefined;
      const shouldEscalate =
        changeOrder.kind === "expedite" || hints?.forcePriorityEscalate === true;
      if (shouldEscalate) {
        priorityEvent = await eventLog.append<PriorityEscalatedByChangePayload>({
          workOrderId,
          type: "work_order.priority.escalated",
          actor,
          payload: {
            changeOrderId: changeOrder.id,
            reason:
              changeOrder.kind === "expedite" ? "expedite_kind" : "hint",
          },
        });
        downstreamEventIds.push(priorityEvent.id);
        effectsFired.push("priority");
      }

      // 5) Final envelope — always emitted so the change-approved / change-applied
      //    pair is queryable even when no downstream effects fired.
      const appliedEvent = await eventLog.append<ChangeAppliedPayload>({
        workOrderId,
        type: "work_order.change.applied",
        actor,
        payload: {
          changeOrderId: changeOrder.id,
          downstreamEventIds: Object.freeze([...downstreamEventIds]),
          effectsFired: Object.freeze([...effectsFired]),
        },
      });

      const cascade: ChangeConsequenceCascade = {
        ...(routingEvent ? { routingEvent } : {}),
        ...(tasksEvent ? { tasksEvent } : {}),
        ...(etaEvent ? { etaEvent } : {}),
        ...(priorityEvent ? { priorityEvent } : {}),
        appliedEvent,
      };

      return { ok: true, cascade };
    },
  };
}
