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
 * PRIME Engine — WorkOrderSummary projection types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.7 (Tracking / Projection) + §16 (event catalog).
 *
 * A `WorkOrderSummary` is a flat, Object-friendly read-model of a single work
 * order, built by folding its event stream. It is what every downstream UI
 * (supervisor board, customer portal, operator kiosk) should read from —
 * callers never need to scan the raw event log for rendering.
 *
 * Contract:
 * - Source of truth is the event log. A summary is always reconstructible
 *   from the stream via `foldEvents([...events])`.
 * - The reducer is PURE: `(summary | null, event) => summary | null`.
 * - Returned summaries are deeply readonly / frozen.
 * - A null summary means "no intake.created yet" — we ignore pre-intake events.
 * - On workOrderId mismatch the reducer returns the summary unchanged. It
 *   does NOT throw — the caller is responsible for filtering, and the
 *   projection factory does this at the boundary.
 *
 * Fields we do NOT track here (deliberate Phase 2.1 scope cut):
 * - Per-step timings (startedAt / completedAt / accumulated minutes).
 *   The reducer tracks step STATE only; time analytics will live in a
 *   separate learning-inputs projection.
 * - Station-level load. Routing emits a `stationLoadSummary` in its payload
 *   but that's a shop-wide view, not a per-WO view.
 * - Cost actuals. Belongs to Cost IQ, which subscribes to PRIME's event log
 *   and maintains its own projection — never here.
 */

import type {
  CustomerId,
  WorkOrderId,
  WorkOrderStepId,
} from "../models/events.js";
import type { IntakePriority } from "../core/intake/intakeTypes.js";
import type {
  PriorityColor,
  PriorityLevel,
  PriorityScore,
} from "../core/priority/priorityTypes.js";
import type { StepState } from "../core/taskflow/taskFlowTypes.js";
import type { ChangeOrderId } from "../core/change/changeOrderTypes.js";
import type { StationId } from "../core/routing/routingTypes.js";
import type {
  EtaConfidence,
  EtaRiskReason,
  Milestone,
} from "../core/tracking/trackingTypes.js";
import type { WorkOrderTerminalState } from "../core/terminal/terminalTypes.js";

// ---------- ETA block ----------

/**
 * Flat ETA view for a summary. `estimatedCompletionAt` is nullable because the
 * ETA can't always be computed (e.g. no remaining estimates, or the WO hasn't
 * been routed yet). Risk reasons accumulate across `eta.at_risk` events so
 * consumers can render the full "what's wrong right now" list; they are
 * cleared when an `eta.updated` event raises confidence above `at_risk`.
 */
export interface WorkOrderSummaryEta {
  readonly estimatedCompletionAt: string | null;
  readonly confidence: EtaConfidence | null;
  readonly atRisk: boolean;
  readonly riskReasons: ReadonlyArray<EtaRiskReason>;
}

// ---------- Summary ----------

/**
 * Per-step state map keyed by `WorkOrderStepId`. Source-of-truth for which
 * steps the reducer has seen at all, and what state they're currently in.
 * Derived counts below are maintained in lockstep so consumers don't have
 * to iterate the map for simple badges.
 */
export type WorkOrderSummaryStepStates = Readonly<
  Record<WorkOrderStepId, StepState>
>;

/**
 * Per-step station assignment, populated from `routing.assigned` events
 * that carry `routedSteps` (Batch W extension). Consumers that need to
 * answer "which WO steps are currently at station X?" read this. Old
 * events without the `routedSteps` payload leave this empty — callers
 * should treat missing entries as "routing didn't record a station" and
 * fall through to machine-sequence or station-focus data.
 */
export type WorkOrderSummaryStepStations = Readonly<
  Record<WorkOrderStepId, StationId>
>;

export interface WorkOrderSummary {
  // Identity
  readonly workOrderId: WorkOrderId;
  readonly customerId: CustomerId;
  readonly customerName: string;
  /** From the original intake.created payload. Mirrors `IntakeInput.source`. */
  readonly source: string;

  // Intake-assigned priority + routed/priority-assigned snapshot.
  // `intakePriority` stays the originally-requested level; `priorityLevel`/
  // `priorityScore`/`priorityColor` reflect the most recent assigned/escalated
  // priority decision.
  readonly intakePriority: IntakePriority;
  readonly priorityLevel: PriorityLevel | null;
  readonly priorityScore: PriorityScore | null;
  readonly priorityColor: PriorityColor | null;

  // Milestone + ETA (tracking projection)
  readonly milestone: Milestone;
  /** ISO-8601. Set on intake.created; updated on each milestone.advanced. */
  readonly milestoneEnteredAt: string;
  readonly eta: WorkOrderSummaryEta;

  // Step aggregates
  /** Authoritative count from `routing.assigned` — null until routed. */
  readonly totalSteps: number | null;
  readonly stepStates: WorkOrderSummaryStepStates;
  /**
   * Per-step station map. Populated from `routing.assigned` when the
   * payload carries `routedSteps` (Batch W). Used by StationKiosk and
   * MasterTablet projections to filter jobs by the station owning the
   * currently-active step. Empty until routing fires with the extended
   * payload; callers should degrade gracefully (show the WO unfiltered,
   * or defer to machine-sequence fallback data) when a station lookup
   * comes up empty.
   */
  readonly stepStations: WorkOrderSummaryStepStations;
  readonly readyStepCount: number;
  readonly activeStepCount: number;
  readonly pausedStepCount: number;
  readonly blockedStepCount: number;
  readonly completedStepCount: number;

  // Annotations (cumulative across all steps)
  readonly pauseCount: number;
  readonly reworkCount: number;
  readonly issueFlagCount: number;

  // Change orders
  readonly openChangeOrderIds: ReadonlyArray<ChangeOrderId>;
  readonly approvedChangeOrderCount: number;
  readonly rejectedChangeOrderCount: number;

  // Terminal
  readonly terminalState: WorkOrderTerminalState | null;
  /** ISO-8601, set once when a terminal event is folded in. */
  readonly terminalReachedAt: string | null;
  readonly terminalReachedBy: string | null;

  // Event-log pointer
  /** `sequenceNumber` of the most recent event folded into this summary. */
  readonly lastEventSequence: number;
  /** ISO-8601 timestamp of the intake.created event that bootstrapped this summary. */
  readonly createdAt: string;
  /** ISO-8601 timestamp of the most recent event folded in. */
  readonly updatedAt: string;

  // Intake metadata (preserved for convenience)
  readonly dueDate: string | null;
  readonly lineItemCount: number;
}

// ---------- Reducer errors (returned, not thrown) ----------

export type SummaryReducerErrorCode =
  /** First-ever event for this work order was not `work_order.intake.created`. */
  | "pre_intake_event"
  /** Event's `workOrderId` does not match the summary's. */
  | "work_order_mismatch"
  /** Event's payload is missing a required field (e.g. step event without `stepId`). */
  | "invalid_event";

export interface SummaryReducerError {
  readonly code: SummaryReducerErrorCode;
  readonly message: string;
  readonly eventId: string;
  readonly eventType: string;
}
