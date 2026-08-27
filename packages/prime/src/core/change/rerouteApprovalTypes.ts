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
 * PRIME Engine — Reroute approval types
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §2 (reroute approval system).
 *
 * The reroute approval layer gates whether `executeRerouteUseCase` is allowed
 * to run. It does NOT perform the reroute itself — the caller orchestrates:
 *
 *   1. Ask approval.request(input, actor) for a decision.
 *   2. If the returned request is `auto_approved` or `approved`, call
 *      executeRerouteUseCase.execute(...) as usual.
 *   3. If `pending`, park the reroute and surface the approval to a reviewer.
 *   4. Reviewer calls approval.approve() or approval.reject() when ready.
 *
 * Mode rules (enforced by the use case):
 *   - `operator_allowed`       → any actor can reroute; request is auto-approved.
 *   - `supervisor_required`    → actors whose role is supervisor / admin /
 *                                pre_production auto-approve themselves;
 *                                every other actor (operator, customer,
 *                                system) creates a `pending` request and
 *                                must wait for a reviewer.
 *
 * Events emitted (added to §16 catalog via models/events.ts):
 *   - work_order.reroute.approval_requested
 *   - work_order.reroute.approval_approved
 *   - work_order.reroute.approval_rejected
 */

import type {
  StationId,
  UserId,
  WorkOrderId,
  WorkOrderStepId,
} from "../../models/events";
import type { RerouteableStepState } from "./changeOrderTypes";

// ---------- Mode & policy ----------

/**
 * Shop-level setting that controls reroute approval. Sourced from tenant
 * configuration; exposed through the `RerouteApprovalPolicyProvider` port so
 * tests can inject a fake and runtime can read from wherever the shop's
 * settings live (IndexedDB row, hub-server, feature flag, etc.).
 */
export type RerouteApprovalMode =
  | "supervisor_required"
  | "operator_allowed";

/**
 * Read the current reroute approval mode for the active shop. Async to allow
 * async backing stores (hub-server, IndexedDB).
 */
export interface RerouteApprovalPolicyProvider {
  getMode(): Promise<RerouteApprovalMode>;
}

// ---------- Approval request entity ----------

export type ApprovalRequestId = string;

/**
 * Status machine:
 *   pending        — created in supervisor_required mode by a non-privileged
 *                    actor; awaiting reviewer decision.
 *   auto_approved  — created already-approved, either because the mode is
 *                    operator_allowed or the requesting actor is a
 *                    supervisor / admin / pre_production user.
 *   approved       — a reviewer explicitly approved a previously-pending
 *                    request.
 *   rejected       — a reviewer rejected a previously-pending request.
 */
export type ApprovalRequestStatus =
  | "pending"
  | "auto_approved"
  | "approved"
  | "rejected";

/**
 * Full approval-request record. Persisted by the caller; the use case only
 * validates transitions and emits events.
 *
 * `reviewer`, `decisionAt`, `decisionNote`, `rejectionReason` are only set
 * after the request leaves `pending`.
 */
export interface RerouteApprovalRequest {
  readonly id: ApprovalRequestId;
  readonly workOrderId: WorkOrderId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
  readonly requestedBy: UserId;
  readonly requestedAt: Date;
  readonly currentStepState: RerouteableStepState;
  readonly workstationClass: string;
  readonly requiredSkillTags: ReadonlyArray<string>;
  readonly mode: RerouteApprovalMode;
  readonly status: ApprovalRequestStatus;
  readonly reviewer?: UserId;
  readonly decisionAt?: Date;
  readonly decisionNote?: string;
  readonly rejectionReason?: string;
}

// ---------- Inputs ----------

/**
 * A caller-supplied reroute request. Shape mirrors `ExecuteRerouteInput` so
 * the downstream `executeRerouteUseCase` can be invoked with the same bag.
 */
export interface RequestRerouteApprovalInput {
  readonly workOrderId: WorkOrderId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
  readonly currentStepState: RerouteableStepState;
  readonly workstationClass: string;
  readonly requiredSkillTags: ReadonlyArray<string>;
  /**
   * Who is asking. Copied onto the approval record as `requestedBy`. For
   * system actors, callers should pass the originating user's id if known,
   * otherwise the system subsystem name.
   */
  readonly requestedBy: UserId;
}

export interface ApproveRerouteInput {
  readonly approval: RerouteApprovalRequest;
  readonly reviewer: UserId;
  readonly decisionNote?: string;
}

export interface RejectRerouteInput {
  readonly approval: RerouteApprovalRequest;
  readonly reviewer: UserId;
  readonly rejectionReason: string;
}

// ---------- Errors ----------

export type RerouteApprovalErrorCode =
  /** Field-level validation failure (empty id, etc.). */
  | "invalid_command"
  /** Tried to approve or reject something that isn't `pending`. */
  | "already_decided"
  /** Reject without a non-empty rejection reason. */
  | "missing_rejection_reason";

export interface RerouteApprovalError {
  readonly code: RerouteApprovalErrorCode;
  readonly message: string;
}

// ---------- Event payloads (extend §16) ----------

export interface RerouteApprovalRequestedPayload {
  readonly approvalId: ApprovalRequestId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reason: string;
  readonly requestedBy: UserId;
  readonly mode: RerouteApprovalMode;
}

export interface RerouteApprovalApprovedPayload {
  readonly approvalId: ApprovalRequestId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reviewer: UserId;
  /** True when no human review was needed (operator_allowed or privileged actor). */
  readonly autoApproved: boolean;
  readonly decisionNote?: string;
}

export interface RerouteApprovalRejectedPayload {
  readonly approvalId: ApprovalRequestId;
  readonly stepId: WorkOrderStepId;
  readonly fromStationId: StationId;
  readonly toStationId: StationId;
  readonly reviewer: UserId;
  readonly rejectionReason: string;
}

// ---------- Convenience ----------

/**
 * Simple static provider — returns the same mode on every call. Useful in
 * tests and for shops that haven't wired a dynamic setting yet.
 */
export function createStaticRerouteApprovalPolicy(
  mode: RerouteApprovalMode
): RerouteApprovalPolicyProvider {
  return {
    async getMode() {
      return mode;
    },
  };
}
