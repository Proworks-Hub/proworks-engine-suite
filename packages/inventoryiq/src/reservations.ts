// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { computeAvailability } from "./availability.js";
import {
  addQuantity,
  compareQuantity,
  isNegativeQuantity,
  subtractQuantity,
  zeroQuantity,
  type Quantity,
  type Reservation,
  type StockPosition,
} from "./models.js";
import type {
  InventoryEvent,
  MaterialConsumedPayload,
  MaterialOversoldPayload,
  MaterialReservationReleasedPayload,
  MaterialReservedPayload,
} from "./events.js";
import type { InventoryDeps } from "./ports.js";

// ─────────────────────────────────────────────────────────────────────────────
// Promising material, and then keeping or breaking the promise.
//
// The bugs in this area are all the same bug: a quantity counted twice, or not
// at all, because a reservation was settled twice. So every settlement is
// guarded by the reservation's own status, and a reservation that is already
// consumed or released is refused rather than reprocessed. A retry after a
// timeout is the common case, not an exotic one.
// ─────────────────────────────────────────────────────────────────────────────

export type InventoryFailure =
  | "insufficient_stock"
  | "unknown_material"
  | "unknown_reservation"
  | "already_settled"
  | "unit_mismatch";

export interface InventoryError {
  readonly code: InventoryFailure;
  readonly message: string;
}

export type InventoryResult<T> =
  | { readonly ok: true; readonly data: T; readonly events: InventoryEvent[] }
  | { readonly ok: false; readonly error: InventoryError };

const fail = (code: InventoryFailure, message: string): InventoryResult<never> => ({
  ok: false,
  error: { code, message },
});

export interface ReserveMaterialInput {
  readonly organizationId: string;
  readonly materialId: string;
  readonly locationId: string;
  readonly workOrderId: string;
  readonly quantity: Quantity;
  /**
   * Permit reserving beyond what is on hand.
   *
   * Sometimes correct: a delivery lands this afternoon and the job runs
   * tomorrow. Never a default, and it emits `material.oversold` so the
   * decision is visible to somebody rather than only to the database.
   */
  readonly allowOversell?: boolean;
}

export interface ReserveMaterialUseCase {
  execute(input: ReserveMaterialInput): Promise<InventoryResult<Reservation>>;
}

export function createReserveMaterialUseCase(deps: InventoryDeps): ReserveMaterialUseCase {
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? defaultId("rsv");

  return {
    async execute(input) {
      const position = await deps.stock.position(
        input.organizationId,
        input.materialId,
        input.locationId,
      );

      if (!position) {
        return fail(
          "unknown_material",
          `no stock record for material ${input.materialId} at ${input.locationId}`,
        );
      }
      if (position.onHand.unit !== input.quantity.unit) {
        return fail(
          "unit_mismatch",
          `stock is held in ${position.onHand.unit}; the request is in ${input.quantity.unit}`,
        );
      }

      const availableHere = subtractQuantity(position.onHand, position.reserved);
      const short = compareQuantity(input.quantity, availableHere) > 0;

      if (short && input.allowOversell !== true) {
        return fail(
          "insufficient_stock",
          `${input.materialId}: ${input.quantity.amount} ${input.quantity.unit} requested, ` +
            `${Math.max(availableHere.amount, 0)} available at ${input.locationId}`,
        );
      }

      const at = now().toISOString();
      const reservation: Reservation = {
        reservationId: generateId(),
        organizationId: input.organizationId,
        materialId: input.materialId,
        locationId: input.locationId,
        workOrderId: input.workOrderId,
        quantity: input.quantity,
        status: "held",
        createdAt: at,
      };

      const updated: StockPosition = {
        ...position,
        reserved: addQuantity(position.reserved, input.quantity),
        updatedAt: at,
      };

      // Position first: if saving the reservation then fails, the stock is
      // merely over-reserved, which blocks a promise. The other order loses a
      // reservation and lets the same material be promised twice, which is the
      // failure that reaches a machine.
      await deps.stock.savePosition(updated);
      await deps.reservations.save(reservation);

      const remaining = subtractQuantity(updated.onHand, updated.reserved);
      const events: InventoryEvent[] = [
        event<MaterialReservedPayload>("material.reserved", input.organizationId, input.materialId, at, {
          reservationId: reservation.reservationId,
          workOrderId: input.workOrderId,
          locationId: input.locationId,
          quantity: input.quantity,
          remainingAvailable: isNegativeQuantity(remaining)
            ? zeroQuantity(remaining.unit)
            : remaining,
        }),
      ];

      if (isNegativeQuantity(remaining)) {
        events.push(
          event<MaterialOversoldPayload>("material.oversold", input.organizationId, input.materialId, at, {
            onHand: updated.onHand,
            reserved: updated.reserved,
            over: subtractQuantity(updated.reserved, updated.onHand),
          }),
        );
      }

      return { ok: true, data: reservation, events };
    },
  };
}

export interface ReleaseReservationInput {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly reason?: string;
}

export interface ReleaseReservationUseCase {
  execute(input: ReleaseReservationInput): Promise<InventoryResult<Reservation>>;
}

export function createReleaseReservationUseCase(
  deps: InventoryDeps,
): ReleaseReservationUseCase {
  const now = deps.now ?? (() => new Date());

  return {
    async execute(input) {
      const reservation = await deps.reservations.get(input.organizationId, input.reservationId);
      if (!reservation) {
        return fail("unknown_reservation", `no reservation ${input.reservationId}`);
      }

      if (reservation.status !== "held") {
        // The retry case, and the reason this check exists. Releasing an
        // already-consumed reservation would credit its quantity back to
        // available stock that was genuinely used up.
        return fail(
          "already_settled",
          `reservation ${input.reservationId} is already ${reservation.status}`,
        );
      }

      const position = await deps.stock.position(
        reservation.organizationId,
        reservation.materialId,
        reservation.locationId,
      );
      if (!position) {
        return fail("unknown_material", `stock record vanished for ${reservation.materialId}`);
      }

      const at = now().toISOString();
      await deps.stock.savePosition({
        ...position,
        reserved: subtractQuantity(position.reserved, reservation.quantity),
        updatedAt: at,
      });

      const released: Reservation = { ...reservation, status: "released", settledAt: at };
      await deps.reservations.save(released);

      return {
        ok: true,
        data: released,
        events: [
          event<MaterialReservationReleasedPayload>(
            "material.reservation_released",
            reservation.organizationId,
            reservation.materialId,
            at,
            {
              reservationId: reservation.reservationId,
              workOrderId: reservation.workOrderId,
              locationId: reservation.locationId,
              quantity: reservation.quantity,
              ...(input.reason ? { reason: input.reason } : {}),
            },
          ),
        ],
      };
    },
  };
}

export interface ConsumeMaterialInput {
  readonly organizationId: string;
  readonly reservationId: string;
  /**
   * What was actually used. Defaults to what was reserved.
   *
   * Allowed to differ in both directions, because it does. Using less leaves
   * the remainder available again; using more is a real event on a floor and
   * pretending otherwise makes stock drift from reality.
   */
  readonly actual?: Quantity;
}

export interface ConsumeMaterialUseCase {
  execute(input: ConsumeMaterialInput): Promise<InventoryResult<Reservation>>;
}

export function createConsumeMaterialUseCase(deps: InventoryDeps): ConsumeMaterialUseCase {
  const now = deps.now ?? (() => new Date());

  return {
    async execute(input) {
      const reservation = await deps.reservations.get(input.organizationId, input.reservationId);
      if (!reservation) {
        return fail("unknown_reservation", `no reservation ${input.reservationId}`);
      }
      if (reservation.status !== "held") {
        return fail(
          "already_settled",
          `reservation ${input.reservationId} is already ${reservation.status}`,
        );
      }

      const consumed = input.actual ?? reservation.quantity;
      if (consumed.unit !== reservation.quantity.unit) {
        return fail(
          "unit_mismatch",
          `reserved in ${reservation.quantity.unit}; consumption reported in ${consumed.unit}`,
        );
      }

      const position = await deps.stock.position(
        reservation.organizationId,
        reservation.materialId,
        reservation.locationId,
      );
      if (!position) {
        return fail("unknown_material", `stock record vanished for ${reservation.materialId}`);
      }

      const at = now().toISOString();

      // Reserved drops by what was RESERVED; on-hand drops by what was USED.
      // Using the same number for both is the mistake that leaves phantom
      // reservations behind whenever consumption differs from the plan.
      await deps.stock.savePosition({
        ...position,
        onHand: subtractQuantity(position.onHand, consumed),
        reserved: subtractQuantity(position.reserved, reservation.quantity),
        updatedAt: at,
      });

      const settled: Reservation = { ...reservation, status: "consumed", settledAt: at };
      await deps.reservations.save(settled);

      const variance = subtractQuantity(consumed, reservation.quantity);

      return {
        ok: true,
        data: settled,
        events: [
          event<MaterialConsumedPayload>(
            "material.consumed",
            reservation.organizationId,
            reservation.materialId,
            at,
            {
              reservationId: reservation.reservationId,
              workOrderId: reservation.workOrderId,
              locationId: reservation.locationId,
              consumed,
              reserved: reservation.quantity,
              variance,
            },
          ),
        ],
      };
    },
  };
}

/** Everything a work order still holds. */
export async function heldForWorkOrder(
  deps: InventoryDeps,
  organizationId: string,
  workOrderId: string,
): Promise<Reservation[]> {
  const all = await deps.reservations.listByWorkOrder(organizationId, workOrderId);
  return all.filter((r) => r.status === "held");
}

/** Availability across a set of materials, in one pass over the ledger. */
export async function availabilityFor(
  deps: InventoryDeps,
  organizationId: string,
  materialIds: ReadonlyArray<string>,
) {
  const positions = await deps.stock.positions(organizationId, materialIds);
  return materialIds.map((materialId) => computeAvailability(materialId, positions));
}

function event<TPayload>(
  type: InventoryEvent["type"],
  organizationId: string,
  materialId: string,
  occurredAt: string,
  payload: TPayload,
): InventoryEvent<TPayload> {
  return { type, organizationId, materialId, occurredAt, payload };
}

function defaultId(prefix: string): () => string {
  return () => {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    return typeof g.crypto?.randomUUID === "function"
      ? `${prefix}_${g.crypto.randomUUID()}`
      : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  };
}
