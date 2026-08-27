// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// What a given consumer is allowed to do.
//
// This exists so a capability is built ONCE and different amounts of it are
// exposed to different products — rather than growing a MakerOpsWorkOrderEngine
// beside a ProWorksWorkOrderEngine and maintaining the same bug twice.
//
// It replaces the rule that rots: `if (subscription === "proworks")` scattered
// through domain logic. That couples the domain to a price list, and a price
// list changes far more often than a domain does.
//
// Two things this is deliberately NOT:
//
//   NOT a feature flag. A flag answers "is this rolled out yet?" and is
//   temporary by nature. A capability answers "is this consumer entitled to
//   it?" and is permanent. Conflating them makes a rollout toggle load-bearing
//   for billing.
//
//   NOT a UI concern. Hiding a button is presentation; refusing the operation
//   is authorization. An entitlement checked only in a UI is not checked.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capability names are `engine.capability`, lowercase.
 *
 * Named for what a consumer can DO, never for what they paid. `workorder.basic`
 * survives a repackaging; `workorder.starter_tier` does not.
 */
export const capabilitySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, "capability must look like workorder.basic");

/**
 * The capabilities the suite defines today.
 *
 * Progressive within each engine, not separate systems: `workorder.routing`
 * assumes `workorder.digital`, which assumes `workorder.basic`. One domain,
 * with more of it unlocked.
 */
export const CAPABILITIES = {
  workOrder: {
    /** Create one, put line items on it, mark it done. The whole of a small shop's needs. */
    basic: "workorder.basic",
    /** Render it to something printable, to carry around the shop. */
    print: "workorder.print",
    /** Status that moves as work happens, not one field somebody remembers to change. */
    digital: "workorder.digital",
    /** Steps, milestones, completion — a work order that knows where it is. */
    productionTracking: "workorder.production_tracking",
    /** Which station types can perform each step. */
    routing: "workorder.routing",
    /** Which physical machine, given what is free. */
    machineAssignment: "workorder.machine_assignment",
    scheduling: "workorder.scheduling",
    /** Operators working against it live, on the floor. */
    shopFloor: "workorder.shop_floor",
  },
  forgeIq: {
    basic: "forgeiq.basic",
    builder: "forgeiq.builder",
    manufacturing: "forgeiq.manufacturing",
  },
  costIq: {
    /** Material, labour, a suggested price. What a maker actually asks for. */
    basic: "costiq.basic",
    /** Waste, overhead, setup, margin, estimate-versus-actual. */
    advanced: "costiq.advanced",
    realtime: "costiq.realtime",
  },
  inventory: {
    /** What is on hand, and correcting it. A maker counting sheets on a rack. */
    basic: "inventory.basic",
    /** More than one place to look. A shop with a rack, a shelf and a back room. */
    multiLocation: "inventory.multi_location",
    /** Promising material to a job before it is used, so two jobs cannot claim it. */
    reservations: "inventory.reservations",
    /** Reorder points and the signals that come off them. */
    replenishment: "inventory.reorder",
    /** Reserved versus actually used — the shop's real waste rate. */
    consumptionVariance: "inventory.consumption_variance",
  },
  receipt: {
    capture: "receipts.capture",
    costIntelligence: "receipts.cost_intelligence",
  },
  prime: {
    /** Coordinate a workflow across engines. */
    orchestration: "prime.orchestration",
    automation: "prime.automation",
  },
} as const;

/** Capabilities implied by holding another one. */
const IMPLIED: Readonly<Record<string, readonly string[]>> = {
  "workorder.print": ["workorder.basic"],
  "workorder.digital": ["workorder.basic"],
  "workorder.production_tracking": ["workorder.basic", "workorder.digital"],
  "workorder.routing": ["workorder.basic", "workorder.digital"],
  "workorder.machine_assignment": ["workorder.basic", "workorder.digital", "workorder.routing"],
  "workorder.scheduling": ["workorder.basic", "workorder.digital", "workorder.routing"],
  "workorder.shop_floor": ["workorder.basic", "workorder.digital", "workorder.production_tracking"],
  "forgeiq.builder": ["forgeiq.basic"],
  "forgeiq.manufacturing": ["forgeiq.basic", "forgeiq.builder"],
  "costiq.advanced": ["costiq.basic"],
  "costiq.realtime": ["costiq.basic", "costiq.advanced"],
  "inventory.multi_location": ["inventory.basic"],
  "inventory.reorder": ["inventory.basic"],
  "inventory.reservations": ["inventory.basic"],
  // Variance is reserved-versus-used, so it is meaningless without something
  // to have reserved against.
  "inventory.consumption_variance": ["inventory.basic", "inventory.reservations"],
  "receipts.cost_intelligence": ["receipts.capture"],
  "prime.automation": ["prime.orchestration"],
};

/**
 * Expands a granted set to include everything those grants imply.
 *
 * Without this, granting `workorder.shop_floor` and forgetting
 * `workorder.basic` produces a consumer who can run a shop floor but cannot
 * create a work order — a bug that appears only in whichever tier somebody
 * configured hastily.
 */
export function expandCapabilities(granted: readonly string[]): ReadonlySet<string> {
  const all = new Set<string>();
  const add = (capability: string): void => {
    if (all.has(capability)) return;
    all.add(capability);
    for (const implied of IMPLIED[capability] ?? []) add(implied);
  };
  for (const capability of granted) add(capability);
  return all;
}

/** What a consumer holds, resolved by a host from whatever it bills on. */
export const capabilityGrantSchema = z
  .object({
    organizationId: z.string().min(1),
    /** Which application is asking. One org may hold different sets per app. */
    application: z.string().min(1),
    capabilities: z.array(capabilitySchema).default([]),
    /** When these lapse. Absent means they do not. */
    expiresAt: z.string().optional(),
  })
  .strict();
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

/**
 * Raised when an operation needs a capability the caller does not hold.
 *
 * Carries what was needed, so "why can I not do this?" is answered by the error
 * rather than by somebody's memory of the pricing page. Permanent by
 * classification — retrying will not grant an entitlement.
 */
export class CapabilityError extends Error {
  readonly transient = false as const;
  constructor(
    readonly capability: string,
    readonly organizationId: string,
  ) {
    super(
      `"${organizationId}" does not hold "${capability}". ` +
        `This is an entitlement, not a bug: the operation exists and is refused.`,
    );
    this.name = "CapabilityError";
  }
}

/**
 * Answers whether a consumer may use a capability.
 *
 * A port: a host resolves it from subscriptions, licences or a config file, and
 * no engine learns what any of those look like.
 */
export interface CapabilityResolver {
  granted(
    organizationId: string,
    application: string,
  ): ReadonlySet<string> | Promise<ReadonlySet<string>>;
}

/**
 * Throws unless the capability is held.
 *
 * Called at the DOMAIN boundary, not in a UI. A restricted feature that is
 * merely hidden is available to anyone who opens the network tab.
 */
export async function requireCapability(
  resolver: CapabilityResolver,
  organizationId: string,
  application: string,
  capability: string,
): Promise<void> {
  const granted = await resolver.granted(organizationId, application);
  if (!granted.has(capability)) throw new CapabilityError(capability, organizationId);
}

/** A resolver over a fixed set of grants. Enough for a host with a config file. */
export function createCapabilityResolver(grants: readonly CapabilityGrant[]): CapabilityResolver {
  const index = new Map<string, ReadonlySet<string>>();
  for (const grant of grants) {
    index.set(
      `${grant.organizationId}|${grant.application}`,
      expandCapabilities(grant.capabilities),
    );
  }
  return {
    granted: (organizationId, application) =>
      index.get(`${organizationId}|${application}`) ?? new Set<string>(),
  };
}
