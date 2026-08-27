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
 * PRIME Engine — Change / Rework / Reroute types
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.6.
 *
 * Two concerns live in this module:
 *
 *  1. **Change orders** — a customer- or shop-initiated amendment to an
 *     in-flight work order. A change order always carries a `ChangeOrderKind`
 *     (add an item, remove an item, modify spec, expedite, change quantity),
 *     and transitions through `pending → approved | rejected`. Approval /
 *     rejection is by a reviewer (pre-production, supervisor, admin) and
 *     emits a decision event with timestamp + decision reason.
 *
 *  2. **Reroutes** — a mid-flight change of the station an already-routed
 *     step will run on. Valid only while the step is still reroutable
 *     (ready / paused / blocked). In-progress or completed steps can't be
 *     rerouted — those require a rework cycle (handled in Task Flow §3.5
 *     via `log_rework`).
 *
 * Reuses the `StationRegistry` port from Routing (§3.3) so eligibility rules
 * stay in one place.
 *
 * §16 event catalog coverage:
 *  - work_order.change_order.created   — created in `pending` status
 *  - work_order.change_order.approved  — reviewer decision
 *  - work_order.change_order.rejected  — reviewer decision w/ reason
 *  - work_order.reroute.executed       — mid-flight station swap
 *
 * NOTE: `step.rework.logged` is handled in Task Flow (§3.5, Session 6), not
 * here. Rework is a Task-Flow annotation; this module is strictly about
 * change-order lifecycle and route mutation.
 */

import type {
  StationId,
  WorkOrderId,
  WorkOrderStepId,
} from "../../models/events";

// ---------- Change orders ----------

/**
 * What kind of amendment is being requested. Captured verbatim on the event
 * so the learning layer (§21) can correlate change kind with downstream
 * schedule impact.
 */
export type ChangeOrderKind =
  | "add_item"
  | "remove_item"
  | "modify_spec"
  | "expedite"
  | "change_quantity";

export type ChangeOrderStatus = "pending" | "approved" | "rejected";

export type ChangeOrderId = string;

/**
 * Full change-order entity. Persisted by the caller; this module only
 * validates transitions and emits the correct events.
 *
 * `decisionAt` / `reviewer` / `rejectionReason` are only set once the change
 * order leaves `pending`. All optional fields use `?:` (never `| undefined`)
 * to stay aligned with the rest of the PRIME codebase.
 */
export interface ChangeOrder {
  readonly id: ChangeOrderId;
  readonly workOrderId: WorkOrderId;
  readonly kind: ChangeOrderKind;
  readonly description: string;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly status: ChangeOrderStatus;
  readonly reviewer?: string;
  readonly decisionAt?: Date;
  readonly rejectionReason?: string;
}

/**
 * Inputs for creating a new change order. The caller supplies `id` + request
 * metadata; `status` is always set to `pending` at creation time by the use
 * case (never by the caller).
 */
export interface CreateChangeOrderInput {
  readonly id: ChangeOrderId;
  readonly workOrderId: WorkOrderId;
  readonly kind: ChangeOrderKind;
  readonly description: string;
  readonly requestedBy: string;
}

export interface ApproveChangeOrderInput {
  readonly changeOrder: ChangeOrder;
  readonly reviewer: string;
}

export interface RejectChangeOrderInput {
  readonly changeOrder: ChangeOrder;
  readonly reviewer: string;
  readonly rejectionReason: string;
}

// ---------- Reroute ----------

/**
 * A mid-flight reroute request. `fromStationId` is derived from the current
 * `RoutedStep.stationId`; the caller supplies it so the reroute event
 * carries both sides of the swap for audit / learning.
 */
export interface ExecuteRerouteInput {
  readonly workOrderId: WorkOrderId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
  /**
   * The step's current task-flow state. Used by the use case to verify the
   * step is reroutable (only `ready | paused | blocked` qualify). In-progress
   * or completed steps require a rework cycle (§3.5), not a reroute.
   */
  readonly currentStepState: RerouteableStepState;
  /**
   * Spec classification + skill requirements at the rerouted step, so the
   * `StationRegistry` can validate the target station is eligible. These are
   * passthroughs from the `RoutedStep` the caller already holds.
   */
  readonly workstationClass: string;
  readonly requiredSkillTags: ReadonlyArray<string>;
}

/**
 * Subset of `StepState` (Task Flow §3.5) where reroute is permitted.
 * Kept as a string literal union (not an import) so this module stays
 * independent of Task Flow — both consumers serialize the same strings.
 */
export type RerouteableStepState = "ready" | "paused" | "blocked";

// ---------- Errors ----------

export type ChangeErrorCode =
  /** Tried to approve/reject a change order that isn't in `pending`. */
  | "already_decided"
  /** Reject without `rejectionReason`, or other field-level validation. */
  | "invalid_command"
  /** WO id mismatch between change order / reroute input. */
  | "work_order_mismatch"
  /** Reroute when the current step state isn't reroutable. */
  | "step_not_reroutable"
  /** Reroute target station is not in the registry at all. */
  | "station_not_found"
  /** Reroute target exists but fails the class / skill / status eligibility filter. */
  | "station_not_eligible";

export interface ChangeError {
  readonly code: ChangeErrorCode;
  readonly message: string;
}

// ---------- Event payloads (§16) ----------

export interface ChangeOrderCreatedPayload {
  readonly changeOrderId: ChangeOrderId;
  readonly kind: ChangeOrderKind;
  readonly description: string;
  readonly requestedBy: string;
}

export interface ChangeOrderApprovedPayload {
  readonly changeOrderId: ChangeOrderId;
  readonly kind: ChangeOrderKind;
  readonly reviewer: string;
}

export interface ChangeOrderRejectedPayload {
  readonly changeOrderId: ChangeOrderId;
  readonly kind: ChangeOrderKind;
  readonly reviewer: string;
  readonly rejectionReason: string;
}

export interface RerouteExecutedPayload {
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
  readonly stepStateAtReroute: RerouteableStepState;
}
