// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// What ingestion announces.
//
// Returned, never published — the same rule as InventoryIQ. Recording the
// idempotency key and publishing "order ingested" have to succeed or fail
// together, and only the host owns a transaction that can promise it.
// ─────────────────────────────────────────────────────────────────────────────

export const ORDER_EVENTS = [
  "order.ingested",
  "order.duplicate_skipped",
  /** A line nobody can route until a human maps it. */
  "order.line_unmatched",
  "order.ready_for_production",
] as const;

export type OrderEventType = (typeof ORDER_EVENTS)[number];

export interface OrderIngestionEvent<TPayload = unknown> {
  readonly type: OrderEventType;
  readonly organizationId: string;
  readonly orderRef: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
}

export interface OrderIngestedPayload {
  readonly channel: string;
  readonly externalOrderId: string;
  readonly lineCount: number;
  readonly fullyMatched: boolean;
  readonly paid?: boolean;
}

export interface OrderDuplicateSkippedPayload {
  readonly channel: string;
  readonly externalOrderId: string;
  readonly firstIngestedAt: string;
}

export interface OrderLineUnmatchedPayload {
  readonly externalLineId: string;
  /** Why, specifically. A boolean here would make every fix a guess. */
  readonly reason: string;
  readonly sourceSku?: string;
  readonly sourceTitle?: string;
  readonly quantity: number;
}

export interface OrderReadyForProductionPayload {
  readonly requiresConfiguration: boolean;
  readonly lineCount: number;
}
