// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { InventorySignal } from "@proworks-hub/contracts";

import type { Availability, Shortage } from "./availability.js";

// ─────────────────────────────────────────────────────────────────────────────
// InventoryIQ's answer to Prime.
//
// `DecisionContext.inventory` has existed since Prime was written and nothing
// ever produced it — the decision engine has been asking "is there material"
// and getting silence. This is the producer.
//
// The mapping lives here, with the engine that owns the availability
// vocabulary, for the same reason the milestone→stage mapping lives with
// WorkOrderIQ: the compiler then forces this one file to change when the
// internal shape does, and it is the only place an external contract is built.
// ─────────────────────────────────────────────────────────────────────────────

export interface ToInventorySignalInput {
  readonly availability: Availability;
  /**
   * The category Prime and ForgeIQ speak in.
   *
   * Deliberately supplied rather than derived. A material id is inventory's
   * key; a category is the plan's word for a class of material, and mapping
   * between them is a host's decision about its own catalogue.
   */
  readonly materialCategory: string;
  /** Present when this material was checked against a specific requirement. */
  readonly shortage?: Shortage;
}

/**
 * Turns availability into the signal Prime reads.
 *
 * `onHandSheets` is only populated when the material is genuinely counted in
 * sheets. Reporting square feet in a field named for sheets would be a number
 * that reads correctly and means something else — the exact failure the unit
 * types in this engine exist to prevent, reintroduced at the boundary.
 */
export function toInventorySignal(input: ToInventorySignalInput): InventorySignal {
  const { availability, shortage } = input;

  const sufficient = shortage === undefined;
  const note = describe(availability, shortage);

  return {
    materialCategory: input.materialCategory,
    ...(availability.unit === "sheet" ? { onHandSheets: availability.available.amount } : {}),
    sufficient,
    ...(note ? { note } : {}),
  };
}

/**
 * A sentence a human can act on.
 *
 * Prime decides from `sufficient`; the note is for whoever reads the decision
 * afterwards and wants to know why it went that way. "Blocked" with no reason
 * is a support ticket.
 */
function describe(availability: Availability, shortage?: Shortage): string | undefined {
  if (shortage?.unknownMaterial) {
    return `${shortage.materialId} is not stocked at any location`;
  }
  if (shortage) {
    return (
      `short ${shortage.short.amount} ${shortage.short.unit} — ` +
      `${shortage.required.amount} required, ${shortage.available.amount} available`
    );
  }
  if (availability.oversold) {
    // Available is zero here, so a caller looking only at the number would
    // report a shortage. It is worse than a shortage: promises already made
    // cannot all be kept.
    return (
      `oversold — ${availability.reserved.amount} ${availability.unit} reserved ` +
      `against ${availability.onHand.amount} on hand`
    );
  }
  return undefined;
}
