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

  savePosition(position: StockPosition): Promise<void>;
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
