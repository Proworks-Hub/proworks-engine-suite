// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import type { PriceObservation } from "@proworks/contracts";
import {
  costBasisToMaterialRate,
  priceObservationsToCostBasis,
} from "../adapters/priceObservationAdapter.js";

const now = new Date("2026-08-27T12:00:00Z");

const observation = (
  cents: number,
  observedOn: string,
  extra: Partial<PriceObservation> = {},
): PriceObservation => ({
  ownership: "canonical",
  itemKey: "a36 steel sheet 4x8x125",
  itemName: 'A36 steel sheet 4 x 8 x 0.125"',
  merchantKey: "metalsupermarkets",
  merchantName: "Metal Supermarkets",
  region: "US-CO",
  price: { cents, currency: "USD" },
  quantity: 1,
  unit: "each",
  unitPrice: { cents, currency: "USD" },
  onSale: false,
  saleType: null,
  observedOn,
  source: "receipt",
  confidence: 0.8,
  fingerprint: `fp|${observedOn}|${cents}`,
  ...extra,
});

describe("observed prices as a cost basis", () => {
  it("turns purchases into a material rate", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [observation(13800, "2026-08-26"), observation(14200, "2026-07-15"), observation(13600, "2026-06-02")],
      { now },
    )!;

    expect(basis.unitPriceCents).toBe(13800);
    expect(basis.observationCount).toBe(3);
    expect(basis.observedOn).toBe("2026-08-26");
    expect(costBasisToMaterialRate(basis).unitCost).toBe(138);
  });

  it("excludes sale prices and says that it did", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [
        observation(13800, "2026-08-26"),
        observation(14200, "2026-07-15"),
        observation(9900, "2026-08-01", { onSale: true, saleType: "other" }),
      ],
      { now },
    )!;

    expect(basis.observationCount).toBe(2);
    expect(basis.caveats.some((c) => /sale price/i.test(c))).toBe(true);
  });

  it("warns when it had to include sale prices", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [observation(13800, "2026-08-26"), observation(9900, "2026-08-01", { onSale: true })],
      { now },
    )!;
    expect(basis.caveats.some((c) => /too few regular observations/i.test(c))).toBe(true);
  });

  it("flags a stale price rather than quoting from it silently", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [observation(13800, "2026-01-02"), observation(13600, "2026-01-01")],
      { now },
    )!;
    expect(basis.ageDays).toBeGreaterThan(90);
    expect(basis.caveats.some((c) => /days old/i.test(c))).toBe(true);
  });

  it("says a single purchase is a transaction, not a market rate", () => {
    const basis = priceObservationsToCostBasis("a36 steel sheet 4x8x125", [observation(13800, "2026-08-26")], {
      now,
    })!;
    expect(basis.caveats.some((c) => /single purchase/i.test(c))).toBe(true);
  });

  it("refuses to produce a basis from prices beyond the window", () => {
    expect(
      priceObservationsToCostBasis("a36 steel sheet 4x8x125", [observation(13800, "2020-01-01")], { now }),
    ).toBeNull();
  });

  it("returns nothing when it has never seen the item", () => {
    expect(priceObservationsToCostBasis("unknown", [observation(13800, "2026-08-26")], { now })).toBeNull();
  });

  it("warns when observations mix units it cannot reconcile", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [observation(13800, "2026-08-26"), observation(300, "2026-08-20", { unit: "lb" })],
      { now },
    )!;
    expect(basis.caveats.some((c) => /mixed units/i.test(c))).toBe(true);
  });

  it("narrows to one supplier when asked", () => {
    const basis = priceObservationsToCostBasis(
      "a36 steel sheet 4x8x125",
      [
        observation(13800, "2026-08-26"),
        observation(15000, "2026-08-25", { merchantKey: "grainger", merchantName: "Grainger" }),
      ],
      { merchantKey: "grainger", now },
    )!;
    expect(basis.merchantName).toBe("Grainger");
    expect(basis.unitPriceCents).toBe(15000);
  });

  it("carries its caveats into the assumptions a quote would state", () => {
    const basis = priceObservationsToCostBasis("a36 steel sheet 4x8x125", [observation(13800, "2026-08-26")], {
      now,
    })!;
    const rate = costBasisToMaterialRate(basis);
    expect(rate.assumptions[0]).toMatch(/observed purchase/i);
    expect(rate.assumptions.length).toBeGreaterThan(1);
  });
});
