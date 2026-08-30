/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import {
  ONE,
  ZERO,
  abs,
  add,
  allocate,
  compare,
  divide,
  equals,
  fromInteger,
  fromNumber,
  fromString,
  fromUnits,
  greaterThan,
  isNegative,
  isZero,
  multiply,
  negate,
  normalize,
  rescale,
  subtract,
  sum,
  toNumber,
  toString,
  type Decimal,
  type RoundingMode,
} from "../decimal.js";

// ─────────────────────────────────────────────────────────────────────────────
// The arithmetic every authoritative amount in CostIQ rests on.
//
// v1 does its money math in JavaScript `Number`. These tests exist to prove
// the replacement is actually exact — not "close enough", not "rounds nicely
// in the cases we tried", but exact, including the cases where floating point
// is famously wrong.
// ─────────────────────────────────────────────────────────────────────────────

const d = fromString;

describe("the arithmetic floating point gets wrong", () => {
  it("adds 0.1 and 0.2 to exactly 0.3", () => {
    // The canonical example. In IEEE-754 this is 0.30000000000000004.
    expect(toString(add(d("0.1"), d("0.2")))).toBe("0.3");
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("sums a thousand pennies to exactly ten pounds", () => {
    // Where a cost engine actually loses money: not one addition, but many.
    const pennies = Array.from({ length: 1000 }, () => d("0.01"));
    expect(toString(sum(pennies))).toBe("10.00");

    const asFloats = Array.from({ length: 1000 }, () => 0.01).reduce((a, b) => a + b, 0);
    expect(asFloats).not.toBe(10);
  });

  it("subtracts without drift", () => {
    expect(toString(subtract(d("1.00"), d("0.9")))).toBe("0.10");
    expect(1.0 - 0.9).not.toBe(0.1);
  });

  it("multiplies 1.1 by 1.1 to exactly 1.21", () => {
    expect(toString(multiply(d("1.1"), d("1.1")))).toBe("1.21");
    expect(1.1 * 1.1).not.toBe(1.21);
  });
});

describe("scale is tracked honestly", () => {
  it("keeps trailing zeros the caller wrote", () => {
    // 12.30 and 12.3 are the same number written to different precision, and
    // a cost sheet that says "12.30" should keep saying so.
    expect(toString(d("12.30"))).toBe("12.30");
    expect(toString(d("12.3"))).toBe("12.3");
  });

  it("treats them as equal", () => {
    expect(equals(d("12.30"), d("12.3"))).toBe(true);
    expect(compare(d("1.50"), d("1.5"))).toBe(0);
  });

  it("grows the scale on multiplication, because that is the true answer", () => {
    // 0.5 × 0.5 genuinely needs two places. Pretending otherwise is where
    // silent precision loss starts.
    expect(multiply(d("0.5"), d("0.5")).scale).toBe(2);
    expect(toString(multiply(d("0.5"), d("0.5")))).toBe("0.25");
  });

  it("takes the larger scale on addition", () => {
    expect(add(d("1.5"), d("2.25")).scale).toBe(2);
    expect(toString(add(d("1.5"), d("2.25")))).toBe("3.75");
  });

  it("normalises only for canonical form", () => {
    // Two equal values must serialise identically or a fingerprint over them
    // would differ for the same number.
    expect(toString(normalize(d("12.3400")))).toBe("12.34");
    expect(toString(normalize(d("100")))).toBe("100");
    expect(toString(normalize(d("0.000")))).toBe("0");
  });
});

describe("division demands a decision", () => {
  it("requires a scale and a mode", () => {
    // One third has no finite decimal form. There is no correct default here,
    // so the caller states what they want.
    expect(toString(divide(ONE, fromInteger(3), 4, "HALF_UP"))).toBe("0.3333");
    expect(toString(divide(ONE, fromInteger(3), 2, "HALF_UP"))).toBe("0.33");
  });

  it("refuses division by zero rather than returning infinity", () => {
    // A cost model dividing by zero has a missing input, not a very large
    // answer.
    expect(() => divide(ONE, ZERO, 2, "HALF_UP")).toThrow(/missing input/);
  });

  it("divides negatives with the sign on the quotient", () => {
    expect(toString(divide(d("-10"), fromInteger(4), 2, "HALF_UP"))).toBe("-2.50");
    expect(toString(divide(d("10"), fromInteger(-4), 2, "HALF_UP"))).toBe("-2.50");
    expect(toString(divide(d("-10"), fromInteger(-4), 2, "HALF_UP"))).toBe("2.50");
  });
});

describe("every rounding mode does what it says", () => {
  const cases: ReadonlyArray<[string, RoundingMode, string]> = [
    ["2.5", "HALF_UP", "3"],
    ["2.5", "HALF_DOWN", "2"],
    ["2.5", "HALF_EVEN", "2"],
    ["3.5", "HALF_EVEN", "4"],
    ["2.4", "HALF_UP", "2"],
    ["2.6", "HALF_DOWN", "3"],
    ["2.1", "DOWN", "2"],
    ["2.9", "DOWN", "2"],
    ["2.1", "UP", "3"],
    ["2.1", "CEILING", "3"],
    ["2.9", "FLOOR", "2"],
  ];

  for (const [input, mode, expected] of cases) {
    it(`rounds ${input} to ${expected} under ${mode}`, () => {
      expect(toString(rescale(d(input), 0, mode))).toBe(expected);
    });
  }

  const negativeCases: ReadonlyArray<[string, RoundingMode, string]> = [
    // The modes that treat sign differently are where implementations
    // usually disagree, so each is pinned explicitly.
    ["-2.5", "HALF_UP", "-3"],
    ["-2.5", "HALF_DOWN", "-2"],
    ["-2.5", "HALF_EVEN", "-2"],
    ["-2.1", "DOWN", "-2"],
    ["-2.1", "UP", "-3"],
    ["-2.1", "CEILING", "-2"],
    ["-2.1", "FLOOR", "-3"],
  ];

  for (const [input, mode, expected] of negativeCases) {
    it(`rounds ${input} to ${expected} under ${mode}`, () => {
      expect(toString(rescale(d(input), 0, mode))).toBe(expected);
    });
  }

  it("uses HALF_EVEN to avoid upward drift over many roundings", () => {
    // The reason banker's rounding exists. Rounding .5 up every time biases a
    // long series of totals upward; HALF_EVEN splits them.
    const halves = ["0.5", "1.5", "2.5", "3.5", "4.5", "5.5", "6.5", "7.5"];
    const halfUp = sum(halves.map((h) => rescale(d(h), 0, "HALF_UP")));
    const halfEven = sum(halves.map((h) => rescale(d(h), 0, "HALF_EVEN")));
    expect(toString(halfUp)).toBe("36");
    expect(toString(halfEven)).toBe("32");
    // The exact sum is 32, so HALF_EVEN is the unbiased one.
    expect(toString(rescale(sum(halves.map(d)), 0, "HALF_EVEN"))).toBe("32");
  });
});

describe("getting values in from the outside", () => {
  it("parses the strings people actually write", () => {
    expect(toString(d("0"))).toBe("0");
    expect(toString(d("-0.5"))).toBe("-0.5");
    expect(toString(d("+12.75"))).toBe("12.75");
    expect(toString(d(".5"))).toBe("0.5");
    expect(toString(d("  42  "))).toBe("42");
    expect(toString(d("1000000000000000000000000.0000001"))).toBe("1000000000000000000000000.0000001");
  });

  it("refuses text that is not a number", () => {
    // Failing here beats producing NaN and carrying it into a total.
    for (const bad of ["", "  ", "abc", "1.2.3", "1e5", "--1", "1,000", "Infinity", "NaN"]) {
      expect(() => d(bad)).toThrow();
    }
  });

  it("refuses non-finite floats", () => {
    expect(() => fromNumber(Number.NaN)).toThrow(/exactly/);
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow(/exactly/);
  });

  it("converts a float through its shortest round-tripping decimal", () => {
    // The closest thing to what the caller meant. `0.1` the float becomes the
    // decimal 0.1, not 0.1000000000000000055511151231257827.
    expect(toString(fromNumber(0.1))).toBe("0.1");
    expect(toString(fromNumber(12.34))).toBe("12.34");
    expect(toString(fromNumber(0))).toBe("0");
    expect(toString(fromNumber(-7.5))).toBe("-7.5");
  });

  it("refuses a fractional value to fromInteger", () => {
    expect(() => fromInteger(1.5)).toThrow(/whole number/);
  });

  it("round-trips through toString without loss", () => {
    for (const text of ["0", "1", "-1", "0.001", "-123456789.987654321", "1000000"]) {
      expect(toString(d(text))).toBe(text);
    }
  });
});

describe("allocation loses nothing", () => {
  it("splits 100 three ways and still totals 100", () => {
    // 33.33 × 3 is 99.99. The missing penny has to go somewhere, and
    // "somewhere" must be decided rather than dropped.
    const parts = allocate(d("100.00"), [ONE, ONE, ONE], 2);
    expect(parts.map(toString)).toEqual(["33.34", "33.33", "33.33"]);
    expect(toString(sum(parts))).toBe("100.00");
  });

  it("splits by weight and still totals exactly", () => {
    const parts = allocate(d("1000.00"), [d("1"), d("2"), d("7")], 2);
    expect(parts.map(toString)).toEqual(["100.00", "200.00", "700.00"]);
    expect(toString(sum(parts))).toBe("1000.00");
  });

  it("re-sums exactly for awkward weights", () => {
    // Property, checked across a spread of awkward cases: whatever the
    // weights, the parts add back up to the total. That invariant is what
    // makes a cost breakdown reconcile with its own total.
    const totals = ["0.01", "1.00", "99.99", "12345.67", "0.07"];
    const weightSets = [
      ["1", "1", "1"],
      ["1", "2", "3", "5", "8"],
      ["0.333", "0.333", "0.334"],
      ["1", "0", "1"],
      ["99", "1"],
    ];
    for (const t of totals) {
      for (const ws of weightSets) {
        const parts = allocate(d(t), ws.map(d), 2);
        expect(toString(sum(parts))).toBe(toString(rescale(d(t), 2, "HALF_EVEN")));
      }
    }
  });

  it("gives a zero-weight part nothing", () => {
    const parts = allocate(d("10.00"), [ONE, ZERO, ONE], 2);
    expect(parts.map(toString)).toEqual(["5.00", "0.00", "5.00"]);
  });

  it("gives the spare unit to the largest remainder, not the first share", () => {
    // 1.00 split by 1:2:4 is 0.142857…, 0.285714…, 0.571428…
    // Flooring gives 0.14 + 0.28 + 0.57 = 0.99, so one penny is spare.
    //
    // The largest fractional part is the SECOND share (0.005714), so that is
    // where the penny belongs. Handing it to the first share instead would
    // also re-sum to 1.00 — which is why the earlier tests could not tell the
    // difference, and why this case exists.
    const parts = allocate(d("1.00"), [d("1"), d("2"), d("4")], 2);
    expect(parts.map(toString)).toEqual(["0.14", "0.29", "0.57"]);
    expect(toString(sum(parts))).toBe("1.00");
  });

  it("distributes several spare units to the largest remainders in order", () => {
    // 1.00 split seven ways: 0.142857… each, floors to 0.14, total 0.98.
    // Two pennies spare, and every remainder is equal — so the tie-break by
    // index decides, and it must be the first two rather than an arbitrary two.
    const parts = allocate(d("1.00"), Array.from({ length: 7 }, () => ONE), 2);
    expect(parts.map(toString)).toEqual(["0.15", "0.15", "0.14", "0.14", "0.14", "0.14", "0.14"]);
    expect(toString(sum(parts))).toBe("1.00");
  });

  it("is deterministic — same input, same split, every time", () => {
    // An allocation that depended on iteration order would produce different
    // invoices for identical input.
    const once = allocate(d("100.00"), [ONE, ONE, ONE], 2).map(toString);
    for (let i = 0; i < 20; i += 1) {
      expect(allocate(d("100.00"), [ONE, ONE, ONE], 2).map(toString)).toEqual(once);
    }
  });

  it("refuses weights that sum to zero", () => {
    expect(() => allocate(d("10.00"), [ZERO, ZERO], 2)).toThrow(/no proportion/);
  });

  it("refuses a negative weight", () => {
    // A negative share of a cost is not a share.
    expect(() => allocate(d("10.00"), [ONE, negate(ONE)], 2)).toThrow(/negative weight/);
  });

  it("allocates a negative total, for credits and reversals", () => {
    const parts = allocate(d("-100.00"), [ONE, ONE, ONE], 2);
    expect(toString(sum(parts))).toBe("-100.00");
  });

  it("returns nothing for no weights rather than throwing", () => {
    expect(allocate(d("10.00"), [], 2)).toEqual([]);
  });
});

describe("comparison and sign", () => {
  it("orders across scales", () => {
    expect(greaterThan(d("1.10"), d("1.0999"))).toBe(true);
    expect(greaterThan(d("-1"), d("-2"))).toBe(true);
    expect(compare(d("0.10"), d("0.1"))).toBe(0);
  });

  it("knows zero however it is written", () => {
    expect(isZero(d("0"))).toBe(true);
    expect(isZero(d("0.0000"))).toBe(true);
    expect(isZero(d("-0.00"))).toBe(true);
  });

  it("negates and absolutes", () => {
    expect(toString(negate(d("1.25")))).toBe("-1.25");
    expect(toString(abs(d("-1.25")))).toBe("1.25");
    expect(isNegative(d("-0.01"))).toBe(true);
  });
});

describe("guard rails", () => {
  it("refuses a negative scale", () => {
    expect(() => fromUnits(1n, -1)).toThrow(/non-negative/);
  });

  it("refuses a scale large enough to be a symptom", () => {
    // Reaching this usually means values were multiplied repeatedly with no
    // rounding step, which is a modelling mistake rather than a precision need.
    expect(() => fromUnits(1n, 101)).toThrow(/exceeds the supported maximum/);
  });

  it("survives very large magnitudes, because BigInt is unbounded", () => {
    const huge = fromString("9".repeat(40));
    expect(toString(multiply(huge, huge))).toBe(toString(fromUnits(BigInt("9".repeat(40)) ** 2n, 0)));
  });

  it("exposes toNumber as the lossy escape it is", () => {
    // Named to be greppable: an authoritative calculation containing this call
    // has left exact arithmetic.
    expect(toNumber(d("12.34"))).toBe(12.34);
  });

  it("returns frozen values, so a decimal cannot be edited in place", () => {
    const value: Decimal = d("1.23");
    expect(Object.isFrozen(value)).toBe(true);
  });
});
