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
 * PRIME Engine — assignPriority use case
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.4 (Priority Module).
 *
 * Takes an `AssignPriorityInput` (workOrderId, priorityLevel, createdAt,
 * optional dueDate, routed steps) + an injected clock, and:
 *   1. Computes the priority score breakdown once per work order (base + aging
 *      + due-date urgency). All steps in a WO share the WO's score — priority
 *      is a work-order property, routed onto every step for queue display.
 *   2. Computes the priority color the same way (rush / overdue / <24h → red;
 *      <72h or high → yellow; else green).
 *   3. Fans priority onto each routed step, producing `PrioritizedStep[]`
 *      that promote `workOrderId` into the row. Queues can sort the flat list
 *      without joining back to the WO.
 *   4. Emits exactly one `work_order.priority.assigned` event with a compact
 *      payload (level, score, color, breakdown, stepCount, dueDate). The full
 *      step list travels with the use-case return, not the event payload —
 *      same pattern as Routing / Template Resolver.
 *
 * Phase 1 does NOT:
 * - Emit `work_order.priority.escalated` / `priority.deescalated`
 *   (deferred; supervisor bumps / aging promotions come later).
 * - Consider customer-tier bumps, upstream-delay inputs, or learning-layer
 *   suggested tunings.
 * - Re-score on replay. Score is a point-in-time snapshot; subsequent
 *   scoring runs mint new events.
 *
 * Pure use case — all I/O goes through the injected `EventLog` and `Clock`.
 */

import type { EventActor } from "../../models/events.js";
import type {
  Clock,
  EventLog,
} from "../logging/eventLog.js";
import type {
  AssignPriorityInput,
  PriorityAssignedPayload,
  PrioritizedStep,
} from "./priorityTypes.js";
import {
  calculatePriorityColor,
  calculatePriorityScore,
} from "./priorityScore.js";

// ---------- Public surface ----------

export type AssignPriorityResult = {
  readonly ok: true;
  readonly prioritizedSteps: ReadonlyArray<PrioritizedStep>;
};

export interface AssignPriorityUseCaseDeps {
  readonly eventLog: EventLog;
  /** Injected for deterministic tests. Defaults to wall clock. */
  readonly clock?: Clock;
}

export interface AssignPriorityUseCase {
  execute(
    input: AssignPriorityInput,
    actor: EventActor
  ): Promise<AssignPriorityResult>;
}

// ---------- Factory ----------

export function createAssignPriorityUseCase(
  deps: AssignPriorityUseCaseDeps
): AssignPriorityUseCase {
  const { eventLog } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async execute(input, actor) {
      const now = clock();
      const createdAt = new Date(input.createdAt);
      const dueDate = input.dueDate ? new Date(input.dueDate) : null;

      const breakdown = calculatePriorityScore(
        input.priorityLevel,
        createdAt,
        dueDate,
        now
      );
      const color = calculatePriorityColor(input.priorityLevel, dueDate, now);

      const prioritizedSteps: PrioritizedStep[] = input.routedSteps.map(
        (routed) =>
          Object.freeze({
            tentativeStepId: routed.tentativeStepId,
            workOrderId: input.workOrderId,
            stationId: routed.stationId,
            lineItemId: routed.lineItemId,
            templateId: routed.templateId,
            templateStepId: routed.templateStepId,
            label: routed.label,
            dependsOn: routed.dependsOn,
            optional: routed.optional,
            estimatedDurationMinutes: routed.estimatedDurationMinutes,
            priorityLevel: input.priorityLevel,
            priorityScore: breakdown.total,
            priorityColor: color,
            priorityScoreBreakdown: breakdown,
            dueDate: input.dueDate,
          })
      );

      await eventLog.append<PriorityAssignedPayload>({
        workOrderId: input.workOrderId,
        type: "work_order.priority.assigned",
        actor,
        payload: {
          priorityLevel: input.priorityLevel,
          priorityScore: breakdown.total,
          priorityColor: color,
          scoreBreakdown: breakdown,
          stepCount: prioritizedSteps.length,
          dueDate: input.dueDate,
        },
      });

      return { ok: true, prioritizedSteps };
    },
  };
}
