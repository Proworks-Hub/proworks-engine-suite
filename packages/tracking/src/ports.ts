// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type {
  OrderTrackingSnapshot,
  ShipmentTrackingSnapshot,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// What tracking asks of the world.
//
// This package depends on `contracts` and nothing else — deliberately NOT on
// WorkOrderIQ. If it imported the work-order engine, a host that wants to show
// a customer where their order is would have to install a production engine to
// do it, and the two would stop being separable. So WorkOrderIQ implements this
// port; tracking never learns it exists.
//
// That also puts the milestone→stage mapping in the right place: with the
// engine that owns the internal vocabulary. The claim that renaming an internal
// milestone cannot change a public contract is only true if the translation
// lives next to the thing being renamed.
// ─────────────────────────────────────────────────────────────────────────────

/** Who is asking, and about what. */
export interface TrackingQuery {
  readonly orderRef: string;
  readonly organizationId: string;
}

/**
 * Something that can say where an order is.
 *
 * Returns `null` for an order it does not know about — which is normal, not an
 * error. A web order that has not reached the shop yet is unknown to the
 * production source and fully known to the order source.
 */
export interface TrackingSource {
  /** For diagnostics and for breaking ties deterministically. */
  readonly name: string;
  get(query: TrackingQuery): Promise<OrderTrackingSnapshot | null>;
}

/**
 * Something that can say where a parcel is.
 *
 * Separate from `TrackingSource` because it answers a different question and
 * fails differently: a carrier API is remote, rate-limited and frequently down,
 * and tracking must degrade to production-only rather than fail.
 */
export interface ShipmentProvider {
  readonly name: string;
  get(query: TrackingQuery): Promise<ShipmentTrackingSnapshot | null>;
}
