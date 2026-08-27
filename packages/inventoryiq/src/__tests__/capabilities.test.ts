// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CapabilityError,
  createCapabilityResolver,
  expandCapabilities,
} from "@proworks-hub/contracts";

import {
  INVENTORY_OPERATIONS,
  INVENTORY_OPERATION_CAPABILITY,
  createInventoryGuard,
} from "../capabilities.js";

const ORG = "org-a";

const guardFor = (capabilities: string[], application = "makerops") =>
  createInventoryGuard({
    capabilities: createCapabilityResolver([
      { organizationId: ORG, application, capabilities },
    ]),
    application,
  });

describe("one engine, two tiers", () => {
  it("lets a maker on the entry tier do the whole of a small shop's job", async () => {
    // Counting what is on the rack and correcting it. Gating this would make
    // the engine useless at exactly the tier it exists to serve.
    const guard = guardFor([CAPABILITIES.inventory.basic]);

    await expect(guard.assert("read_availability", ORG)).resolves.toBeUndefined();
    await expect(guard.assert("adjust_stock", ORG)).resolves.toBeUndefined();
  });

  it("refuses that maker the features a one-person shop does not need", async () => {
    const guard = guardFor([CAPABILITIES.inventory.basic]);

    await expect(guard.assert("reserve", ORG)).rejects.toThrow(CapabilityError);
    await expect(guard.assert("read_across_locations", ORG)).rejects.toThrow();
    await expect(guard.assert("reorder_signals", ORG)).rejects.toThrow();
  });

  it("gives a shop that bought reservations the ability to settle them too", async () => {
    // A consumer that can make promises but not clear them accumulates
    // reservations nobody can settle — so release and consume ride the same
    // capability that created them.
    const guard = guardFor([CAPABILITIES.inventory.reservations], "proworks");

    for (const operation of ["reserve", "release", "consume"] as const) {
      await expect(guard.assert(operation, ORG)).resolves.toBeUndefined();
    }
  });

  it("carries the entry tier along with anything above it", async () => {
    // Granting reservations and forgetting basic would produce a shop that can
    // promise material it cannot count.
    const guard = guardFor([CAPABILITIES.inventory.reservations], "proworks");
    await expect(guard.assert("read_availability", ORG)).resolves.toBeUndefined();
  });

  it("treats variance as needing something to have reserved against", async () => {
    expect([...expandCapabilities([CAPABILITIES.inventory.consumptionVariance])]).toEqual(
      expect.arrayContaining([
        CAPABILITIES.inventory.basic,
        CAPABILITIES.inventory.reservations,
      ]),
    );
  });

  it("answers without throwing when a caller is deciding what to render", async () => {
    // A UI asking "should this button exist" should not have to catch.
    const guard = guardFor([CAPABILITIES.inventory.basic]);

    expect(await guard.allows("adjust_stock", ORG)).toBe(true);
    expect(await guard.allows("reserve", ORG)).toBe(false);
  });

  it("refuses an organization nobody granted anything", async () => {
    const guard = guardFor([CAPABILITIES.inventory.reservations]);
    await expect(guard.assert("read_availability", "org-unknown")).rejects.toThrow();
  });
});

describe("the operation catalogue", () => {
  it("prices every operation it names", () => {
    // An operation with no capability entry would be reachable by anyone. The
    // map is the enforcement, so a gap in it is a hole rather than a default.
    for (const operation of INVENTORY_OPERATIONS) {
      expect(INVENTORY_OPERATION_CAPABILITY[operation]).toBeTruthy();
    }
    expect(Object.keys(INVENTORY_OPERATION_CAPABILITY).sort()).toEqual(
      [...INVENTORY_OPERATIONS].sort(),
    );
  });

  it("names only capabilities that actually exist", () => {
    // A typo here fails open in the worst way: `requireCapability` refuses a
    // capability nobody can hold, so the feature is dead rather than exposed —
    // silently, and only for whoever bought that tier.
    const known = new Set<string>(Object.values(CAPABILITIES.inventory));
    for (const capability of Object.values(INVENTORY_OPERATION_CAPABILITY)) {
      expect(known.has(capability), `${capability} is not a declared capability`).toBe(true);
    }
  });
});
