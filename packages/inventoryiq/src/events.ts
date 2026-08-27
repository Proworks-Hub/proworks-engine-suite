// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Quantity } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// What inventory announces.
//
// `material.*`, matching the family the audit found missing. It was deferred
// until now on purpose: an event type nobody emits is a contract nobody
// honours, and until this engine existed nothing could emit these.
// ─────────────────────────────────────────────────────────────────────────────

export const INVENTORY_EVENTS = [
  "material.reserved",
  "material.reservation_released",
  "material.consumed",
  "material.received",
  "material.adjusted",
  "material.shortage_detected",
  "material.reorder_suggested",
  /** More is reserved than exists. Distinct from a shortage — see below. */
  "material.oversold",
] as const;

export type InventoryEventType = (typeof INVENTORY_EVENTS)[number];

export interface InventoryEvent<TPayload = unknown> {
  readonly type: InventoryEventType;
  readonly organizationId: string;
  readonly materialId: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface MaterialReservedPayload {
  readonly reservationId: string;
  readonly workOrderId: string;
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly remainingAvailable: Quantity;
}

export interface MaterialReservationReleasedPayload {
  readonly reservationId: string;
  readonly workOrderId: string;
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly reason?: string;
}

/**
 * Material actually used.
 *
 * `variance` is what makes this worth recording rather than assuming: the
 * difference between what was reserved and what was used is the shop's real
 * waste rate, and it is the number CostIQ needs to stop estimating.
 */
export interface MaterialConsumedPayload {
  readonly reservationId?: string;
  readonly workOrderId: string;
  readonly locationId: string;
  readonly consumed: Quantity;
  readonly reserved?: Quantity;
  readonly variance?: Quantity;
}

export interface MaterialShortageDetectedPayload {
  readonly workOrderId?: string;
  readonly required: Quantity;
  readonly available: Quantity;
  readonly short: Quantity;
  /** True when the material is not stocked at all, rather than merely low. */
  readonly unknownMaterial: boolean;
}

/**
 * More is reserved than physically exists.
 *
 * Deliberately not the same event as a shortage. A shortage says a job cannot
 * be promised; oversold says promises that were already made cannot all be
 * kept, and somebody has to decide which one breaks. Different message,
 * different urgency, different person.
 */
export interface MaterialOversoldPayload {
  readonly onHand: Quantity;
  readonly reserved: Quantity;
  readonly over: Quantity;
}

export interface MaterialReorderSuggestedPayload {
  readonly locationId: string;
  readonly available: Quantity;
  readonly reorderPoint: Quantity;
  readonly suggestedOrder: Quantity;
}

export interface MaterialReceivedPayload {
  readonly locationId: string;
  readonly quantity: Quantity;
  readonly reference?: string;
}

export interface MaterialAdjustedPayload {
  readonly locationId: string;
  readonly delta: Quantity;
  readonly newOnHand: Quantity;
  /** Why somebody changed a number by hand. Required for exactly that reason. */
  readonly reason: string;
}
