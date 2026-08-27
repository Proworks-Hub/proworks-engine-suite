// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import {
  CAPABILITIES,
  requireCapability,
  type CapabilityResolver,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// What each inventory operation costs, in entitlement.
//
// InventoryIQ is an engine — it owns quantity truth as an independent domain,
// and a shop running someone else's ERP could license it alone. It is also
// MODULAR: the same engine serves a maker counting sheets on one rack and a
// shop reserving material across three rooms, with the difference expressed as
// capabilities rather than as two codebases.
//
// That distinction is the whole reason this file exists. The alternative — a
// BasicInventoryEngine and an AdvancedInventoryEngine — duplicates the
// arithmetic that must never disagree between tiers, and the day they diverge
// is the day a maker's available count stops matching the shop's.
//
// WHY THE GUARD IS COMPOSED RATHER THAN BAKED IN. The use cases do not take a
// resolver. A host wires this where it wires everything else, and the engine
// stays usable by a caller that has no entitlement system at all — a test, a
// single-tenant deployment, a shop that bought everything. Baking it in would
// make an unwired deployment silently unentitled, which is the mirror of the
// bug it would be trying to prevent.
//
// The tracking service made the opposite choice and was right to: it was a new
// surface, so failing closed cost nothing. Here, failing closed by default
// would break every existing consumer of a working engine.
// ─────────────────────────────────────────────────────────────────────────────

export const INVENTORY_OPERATIONS = [
  "read_availability",
  "adjust_stock",
  "read_across_locations",
  "reserve",
  "release",
  "consume",
  "reorder_signals",
  "consumption_variance",
] as const;

export type InventoryOperation = (typeof INVENTORY_OPERATIONS)[number];

/**
 * The capability each operation requires.
 *
 * Reading what is on hand is `basic` — it is the whole of a small maker's need,
 * and gating it would make the engine useless at the entry tier it exists to
 * serve. Promising material to a job is `reservations`, because that is the
 * feature a one-person shop genuinely does not need and a busy one cannot work
 * without.
 */
export const INVENTORY_OPERATION_CAPABILITY: Readonly<
  Record<InventoryOperation, string>
> = Object.freeze({
  read_availability: CAPABILITIES.inventory.basic,
  adjust_stock: CAPABILITIES.inventory.basic,
  read_across_locations: CAPABILITIES.inventory.multiLocation,
  reserve: CAPABILITIES.inventory.reservations,
  // Release and consume settle a reservation, so they require the same
  // capability that created it. A consumer able to make promises but not to
  // settle them would accumulate reservations nobody can clear.
  release: CAPABILITIES.inventory.reservations,
  consume: CAPABILITIES.inventory.reservations,
  reorder_signals: CAPABILITIES.inventory.replenishment,
  consumption_variance: CAPABILITIES.inventory.consumptionVariance,
});

export interface InventoryGuard {
  /** Throws `CapabilityError` unless the organization may perform it. */
  assert(operation: InventoryOperation, organizationId: string): Promise<void>;
  /** Non-throwing, for deciding whether to render a control. */
  allows(operation: InventoryOperation, organizationId: string): Promise<boolean>;
}

export interface InventoryGuardDeps {
  readonly capabilities: CapabilityResolver;
  /** The consuming application, for the capability lookup. */
  readonly application: string;
}

/**
 * A guard a host composes around the use cases.
 *
 * The resolver is REQUIRED here, unlike on the use cases themselves. A host
 * that has decided to enforce entitlements has to say what it is enforcing
 * against; an optional resolver on a thing whose only job is enforcement would
 * be a guard that guards nothing.
 */
export function createInventoryGuard(deps: InventoryGuardDeps): InventoryGuard {
  return {
    async assert(operation, organizationId) {
      await requireCapability(
        deps.capabilities,
        organizationId,
        deps.application,
        INVENTORY_OPERATION_CAPABILITY[operation],
      );
    },

    async allows(operation, organizationId) {
      try {
        await requireCapability(
          deps.capabilities,
          organizationId,
          deps.application,
          INVENTORY_OPERATION_CAPABILITY[operation],
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}
