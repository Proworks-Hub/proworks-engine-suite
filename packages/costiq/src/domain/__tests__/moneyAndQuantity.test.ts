/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, toString } from "../decimal.js";
import {
  DEFAULT_ROUNDING_POLICY,
  addMoney,
  allocateMoney,
  assertCurrencyCode,
  compareMoney,
  divideMoney,
  isPayable,
  minorUnitsFor,
  money,
  moneyCanonical,
  moneyFromString,
  moneyToString,
  multiplyMoney,
  percent,
  quantize,
  subtractMoney,
  sumMoney,
  zeroMoney,
  type CurrencyPrecisionProvider,
} from "../money.js";
import {
  addQuantity,
  areCompatible,
  convertQuantity,
  createUnitRegistry,
  quantityCanonical,
  quantityFromString,
  rateMultiplier,
  scaleQuantity,
  sumQuantity,
  unitDefinition,
  unitRate,
} from "../quantity.js";

// ─────────────────────────────────────────────────────────────────────────────
// The two silent failures a cost engine dies of.
//
// Currency confusion produces a total that sums correctly and means nothing.
// Unit confusion produces an answer a thousand times wrong that still looks
// plausible. Neither announces itself, so both are refused structurally rather
// than checked for later.
// ─────────────────────────────────────────────────────────────────────────────

const gbp = (t: string) => moneyFromString(t, "GBP");

describe("money will not mix currencies", () => {
  it("refuses to add across currencies", () => {
    expect(() => addMoney(gbp("10"), moneyFromString("10", "USD"))).toThrow(/Cannot add GBP and USD/);
  });

  it("refuses even when one side is zero", () => {
    // The tempting exception, and exactly how a currency error enters a total:
    // a zero accumulator would let the FIRST addition set the currency and
    // hide every later mismatch.
    expect(() => addMoney(zeroMoney("GBP"), moneyFromString("10", "USD"))).toThrow(/Cannot add/);
  });

  it("refuses to compare or subtract across currencies", () => {
    expect(() => subtractMoney(gbp("10"), moneyFromString("1", "EUR"))).toThrow();
    expect(() => compareMoney(gbp("10"), moneyFromString("1", "EUR"))).toThrow();
  });

  it("refuses to sum a foreign amount into a total", () => {
    expect(() => sumMoney([gbp("1"), moneyFromString("1", "USD")], "GBP")).toThrow(/Cannot sum USD/);
  });

  it("sums an empty list to a correctly denominated zero", () => {
    // The currency is stated rather than taken from the first element, so an
    // empty sum still knows what it is zero of.
    expect(moneyToString(sumMoney([], "JPY"))).toBe("0 JPY");
  });

  it("rejects anything that is not an ISO 4217 code", () => {
    for (const bad of ["gbp", "GB", "GBPX", "", "123"]) {
      expect(() => assertCurrencyCode(bad)).toThrow(/ISO 4217/);
    }
  });
});

describe("currencies do not all have two decimals", () => {
  it("knows the zero-decimal currencies", () => {
    // ¥100.50 is not an amount that exists.
    expect(minorUnitsFor("JPY")).toBe(0);
    expect(minorUnitsFor("KRW")).toBe(0);
    expect(moneyToString(quantize(moneyFromString("100.50", "JPY")))).toBe("100 JPY");
  });

  it("knows the three-decimal currencies", () => {
    expect(minorUnitsFor("KWD")).toBe(3);
    expect(moneyToString(quantize(moneyFromString("1.23456", "KWD")))).toBe("1.235 KWD");
  });

  it("REFUSES an unknown currency instead of assuming two", () => {
    // The whole point. A mistyped or unlisted code must not silently become a
    // two-decimal currency and round wrongly forever.
    expect(() => minorUnitsFor("XYZ")).toThrow(/not configured/);
    expect(() => quantize(moneyFromString("1.005", "XYZ"))).toThrow(/not configured/);
  });

  it("lets a host register its own precision", () => {
    const provider: CurrencyPrecisionProvider = { minorUnits: (c) => (c === "XYZ" ? 4 : null) };
    expect(moneyToString(quantize(moneyFromString("1.23456", "XYZ"), DEFAULT_ROUNDING_POLICY, provider))).toBe(
      "1.2346 XYZ",
    );
  });
});

describe("precision during calculation is not precision at payment", () => {
  it("keeps sub-penny precision until something quantizes it", () => {
    // A unit cost of £0.001234 per gram is real. Rounding it to £0.00 mid
    // calculation is how a thousand line items each lose a fraction.
    const unitCost = gbp("0.001234");
    const total = multiplyMoney(unitCost, fromString("10000"));
    expect(moneyToString(total)).toBe("12.340000 GBP");
    expect(moneyToString(quantize(total))).toBe("12.34 GBP");
  });

  it("shows the drift that per-component rounding causes", () => {
    // The reason RoundingStage is recorded. Rounding each line then summing
    // gives a different answer from summing then rounding, and an auditor
    // asking why a total is a penny out needs to know which happened.
    const lines = ["0.004", "0.004", "0.004", "0.004", "0.004"].map(gbp);
    const roundedEach = sumMoney(lines.map((l) => quantize(l)), "GBP");
    const roundedTotal = quantize(sumMoney(lines, "GBP"));
    expect(moneyToString(roundedEach)).toBe("0.00 GBP");
    expect(moneyToString(roundedTotal)).toBe("0.02 GBP");
  });

  it("knows whether an amount is payable as it stands", () => {
    expect(isPayable(gbp("12.34"))).toBe(true);
    expect(isPayable(gbp("12.345"))).toBe(false);
    expect(isPayable(moneyFromString("100", "JPY"))).toBe(true);
    expect(isPayable(moneyFromString("100.5", "JPY"))).toBe(false);
  });

  it("defaults to rounding once, on the total, at the currency's precision", () => {
    expect(DEFAULT_ROUNDING_POLICY.stage).toBe("TOTAL");
    expect(DEFAULT_ROUNDING_POLICY.mode).toBe("HALF_EVEN");
    expect(DEFAULT_ROUNDING_POLICY.scale).toBeNull();
  });
});

describe("money arithmetic that exists and money arithmetic that does not", () => {
  it("multiplies by a dimensionless factor", () => {
    expect(moneyToString(multiplyMoney(gbp("12.50"), fromString("3")))).toBe("37.50 GBP");
  });

  it("divides with an explicit scale and mode", () => {
    expect(moneyToString(divideMoney(gbp("10.00"), fromString("3"), 2, "HALF_EVEN"))).toBe("3.33 GBP");
  });

  it("turns a percentage into a fraction", () => {
    expect(toString(percent("7.5"))).toBe("0.075");
    expect(toString(percent("100"))).toBe("1.00");
    expect(moneyToString(multiplyMoney(gbp("200.00"), percent("15")))).toBe("30.0000 GBP");
  });

  it("hashes equal amounts identically however they were written", () => {
    // A calculation fingerprint must not change when nothing about the money
    // did.
    expect(moneyCanonical(gbp("12.30"))).toBe(moneyCanonical(gbp("12.3")));
    expect(moneyCanonical(gbp("12.30"))).toBe("12.3 GBP");
  });
});

describe("allocating money loses nothing", () => {
  it("splits at the currency's own precision", () => {
    const parts = allocateMoney(gbp("100.00"), [fromString("1"), fromString("1"), fromString("1")]);
    expect(parts.map(moneyToString)).toEqual(["33.34 GBP", "33.33 GBP", "33.33 GBP"]);
    expect(moneyToString(sumMoney(parts, "GBP"))).toBe("100.00 GBP");
  });

  it("splits a zero-decimal currency in whole units", () => {
    const parts = allocateMoney(moneyFromString("100", "JPY"), [fromString("1"), fromString("1"), fromString("1")]);
    expect(parts.map(moneyToString)).toEqual(["34 JPY", "33 JPY", "33 JPY"]);
    expect(moneyToString(sumMoney(parts, "JPY"))).toBe("100 JPY");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("quantities will not mix units", () => {
  it("refuses to add different units", () => {
    expect(() => addQuantity(quantityFromString("1", "kg"), quantityFromString("1", "g"))).toThrow(
      /Cannot add kg and g/,
    );
  });

  it("refuses to sum a foreign unit into a total", () => {
    expect(() => sumQuantity([quantityFromString("1", "kg"), quantityFromString("1", "lb")], "kg")).toThrow(
      /Cannot sum lb/,
    );
  });

  it("treats a count as a real unit, not a bare number", () => {
    // Five of something is not five kilograms. Letting a dimensionless number
    // be compatible with everything is how unit checks get bypassed.
    expect(() => addQuantity(quantityFromString("5", "each"), quantityFromString("5", "kg"))).toThrow();
    expect(areCompatible("each", "kg")).toBe(false);
  });
});

describe("conversion is explicit and dimensionally honest", () => {
  it("converts within a dimension", () => {
    expect(quantityCanonical(convertQuantity(quantityFromString("1", "kg"), "g", 6, "HALF_EVEN"))).toBe("1000 g");
    expect(quantityCanonical(convertQuantity(quantityFromString("500", "g"), "kg", 6, "HALF_EVEN"))).toBe("0.5 kg");
    expect(quantityCanonical(convertQuantity(quantityFromString("2", "h"), "min", 6, "HALF_EVEN"))).toBe("120 min");
  });

  it("uses the exact international imperial definitions", () => {
    // An inch is exactly 25.4 mm and a pound exactly 453.59237 g. These are
    // definitions, not approximations, and a cost engine should use them as
    // such.
    expect(quantityCanonical(convertQuantity(quantityFromString("1", "in"), "mm", 6, "HALF_EVEN"))).toBe("25.4 mm");
    expect(quantityCanonical(convertQuantity(quantityFromString("1", "lb"), "g", 6, "HALF_EVEN"))).toBe("453.59237 g");
    expect(quantityCanonical(convertQuantity(quantityFromString("1", "ft2"), "mm2", 6, "HALF_EVEN"))).toBe("92903.04 mm2");
  });

  it("REFUSES across dimensions rather than reporting a missing factor", () => {
    // Kilograms to hours is a modelling error, not an absent conversion.
    expect(() => convertQuantity(quantityFromString("1", "kg"), "h", 6, "HALF_EVEN")).toThrow(
      /measure different things/,
    );
  });

  it("refuses an unknown unit", () => {
    expect(() => unitDefinition("widgets")).toThrow(/Unknown unit/);
    expect(() => convertQuantity(quantityFromString("1", "kg"), "widgets", 6, "HALF_EVEN")).toThrow(/Unknown unit/);
  });

  it("round-trips a conversion at sufficient scale", () => {
    const original = quantityFromString("2.5", "kg");
    const there = convertQuantity(original, "g", 9, "HALF_EVEN");
    const back = convertQuantity(there, "kg", 9, "HALF_EVEN");
    expect(quantityCanonical(back)).toBe(quantityCanonical(original));
  });

  it("lets a host register its own units", () => {
    const registry = createUnitRegistry([
      { code: "sheet", dimension: "COUNT", inBaseUnits: fromString("1") },
      { code: "gross", dimension: "COUNT", inBaseUnits: fromString("144") },
    ]);
    expect(
      quantityCanonical(convertQuantity(quantityFromString("2", "gross"), "sheet", 6, "HALF_EVEN", registry)),
    ).toBe("288 sheet");
  });
});

describe("rates are unit-safe by construction", () => {
  it("converts a quantity into the rate's own unit before applying it", () => {
    // "£12 per kg" applied to "500 g" must convert. A bare 12 times a bare 500
    // can only produce 6000 and a bad day.
    const perKg = unitRate(gbp("12.00"), "kg");
    const consumed = quantityFromString("500", "g");
    const multiplier = rateMultiplier(consumed, perKg, 9, "HALF_EVEN");
    expect(toString(multiplier)).toBe("0.500000000");
    expect(moneyToString(quantize(multiplyMoney(perKg.value, multiplier)))).toBe("6.00 GBP");
  });

  it("refuses a rate whose unit measures something else", () => {
    const perKg = unitRate(gbp("12.00"), "kg");
    expect(() => rateMultiplier(quantityFromString("30", "min"), perKg, 9, "HALF_EVEN")).toThrow(
      /measure different things/,
    );
  });
});

describe("quantity scaling and canonical form", () => {
  it("scales by a dimensionless factor, keeping the unit", () => {
    // A waste allowance is a factor, not a quantity.
    expect(quantityCanonical(scaleQuantity(quantityFromString("100", "g"), fromString("1.05")))).toBe("105 g");
  });

  it("hashes equal quantities identically", () => {
    expect(quantityCanonical(quantityFromString("1.50", "kg"))).toBe(quantityCanonical(quantityFromString("1.5", "kg")));
  });
});
