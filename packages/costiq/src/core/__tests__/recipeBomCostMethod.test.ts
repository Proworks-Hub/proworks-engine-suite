/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { normalize, toString } from "../../domain/decimal.js";
import { defaultCurrencyPrecision } from "../../domain/money.js";
import { defaultUnitRegistry } from "../../domain/quantity.js";
import type { CostPolicy } from "../../domain/costModel.js";
import { buildCostGraph, rollup } from "../costGraph.js";
import { createMethodRegistry, runMethod, type CostMethod } from "../methodRegistry.js";
import { recipeBomCostMethodV1 } from "../recipeBomCostMethod.js";

// ─────────────────────────────────────────────────────────────────────────────
// Costing something made of things that are made of things.
//
// The two errors this guards against are the ones everybody makes at least
// once: forgetting to multiply through a level, and confusing waste with
// yield. Both produce plausible numbers.
// ─────────────────────────────────────────────────────────────────────────────

const policy: CostPolicy = {
  policyId: "p",
  policyVersion: "1",
  currency: "GBP",
  roundingMode: "HALF_EVEN",
  roundingStage: "TOTAL",
  roundingScale: null,
  calculationScale: 10,
  acceptedSources: ["CONTRACT"],
  allowFallback: false,
  freshnessWindowDays: 90,
  minimumSampleSize: 1,
};

const context = (asOf = "2026-08-30T00:00:00.000Z") => ({
  policy,
  asOf: new Date(asOf),
  units: defaultUnitRegistry,
  currencyPrecision: defaultCurrencyPrecision,
});

const registry = createMethodRegistry([recipeBomCostMethodV1 as CostMethod<never>]);
const run = (input: unknown, asOf?: string) => runMethod(registry, "RECIPE_BOM", "1.0.0", input, context(asOf));

function totalOf(input: unknown, asOf?: string): string {
  const result = run(input, asOf);
  if (!result.ok) throw new Error(`${result.reason} ${result.issues.join("; ")}`);
  const graph = buildCostGraph(result.output.components);
  if (!graph.ok) throw new Error(graph.problems.map((p) => p.message).join("; "));
  // Normalised: trailing zeros are an artefact of which arithmetic path
  // produced the number, and these tests are about the value.
  return toString(normalize(rollup(graph.graph).total));
}

const firePit = {
  productRef: "firepit-24",
  quantity: "1",
  lines: [
    {
      lineId: "panels",
      label: "Panel set",
      quantityPerParent: "4",
      quantityUnit: "each",
      children: [
        {
          lineId: "steel",
          label: "Corten sheet",
          quantityPerParent: "2.5",
          quantityUnit: "kg",
          unitCost: "2.00",
        },
      ],
    },
  ],
};

describe("quantities multiply down the tree", () => {
  it("costs 4 panels of 2.5 kg as 10 kg, not 2.5", () => {
    // The mistake everybody makes at least once: costing the panel and
    // forgetting the four.
    expect(totalOf(firePit)).toBe("20");
  });

  it("multiplies through the order quantity as well", () => {
    // 3 pits × 4 panels × 2.5 kg × £2 = £60.
    expect(totalOf({ ...firePit, quantity: "3" })).toBe("60");
  });

  it("carries the exploded quantity onto the component, not just the amount", () => {
    // So an explanation can say "10 kg" rather than leaving the reader to
    // divide the amount by a rate to work it out.
    const result = run(firePit);
    if (!result.ok) throw new Error(result.reason);
    const steel = result.output.components.find((c) => c.componentId === "bom:steel");
    expect(steel!.quantity).toBe("10.0");
    expect(steel!.quantityUnit).toBe("kg");
  });

  it("multiplies through three levels", () => {
    const deep = {
      productRef: "p",
      quantity: "2",
      lines: [
        {
          lineId: "a",
          label: "A",
          quantityPerParent: "3",
          quantityUnit: "each",
          children: [
            {
              lineId: "b",
              label: "B",
              quantityPerParent: "5",
              quantityUnit: "each",
              children: [
                { lineId: "c", label: "C", quantityPerParent: "7", quantityUnit: "kg", unitCost: "1.00" },
              ],
            },
          ],
        },
      ],
    };
    // 2 × 3 × 5 × 7 = 210.
    expect(totalOf(deep)).toBe("210");
  });
});

describe("waste and yield are different numbers applied in different directions", () => {
  const line = (over: Record<string, unknown>) => ({
    productRef: "p",
    quantity: "1",
    lines: [{ lineId: "m", label: "Material", quantityPerParent: "100", quantityUnit: "kg", unitCost: "1.00", ...over }],
  });

  it("waste MULTIPLIES — more is drawn than ends up in the product", () => {
    expect(totalOf(line({ wasteFactor: "1.1" }))).toBe("110");
  });

  it("yield DIVIDES — more must be started than is delivered", () => {
    expect(totalOf(line({ yield: "0.9" }))).toBe("111.1111111111");
  });

  it("does not treat 10% waste and 90% yield as the same thing", () => {
    // 110 versus 111.11. Small on one line, and it compounds through every
    // level of a deep assembly.
    expect(totalOf(line({ wasteFactor: "1.1" }))).not.toBe(totalOf(line({ yield: "0.9" })));
  });

  it("refuses a waste factor below 1, naming what it actually is", () => {
    const result = run(line({ wasteFactor: "0.9" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("that is a yield, and it divides");
  });

  it("refuses a yield above 1 or at zero", () => {
    expect(run(line({ yield: "1.5" })).ok).toBe(false);
    expect(run(line({ yield: "0" })).ok).toBe(false);
  });

  it("says in the notes when each was applied", () => {
    const result = run(line({ wasteFactor: "1.1", yield: "0.95" }));
    if (!result.ok) throw new Error(result.reason);
    const notes = result.output.components[0]!.notes.join(" ");
    expect(notes).toContain("Waste factor");
    expect(notes).toContain("more must be started");
  });
});

describe("effectivity is read at the calculation's instant", () => {
  const withDates = {
    productRef: "p",
    quantity: "1",
    lines: [
      {
        lineId: "old",
        label: "Old part",
        quantityPerParent: "1",
        quantityUnit: "each",
        unitCost: "10.00",
        effectiveTo: "2026-06-01T00:00:00.000Z",
      },
      {
        lineId: "new",
        label: "New part",
        quantityPerParent: "1",
        quantityUnit: "each",
        unitCost: "12.00",
        effectiveFrom: "2026-06-01T00:00:00.000Z",
      },
    ],
  };

  it("uses the revision in force then, not the current one", () => {
    // A BOM revision taking effect next month must not appear in this month's
    // cost — and replaying an old estimate must read the old structure.
    expect(totalOf(withDates, "2026-03-01T00:00:00.000Z")).toBe("10");
    expect(totalOf(withDates, "2026-08-01T00:00:00.000Z")).toBe("12");
  });

  it("treats the start instant as INCLUSIVE and the end instant as EXCLUSIVE", () => {
    // The boundary convention, pinned because this is exactly where costing
    // systems disagree — and a half-open interval is what makes two
    // consecutive revisions meet without overlapping or leaving a gap.
    //
    // At exactly 2026-06-01 the old part has stopped and the new one has
    // started, so the cost is the new one and not both.
    expect(totalOf(withDates, "2026-06-01T00:00:00.000Z")).toBe("12");

    // One millisecond earlier, only the old part applies.
    expect(totalOf(withDates, "2026-05-31T23:59:59.999Z")).toBe("10");
  });

  it("says which lines it excluded and why", () => {
    const result = run(withDates, "2026-03-01T00:00:00.000Z");
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.diagnostics.join()).toContain("not effective");
  });
});

describe("structural refusals", () => {
  it("refuses a line that is both purchased and made", () => {
    // Having both would count the same cost twice: once as the price, once as
    // the sum of its parts.
    const result = run({
      productRef: "p",
      quantity: "1",
      lines: [
        {
          lineId: "a",
          label: "A",
          quantityPerParent: "1",
          quantityUnit: "each",
          unitCost: "5.00",
          children: [{ lineId: "b", label: "B", quantityPerParent: "1", quantityUnit: "kg", unitCost: "1.00" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("count the same cost twice");
  });

  it("refuses a line with neither a price nor parts", () => {
    const result = run({
      productRef: "p",
      quantity: "1",
      lines: [{ lineId: "a", label: "A", quantityPerParent: "1", quantityUnit: "each" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("silently costed at zero");
  });

  it("allows an explicitly unpriced line, and reports it", () => {
    const result = run({
      productRef: "p",
      quantity: "1",
      lines: [
        {
          lineId: "a",
          label: "Powder coat",
          quantityPerParent: "1",
          quantityUnit: "each",
          unpricedReason: "No supplier quote on file.",
        },
      ],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.components[0]!.kind).toBe("UNPRICED");
    expect(result.output.assumptions.map((a) => a.id)).toContain("bom.incomplete");
  });

  it("refuses a duplicate line id", () => {
    const result = run({
      productRef: "p",
      quantity: "1",
      lines: [
        { lineId: "dup", label: "A", quantityPerParent: "1", quantityUnit: "kg", unitCost: "1" },
        { lineId: "dup", label: "B", quantityPerParent: "1", quantityUnit: "kg", unitCost: "1" },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("ambiguous");
  });

  it("refuses a structure that contains itself", () => {
    const result = run({
      productRef: "p",
      quantity: "1",
      lines: [
        {
          lineId: "a",
          label: "A",
          quantityPerParent: "1",
          quantityUnit: "each",
          children: [
            {
              lineId: "a",
              label: "A again",
              quantityPerParent: "1",
              quantityUnit: "each",
              unitCost: "1",
            },
          ],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("cycle");
  });
});

describe("operations", () => {
  const withOps = {
    productRef: "p",
    quantity: "10",
    lines: [],
    operations: [
      {
        operationId: "cut",
        label: "Laser cut",
        minutesPerUnit: "3",
        ratePerMinute: "1.50",
        setupMinutes: "20",
        setupRatePerMinute: "0.80",
      },
    ],
  };

  it("costs run time per finished unit", () => {
    // 10 units × 3 min × £1.50 = £45, plus setup.
    const result = run(withOps);
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.components.find((c) => c.componentId === "op:cut")!.amount).toBe("45.00");
  });

  it("charges setup ONCE per batch, not per unit", () => {
    // The other classic BOM error. Per-unit setup makes large orders look far
    // too expensive, which loses the orders worth having.
    const result = run(withOps);
    if (!result.ok) throw new Error(result.reason);
    expect(result.output.components.find((c) => c.componentId === "setup:cut")!.amount).toBe("16.00");
  });

  it("does not scale setup with the order", () => {
    const ten = run(withOps);
    const hundred = run({ ...withOps, quantity: "100" });
    if (!ten.ok || !hundred.ok) throw new Error("expected both to succeed");
    const setupOf = (r: typeof ten) =>
      r.ok ? r.output.components.find((c) => c.componentId === "setup:cut")!.amount : "";
    expect(setupOf(hundred)).toBe(setupOf(ten));
  });

  it("refuses setup minutes with no rate", () => {
    const result = run({
      ...withOps,
      operations: [{ operationId: "c", label: "Cut", minutesPerUnit: "1", ratePerMinute: "1", setupMinutes: "10" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join()).toContain("hide a missing rate");
  });
});

describe("scale and determinism", () => {
  it("handles a deep structure without recursing", () => {
    // Built iteratively; a recursive expansion would overflow on a deep BOM
    // and the crash would name framework code.
    let line: Record<string, unknown> = {
      lineId: "leaf",
      label: "Leaf",
      quantityPerParent: "1",
      quantityUnit: "kg",
      unitCost: "0.01",
    };
    for (let i = 0; i < 500; i += 1) {
      line = { lineId: `n${i}`, label: `N${i}`, quantityPerParent: "1", quantityUnit: "each", children: [line] };
    }
    expect(totalOf({ productRef: "p", quantity: "1", lines: [line] })).toBe("0.01");
  });

  it("produces identical output for identical input", () => {
    const first = JSON.stringify(run(firePit));
    for (let i = 0; i < 5; i += 1) expect(JSON.stringify(run(firePit))).toBe(first);
  });
});
