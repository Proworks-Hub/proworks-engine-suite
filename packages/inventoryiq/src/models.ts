// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// What a shop has, in units it can actually count.
//
// TWO DECISIONS HERE DO MOST OF THE WORK.
//
// 1. A QUANTITY CARRIES ITS UNIT, and arithmetic across units throws.
//    Inventory bugs are overwhelmingly unit bugs: someone subtracts linear feet
//    from square feet and the number stays plausible for months. A bare number
//    cannot refuse that. This can.
//
// 2. QUANTITIES ACCUMULATE AS INTEGERS. Material amounts are genuinely
//    fractional — 12.5 sq ft, 0.75 lb — so they cannot be integers at the
//    surface. But a running balance is added to and subtracted from hundreds of
//    times as reservations come and go, and binary floats drift under exactly
//    that pattern: a stock level that should be zero reads 1e-14, "is anything
//    left" answers yes, and a work order is released to a station with no
//    material. So the public API takes decimals and every accumulation happens
//    in thousandths as integers.
//
//    Thousandths, not cents: a thousandth of a sheet or a pound is finer than
//    any shop measures, and the numbers stay far inside safe integer range.
// ─────────────────────────────────────────────────────────────────────────────

export const unitOfMeasureSchema = z.enum([
  "each",
  "sheet",
  "roll",
  "linear_ft",
  "sq_ft",
  "linear_m",
  "sq_m",
  "lb",
  "kg",
  "oz",
  "g",
  "ml",
  "l",
  "yard",
  "hour",
]);
export type UnitOfMeasure = z.infer<typeof unitOfMeasureSchema>;

export const quantitySchema = z
  .object({
    amount: z.number().finite(),
    unit: unitOfMeasureSchema,
  })
  .strict();
export type Quantity = z.infer<typeof quantitySchema>;

/** Raised when two quantities that cannot be combined are combined. */
export class UnitMismatchError extends Error {
  constructor(
    readonly left: UnitOfMeasure,
    readonly right: UnitOfMeasure,
  ) {
    super(
      `cannot combine a quantity in ${left} with one in ${right}; ` +
        `convert explicitly, because guessing is how stock goes wrong quietly`,
    );
    this.name = "UnitMismatchError";
  }
}

const SCALE = 1000;

/** Decimal amount to integer thousandths, rounded to the nearest. */
export const toMilli = (amount: number): number => Math.round(amount * SCALE);

/** Integer thousandths back to a decimal amount. */
export const fromMilli = (milli: number): number => milli / SCALE;

export const quantity = (amount: number, unit: UnitOfMeasure): Quantity => ({ amount, unit });

export const zeroQuantity = (unit: UnitOfMeasure): Quantity => ({ amount: 0, unit });

function assertSameUnit(a: Quantity, b: Quantity): void {
  if (a.unit !== b.unit) throw new UnitMismatchError(a.unit, b.unit);
}

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  assertSameUnit(a, b);
  return { amount: fromMilli(toMilli(a.amount) + toMilli(b.amount)), unit: a.unit };
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  assertSameUnit(a, b);
  return { amount: fromMilli(toMilli(a.amount) - toMilli(b.amount)), unit: a.unit };
}

/** Sums quantities, refusing a mixed-unit list. An empty list needs a unit. */
export function sumQuantities(
  quantities: ReadonlyArray<Quantity>,
  unit: UnitOfMeasure,
): Quantity {
  let total = 0;
  for (const q of quantities) {
    if (q.unit !== unit) throw new UnitMismatchError(unit, q.unit);
    total += toMilli(q.amount);
  }
  return { amount: fromMilli(total), unit };
}

/** Negative, zero, positive — the sign of `a - b`. */
export function compareQuantity(a: Quantity, b: Quantity): number {
  assertSameUnit(a, b);
  return toMilli(a.amount) - toMilli(b.amount);
}

export const isZeroQuantity = (q: Quantity): boolean => toMilli(q.amount) === 0;
export const isNegativeQuantity = (q: Quantity): boolean => toMilli(q.amount) < 0;

// ---------- Material ----------

/**
 * A material as inventory refers to it.
 *
 * Identity only — no cost. What a shop paid for a roll is CostIQ's and
 * ReceiptIQ's business, and putting a price here would create a second,
 * quietly diverging answer to what something costs.
 */
export const materialRefSchema = z
  .object({
    materialId: z.string().min(1),
    /** What the floor calls it. */
    name: z.string().min(1),
    unit: unitOfMeasureSchema,
    /** Supplier part number, for reordering. */
    sku: z.string().optional(),
    category: z.string().optional(),
  })
  .strict();
export type MaterialRef = z.infer<typeof materialRefSchema>;

// ---------- Stock ----------

/**
 * What is physically at one location for one material.
 *
 * `onHand` and `reserved` are separate on purpose, and both are facts rather
 * than a derived pair. On-hand changes when material physically moves;
 * reserved changes when a promise is made. Storing only a net "available"
 * loses the ability to answer why nothing is available, which is the question
 * anybody actually asks.
 */
export const stockPositionSchema = z
  .object({
    materialId: z.string().min(1),
    organizationId: z.string().min(1),
    /** A bin, shelf, rack or room. One shop, many places to look. */
    locationId: z.string().min(1),
    onHand: quantitySchema,
    reserved: quantitySchema,
    /** Below this, reorder. Absent when nobody has set one. */
    reorderPoint: quantitySchema.optional(),
    reorderQuantity: quantitySchema.optional(),
    updatedAt: z.string().datetime(),
    /**
     * Optimistic concurrency. Incremented by the LEDGER on every write.
     *
     * Added because `reserveMaterial` read a position, awaited, then wrote an
     * unconditional overwrite. Concurrent reserves for one (org, material,
     * location) all read the same figure and overwrote each other: two
     * reserves of 8 against 10 on hand were BOTH granted, sixteen sheets were
     * promised, and the ledger reported 8. Since `insufficient_stock` is
     * decided against that under-counted figure, the engine went on approving
     * holds for material already spoken for.
     *
     * `updatedAt` could not serve as the token. Two writes inside the same
     * millisecond carry the same timestamp — which is not a theoretical
     * concern, it is what every test with a fixed clock does — and a
     * compare-and-set on equal timestamps succeeds when it must fail.
     *
     * Defaulted so every existing caller and stored row starts at 0 rather
     * than being unversioned, which would compare as `undefined` and match
     * nothing.
     */
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type StockPosition = z.infer<typeof stockPositionSchema>;
/**
 * A position as a caller supplies one, before defaults are applied.
 *
 * `version` is omitted here and required on the parsed type. That asymmetry is
 * the point: nobody hands the ledger a version, and everybody reads one back.
 */
export type StockPositionInput = z.input<typeof stockPositionSchema>;

/**
 * Raised when a save states a version that is no longer current.
 *
 * A distinct type, because the correct response is to reload and reconsider
 * rather than retry the same write — and a caller cannot tell that apart from
 * a generic failure. The same shape `WorkflowConflictError` already uses.
 */
export class StockConflictError extends Error {
  readonly transient = true as const;
  constructor(
    readonly materialId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Stock position for ${materialId} changed underneath: expected version ${expectedVersion}, ` +
        `found ${actualVersion}. Reload it and decide again rather than retrying this write.`,
    );
    this.name = "StockConflictError";
  }
}

/**
 * A promise that some material is spoken for.
 *
 * Held against a work order, so releasing one is possible without knowing what
 * else that work order reserved.
 */
export const reservationSchema = z
  .object({
    reservationId: z.string().min(1),
    organizationId: z.string().min(1),
    materialId: z.string().min(1),
    locationId: z.string().min(1),
    /** What the material is spoken for. */
    workOrderId: z.string().min(1),
    quantity: quantitySchema,
    status: z.enum(["held", "consumed", "released"]),
    createdAt: z.string().datetime(),
    settledAt: z.string().datetime().optional(),
  })
  .strict();
export type Reservation = z.infer<typeof reservationSchema>;
