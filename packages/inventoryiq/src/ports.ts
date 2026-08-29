// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Reservation, StockPosition } from "./models.js";

// ─────────────────────────────────────────────────────────────────────────────
// What InventoryIQ asks of a host.
//
// Note what is NOT here: a way to publish events. The use cases RETURN the
// events they produced and publish nothing.
//
// That is not squeamishness about I/O. Reserving material is two writes — the
// position and the reservation — and if an event announcing the reservation
// escapes while those writes roll back, every consumer now believes in a
// reservation that does not exist. Only the host owns the transaction, so only
// the host can write the events inside it. Handing them back is what lets it,
// and it is exactly what the outbox in `contracts` expects to be given.
// ─────────────────────────────────────────────────────────────────────────────

export interface StockLedger {
  /** Every location holding any of these materials, for one organization. */
  positions(
    organizationId: string,
    materialIds: ReadonlyArray<string>,
  ): Promise<StockPosition[]>;

  position(
    organizationId: string,
    materialId: string,
    locationId: string,
  ): Promise<StockPosition | null>;

  /**
   * Persists a change, stating the version that was read.
   *
   * MUST throw `StockConflictError` when that version is stale, and MUST
   * increment the stored version itself. Both halves matter:
   *
   * Silently accepting a stale write is how two concurrent reserves each
   * believe they hold material and one's hold disappears — which is exactly
   * what this engine did before the version existed.
   *
   * Leaving the increment to callers means one that forgets leaves the version
   * unchanged, and the next stale write passes too. Concurrency control that
   * depends on everybody remembering is concurrency control that eventually is
   * not there.
   *
   * A durable implementation does this as ONE conditional statement —
   * `UPDATE ... WHERE version = ?` and check the affected rows. A read
   * followed by a write reads exactly as correctly and is exactly as wrong.
   */
  savePosition(position: StockPosition, expectedVersion: number): Promise<void>;
}

export interface ReservationStore {
  get(organizationId: string, reservationId: string): Promise<Reservation | null>;
  save(reservation: Reservation): Promise<void>;
  listByWorkOrder(organizationId: string, workOrderId: string): Promise<Reservation[]>;
}

export interface InventoryDeps {
  readonly stock: StockLedger;
  readonly reservations: ReservationStore;
  readonly now?: () => Date;
  readonly generateId?: () => string;
}
