// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Reservation, StockPosition } from "./models.js";
import type { ReservationStore, StockLedger } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory ledger and reservation store.
//
// For tests, and for a host that has not chosen a database yet. NOT durable and
// NOT transactional: two concurrent reservations against the same position both
// read the same `reserved` and the second overwrites the first. A real ledger
// needs a row lock or a conditional update, and this one says so rather than
// appearing to work.
//
// Every method narrows its port's return type to a plain Promise rather than
// leaving it as the union the port allows. That is a standing rule here for a
// specific reason: vitest strips types, so a returned union passes tests and
// fails typecheck, and the gap between those two is where a whole afternoon
// goes.
// ─────────────────────────────────────────────────────────────────────────────

export interface InMemoryStockLedger extends StockLedger {
  seed(positions: ReadonlyArray<StockPosition>): void;
  all(): StockPosition[];
  clear(): void;
}

const positionKey = (organizationId: string, materialId: string, locationId: string): string =>
  `${organizationId}::${materialId}::${locationId}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createInMemoryStockLedger(
  initial: ReadonlyArray<StockPosition> = [],
): InMemoryStockLedger {
  const positions = new Map<string, StockPosition>();

  const put = (position: StockPosition): void => {
    positions.set(
      positionKey(position.organizationId, position.materialId, position.locationId),
      clone(position),
    );
  };
  for (const position of initial) put(position);

  return {
    async positions(organizationId, materialIds) {
      const wanted = new Set(materialIds);
      return [...positions.values()]
        .filter((p) => p.organizationId === organizationId && wanted.has(p.materialId))
        .map(clone);
    },

    async position(organizationId, materialId, locationId) {
      const found = positions.get(positionKey(organizationId, materialId, locationId));
      return found ? clone(found) : null;
    },

    async savePosition(position) {
      put(position);
    },

    seed(next) {
      for (const position of next) put(position);
    },
    all: () => [...positions.values()].map(clone),
    clear: () => positions.clear(),
  };
}

export interface InMemoryReservationStore extends ReservationStore {
  all(): Reservation[];
  clear(): void;
}

export function createInMemoryReservationStore(): InMemoryReservationStore {
  const reservations = new Map<string, Reservation>();

  return {
    async get(organizationId, reservationId) {
      const found = reservations.get(reservationId);
      // Scoped by organization, not merely by id. An id-only lookup is how one
      // tenant settles another's reservation by guessing a string.
      if (!found || found.organizationId !== organizationId) return null;
      return clone(found);
    },

    async save(reservation) {
      reservations.set(reservation.reservationId, clone(reservation));
    },

    async listByWorkOrder(organizationId, workOrderId) {
      return [...reservations.values()]
        .filter((r) => r.organizationId === organizationId && r.workOrderId === workOrderId)
        .map(clone);
    },

    all: () => [...reservations.values()].map(clone),
    clear: () => reservations.clear(),
  };
}
