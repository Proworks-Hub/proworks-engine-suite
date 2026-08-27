// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  FormulaError,
  MAX_EXPRESSION_LENGTH,
  compileFormula,
  evaluateFormula,
  validateFormula,
} from "../expression.js";

// ─────────────────────────────────────────────────────────────────────────────
// A merchant's formula is untrusted input that runs on a server for every
// customer. Most of these tests are about what it CANNOT do.
// ─────────────────────────────────────────────────────────────────────────────

const scope = { productWidth: 36, height: 42, margin: 2, material: "aluminum" };

describe("the formulas a merchant actually writes", () => {
  it("does arithmetic with the usual precedence", () => {
    expect(evaluateFormula("productWidth * 0.04", scope)).toBeCloseTo(1.44);
    // Not 76: multiplication binds tighter, as everyone expects and nobody checks.
    expect(evaluateFormula("2 + 2 * 36", scope)).toBe(74);
    expect(evaluateFormula("(2 + 2) * 3", scope)).toBe(12);
  });

  it("handles the directive's own examples", () => {
    expect(evaluateFormula("floor(height / 14)", scope)).toBe(3);
    expect(evaluateFormula("productWidth > 36 ? 4 : 2", scope)).toBe(2);
    expect(evaluateFormula("productWidth - margin - margin", scope)).toBe(32);
  });

  it("compares and combines conditions", () => {
    expect(evaluateFormula("productWidth >= 36 && height > 40", scope)).toBe(true);
    expect(evaluateFormula("productWidth > 100 || height > 40", scope)).toBe(false || true);
    expect(evaluateFormula("!(productWidth > 100)", scope)).toBe(true);
  });

  it("compares against option ids as text", () => {
    expect(evaluateFormula("material == 'aluminum'", scope)).toBe(true);
    expect(evaluateFormula("material == 'oak'", scope)).toBe(false);
  });

  it("is left-associative where that matters", () => {
    // 100 - 10 - 5 is 85, not 95. Getting this wrong silently inflates a margin.
    expect(evaluateFormula("100 - 10 - 5", {})).toBe(85);
    expect(evaluateFormula("100 / 10 / 2", {})).toBe(5);
  });

  it("offers only arithmetic helpers, and they are total", () => {
    expect(evaluateFormula("min(3, 9, 5)", {})).toBe(3);
    expect(evaluateFormula("clamp(50, 0, 30)", {})).toBe(30);
    // sqrt of a negative would be NaN, which propagates silently through every
    // later operation and surfaces as a blank dimension.
    expect(evaluateFormula("sqrt(0 - 4)", {})).toBe(0);
  });
});

describe("what a formula cannot reach", () => {
  it("cannot call anything but the listed functions", () => {
    for (const attack of [
      "require('fs')",
      "process.exit(1)",
      "constructor('return 1')",
      "eval('1')",
      "fetch('http://x')",
    ]) {
      expect(() => evaluateFormula(attack, scope), attack).toThrow(FormulaError);
    }
  });

  it("has no property access at all", () => {
    // The grammar has no `.`, so there is no path to a prototype, a global, or
    // any object the evaluator happens to hold.
    expect(() => evaluateFormula("productWidth.constructor", scope)).toThrow(FormulaError);
    expect(() => evaluateFormula("this.x", scope)).toThrow(FormulaError);
    expect(() => evaluateFormula("({}).toString", scope)).toThrow(FormulaError);
  });

  it("cannot assign, define, or sequence", () => {
    for (const attack of ["x = 1", "function f(){}", "1; 2", "() => 1"]) {
      expect(() => evaluateFormula(attack, scope), attack).toThrow(FormulaError);
    }
  });

  it("refuses an unknown name instead of treating it as zero", () => {
    // A misspelled variable quietly becoming 0 turns `width * 0.04` into a
    // border of nothing, and the sign ships wrong.
    expect(() => evaluateFormula("widht * 0.04", scope)).toThrow(/not a value/);
  });

  it("refuses a character it does not recognise", () => {
    // Skipping it would turn `width $ 2` into `width`.
    expect(() => evaluateFormula("productWidth $ 2", scope)).toThrow(/unexpected character/);
  });

  it("cannot be shadowed into inverting a rule", () => {
    // `true` and `false` are literals, not scope entries.
    expect(evaluateFormula("true", { true: false } as never)).toBe(true);
  });
});

describe("what a formula cannot do to the server", () => {
  it("refuses an expression longer than the limit", () => {
    const huge = "1+".repeat(MAX_EXPRESSION_LENGTH) + "1";
    expect(() => compileFormula(huge)).toThrow(/the limit is/);
  });

  it("refuses nesting deep enough to exhaust the stack", () => {
    const deep = "(".repeat(200) + "1" + ")".repeat(200);
    expect(() => compileFormula(deep)).toThrow(/nested too deeply/);
  });

  it("terminates on every input it accepts", () => {
    // There are no loops in the grammar, so this is true by construction — the
    // test exists to make a future contributor think before adding one.
    const start = Date.now();
    evaluateFormula("floor(sqrt(productWidth * height) + min(1,2,3))", scope);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("errors a customer must never see", () => {
  it("names division by zero rather than returning Infinity", () => {
    // Infinity propagates into a dimension and produces a product nobody can
    // make — and it does it silently.
    expect(() => evaluateFormula("productWidth / 0", scope)).toThrow(/divide by zero/);
    expect(() => evaluateFormula("productWidth % 0", scope)).toThrow(/remainder by zero/);
  });

  it("refuses to add text to a number", () => {
    // Implicit concatenation is how `width + margin` silently becomes "362".
    expect(() => evaluateFormula("material + 1", scope)).toThrow(/needs a number/);
  });

  it("short-circuits so a guard actually guards", () => {
    // `a && b` must not evaluate `b` when `a` is false — the guard exists
    // precisely to avoid reaching it.
    expect(evaluateFormula("false && missingName", scope)).toBe(false);
    expect(evaluateFormula("true || missingName", scope)).toBe(true);
  });
});

describe("checking a formula before a customer meets it", () => {
  it("reports every name the formula needs", () => {
    const compiled = compileFormula("productWidth - margin * 2 + floor(height)");
    expect(compiled.dependencies).toEqual(["height", "margin", "productWidth"]);
  });

  it("does not count function names or literals as dependencies", () => {
    expect(compileFormula("floor(3.7) + (true ? 1 : 0)").dependencies).toEqual([]);
  });

  it("names the misspelled variable at build time", () => {
    // A merchant should learn this while typing, not a customer at checkout.
    const result = validateFormula("prodcutWidth * 2", ["productWidth", "height"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/prodcutWidth/);
  });

  it("accepts a formula whose names all resolve", () => {
    expect(validateFormula("productWidth * 0.04", ["productWidth"]).ok).toBe(true);
  });

  it("reports a syntax error rather than throwing at the caller", () => {
    const result = validateFormula("productWidth *", ["productWidth"]);
    expect(result.ok).toBe(false);
  });

  it("compiles once and evaluates many times", () => {
    // Published configurators run this per customer; parsing each time would
    // put a tokenizer in the checkout path.
    const compiled = compileFormula("productWidth * 2");
    expect(compiled.evaluate({ productWidth: 10 })).toBe(20);
    expect(compiled.evaluate({ productWidth: 15 })).toBe(30);
  });
});
