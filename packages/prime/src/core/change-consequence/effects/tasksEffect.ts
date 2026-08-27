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
 * Change-order consequence — Tasks effect.
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §3.2 step 2.
 *
 * Runs after the routingEffect. If routing was invalidated, existing step
 * payloads are stale and should be regenerated. If the caller supplied
 * `invalidatedStepIds` on the hints, they are carried through on the event
 * so downstream consumers (task-flow projection, learning layer) know the
 * exact scope. Otherwise the event is emitted without a list and consumers
 * treat the whole work order as dirty.
 *
 * Pure function — emits no events itself; the engine composes and appends.
 */

import type { ChangeOrder } from "../../change/changeOrderTypes";
import type { WorkOrderStepId } from "../../../models/events";
import type {
  ChangeConsequenceHints,
  RoutingEffectDecision,
} from "./routingEffect";

export interface TasksRegeneratedPayload {
  readonly changeOrderId: string;
  /** When the caller supplied hints.invalidatedStepIds, they are echoed here. */
  readonly invalidatedStepIds?: ReadonlyArray<WorkOrderStepId>;
  /**
   * Why regeneration is needed:
   *   - "routing_invalidated"    — routingEffect fired, so all downstream steps are stale.
   *   - "explicit_step_list"     — caller asked for regeneration of specific steps.
   *   - "forced"                 — hints.forceTasksRegenerate was true.
   */
  readonly reason: "routing_invalidated" | "explicit_step_list" | "forced";
}

export type TasksEffectDecision =
  | { readonly applies: false }
  | { readonly applies: true; readonly payload: TasksRegeneratedPayload };

export function evaluateTasksEffect(
  changeOrder: ChangeOrder,
  routingDecision: RoutingEffectDecision,
  hints?: ChangeConsequenceHints
): TasksEffectDecision {
  if (hints?.forceTasksRegenerate === true) {
    return {
      applies: true,
      payload: {
        changeOrderId: changeOrder.id,
        reason: "forced",
        ...(hints.invalidatedStepIds
          ? { invalidatedStepIds: hints.invalidatedStepIds }
          : {}),
      },
    };
  }

  if (routingDecision.applies) {
    return {
      applies: true,
      payload: {
        changeOrderId: changeOrder.id,
        reason: "routing_invalidated",
        ...(hints?.invalidatedStepIds
          ? { invalidatedStepIds: hints.invalidatedStepIds }
          : {}),
      },
    };
  }

  if (hints?.invalidatedStepIds && hints.invalidatedStepIds.length > 0) {
    return {
      applies: true,
      payload: {
        changeOrderId: changeOrder.id,
        reason: "explicit_step_list",
        invalidatedStepIds: hints.invalidatedStepIds,
      },
    };
  }

  return { applies: false };
}
