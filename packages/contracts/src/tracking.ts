// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Tracking — "where is my order", normalized across the things that answer it.
//
// WHY THIS IS A CONTRACT AND NOT A PROJECTION.
//
// WorkOrderIQ already has a customer-facing projection, and it is good: it
// refuses to leak station names, operator ids or internal priority. But it is
// WorkOrderIQ-SHAPED — it takes a WorkOrderId and reads a work-order summary.
//
// Tracking is not a work-order question. It is an ORDER question, and an order
// can be:
//   - in production, and have a work order  (ProWorks)
//   - accepted and not yet routed, with no work order at all  (KSix web order)
//   - finished, boxed, and on a truck, where production state is stale and the
//     carrier is the only source that knows anything  (both)
//
// A projection that reads work-order events cannot answer the second or third.
// So the SNAPSHOT is the contract, the sources map into it, and the tracking
// service merges. That is also what lets a host show one consistent bar
// without knowing which source is currently authoritative.
//
// WHY REDACTION IS STRUCTURAL.
//
// Different audiences get different depth, and a per-audience DTO hand-written
// per surface is how a station name eventually reaches a customer — not through
// malice, through an object spread. So internal detail lives in ONE nested
// block, and narrowing an audience DROPS the block rather than picking fields
// out of it. A field added to the internal block can never widen exposure,
// which is the property that has to survive people who have not read this file.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is looking.
 *
 *   customer   — the person who placed the order. Least detail.
 *   partner    — a subcontracting shop. Sees the work it was given and
 *                nothing about the originator's customer or logistics.
 *   shop_floor — an operator. Sees stations and steps.
 *   manager    — full internal view.
 */
export const trackingAudienceSchema = z.enum([
  "customer",
  "partner",
  "shop_floor",
  "manager",
]);
export type TrackingAudience = z.infer<typeof trackingAudienceSchema>;

/**
 * The canonical stage vocabulary, spanning production AND fulfilment.
 *
 * It has two terminal branches on purpose. A shop's order is picked up at the
 * counter; a web order ships. Collapsing those into one "done" loses the only
 * thing the customer wants to know at the end, which is whether to drive over
 * or wait at home.
 *
 * WorkOrderIQ's internal Milestone maps INTO this; it is deliberately not the
 * same type, so renaming an internal milestone cannot change a public contract.
 */
export const trackingStageSchema = z.enum([
  "received",
  "proof_sent",
  "proof_approved",
  "in_production",
  "quality_check",
  "packing",
  // Branch: shipped.
  "shipped",
  "out_for_delivery",
  "delivered",
  // Branch: collected.
  "ready_for_pickup",
  "picked_up",
  // Terminal or off-sequence.
  "cancelled",
  "on_hold",
]);
export type TrackingStage = z.infer<typeof trackingStageSchema>;

/**
 * The forward sequence for an order that ships, and for one that is collected.
 *
 * Two arrays rather than one, because an order is on exactly one branch and a
 * combined ordering would place "ready_for_pickup" and "shipped" in a false
 * relationship. `cancelled` and `on_hold` are in neither: they are conditions,
 * not positions.
 */
export const TRACKING_STAGE_ORDER: ReadonlyArray<TrackingStage> = Object.freeze([
  "received",
  "proof_sent",
  "proof_approved",
  "in_production",
  "quality_check",
  "packing",
  "shipped",
  "out_for_delivery",
  "delivered",
]);

export const PICKUP_STAGE_ORDER: ReadonlyArray<TrackingStage> = Object.freeze([
  "received",
  "proof_sent",
  "proof_approved",
  "in_production",
  "quality_check",
  "packing",
  "ready_for_pickup",
  "picked_up",
]);

/**
 * How much to trust `estimatedCompletionAt`.
 *
 * Deliberately the same three words WorkOrderIQ's tracking module already uses,
 * because it already derives them from real step estimates. An ETA shown
 * without its confidence is a promise; shown with it, it is an estimate.
 */
export const trackingConfidenceSchema = z.enum(["firm", "tentative", "at_risk"]);
export type TrackingConfidence = z.infer<typeof trackingConfidenceSchema>;

// ---------- Shipment ----------

export const shipmentStatusSchema = z.enum([
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
  "returned",
]);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

/**
 * What a carrier knows. Populated by a host integration, never by an engine —
 * no engine in this suite makes a network call.
 */
export const shipmentTrackingSnapshotSchema = z
  .object({
    carrier: z.string().min(1),
    trackingNumber: z.string().min(1),
    trackingUrl: z.string().url().optional(),
    status: shipmentStatusSchema,
    shippedAt: z.string().datetime().optional(),
    estimatedDeliveryAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
    /** Coarse, as carriers report it — "Denver, CO". Never a street address. */
    lastKnownLocation: z.string().optional(),
    lastEventAt: z.string().datetime().optional(),
  })
  .strict();
export type ShipmentTrackingSnapshot = z.infer<typeof shipmentTrackingSnapshotSchema>;

// ---------- Internal detail ----------

/**
 * Everything that is true but not everyone's business.
 *
 * One block, so redaction is a delete rather than a re-pick. Anything added
 * here is invisible to a customer by construction.
 */
export const internalTrackingDetailSchema = z
  .object({
    workOrderId: z.string().optional(),
    currentMilestone: z.string().optional(),
    currentStation: z.string().optional(),
    assignedOperatorId: z.string().optional(),
    completedStepCount: z.number().int().nonnegative().optional(),
    totalStepCount: z.number().int().nonnegative().optional(),
    /** Why the ETA is at risk. The customer is told THAT, never WHY. */
    riskReason: z.string().optional(),
    priority: z.string().optional(),
    blockedReason: z.string().optional(),
    holdReason: z.string().optional(),
  })
  .strict();
export type InternalTrackingDetail = z.infer<typeof internalTrackingDetailSchema>;

// ---------- The snapshot ----------

export const orderTrackingSnapshotSchema = z
  .object({
    /**
     * The reference the VIEWER uses. For a customer that is their order
     * number, not a work-order id — an id someone cannot resolve is an id
     * they will eventually try to use somewhere it does resolve.
     */
    orderRef: z.string().min(1),
    organizationId: z.string().min(1),
    stage: trackingStageSchema,
    /** Position within the relevant branch, or -1 for a stage outside it. */
    stageIndex: z.number().int(),
    percentComplete: z.number().int().min(0).max(100),
    estimatedCompletionAt: z.string().datetime().nullable(),
    confidence: trackingConfidenceSchema,
    /**
     * "Running a bit late." A boolean on purpose: the customer is entitled to
     * know their order is behind, and not to a diagnosis of the shop.
     */
    runningBehind: z.boolean(),
    generatedAt: z.string().datetime(),
    shipment: shipmentTrackingSnapshotSchema.optional(),
    internal: internalTrackingDetailSchema.optional(),
  })
  .strict();
export type OrderTrackingSnapshot = z.infer<typeof orderTrackingSnapshotSchema>;

/** A snapshot that structurally cannot carry internal detail. */
export type PublicTrackingSnapshot = Omit<OrderTrackingSnapshot, "internal"> & {
  readonly internal?: never;
};

// ---------- Redaction ----------

/** What each audience may see beyond the public fields. */
const AUDIENCE_GRANTS: Readonly<
  Record<TrackingAudience, { internal: boolean; shipment: boolean }>
> = Object.freeze({
  // Their package, their tracking number.
  customer: { internal: false, shipment: true },
  // A subcontractor knows the work it was given. Where the originator ships it
  // afterwards is the originator's business and its customer's, not theirs.
  partner: { internal: false, shipment: false },
  shop_floor: { internal: true, shipment: true },
  manager: { internal: true, shipment: true },
});

/**
 * Narrows a snapshot to what an audience may see.
 *
 * Deletes blocks; never rebuilds from picked fields. The distinction is the
 * whole point: a rebuild must be updated every time a field is added, and the
 * failure mode of forgetting is exposure. Deleting fails the other way.
 */
export function redactTrackingFor(
  snapshot: OrderTrackingSnapshot,
  audience: TrackingAudience,
): OrderTrackingSnapshot {
  const grants = AUDIENCE_GRANTS[audience];
  const { internal, shipment, ...rest } = snapshot;

  return {
    ...rest,
    ...(grants.shipment && shipment ? { shipment } : {}),
    ...(grants.internal && internal ? { internal } : {}),
  };
}

/** `redactTrackingFor(s, "customer")`, typed so the result cannot regain it. */
export function toPublicTrackingSnapshot(
  snapshot: OrderTrackingSnapshot,
): PublicTrackingSnapshot {
  return redactTrackingFor(snapshot, "customer") as PublicTrackingSnapshot;
}

/**
 * Throws if a snapshot bound for an audience carries more than it may.
 *
 * The belt to redaction's braces, for a host that assembles a snapshot by hand
 * and sends it somewhere. Cheap enough to leave on in production.
 */
export function assertTrackingSafeFor(
  snapshot: OrderTrackingSnapshot,
  audience: TrackingAudience,
): void {
  const grants = AUDIENCE_GRANTS[audience];
  const violations: string[] = [];

  if (!grants.internal && snapshot.internal !== undefined) {
    violations.push(`internal detail (${Object.keys(snapshot.internal).join(", ")})`);
  }
  if (!grants.shipment && snapshot.shipment !== undefined) {
    violations.push("shipment detail");
  }

  // Every violation at once. Reporting only the first means a caller fixes it,
  // re-runs, and is told about the next one — which is how a check that exists
  // to be helpful becomes a check people route around.
  if (violations.length > 0) {
    throw new Error(
      `tracking snapshot for audience "${audience}" carries ` +
        `${violations.join(" and ")}; redact it before sending`,
    );
  }
}

// ---------- Merge ----------

/**
 * Decides the stage when production and the carrier both have an opinion.
 *
 * THE RULE: once the box physically leaves, the carrier is authoritative.
 * Production state does not become wrong at that point — it becomes STALE, and
 * a stale internal truth loses to a live external one. Before the box leaves
 * (`label_created`), a label proves only that somebody printed a label, so
 * production still wins.
 *
 * Terminal states are never overwritten. A cancelled order with a stray
 * carrier scan is cancelled.
 */
export function mergeShipmentIntoTracking(
  production: OrderTrackingSnapshot,
  shipment: ShipmentTrackingSnapshot | undefined,
): OrderTrackingSnapshot {
  if (!shipment) return production;
  if (production.stage === "cancelled") return { ...production, shipment };

  const stage = shipmentStageFor(shipment.status);
  if (!stage) return { ...production, shipment };

  const stageIndex = TRACKING_STAGE_ORDER.indexOf(stage);
  const productionIndex = TRACKING_STAGE_ORDER.indexOf(production.stage);

  // A carrier hiccup is not backwards progress. Never move an order back down
  // the bar on the strength of one scan arriving out of order.
  if (productionIndex > stageIndex) return { ...production, shipment };

  return {
    ...production,
    stage,
    stageIndex,
    percentComplete: stage === "delivered" ? 100 : production.percentComplete,
    estimatedCompletionAt:
      shipment.deliveredAt ??
      shipment.estimatedDeliveryAt ??
      production.estimatedCompletionAt,
    shipment,
  };
}

function shipmentStageFor(status: ShipmentStatus): TrackingStage | undefined {
  switch (status) {
    // Somebody printed a label. The box may still be on the bench.
    case "label_created":
      return undefined;
    case "in_transit":
      return "shipped";
    case "out_for_delivery":
      return "out_for_delivery";
    case "delivered":
      return "delivered";
    // Both mean "not delivered, and a human needs to look". Neither is a stage
    // the customer bar can express, so production's stage stands and the
    // shipment block carries the detail.
    case "exception":
    case "returned":
      return undefined;
  }
}

/** Index of a stage within whichever branch it belongs to, or -1. */
export function trackingStageIndex(
  stage: TrackingStage,
  branch: "ship" | "pickup" = "ship",
): number {
  const order = branch === "ship" ? TRACKING_STAGE_ORDER : PICKUP_STAGE_ORDER;
  return order.indexOf(stage);
}

/** Validates an assembled snapshot, throwing with zod's detail on failure. */
export function validateTrackingSnapshot(input: unknown): OrderTrackingSnapshot {
  return orderTrackingSnapshotSchema.parse(input);
}
