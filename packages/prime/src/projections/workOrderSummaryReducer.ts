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
 * PRIME Engine — WorkOrderSummary reducer
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7 + §16.
 *
 * A pure fold from the event log into a `WorkOrderSummary`. No I/O, no clock,
 * no ambient state. The reducer is total over the 22 event types Phase 1
 * currently emits and tolerant of the 5 forward-declared ones (see audit in
 * §16) — unknown types pass through as no-ops so the reducer doesn't break
 * when a future module starts emitting them before this file is updated.
 *
 * Contract:
 * - `reduceWorkOrderSummary(null, intake.created)` → bootstrapped summary.
 * - `reduceWorkOrderSummary(null, anything_else)` → null (pre-intake events
 *   ignored; use `foldEvents` for a full-stream fold with error collection).
 * - `reduceWorkOrderSummary(summary, event)` with matching workOrderId →
 *   new frozen summary. Mismatched workOrderId → summary unchanged.
 * - Terminal events are absorbed but subsequent events are also folded in —
 *   we don't pretend the stream ends, we just freeze `terminalState`. A
 *   second terminal event will overwrite the first; the caller is expected
 *   to prevent that via the use case's `already_terminal` guard.
 */

import type {
  WorkOrderEvent,
  WorkOrderEventType,
} from "../models/events";
import type {
  IntakeCreatedPayload,
} from "../core/intake/intakeTypes";
import type { PriorityAssignedPayload } from "../core/priority/priorityTypes";
import type { RoutingAssignedPayload } from "../core/routing/routingTypes";
import type { StepState } from "../core/taskflow/taskFlowTypes";
import type {
  ChangeOrderApprovedPayload,
  ChangeOrderCreatedPayload,
  ChangeOrderRejectedPayload,
} from "../core/change/changeOrderTypes";
import type {
  EtaAtRiskPayload,
  EtaUpdatedPayload,
  MilestoneAdvancedPayload,
} from "../core/tracking/trackingTypes";
import type {
  WorkOrderCancelledPayload,
  WorkOrderCompletedPayload,
} from "../core/terminal/terminalTypes";

import type {
  SummaryReducerError,
  WorkOrderSummary,
  WorkOrderSummaryEta,
  WorkOrderSummaryStepStates,
  WorkOrderSummaryStepStations,
} from "./workOrderSummaryTypes";

// ---------- Public API ----------

/**
 * Fold a single event into a running summary.
 * @param summary - previous summary, or null if no intake.created seen yet
 * @param event   - next event to apply
 * @returns new (frozen) summary, or null if we're still pre-intake
 */
export function reduceWorkOrderSummary(
  summary: WorkOrderSummary | null,
  event: WorkOrderEvent
): WorkOrderSummary | null {
  // Pre-intake: only a `work_order.intake.created` event can bootstrap.
  if (summary === null) {
    if (event.type !== "work_order.intake.created") return null;
    return bootstrapFromIntake(event as WorkOrderEvent<IntakeCreatedPayload>);
  }

  // Guard: foreign work order — leave the summary alone.
  if (event.workOrderId !== summary.workOrderId) return summary;

  const updated = applyEvent(summary, event);
  // Bump the log pointer / updatedAt on every accepted event.
  return freezeSummary({
    ...updated,
    lastEventSequence: event.sequenceNumber,
    updatedAt: event.timestamp,
  });
}

/**
 * Fold a full event stream into a summary, collecting per-event errors.
 * Errors are non-fatal — folding continues from the prior (or null) state.
 */
export function foldEvents(
  events: ReadonlyArray<WorkOrderEvent>
): {
  readonly summary: WorkOrderSummary | null;
  readonly errors: ReadonlyArray<SummaryReducerError>;
} {
  let summary: WorkOrderSummary | null = null;
  const errors: SummaryReducerError[] = [];

  for (const event of events) {
    // Pre-intake ignore is normal; only record it as an error if something
    // non-intake-created shows up BEFORE the intake — callers can treat this
    // as a data-integrity signal when replaying from an unfiltered stream.
    if (summary === null && event.type !== "work_order.intake.created") {
      errors.push({
        code: "pre_intake_event",
        message: `Event '${event.type}' received before intake.created for WO '${event.workOrderId}'`,
        eventId: event.id,
        eventType: event.type,
      });
      continue;
    }
    if (summary !== null && event.workOrderId !== summary.workOrderId) {
      errors.push({
        code: "work_order_mismatch",
        message: `Event workOrderId '${event.workOrderId}' does not match summary '${summary.workOrderId}'`,
        eventId: event.id,
        eventType: event.type,
      });
      continue;
    }
    // Step events MUST carry top-level stepId.
    if (isStepEvent(event.type) && !event.stepId) {
      errors.push({
        code: "invalid_event",
        message: `Step event '${event.type}' missing top-level stepId`,
        eventId: event.id,
        eventType: event.type,
      });
      continue;
    }
    summary = reduceWorkOrderSummary(summary, event);
  }

  return { summary, errors };
}

// ---------- Bootstrap ----------

function bootstrapFromIntake(
  event: WorkOrderEvent<IntakeCreatedPayload>
): WorkOrderSummary {
  const p = event.payload;
  const summary: WorkOrderSummary = {
    workOrderId: event.workOrderId,
    customerId: p.customerId,
    customerName: p.customerName,
    source: p.source,

    intakePriority: p.priority,
    priorityLevel: null,
    priorityScore: null,
    priorityColor: null,

    milestone: "intake",
    milestoneEnteredAt: event.timestamp,
    eta: emptyEta(),

    totalSteps: null,
    stepStates: Object.freeze({}),
    stepStations: Object.freeze({}),
    readyStepCount: 0,
    activeStepCount: 0,
    pausedStepCount: 0,
    blockedStepCount: 0,
    completedStepCount: 0,

    pauseCount: 0,
    reworkCount: 0,
    issueFlagCount: 0,

    openChangeOrderIds: Object.freeze([]),
    approvedChangeOrderCount: 0,
    rejectedChangeOrderCount: 0,

    terminalState: null,
    terminalReachedAt: null,
    terminalReachedBy: null,

    lastEventSequence: event.sequenceNumber,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,

    dueDate: p.dueDate ?? null,
    lineItemCount: p.lineItemCount,
  };
  return freezeSummary(summary);
}

// ---------- Per-event dispatch ----------

function applyEvent(
  summary: WorkOrderSummary,
  event: WorkOrderEvent
): WorkOrderSummary {
  switch (event.type) {
    // Intake
    case "work_order.intake.created":
      // Second intake.created is a no-op — log is expected to be unique.
      return summary;
    case "work_order.intake.validation_failed":
      return summary;

    // Template
    case "work_order.template.resolved":
      return summary; // summary doesn't track templates directly in v1
    case "work_order.template.overridden":
      return summary;

    // Routing
    case "work_order.routing.assigned": {
      const p = event.payload as RoutingAssignedPayload;
      // Batch W — if the payload carries per-step station assignments,
      // fold them into `stepStations`. Older emitters (Phase 1 routing
      // module before the payload extension) don't include `routedSteps`;
      // in that case we leave the map empty and kiosk/master-tablet
      // projections degrade to showing WOs unfiltered by station.
      const nextStations: WorkOrderSummaryStepStations =
        p.routedSteps && p.routedSteps.length > 0
          ? Object.freeze(
              p.routedSteps.reduce<Record<string, string>>((acc, rs) => {
                acc[rs.stepId] = rs.stationId;
                return acc;
              }, { ...summary.stepStations }),
            )
          : summary.stepStations;
      return {
        ...summary,
        totalSteps: p.stepCount,
        stepStations: nextStations,
      };
    }
    case "work_order.routing.reroute_suggested":
      return summary;
    case "work_order.routing.batched_with":
      return summary;

    // Priority
    case "work_order.priority.assigned": {
      const p = event.payload as PriorityAssignedPayload;
      return {
        ...summary,
        priorityLevel: p.priorityLevel,
        priorityScore: p.priorityScore,
        priorityColor: p.priorityColor,
      };
    }
    case "work_order.priority.escalated":
    case "work_order.priority.deescalated":
      // Future emitters will set `toLevel`; we'd read that here. For now,
      // these are forward-declared and won't appear in Phase 1 streams.
      return summary;

    // Step lifecycle
    case "step.ready":
      return setStepState(summary, event.stepId!, "ready");
    case "step.started":
      return setStepState(summary, event.stepId!, "in_progress");
    case "step.paused":
      return {
        ...setStepState(summary, event.stepId!, "paused"),
        pauseCount: summary.pauseCount + 1,
      };
    case "step.resumed":
      return setStepState(summary, event.stepId!, "in_progress");
    case "step.completed":
      return setStepState(summary, event.stepId!, "completed");
    case "step.blocked":
      return setStepState(summary, event.stepId!, "blocked");
    case "step.issue_flagged":
      return { ...summary, issueFlagCount: summary.issueFlagCount + 1 };
    case "step.rework.logged":
      return { ...summary, reworkCount: summary.reworkCount + 1 };

    // Change orders / reroute
    case "work_order.change_order.created": {
      const p = event.payload as ChangeOrderCreatedPayload;
      return {
        ...summary,
        openChangeOrderIds: Object.freeze([
          ...summary.openChangeOrderIds,
          p.changeOrderId,
        ]),
      };
    }
    case "work_order.change_order.approved": {
      const p = event.payload as ChangeOrderApprovedPayload;
      return {
        ...summary,
        openChangeOrderIds: freezeRemove(
          summary.openChangeOrderIds,
          p.changeOrderId
        ),
        approvedChangeOrderCount: summary.approvedChangeOrderCount + 1,
      };
    }
    case "work_order.change_order.rejected": {
      const p = event.payload as ChangeOrderRejectedPayload;
      return {
        ...summary,
        openChangeOrderIds: freezeRemove(
          summary.openChangeOrderIds,
          p.changeOrderId
        ),
        rejectedChangeOrderCount: summary.rejectedChangeOrderCount + 1,
      };
    }
    case "work_order.reroute.executed":
      // Station swap doesn't change summary aggregates — summary doesn't
      // track per-step station assignments. Ignore.
      return summary;

    // Tracking
    case "work_order.milestone.advanced": {
      const p = event.payload as MilestoneAdvancedPayload;
      return {
        ...summary,
        milestone: p.toMilestone,
        milestoneEnteredAt: event.timestamp,
      };
    }
    case "work_order.eta.updated": {
      const p = event.payload as EtaUpdatedPayload;
      const atRisk = p.confidence === "at_risk";
      return {
        ...summary,
        eta: Object.freeze({
          estimatedCompletionAt: p.newEtaAt ?? null,
          confidence: p.confidence,
          atRisk,
          // Raising confidence out of at_risk clears the reason list.
          riskReasons: atRisk ? summary.eta.riskReasons : Object.freeze([]),
        }),
      };
    }
    case "work_order.eta.at_risk": {
      const p = event.payload as EtaAtRiskPayload;
      const already = summary.eta.riskReasons.includes(p.riskReason);
      return {
        ...summary,
        eta: Object.freeze({
          ...summary.eta,
          atRisk: true,
          riskReasons: already
            ? summary.eta.riskReasons
            : Object.freeze([...summary.eta.riskReasons, p.riskReason]),
        }),
      };
    }

    // Terminal
    case "work_order.completed": {
      const p = event.payload as WorkOrderCompletedPayload;
      return {
        ...summary,
        terminalState: "completed",
        terminalReachedAt: event.timestamp,
        terminalReachedBy: p.completedBy,
      };
    }
    case "work_order.cancelled": {
      const p = event.payload as WorkOrderCancelledPayload;
      return {
        ...summary,
        terminalState: "cancelled",
        terminalReachedAt: event.timestamp,
        terminalReachedBy: p.cancelledBy,
      };
    }

    // Reroute approval (phase-1 upgrade §2) — not reflected in the
    // work-order summary; tracked by a dedicated approval projection.
    case "work_order.reroute.approval_requested":
    case "work_order.reroute.approval_approved":
    case "work_order.reroute.approval_rejected":
      return summary;

    // Change-order consequence cascade (phase-1 upgrade §3) — tracked by a
    // dedicated cascade projection; the summary stays untouched so the
    // change.applied envelope (and its children) don't interfere with the
    // work-order's own status / terminal-state machine.
    case "work_order.change.applied":
    case "work_order.routing.recomputed":
    case "work_order.tasks.regenerated":
    case "work_order.eta.recalculated":
      return summary;

    default: {
      // Unknown event type — no-op so future spec growth doesn't break us.
      // Exhaustiveness check keeps this honest against the union:
      const _exhaustive: never = event.type;
      void _exhaustive;
      return summary;
    }
  }
}

// ---------- Helpers ----------

function emptyEta(): WorkOrderSummaryEta {
  return Object.freeze({
    estimatedCompletionAt: null,
    confidence: null,
    atRisk: false,
    riskReasons: Object.freeze([]),
  });
}

function setStepState(
  summary: WorkOrderSummary,
  stepId: string,
  state: StepState
): WorkOrderSummary {
  const prev = summary.stepStates[stepId];
  if (prev === state) return summary; // idempotent: same-state writes are no-ops

  const nextStates: WorkOrderSummaryStepStates = Object.freeze({
    ...summary.stepStates,
    [stepId]: state,
  });

  return { ...summary, stepStates: nextStates, ...recountStates(nextStates) };
}

function recountStates(states: WorkOrderSummaryStepStates): {
  readyStepCount: number;
  activeStepCount: number;
  pausedStepCount: number;
  blockedStepCount: number;
  completedStepCount: number;
} {
  let ready = 0;
  let active = 0;
  let paused = 0;
  let blocked = 0;
  let completed = 0;
  for (const s of Object.values(states)) {
    if (s === "ready") ready++;
    else if (s === "in_progress") active++;
    else if (s === "paused") paused++;
    else if (s === "blocked") blocked++;
    else if (s === "completed") completed++;
  }
  return {
    readyStepCount: ready,
    activeStepCount: active,
    pausedStepCount: paused,
    blockedStepCount: blocked,
    completedStepCount: completed,
  };
}

function freezeRemove(
  list: ReadonlyArray<string>,
  id: string
): ReadonlyArray<string> {
  const idx = list.indexOf(id);
  if (idx === -1) return list;
  const next = list.slice();
  next.splice(idx, 1);
  return Object.freeze(next);
}

function freezeSummary(summary: WorkOrderSummary): WorkOrderSummary {
  return Object.freeze(summary);
}

const STEP_EVENT_TYPES: ReadonlySet<WorkOrderEventType> = new Set([
  "step.ready",
  "step.started",
  "step.paused",
  "step.resumed",
  "step.completed",
  "step.blocked",
  "step.issue_flagged",
  "step.rework.logged",
]);

function isStepEvent(t: WorkOrderEventType): boolean {
  return STEP_EVENT_TYPES.has(t);
}
