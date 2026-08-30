/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { ONE, compare, fromString, toString } from "../../domain/decimal.js";
import {
  computeQuantityEconomics,
  learningCurveFactor,
  packsRequired,
  quantityTable,
  tierFor,
  type QuantityEconomicsInput,
} from "../quantityEconomics.js";

// ─────────────────────────────────────────────────────────────────────────────
// Why ten costs less each than one, and exactly where it stops.
//
// Per-unit cost is nearly total-divided-by-quantity, and the difference is the
// whole subject. The curve has steps in it; the steps are where money is made
// and lost; and a step nobody can explain is a step people stop trusting.
// ─────────────────────────────────────────────────────────────────────────────

const d = fromString;

const base = (over: Partial<Omit<QuantityEconomicsInput, "quantity">> = {}): Omit<QuantityEconomicsInput, "quantity"> => ({
  variableUnitCost: d("10.00"),
  nonRecurring: [],
  tiers: [],
  packs: [],
  minimumOrderCharge: null,
  scale: 6,
  mode: "HALF_EVEN",
  ...over,
});

const at = (quantity: string, over: Partial<Omit<QuantityEconomicsInput, "quantity">> = {}) =>
  computeQuantityEconomics({ ...base(over), quantity: d(quantity) });

describe("setup is paid once, however many you make", () => {
  it("spreads a non-recurring cost across the units it serves", () => {
    // £900 over 100 units is £9 each; an order of 10 carries £90.
    const result = at("10", {
      nonRecurring: [{ id: "die", label: "Form die", amount: d("900.00"), amortizeOverUnits: d("100") }],
    });
    expect(toString(result.totalCost)).toBe("190.000000");
    expect(toString(result.unitCost)).toBe("19.000000");
  });

  it("charges the whole thing when no amortisation basis is given", () => {
    // Null is not "over one" — it is a different decision, and charging a £900
    // die entirely to a batch of 3 is sometimes right.
    const result = at("3", {
      nonRecurring: [{ id: "die", label: "Form die", amount: d("900.00"), amortizeOverUnits: null }],
    });
    expect(toString(result.totalCost)).toBe("930.00");
    expect(result.effects.join()).toContain("charged wholly to this order");
  });

  it("refuses to amortise over nothing", () => {
    expect(() =>
      at("10", { nonRecurring: [{ id: "d", label: "Die", amount: d("900"), amortizeOverUnits: d("0") }] }),
    ).toThrow(/no answer/);
  });

  it("makes the per-unit cost fall as quantity rises", () => {
    // The whole reason customers ask "what about 50?".
    const nonRecurring = [{ id: "s", label: "Setup", amount: d("100.00"), amortizeOverUnits: null }];
    const one = at("1", { nonRecurring });
    const ten = at("10", { nonRecurring });
    expect(compare(ten.unitCost, one.unitCost)).toBe(-1);
    expect(toString(one.unitCost)).toBe("110.000000");
    expect(toString(ten.unitCost)).toBe("20.000000");
  });
});

describe("material comes in packs, so wanting 3 can mean buying 4", () => {
  const pack = { id: "sheet", label: "Steel sheet", unitsPerPack: d("4"), packCost: d("40.00") };

  it("always rounds packs UP", () => {
    // Rounding to nearest would produce a cost that cannot be purchased.
    expect(toString(packsRequired(pack, d("1"), 6))).toBe("1");
    expect(toString(packsRequired(pack, d("4"), 6))).toBe("1");
    expect(toString(packsRequired(pack, d("5"), 6))).toBe("2");
    expect(toString(packsRequired(pack, d("8"), 6))).toBe("2");
    expect(toString(packsRequired(pack, d("9"), 6))).toBe("3");
  });

  it("names the spare that the order still pays for", () => {
    // The wasted remainder is where the steps come from, so it is named rather
    // than absorbed.
    const result = at("3", { packs: [pack] });
    expect(result.effects.join()).toContain("leaving 1 spare");
  });

  it("says so when packs are used exactly", () => {
    expect(at("4", { packs: [pack] }).effects.join()).toContain("used exactly");
  });

  it("refuses a pack that yields nothing", () => {
    expect(() => packsRequired({ ...pack, unitsPerPack: d("0") }, d("1"), 6)).toThrow(/cannot satisfy/);
  });
});

describe("suppliers price in tiers", () => {
  const tiers = [
    { fromQuantity: d("1"), unitRate: d("10.00"), label: "1+" },
    { fromQuantity: d("25"), unitRate: d("8.50"), label: "25+" },
    { fromQuantity: d("100"), unitRate: d("7.00"), label: "100+" },
  ];

  it("takes the highest threshold at or below the quantity", () => {
    expect(tierFor(tiers, d("1"))!.label).toBe("1+");
    expect(tierFor(tiers, d("24"))!.label).toBe("1+");
    expect(tierFor(tiers, d("25"))!.label).toBe("25+");
    expect(tierFor(tiers, d("99"))!.label).toBe("25+");
    expect(tierFor(tiers, d("100"))!.label).toBe("100+");
  });

  it("does not depend on the order tiers were listed in", () => {
    // Tier tables are usually pasted in, so two callers who list them
    // differently must get the same answer.
    const shuffled = [tiers[2]!, tiers[0]!, tiers[1]!];
    expect(tierFor(shuffled, d("50"))!.label).toBe("25+");
  });

  it("returns nothing below the lowest threshold", () => {
    expect(tierFor([{ fromQuantity: d("10"), unitRate: d("5"), label: "10+" }], d("5"))).toBeNull();
  });

  it("applies the tier rate and says which one", () => {
    const result = at("30", { tiers });
    expect(toString(result.totalCost)).toBe("255.00");
    expect(result.effects.join()).toContain('"25+"'.replace(/"/g, ""));
  });
});

describe("a minimum charge is a floor, and it is visible", () => {
  it("raises a small order to the floor", () => {
    const result = at("1", { variableUnitCost: d("2.00"), minimumOrderCharge: d("50.00") });
    expect(toString(result.totalCost)).toBe("50.00");
    expect(result.minimumApplied).toBe(true);
    expect(result.effects.join()).toContain("Raised to the minimum");
  });

  it("does not lower an order already above it", () => {
    const result = at("100", { variableUnitCost: d("2.00"), minimumOrderCharge: d("50.00") });
    expect(toString(result.totalCost)).toBe("200.00");
    expect(result.minimumApplied).toBe(false);
  });
});

describe("the quantity table shows the steps and explains them", () => {
  const tiers = [
    { fromQuantity: d("1"), unitRate: d("10.00"), label: "1+" },
    { fromQuantity: d("25"), unitRate: d("8.50"), label: "25+" },
  ];
  const packs = [{ id: "sheet", label: "Steel sheet", unitsPerPack: d("10"), packCost: d("30.00") }];

  it("produces a row per quantity, ascending", () => {
    const table = quantityTable([d("50"), d("1"), d("10")], base({ tiers }));
    expect(table.map((r) => toString(r.quantity))).toEqual(["1", "10", "50"]);
  });

  it("reports the change in unit cost from the previous row", () => {
    const table = quantityTable([d("1"), d("10")], base({ nonRecurring: [{ id: "s", label: "Setup", amount: d("90.00"), amortizeOverUnits: null }] }));
    expect(table[0]!.unitCostDelta).toBeNull();
    expect(compare(table[1]!.unitCostDelta!, fromString("0"))).toBe(-1);
  });

  it("NAMES the tier boundary where the unit cost steps", () => {
    // "Unit cost drops at 25 because that is where the next tier starts" is a
    // sentence somebody can sell with.
    const table = quantityTable([d("24"), d("25")], base({ tiers }));
    expect(table[1]!.discontinuity).toContain("25+");
  });

  it("NAMES the pack boundary where the unit cost steps", () => {
    const table = quantityTable([d("10"), d("11")], base({ packs }));
    expect(table[1]!.discontinuity).toContain("pack count moved from 1 to 2");
  });

  it("names the point a minimum stops applying", () => {
    const table = quantityTable(
      [d("1"), d("100")],
      base({ variableUnitCost: d("1.00"), minimumOrderCharge: d("50.00") }),
    );
    expect(table[1]!.discontinuity).toContain("order minimum stopped applying");
  });

  it("carries the effects onto every row", () => {
    const table = quantityTable([d("3")], base({ packs }));
    expect(table[0]!.effects.join()).toContain("spare");
  });

  it("does not mutate the baseline inputs", () => {
    // Generating a table must never disturb the estimate a customer was
    // quoted.
    const inputs = base({ tiers, packs });
    const before = JSON.stringify(inputs, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    quantityTable([d("1"), d("25"), d("100")], inputs);
    expect(JSON.stringify(inputs, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });
});

describe("unit cost falls monotonically when nothing structural changes", () => {
  it("never rises as quantity rises, with only amortised setup", () => {
    // A property: with a fixed rate and one amortised setup, more units can
    // only be cheaper per unit. A rise would mean an arithmetic fault.
    const inputs = base({ nonRecurring: [{ id: "s", label: "Setup", amount: d("500.00"), amortizeOverUnits: null }] });
    const table = quantityTable(["1", "2", "5", "10", "25", "50", "100", "1000"].map(d), inputs);
    for (let i = 1; i < table.length; i += 1) {
      expect(compare(table[i]!.unitCost, table[i - 1]!.unitCost)).toBeLessThanOrEqual(0);
    }
  });
});

describe("a learning curve is off unless asked for", () => {
  it("reduces by the rate at each doubling", () => {
    // 0.85 means each doubling costs 85% as much. Two units is one doubling.
    const two = learningCurveFactor(d("2"), d("0.85"), 8, "HALF_EVEN");
    expect(toString(two.factor)).toBe("0.85");
    const four = learningCurveFactor(d("4"), d("0.85"), 8, "HALF_EVEN");
    expect(toString(four.factor)).toBe("0.7225");
  });

  it("applies nothing below two units", () => {
    expect(toString(learningCurveFactor(d("1"), d("0.85"), 8, "HALF_EVEN").factor)).toBe("1");
  });

  it("applies nothing BELOW one unit either", () => {
    // The case the "below two units" test missed. Without the guard the
    // remainder interpolation goes negative and the factor comes out ABOVE
    // one — a learning curve that makes things more expensive the fewer you
    // make. Fractional quantities are real: half a sheet, 0.4 hours.
    for (const units of ["0.5", "0.1", "0.999"]) {
      const result = learningCurveFactor(d(units), d("0.85"), 8, "HALF_EVEN");
      expect(toString(result.factor)).toBe("1");
    }
  });

  it("records the formula and rate with the result", () => {
    // A quiet 15% reduction applied to every estimate is a quiet 15% reduction
    // in every quote. The directive requires the formula recorded.
    const result = learningCurveFactor(d("8"), d("0.9"), 8, "HALF_EVEN");
    expect(result.formula).toContain("Wright");
    expect(result.formula).toContain("0.9");
    expect(result.formula).toContain("3 doubling");
  });

  it("names interpolation as the approximation it is", () => {
    expect(learningCurveFactor(d("6"), d("0.85"), 8, "HALF_EVEN").formula).toContain("interpolation");
  });

  it("refuses a rate outside 0 to 1", () => {
    for (const bad of ["0", "1.2", "-0.5"]) {
      expect(() => learningCurveFactor(d("10"), d(bad), 8, "HALF_EVEN")).toThrow(/between 0 and 1/);
    }
  });

  it("never increases cost", () => {
    for (const units of ["2", "3", "10", "100"]) {
      expect(compare(learningCurveFactor(d(units), d("0.85"), 8, "HALF_EVEN").factor, ONE)).toBeLessThanOrEqual(0);
    }
  });
});

describe("guards", () => {
  it("refuses an order of nothing", () => {
    expect(() => at("0")).toThrow(/order of nothing/);
  });
});
