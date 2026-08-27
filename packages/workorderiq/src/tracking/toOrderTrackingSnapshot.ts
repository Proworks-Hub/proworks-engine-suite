// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  OrderTrackingSnapshot,
  TrackingConfidence,
  TrackingStage,
} from "@proworks-hub/contracts";
import { trackingStageIndex } from "@proworks-hub/contracts";

import type { Milestone, WorkOrderProjection } from "../core/tracking/trackingTypes.js";

// ─────────────────────────────────────────────────────────────────────────────
// WorkOrderIQ's answer to "where is this order".
//
// The translation from the internal milestone vocabulary to the public stage
// vocabulary lives HERE, with the engine that owns the internal names — not in
// the tracking service. That placement is the whole reason the claim holds
// that renaming an internal milestone cannot change a public contract: the
// compiler forces this file to be updated, and this file is the only place a
// public name is produced.
//
// It is a pure function over a projection the engine already computes. It adds
// no state, no I/O, and no second source of truth.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the finished work leaves by carrier or over the counter. */
export type FulfilmentBranch = "ship" | "pickup";

export interface ToOrderTrackingSnapshotInput {
  readonly projection: WorkOrderProjection;
  /**
   * What the CUSTOMER calls this order. A work-order id is an internal key;
   * handing one to a customer invites them to quote it at somebody who cannot
   * resolve it.
   */
  readonly orderRef: string;
  readonly organizationId: string;
  readonly branch: FulfilmentBranch;
  /** True when the order is past its promised date, however that is decided. */
  readonly pastDue?: boolean;
  readonly now?: () => Date;
}

/**
 * Maps an internal milestone onto the public stage vocabulary.
 *
 * Two mappings are worth explaining because they look wrong at a glance:
 *
 * `routed` becomes `received`. Routing is a scheduling decision the shop makes
 * about itself; from outside, an order that has been routed and one that has
 * not are both "we have it, we have not started".
 *
 * `completed` on the ship branch becomes `packing`, not `shipped`. Production
 * finishing means the box is packed and waiting for a carrier. Nothing has
 * shipped until a carrier says so, and the shipment merge is what advances it.
 * Saying "shipped" here is the promise that generates the phone call.
 */
function stageFor(milestone: Milestone, branch: FulfilmentBranch): TrackingStage {
  switch (milestone) {
    case "intake":
    case "routed":
      return "received";
    case "in_production":
      return "in_production";
    case "quality_check":
      return "quality_check";
    case "ready_for_pickup":
      // Required steps done, optional ones may remain. Not yet collectable.
      return "packing";
    case "completed":
      return branch === "pickup" ? "ready_for_pickup" : "packing";
  }
}

/**
 * The engine's confidence carries across unchanged.
 *
 * Both vocabularies use the same three words, and that is deliberate rather
 * than convenient: an ETA shown without its confidence reads as a promise.
 */
function confidenceFor(projection: WorkOrderProjection): TrackingConfidence {
  return projection.etaConfidence;
}

export function toOrderTrackingSnapshot(
  input: ToOrderTrackingSnapshotInput,
): OrderTrackingSnapshot {
  const { projection, branch } = input;
  const now = input.now ?? (() => new Date());
  const stage = stageFor(projection.currentMilestone, branch);

  return {
    orderRef: input.orderRef,
    organizationId: input.organizationId,
    stage,
    stageIndex: trackingStageIndex(stage, branch),
    percentComplete: projection.percentComplete,
    estimatedCompletionAt: projection.estimatedCompletionAt
      ? projection.estimatedCompletionAt.toISOString()
      : null,
    confidence: confidenceFor(projection),
    // At risk OR past due. The customer is entitled to know their order is
    // behind; the reason stays in the internal block.
    runningBehind: projection.etaConfidence === "at_risk" || input.pastDue === true,
    generatedAt: now().toISOString(),
    internal: {
      workOrderId: projection.workOrderId,
      currentMilestone: projection.currentMilestone,
      completedStepCount: projection.completedStepCount,
      totalStepCount: projection.totalStepCount,
      ...(projection.etaRiskReason ? { riskReason: projection.etaRiskReason } : {}),
    },
  };
}
