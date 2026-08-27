// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import { assertNoIdentityFields, type NormalizedReceipt } from "@proworks-hub/contracts";
import { contributeObservations } from "../boundary/contribute.js";
import { normalizeReceipt } from "../normalizeReceipt.js";

// ─────────────────────────────────────────────────────────────────────────────
// The privacy boundary is the one thing in this engine that cannot be allowed
// to regress quietly, so it is tested as behaviour rather than trusted as
// design. These are the portable equivalent of the guard Family Table's shared
// database runs at install time.
// ─────────────────────────────────────────────────────────────────────────────

const householdReceipt = (): NormalizedReceipt =>
  normalizeReceipt(
    {
      merchant: "HOME DEPOT #1234",
      regionText: "Brighton, CO",
      date: "2026-08-26",
      items: [
        { name: '1/8" steel flat bar', price: 37.94, qty: 2, sku: "123456" },
        { name: "Sales Tax", price: 2.47, isTax: true },
      ],
    },
    { ownerRef: "household-abc-123", ownership: "tenant-private" },
  );

describe("assertNoIdentityFields", () => {
  it("refuses a household identifier", () => {
    expect(() => assertNoIdentityFields({ householdId: "abc" })).toThrow(/must not identify/i);
  });

  it("refuses one nested inside metadata", () => {
    expect(() => assertNoIdentityFields({ meta: { deep: { user_email: "a@b.c" } } })).toThrow();
  });

  it("refuses one hidden inside an array", () => {
    expect(() => assertNoIdentityFields({ rows: [{ ok: 1 }, { created_by: "x" }] })).toThrow();
  });

  it("allows an ordinary canonical record", () => {
    expect(() =>
      assertNoIdentityFields({ itemKey: "steel bar", merchantKey: "homedepot", region: "US-CO" }),
    ).not.toThrow();
  });
});

describe("the contribution boundary", () => {
  it("shares nothing without an opt-in", () => {
    const result = contributeObservations(householdReceipt(), { optedIn: false });
    expect(result.observations).toHaveLength(0);
    expect(result.withheld.every((w) => /not opted in/.test(w.reason))).toBe(true);
  });

  it("shares nothing without a region", () => {
    const receipt = normalizeReceipt(
      { merchant: "Home Depot", date: "2026-08-26", items: [{ name: "bolt", price: 1.5 }] },
      { ownerRef: "household-abc", ownership: "tenant-private" },
    );
    const result = contributeObservations(receipt, { optedIn: true });
    expect(result.observations).toHaveLength(0);
    expect(result.withheld[0]!.reason).toMatch(/no region/);
  });

  it("carries no trace of the owner or the receipt across", () => {
    const receipt = householdReceipt();
    const { observations } = contributeObservations(receipt, { optedIn: true });

    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(() => assertNoIdentityFields(observation)).not.toThrow();

      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain(receipt.ownerRef);
      expect(serialized).not.toContain(receipt.fingerprint);
      expect(serialized).not.toContain("household");

      // Nothing finer than a date, and nothing finer than a state.
      expect(observation.observedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(observation.region).toBe("US-CO");
    }
  });

  it("does not contribute tax as if it were a product", () => {
    const { observations, withheld } = contributeObservations(householdReceipt(), { optedIn: true });
    expect(observations.some((o) => /tax/i.test(o.itemName))).toBe(false);
    expect(withheld.some((w) => w.reason === "tax is not a product")).toBe(true);
  });

  it("gives the same fact the same fingerprint, so two hosts dedupe to one", () => {
    const fromFamilyTable = contributeObservations(householdReceipt(), { optedIn: true });

    // The same purchase, captured by a different application with its own
    // owner, its own tenant, and the merchant printed differently.
    const fromProWorks = contributeObservations(
      normalizeReceipt(
        {
          merchant: "THE HOME DEPOT 4512",
          regionText: "COLORADO SPRINGS CO 80903",
          date: "2026-08-26",
          items: [{ name: '1/8" steel flat bar', price: 37.94, qty: 2, sku: "123456" }],
        },
        { ownerRef: "shop-xyz-789", ownership: "host-private" },
      ),
      { optedIn: true },
    );

    expect(fromFamilyTable.observations[0]!.merchantKey).toBe(
      fromProWorks.observations[0]!.merchantKey,
    );
    expect(fromFamilyTable.observations[0]!.itemKey).toBe(fromProWorks.observations[0]!.itemKey);
    // Same item, same chain, same day, same unit price — one fact.
    expect(fromFamilyTable.observations[0]!.fingerprint).toBe(
      fromProWorks.observations[0]!.fingerprint,
    );
  });

  it("lets a host withhold specific lines", () => {
    const { observations } = contributeObservations(householdReceipt(), {
      optedIn: true,
      lineFilter: (line) => !/steel/i.test(line.name),
    });
    expect(observations).toHaveLength(0);
  });
});

describe("normalized receipts stay private", () => {
  it("is always classified as private, never canonical", () => {
    expect(householdReceipt().ownership).toBe("tenant-private");
  });

  it("has nowhere to put a receipt image", () => {
    expect(Object.keys(householdReceipt())).not.toContain("image");
    expect(JSON.stringify(householdReceipt())).not.toMatch(/base64|imageUrl/i);
  });
});
