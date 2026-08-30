/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import {
  compareLifecycle,
  computeLandedCost,
  computeLifecycleCost,
  computeShouldCost,
  shouldCostGap,
  type LandedCostInput,
  type ShipmentLine,
  type ShouldCostInput,
} from "../shouldCostAndLanded.js";

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// Three different answers to "what does this cost", and the ways they get
// confused: should-cost merged with paid, an allocation basis chosen once and
// forgotten, and a TCO with no stated horizon.
// ─────────────────────────────────────────────────────────────────────────────

const shouldCostInput = (over: Partial<ShouldCostInput> = {}): ShouldCostInput => ({
  materialCost: d("10.00"),
  processMinutes: d("5"),
  processRatePerMinute: d("1.00"),
  setupCost: d("100.00"),
  setupAmortizedOverUnits: d("100"),
  overheadFraction: d("0.2"),
  supplierMarginFraction: d("0.15"),
  quantity: d("10"),
  scale: 6,
  mode: "HALF_EVEN",
  rateSource: "Regional machining rate survey 2026",
  ...over,
});

describe("should-cost is built up, and every input is arguable", () => {
  it("builds material, process, setup, overhead and margin", () => {
    const r = computeShouldCost(shouldCostInput());
    // material 10 + process 5 + setup share (100/100 x 10 = 10) = 25 direct.
    expect(n(r.directCost)).toBe("25");
    // overhead 20% = 5, supplier cost 30.
    expect(n(r.overhead)).toBe("5");
    expect(n(r.supplierCost)).toBe("30");
    // margin is on PRICE: 30 / 0.85 = 35.294118.
    expect(n(r.shouldCostPrice)).toBe("35.294118");
  });

  it("applies supplier margin as a margin, not a markup", () => {
    // Marking up here would understate what a supplier needs to charge — the
    // same error that costs sellers money, in reverse.
    const r = computeShouldCost(shouldCostInput({ supplierMarginFraction: d("0.5") }));
    // 30 / 0.5 = 60, not 30 x 1.5 = 45.
    expect(n(r.shouldCostPrice)).toBe("60");
  });

  it("records every assumption, so the number can be argued with", () => {
    // A should-cost nobody can challenge is a number nobody will act on in a
    // negotiation.
    const r = computeShouldCost(shouldCostInput());
    const text = r.assumptions.join(" ");
    expect(text).toContain("Regional machining rate survey 2026");
    expect(text).toContain("overhead assumed at 20%");
    expect(text).toContain("margin assumed at 15%");
    expect(text).toContain("amortised over 100 units");
  });

  it("refuses a supplier margin of 100% or more", () => {
    expect(() => computeShouldCost(shouldCostInput({ supplierMarginFraction: d("1") }))).toThrow(/must be below 1/);
  });

  it("refuses a zero quantity", () => {
    expect(() => computeShouldCost(shouldCostInput({ quantity: d("0") }))).toThrow(/no per-unit answer/);
  });

  it("charges setup wholly when there is no amortisation basis", () => {
    const r = computeShouldCost(shouldCostInput({ setupAmortizedOverUnits: null }));
    expect(n(r.setupShare)).toBe("100");
    expect(r.assumptions.join()).toContain("charged wholly");
  });
});

describe("the gap is the whole point of should-cost", () => {
  it("reports paying more than it should cost", () => {
    const gap = shouldCostGap(d("42.00"), d("31.00"), 6, "HALF_EVEN");
    expect(n(gap.gap)).toBe("11");
    expect(gap.direction).toBe("PAYING_MORE");
  });

  it("reports paying less", () => {
    expect(shouldCostGap(d("25.00"), d("31.00"), 6, "HALF_EVEN").direction).toBe("PAYING_LESS");
  });

  it("says explicitly that acting on it is not CostIQ's decision", () => {
    // Renegotiating is a procurement decision the charter places outside.
    expect(shouldCostGap(d("42"), d("31"), 6, "HALF_EVEN").note).toContain("CostIQ does not own");
  });

  it("reports zero fraction against a zero should-cost rather than dividing", () => {
    expect(n(shouldCostGap(d("42"), d("0"), 6, "HALF_EVEN").gapFraction)).toBe("0");
  });
});

describe("landed cost: the allocation basis is a choice that matters", () => {
  const lines: readonly ShipmentLine[] = [
    { lineId: "heavy", label: "Steel castings", goodsValue: d("100"), weight: d("900"), volume: d("1"), units: d("10") },
    { lineId: "light", label: "Electronics", goodsValue: d("900"), weight: d("100"), volume: d("1"), units: d("10") },
  ];

  const landed = (over: Partial<LandedCostInput> = {}) =>
    computeLandedCost({
      lines,
      freight: d("100.00"),
      insurance: d("0"),
      handling: d("0"),
      dutyFractionByLine: new Map(),
      basis: "BY_VALUE",
      scale: 6,
      mode: "HALF_EVEN",
      ...over,
    });

  it("gives materially different answers by value and by weight", () => {
    // The same shipment. Neither is wrong; the difference is why the basis
    // travels with the result rather than being a setting somebody forgot.
    const byValue = landed({ basis: "BY_VALUE" });
    const byWeight = landed({ basis: "BY_WEIGHT" });
    expect(n(byValue.lines.find((l) => l.lineId === "heavy")!.allocatedFreight)).toBe("10");
    expect(n(byWeight.lines.find((l) => l.lineId === "heavy")!.allocatedFreight)).toBe("90");
  });

  it("carries a note explaining the basis's trade-off", () => {
    expect(landed({ basis: "BY_VALUE" }).basisNote).toContain("expensive light items more freight");
    expect(landed({ basis: "BY_WEIGHT" }).basisNote).toContain("under-charges bulky light items");
    expect(landed({ basis: "BY_UNIT" }).basisNote).toContain("charges a washer the same as a casting");
  });

  it("allocates the whole shipment cost, losing nothing", () => {
    const result = landed({ freight: d("100.00"), insurance: d("50.00"), handling: d("25.00") });
    const allocated = result.lines.reduce(
      (acc, l) => acc + Number(toString(l.allocatedFreight)) + Number(toString(l.allocatedInsurance)) + Number(toString(l.allocatedHandling)),
      0,
    );
    expect(allocated).toBeCloseTo(175, 6);
  });

  it("applies duty per line on its own value, not as a shipment total", () => {
    // A tariff applies to the goods it applies to.
    const result = landed({ dutyFractionByLine: new Map([["heavy", d("0.05")]]) });
    expect(n(result.lines.find((l) => l.lineId === "heavy")!.duty)).toBe("5");
    expect(n(result.lines.find((l) => l.lineId === "light")!.duty)).toBe("0");
  });

  it("refuses a basis the shipment does not vary by", () => {
    const noVolume = lines.map((l) => ({ ...l, volume: d("0") }));
    expect(() => computeLandedCost({
      lines: noVolume,
      freight: d("100"),
      insurance: d("0"),
      handling: d("0"),
      dutyFractionByLine: new Map(),
      basis: "BY_VOLUME",
      scale: 6,
      mode: "HALF_EVEN",
    })).toThrow(/basis the shipment actually varies by/);
  });

  it("handles an empty shipment without dividing by nothing", () => {
    const empty = landed({ lines: [] });
    expect(empty.total).toEqual(d("0"));
    // The early-return path must still carry the basis and its note. A
    // mutation blanking the note there survived until this assertion existed,
    // because every other note test goes through the main path.
    expect(empty.basis).toBe("BY_VALUE");
    expect(empty.basisNote.length).toBeGreaterThan(0);
  });

  it("reports zero per-unit for a line with no units rather than dividing", () => {
    const zeroUnits = [{ ...lines[0]!, units: d("0") }];
    const result = landed({ lines: zeroUnits });
    expect(n(result.lines[0]!.landedPerUnit)).toBe("0");
  });
});

describe("lifecycle cost needs a stated horizon", () => {
  const costs = [
    { label: "Purchase", amount: d("1000"), year: 0, recurring: false },
    { label: "Maintenance", amount: d("100"), year: 1, recurring: true },
    { label: "Disposal", amount: d("200"), year: 9, recurring: false },
  ];

  it("refuses to compute without one", () => {
    // Five years and fifteen years are different answers to the same question.
    expect(() =>
      computeLifecycleCost({ costs, horizonYears: 0, discountRate: null, scale: 6, mode: "HALF_EVEN" }),
    ).toThrow(/without one the total is not a number/);
  });

  it("repeats recurring costs across the horizon", () => {
    const r = computeLifecycleCost({ costs, horizonYears: 5, discountRate: null, scale: 6, mode: "HALF_EVEN" });
    // 1000 + 100 x 4 (years 1-4) = 1400. Disposal at year 9 is outside.
    expect(n(r.undiscountedTotal)).toBe("1400");
  });

  it("EXCLUDES costs beyond the horizon and says so", () => {
    // Silently dropping them would make a long-lived alternative look cheaper.
    const r = computeLifecycleCost({ costs, horizonYears: 5, discountRate: null, scale: 6, mode: "HALF_EVEN" });
    expect(r.assumptions.join()).toContain("beyond the 5-year horizon");
    expect(r.assumptions.join()).toContain("A longer horizon would change this answer");
  });

  it("discounts future money when a rate is supplied", () => {
    const r = computeLifecycleCost({
      costs: [{ label: "Later", amount: d("100"), year: 1, recurring: false }],
      horizonYears: 2,
      discountRate: d("0.1"),
      scale: 6,
      mode: "HALF_EVEN",
    });
    // 100 / 1.1 = 90.909091.
    expect(n(r.byYear[0]!.discounted)).toBe("90.909091");
  });

  it("says whose parameter the discount rate is", () => {
    // Using a rate CostIQ invented would be CostIQ making a financial
    // assumption it does not own.
    const r = computeLifecycleCost({ costs, horizonYears: 5, discountRate: d("0.08"), scale: 6, mode: "HALF_EVEN" });
    expect(r.assumptions.join()).toContain("must come from Finance IQ");
  });

  it("treats undiscounted as a stated choice", () => {
    const r = computeLifecycleCost({ costs, horizonYears: 5, discountRate: null, scale: 6, mode: "HALF_EVEN" });
    expect(r.assumptions.join()).toContain("Future money is treated as equal to money today");
  });
});

describe("comparing lifecycle alternatives", () => {
  const build = (label: string, amount: string, horizonYears: number) => ({
    label,
    result: computeLifecycleCost({
      costs: [{ label, amount: d(amount), year: 0, recurring: false }],
      horizonYears,
      discountRate: null,
      scale: 6,
      mode: "HALF_EVEN",
    }),
  });

  it("ranks by total over the horizon", () => {
    const ranked = compareLifecycle([build("expensive", "2000", 5), build("cheap", "1000", 5)]).ranked;
    expect(ranked.map((r) => r.label)).toEqual(["cheap", "expensive"]);
  });

  it("REFUSES to compare across different horizons", () => {
    // The shorter horizon flatters whichever option front-loads its costs, and
    // the mistake is almost invisible in a summary table.
    expect(() => compareLifecycle([build("a", "1000", 5), build("b", "1000", 15)])).toThrow(
      /different horizons/,
    );
  });

  it("says that choosing is not CostIQ's decision", () => {
    const result = compareLifecycle([build("a", "1000", 5)]);
    expect(result.note).toContain("informs and does not make");
  });
});
