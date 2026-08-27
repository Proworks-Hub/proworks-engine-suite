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
 * PRIME Engine — Reroute approval use case
 *
 * Spec: PRIME-PHASE-1-UPGRADE-SPEC.md §2.
 *
 * Three operations:
 *   - request(input, actor)  — creates an approval record; emits either a
 *                              `reroute.approval_requested` (pending) OR
 *                              `reroute.approval_approved` (auto) event.
 *   - approve(input)         — pending → approved; emits `approval_approved`.
 *   - reject(input)          — pending → rejected; emits `approval_rejected`.
 *
 * The use case is stateless. It emits events, returns the new approval
 * record, and leaves persistence to the caller (mirrors the existing
 * changeOrderUseCase / executeRerouteUseCase patterns).
 */

import type {
  Clock,
  EventLog,
  IdGenerator,
} from "../logging/eventLog.js";
import type {
  EventActor,
  UserId,
} from "../../models/events.js";
import type {
  ApproveRerouteInput,
  RejectRerouteInput,
  RequestRerouteApprovalInput,
  RerouteApprovalApprovedPayload,
  RerouteApprovalError,
  RerouteApprovalPolicyProvider,
  RerouteApprovalRejectedPayload,
  RerouteApprovalRequest,
  RerouteApprovalRequestedPayload,
} from "./rerouteApprovalTypes.js";

// ---------- Public surface ----------

export type RequestRerouteApprovalResult =
  | { readonly ok: true; readonly approval: RerouteApprovalRequest }
  | { readonly ok: false; readonly error: RerouteApprovalError };

export type DecideRerouteApprovalResult =
  | { readonly ok: true; readonly approval: RerouteApprovalRequest }
  | { readonly ok: false; readonly error: RerouteApprovalError };

export interface RerouteApprovalUseCaseDeps {
  readonly eventLog: EventLog;
  readonly policy: RerouteApprovalPolicyProvider;
  /** Override for deterministic ids in tests. Defaults to crypto.randomUUID(). */
  readonly idGenerator?: IdGenerator;
  /** Override for deterministic timestamps in tests. Defaults to `() => new Date()`. */
  readonly clock?: Clock;
}

export interface RerouteApprovalUseCase {
  request(
    input: RequestRerouteApprovalInput,
    actor: EventActor
  ): Promise<RequestRerouteApprovalResult>;
  approve(
    input: ApproveRerouteInput,
    actor: EventActor
  ): Promise<DecideRerouteApprovalResult>;
  reject(
    input: RejectRerouteInput,
    actor: EventActor
  ): Promise<DecideRerouteApprovalResult>;
}

// ---------- Actor role helpers ----------

/**
 * Actors that can self-approve a reroute under `supervisor_required` mode.
 * Operator and customer actors — and any system actor — always require
 * explicit review.
 */
function isPrivilegedActor(actor: EventActor): boolean {
  if (actor.kind !== "user") {
    return false;
  }
  return (
    actor.role === "admin" ||
    actor.role === "supervisor" ||
    actor.role === "pre_production"
  );
}

// ---------- Factory ----------

export function createRerouteApprovalUseCase(
  deps: RerouteApprovalUseCaseDeps
): RerouteApprovalUseCase {
  const { eventLog, policy } = deps;
  const idGenerator: IdGenerator =
    deps.idGenerator ?? (() => crypto.randomUUID());
  const clock: Clock = deps.clock ?? (() => new Date());

  return {
    async request(input, actor) {
      const fieldError = validateRequestFields(input);
      if (fieldError) {
        return { ok: false, error: fieldError };
      }

      const mode = await policy.getMode();
      const autoApproved = mode === "operator_allowed" || isPrivilegedActor(actor);
      const now = clock();
      const approvalId = idGenerator();

      const baseApproval: RerouteApprovalRequest = {
        id: approvalId,
        workOrderId: input.workOrderId,
        stepId: input.stepId,
        fromStationId: input.fromStationId,
        toStationId: input.toStationId,
        reason: input.reason,
        requestedBy: input.requestedBy,
        requestedAt: now,
        currentStepState: input.currentStepState,
        workstationClass: input.workstationClass,
        requiredSkillTags: input.requiredSkillTags,
        mode,
        status: autoApproved ? "auto_approved" : "pending",
        ...(autoApproved
          ? { reviewer: input.requestedBy, decisionAt: now }
          : {}),
      };

      if (autoApproved) {
        await eventLog.append<RerouteApprovalApprovedPayload>({
          workOrderId: input.workOrderId,
          stepId: input.stepId,
          type: "work_order.reroute.approval_approved",
          actor,
          payload: {
            approvalId,
            stepId: input.stepId,
            fromStationId: input.fromStationId,
            toStationId: input.toStationId,
            reviewer: input.requestedBy,
            autoApproved: true,
          },
        });
      } else {
        await eventLog.append<RerouteApprovalRequestedPayload>({
          workOrderId: input.workOrderId,
          stepId: input.stepId,
          type: "work_order.reroute.approval_requested",
          actor,
          payload: {
            approvalId,
            stepId: input.stepId,
            fromStationId: input.fromStationId,
            toStationId: input.toStationId,
            reason: input.reason,
            requestedBy: input.requestedBy,
            mode,
          },
        });
      }

      return { ok: true, approval: Object.freeze(baseApproval) };
    },

    async approve(input, actor) {
      const fieldError = validateReviewerField(input.reviewer);
      if (fieldError) {
        return { ok: false, error: fieldError };
      }
      if (input.approval.status !== "pending") {
        return {
          ok: false,
          error: {
            code: "already_decided",
            message: `Approval '${input.approval.id}' is already in status '${input.approval.status}'`,
          },
        };
      }

      const now = clock();
      const decided: RerouteApprovalRequest = {
        ...input.approval,
        status: "approved",
        reviewer: input.reviewer,
        decisionAt: now,
        ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
      };

      await eventLog.append<RerouteApprovalApprovedPayload>({
        workOrderId: decided.workOrderId,
        stepId: decided.stepId,
        type: "work_order.reroute.approval_approved",
        actor,
        payload: {
          approvalId: decided.id,
          stepId: decided.stepId,
          fromStationId: decided.fromStationId,
          toStationId: decided.toStationId,
          reviewer: input.reviewer,
          autoApproved: false,
          ...(input.decisionNote ? { decisionNote: input.decisionNote } : {}),
        },
      });

      return { ok: true, approval: Object.freeze(decided) };
    },

    async reject(input, actor) {
      const fieldError = validateReviewerField(input.reviewer);
      if (fieldError) {
        return { ok: false, error: fieldError };
      }
      if (!input.rejectionReason || input.rejectionReason.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: "missing_rejection_reason",
            message: "reject: rejectionReason must be a non-empty string",
          },
        };
      }
      if (input.approval.status !== "pending") {
        return {
          ok: false,
          error: {
            code: "already_decided",
            message: `Approval '${input.approval.id}' is already in status '${input.approval.status}'`,
          },
        };
      }

      const now = clock();
      const decided: RerouteApprovalRequest = {
        ...input.approval,
        status: "rejected",
        reviewer: input.reviewer,
        decisionAt: now,
        rejectionReason: input.rejectionReason,
      };

      await eventLog.append<RerouteApprovalRejectedPayload>({
        workOrderId: decided.workOrderId,
        stepId: decided.stepId,
        type: "work_order.reroute.approval_rejected",
        actor,
        payload: {
          approvalId: decided.id,
          stepId: decided.stepId,
          fromStationId: decided.fromStationId,
          toStationId: decided.toStationId,
          reviewer: input.reviewer,
          rejectionReason: input.rejectionReason,
        },
      });

      return { ok: true, approval: Object.freeze(decided) };
    },
  };
}

// ---------- Helpers ----------

function validateRequestFields(
  input: RequestRerouteApprovalInput
): RerouteApprovalError | null {
  if (!input.workOrderId || input.workOrderId.trim().length === 0) {
    return invalid("reroute-approval request: workOrderId must be a non-empty string");
  }
  if (!input.stepId || input.stepId.trim().length === 0) {
    return invalid("reroute-approval request: stepId must be a non-empty string");
  }
  if (!input.fromStationId || input.fromStationId.trim().length === 0) {
    return invalid("reroute-approval request: fromStationId must be a non-empty string");
  }
  if (!input.toStationId || input.toStationId.trim().length === 0) {
    return invalid("reroute-approval request: toStationId must be a non-empty string");
  }
  if (input.fromStationId === input.toStationId) {
    return invalid("reroute-approval request: toStationId must differ from fromStationId");
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return invalid("reroute-approval request: reason must be a non-empty string");
  }
  if (!input.requestedBy || input.requestedBy.trim().length === 0) {
    return invalid("reroute-approval request: requestedBy must be a non-empty string");
  }
  if (!input.workstationClass || input.workstationClass.trim().length === 0) {
    return invalid("reroute-approval request: workstationClass must be a non-empty string");
  }
  return null;
}

function validateReviewerField(reviewer: UserId): RerouteApprovalError | null {
  if (!reviewer || reviewer.trim().length === 0) {
    return invalid("reroute-approval decision: reviewer must be a non-empty string");
  }
  return null;
}

function invalid(message: string): RerouteApprovalError {
  return { code: "invalid_command", message };
}
