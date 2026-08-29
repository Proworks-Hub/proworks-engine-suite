// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { StockConflictError, stockPositionSchema } from "./models.js";
import type { Reservation, StockPosition, StockPositionInput } from "./models.js";
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
  /**
   * Accepts INPUT positions, so `version` may be omitted and defaults to 0.
   *
   * A seeded row that arrived unversioned would compare as `undefined` and
   * match no compare-and-set, turning every first write into a spurious
   * conflict.
   */
  seed(positions: ReadonlyArray<StockPositionInput>): void;
  all(): StockPosition[];
  clear(): void;
}

const positionKey = (organizationId: string, materialId: string, locationId: string): string =>
  `${organizationId}::${materialId}::${locationId}`;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createInMemoryStockLedger(
  initial: ReadonlyArray<StockPositionInput> = [],
): InMemoryStockLedger {
  const positions = new Map<string, StockPosition>();

  const put = (position: StockPositionInput): void => {
    // Parsed, so an unversioned input gets version 0 rather than `undefined`.
    // A stored `undefined` would compare against no expected version and turn
    // every first write into a spurious conflict.
    const parsed = stockPositionSchema.parse(position);
    positions.set(
      positionKey(parsed.organizationId, parsed.materialId, parsed.locationId),
      clone(parsed),
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

    async savePosition(position, expectedVersion) {
      // ── Compare and set, with no await between the two ────────────────
      //
      // The check and the write are adjacent and synchronous on purpose.
      // Anything that suspends between them reopens the gap this exists to
      // close: the previous implementation read the position, awaited, and
      // wrote an unconditional overwrite, so concurrent reserves all read the
      // same figure and clobbered each other.
      //
      // JavaScript is single-threaded, so no `await` here means no interleaving
      // here. A durable implementation gets the same property from a single
      // conditional UPDATE rather than from the event loop.
      const key = positionKey(position.organizationId, position.materialId, position.locationId);
      const current = positions.get(key);
      const actual = current?.version ?? 0;

      if (current && actual !== expectedVersion) {
        throw new StockConflictError(position.materialId, expectedVersion, actual);
      }

      // The LEDGER increments, not the caller. A caller that forgot would
      // leave the version unchanged and the next stale write would pass too.
      put({ ...position, version: actual + 1 });
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
