/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { type Decimal, fromString, normalize, toString } from "../../domain/decimal.js";
import type { CostComponent } from "../../domain/costModel.js";
import { computeVariance, detectBias, summariseByCause, type VarianceSide } from "../varianceEngine.js";
import {
  applyOverlay,
  breakEven,
  costBridge,
  rankSensitivity,
  type ScenarioOverride,
} from "../scenarioEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// "£300 over" is a fact nobody can act on. "£280 of it is material price" is a
// supplier conversation. And a scenario is only worth generating if generating
// it obviously cannot damage the quote that was actually sent.
// ─────────────────────────────────────────────────────────────────────────────

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

const side = (spec: {
  componentId: string;
  amount: string;
  label?: string;
  kind?: VarianceSide["kind"];
  quantity?: Decimal;
  rate?: Decimal;
  quantityUnit?: string;
}): VarianceSide => ({
  componentId: spec.componentId,
  kind: spec.kind ?? "MATERIAL",
  label: spec.label ?? spec.componentId,
  amount: d(spec.amount),
  ...(spec.quantity !== undefined ? { quantity: spec.quantity } : {}),
  ...(spec.rate !== undefined ? { rate: spec.rate } : {}),
  ...(spec.quantityUnit !== undefined ? { quantityUnit: spec.quantityUnit } : {}),
});

describe("variance splits into causes that sum to the whole", () => {
  it("attributes a pure price move to RATE", () => {
    const result = computeVariance({
      estimated: [side({ componentId: "steel", amount: "100", quantity: d("50"), rate: d("2") })],
      actual: [side({ componentId: "steel", amount: "110", quantity: d("50"), rate: d("2.20") })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(n(result.total)).toBe("10");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.cause).toBe("RATE");
    expect(n(result.lines[0]!.amount)).toBe("10");
  });

  it("attributes a pure usage move to QUANTITY", () => {
    const result = computeVariance({
      estimated: [side({ componentId: "steel", amount: "100", quantity: d("50"), rate: d("2") })],
      actual: [side({ componentId: "steel", amount: "120", quantity: d("60"), rate: d("2") })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines[0]!.cause).toBe("QUANTITY");
    expect(n(result.lines[0]!.amount)).toBe("20");
  });

  it("splits a combined move so the parts sum EXACTLY to the total", () => {
    // The identity that makes this split the right one: rate + quantity
    // reconcile with the whole, so an attribution is arithmetic rather than a
    // story told over a number.
    const result = computeVariance({
      estimated: [side({ componentId: "steel", amount: "100", quantity: d("50"), rate: d("2") })],
      actual: [side({ componentId: "steel", amount: "132", quantity: d("60"), rate: d("2.20") })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(n(result.total)).toBe("32");
    expect(n(result.unattributed)).toBe("0");
    const byCause = summariseByCause(result);
    // Rate at the ACTUAL quantity: 60 × 0.20 = 12. Quantity at the ESTIMATED
    // rate: 2 × 10 = 20. The joint term sits with price, by convention.
    expect(n(byCause.get("RATE")!)).toBe("12");
    expect(n(byCause.get("QUANTITY")!)).toBe("20");
  });

  it("leaves nothing unattributed when both sides carry rate and quantity", () => {
    const result = computeVariance({
      estimated: [
        side({ componentId: "a", amount: "100", quantity: d("50"), rate: d("2") }),
        side({ componentId: "b", amount: "40", quantity: d("8"), rate: d("5") }),
      ],
      actual: [
        side({ componentId: "a", amount: "132", quantity: d("60"), rate: d("2.20") }),
        side({ componentId: "b", amount: "36", quantity: d("9"), rate: d("4") }),
      ],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(n(result.unattributed)).toBe("0");
  });

  it("reports UNEXPLAINED rather than guessing when rate and quantity are absent", () => {
    // A guessed attribution is worse than an admitted gap: it looks like an
    // answer and sends somebody to the wrong conversation.
    const result = computeVariance({
      estimated: [side({ componentId: "misc", amount: "100" })],
      actual: [side({ componentId: "misc", amount: "150" })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines[0]!.cause).toBe("UNEXPLAINED");
    expect(result.lines[0]!.explanation).toContain("cannot be split");
  });

  it("reports a cost that was incurred but never estimated", () => {
    const result = computeVariance({
      estimated: [],
      actual: [side({ componentId: "surprise", amount: "75", label: "Expedited freight" })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines[0]!.cause).toBe("COVERAGE");
    expect(result.lines[0]!.explanation).toContain("did not know about this cost");
  });

  it("reports a cost that was estimated but never incurred", () => {
    const result = computeVariance({
      estimated: [side({ componentId: "planned", amount: "75" })],
      actual: [],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(n(result.lines[0]!.amount)).toBe("-75");
  });

  it("ignores components that did not move", () => {
    const result = computeVariance({
      estimated: [side({ componentId: "same", amount: "100" })],
      actual: [side({ componentId: "same", amount: "100" })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines).toHaveLength(0);
  });

  it("orders lines by magnitude, largest first", () => {
    // Ids chosen so ALPHABETICAL order is the opposite of magnitude order.
    // An earlier version used "small" and "big", where the id tie-break
    // happened to produce the same answer and a mutation removing the
    // magnitude sort survived.
    const result = computeVariance({
      estimated: [side({ componentId: "a-minor", amount: "10" }), side({ componentId: "z-major", amount: "10" })],
      actual: [side({ componentId: "a-minor", amount: "12" }), side({ componentId: "z-major", amount: "60" })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines.map((l) => l.componentId)).toEqual(["z-major", "a-minor"]);
  });

  it("orders a large NEGATIVE variance above a small positive one", () => {
    // Magnitude, not signed value: being £50 under is as interesting as being
    // £50 over, and a signed sort would bury it at the bottom.
    const result = computeVariance({
      estimated: [side({ componentId: "a-under", amount: "60" }), side({ componentId: "z-over", amount: "10" })],
      actual: [side({ componentId: "a-under", amount: "10" }), side({ componentId: "z-over", amount: "12" })],
      scale: 8,
      mode: "HALF_EVEN",
    });
    expect(result.lines[0]!.componentId).toBe("a-under");
  });

  it("is deterministic regardless of input order", () => {
    const estimated = [side({ componentId: "a", amount: "10" }), side({ componentId: "b", amount: "20" })];
    const actual = [side({ componentId: "a", amount: "12" }), side({ componentId: "b", amount: "25" })];
    const forward = JSON.stringify(computeVariance({ estimated, actual, scale: 8, mode: "HALF_EVEN" }).lines.map((l) => l.componentId));
    const reversed = JSON.stringify(
      computeVariance({ estimated: [...estimated].reverse(), actual: [...actual].reverse(), scale: 8, mode: "HALF_EVEN" }).lines.map((l) => l.componentId),
    );
    expect(reversed).toBe(forward);
  });
});

describe("bias is a pattern, not a single variance", () => {
  const opts = { minimumSample: 5, thresholdFraction: d("0.05"), scale: 8, mode: "HALF_EVEN" as const };

  it("reports nothing below the minimum sample", () => {
    const finding = detectBias([{ estimated: d("100"), actual: d("120") }], opts);
    expect(finding.isPersistent).toBe(false);
    expect(finding.explanation).toContain("distinguish bias from scatter");
  });

  it("finds consistent overspend across a family", () => {
    // Forty jobs averaging 8% over is a rate that is wrong, and worth more
    // than any single variance.
    const observations = Array.from({ length: 10 }, () => ({ estimated: d("100"), actual: d("108") }));
    const finding = detectBias(observations, opts);
    expect(finding.isPersistent).toBe(true);
    expect(finding.explanation).toContain("worth reviewing");
  });

  it("REFUSES to call scatter bias, even when the mean looks large", () => {
    // A mean of 8% made of +100% and -84% is two different problems.
    // "Correcting" a rate on that evidence makes it wrong in every individual
    // case.
    // Mean +72.5%, which is far past the threshold — but three observations
    // lean each way, so it is two different problems rather than one bias.
    const observations = [
      { estimated: d("100"), actual: d("300") },
      { estimated: d("100"), actual: d("50") },
      { estimated: d("100"), actual: d("280") },
      { estimated: d("100"), actual: d("60") },
      { estimated: d("100"), actual: d("290") },
      { estimated: d("100"), actual: d("55") },
    ];
    const finding = detectBias(observations, opts);
    expect(finding.isPersistent).toBe(false);
    expect(finding.explanation).toContain("That is scatter, not bias");
  });

  it("reports nothing when the mean is inside the threshold", () => {
    const observations = Array.from({ length: 10 }, () => ({ estimated: d("100"), actual: d("101") }));
    const finding = detectBias(observations, opts);
    expect(finding.isPersistent).toBe(false);
    expect(finding.explanation).toContain("within the threshold");
  });

  it("survives a zero estimate rather than dividing by it", () => {
    const observations = Array.from({ length: 6 }, () => ({ estimated: d("0"), actual: d("50") }));
    const finding = detectBias(observations, opts);
    expect(finding.isPersistent).toBe(false);
    expect(finding.explanation).toContain("zero estimate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const component = (over: Partial<CostComponent> & { componentId: string; amount: string }): CostComponent =>
  ({
    kind: "MATERIAL",
    label: over.componentId,
    currency: "GBP",
    included: true,
    notes: [],
    basisId: "b1",
    ...over,
  }) as CostComponent;

const baseline: readonly CostComponent[] = [
  component({ componentId: "steel", amount: "100.00", quantity: "50", quantityUnit: "kg", basisId: "rate.steel" }),
  component({ componentId: "labour", amount: "60.00", quantity: "120", quantityUnit: "min", kind: "LABOR" }),
];

describe("a scenario never touches the baseline", () => {
  it("leaves the input completely unchanged", () => {
    // The guarantee that makes scenarios cheap to generate — and the kind that
    // has to be checked rather than intended.
    const before = JSON.stringify(baseline);
    applyOverlay(baseline, [{ target: "COMPONENT_AMOUNT", targetRef: "steel", value: d("999"), rationale: "x" }], 8, "HALF_EVEN");
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it("produces a new total from the overlay", () => {
    const result = applyOverlay(
      baseline,
      [{ target: "COMPONENT_AMOUNT", targetRef: "steel", value: d("80.00"), rationale: "Supplier B" }],
      8,
      "HALF_EVEN",
    );
    expect(n(result.total)).toBe("140");
  });

  it("changes a rate by recomputing from the quantity", () => {
    const result = applyOverlay(
      baseline,
      [{ target: "RATE", targetRef: "rate.steel", value: d("1.80"), rationale: "Quote from B" }],
      8,
      "HALF_EVEN",
    );
    // 50 kg × 1.80 = 90, plus labour 60.
    expect(n(result.total)).toBe("150");
    expect(result.applied.join()).toContain("rate changed to 1.80");
  });

  it("changes a quantity at the same implied rate", () => {
    const result = applyOverlay(
      baseline,
      [{ target: "QUANTITY", targetRef: "steel", value: d("60"), rationale: "Larger part" }],
      8,
      "HALF_EVEN",
    );
    // Implied rate 100/50 = 2; 60 × 2 = 120, plus 60.
    expect(n(result.total)).toBe("180");
  });

  it("applies a yield by dividing, because a worse yield means making more", () => {
    const result = applyOverlay(
      baseline,
      [{ target: "YIELD", targetRef: "steel", value: d("0.8"), rationale: "Scrap rate" }],
      8,
      "HALF_EVEN",
    );
    // 100 / 0.8 = 125, plus 60.
    expect(n(result.total)).toBe("185");
  });

  it("REPORTS an override that matched nothing", () => {
    // Otherwise a typo produces a total identical to the baseline, which reads
    // as "this change makes no difference" — the most misleading outcome
    // available.
    const result = applyOverlay(
      baseline,
      [{ target: "COMPONENT_AMOUNT", targetRef: "does-not-exist", value: d("1"), rationale: "typo" }],
      8,
      "HALF_EVEN",
    );
    expect(result.unmatched).toHaveLength(1);
    expect(n(result.total)).toBe("160");
  });

  it("reports a rate override on a component with no quantity as unmatched", () => {
    const noQuantity = [component({ componentId: "flat", amount: "50.00", basisId: "rate.flat" })];
    const result = applyOverlay(
      noQuantity,
      [{ target: "RATE", targetRef: "rate.flat", value: d("2"), rationale: "x" }],
      8,
      "HALF_EVEN",
    );
    expect(result.unmatched).toHaveLength(1);
  });

  it("refuses a yield outside 0 to 1 by leaving it unmatched", () => {
    const result = applyOverlay(
      baseline,
      [{ target: "YIELD", targetRef: "steel", value: d("1.5"), rationale: "x" }],
      8,
      "HALF_EVEN",
    );
    expect(result.unmatched).toHaveLength(1);
  });
});

describe("a bridge reconciles with its own endpoints", () => {
  it("has lines that sum exactly to the delta", () => {
    // A waterfall whose bars do not reach the end is a waterfall that omitted
    // something.
    const after = applyOverlay(
      baseline,
      [{ target: "COMPONENT_AMOUNT", targetRef: "steel", value: d("80.00"), rationale: "x" }],
      8,
      "HALF_EVEN",
    );
    const bridge = costBridge(baseline, after.components);
    const summed = bridge.lines.reduce((acc, l) => acc + Number(toString(l.delta)), 0);
    expect(n(bridge.delta)).toBe("-20");
    expect(summed).toBeCloseTo(-20, 10);
  });

  it("omits lines that did not move", () => {
    const after = applyOverlay(
      baseline,
      [{ target: "COMPONENT_AMOUNT", targetRef: "steel", value: d("80.00"), rationale: "x" }],
      8,
      "HALF_EVEN",
    );
    const bridge = costBridge(baseline, after.components);
    expect(bridge.lines.map((l) => l.componentId)).toEqual(["steel"]);
  });

  it("treats an added or removed component as a full move", () => {
    const added = [...baseline, component({ componentId: "new", amount: "25.00" })];
    const bridge = costBridge(baseline, added);
    expect(n(bridge.lines[0]!.delta)).toBe("25");
  });
});

describe("sensitivity says which input to nail down first", () => {
  it("ranks by how much the answer moves", () => {
    const ranked = rankSensitivity(
      baseline,
      [
        { componentId: "steel", label: "Steel", variation: d("0.1") },
        { componentId: "labour", label: "Labour", variation: d("0.1") },
      ],
      8,
      "HALF_EVEN",
    );
    expect(ranked[0]!.componentId).toBe("steel");
    // ±10% of 100 is a 20 swing; of 60 it is 12.
    expect(n(ranked[0]!.swing)).toBe("20");
    expect(n(ranked[1]!.swing)).toBe("12");
  });

  it("varies ONE input at a time", () => {
    // Varying several together measures their combination, which is a
    // different and much harder question.
    const ranked = rankSensitivity(baseline, [{ componentId: "steel", label: "Steel", variation: d("0.1") }], 8, "HALF_EVEN");
    // Low = 160 - 100 + 90 = 150; high = 160 - 100 + 110 = 170. Labour is
    // untouched in both.
    expect(n(ranked[0]!.low)).toBe("150");
    expect(n(ranked[0]!.high)).toBe("170");
  });

  it("reports zero swing for an input that does not exist", () => {
    const ranked = rankSensitivity(baseline, [{ componentId: "nope", label: "Nope", variation: d("0.5") }], 8, "HALF_EVEN");
    expect(n(ranked[0]!.swing)).toBe("0");
  });

  it("expresses the swing as a fraction of the total", () => {
    const ranked = rankSensitivity(baseline, [{ componentId: "steel", label: "Steel", variation: d("0.1") }], 8, "HALF_EVEN");
    expect(n(ranked[0]!.swingFraction)).toBe("0.125");
  });
});

describe("break-even", () => {
  it("finds where two alternatives meet", () => {
    // A: £1000 fixed + £5/unit. B: £200 fixed + £13/unit. Meet at 100.
    const result = breakEven(d("1000"), d("5"), d("200"), d("13"), 8, "HALF_EVEN");
    expect(n(result.quantity!)).toBe("100");
    expect(result.explanation).toContain("lower fixed cost wins");
  });

  it("says when they never meet", () => {
    const result = breakEven(d("1000"), d("5"), d("200"), d("5"), 8, "HALF_EVEN");
    expect(result.quantity).toBeNull();
    expect(result.explanation).toContain("never meet");
  });

  it("says when they are identical at every quantity", () => {
    const result = breakEven(d("100"), d("5"), d("100"), d("5"), 8, "HALF_EVEN");
    expect(result.quantity).toBeNull();
    expect(result.explanation).toContain("same at every quantity");
  });

  it("flags a negative crossing as one alternative always winning", () => {
    const result = breakEven(d("100"), d("5"), d("200"), d("13"), 8, "HALF_EVEN");
    expect(result.explanation).toContain("cheaper at every real quantity");
  });
});
