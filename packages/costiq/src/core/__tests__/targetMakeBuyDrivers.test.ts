/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import {
  analyzeDrivers,
  compareDriverRankings,
  costOnWeakEvidence,
  type DriverInput,
} from "../costDriverAnalyzer.js";
import { compareMakeBuy, type BuyOption, type MakeOption } from "../makeBuyComparator.js";
import type { SensitivityRanking } from "../scenarioEngine.js";
import {
  computeTargetCost,
  planReduction,
  type ComponentCost,
  type TargetCostInput,
} from "../targetCostMethod.js";

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// Three questions a cost-plus engine cannot answer: what must this cost, should
// we make it at all, and where is the money actually going.
// ─────────────────────────────────────────────────────────────────────────────

const target = (over: Partial<TargetCostInput> = {}): TargetCostInput => ({
  marketPrice: d("200.00"),
  requiredMarginFraction: d("0.35"),
  currentCost: d("150.00"),
  currency: "GBP",
  scale: 6,
  mode: "HALF_EVEN",
  ...over,
});

describe("target costing runs the other way", () => {
  it("derives the allowable cost from price and margin", () => {
    // 200 x (1 - 0.35) = 130.
    const r = computeTargetCost(target());
    expect(n(r.allowableCost)).toBe("130");
    expect(n(r.requiredMargin)).toBe("70");
  });

  it("treats the margin as a fraction of PRICE, not of cost", () => {
    // Marking 130 up by 35% gives 175.50, not 200. Getting this backwards
    // overstates the allowable cost and lets a doomed product look viable.
    expect(n(computeTargetCost(target({ requiredMarginFraction: d("0.5") })).allowableCost)).toBe("100");
  });

  it("reports the gap when today's cost is too high", () => {
    const r = computeTargetCost(target());
    expect(r.feasibility).toBe("GAP_TO_CLOSE");
    expect(n(r.gap)).toBe("20");
    expect(r.note).toContain("does not work until that closes");
  });

  it("reports headroom without inviting anyone to spend it", () => {
    const r = computeTargetCost(target({ currentCost: d("100.00") }));
    expect(r.feasibility).toBe("WITHIN_TARGET");
    expect(r.note).toContain("not a licence to spend it");
  });

  it("says the question is open when nothing is costed yet", () => {
    const r = computeTargetCost(target({ currentCost: null }));
    expect(r.feasibility).toBe("NOT_YET_COSTED");
    expect(r.gap).toBeNull();
    expect(r.gapFraction).toBeNull();
  });

  it("refuses a margin of 100% or more", () => {
    expect(() => computeTargetCost(target({ requiredMarginFraction: d("1") }))).toThrow(
      /must be below 1/,
    );
  });

  it("refuses a negative margin rather than modelling a designed loss", () => {
    expect(() => computeTargetCost(target({ requiredMarginFraction: d("-0.1") }))).toThrow(
      /visible as a decision/,
    );
  });

  it("refuses a price of zero, which has no allowable cost", () => {
    expect(() => computeTargetCost(target({ marketPrice: d("0") }))).toThrow(/what customers will pay/);
  });

  it("treats costing EXACTLY the allowable amount as within target", () => {
    // The boundary. Landing precisely on the allowable cost is a product that
    // works, not one with a gap of zero to close — and reporting it as
    // GAP_TO_CLOSE would send somebody to find nothing.
    const r = computeTargetCost(target({ currentCost: d("130.00") }));
    expect(r.feasibility).toBe("WITHIN_TARGET");
    expect(n(r.gap)).toBe("0");
  });

  it("reports a zero gap fraction against a zero current cost rather than dividing", () => {
    expect(n(computeTargetCost(target({ currentCost: d("0") })).gapFraction)).toBe("0");
  });
});

describe("splitting a reduction across the things it must come out of", () => {
  const components: readonly ComponentCost[] = [
    { componentId: "steel", label: "Steel", cost: d("80.00"), addressable: false },
    { componentId: "fab", label: "Fabrication", cost: d("50.00"), addressable: true },
    { componentId: "finish", label: "Finishing", cost: d("20.00"), addressable: true },
  ];

  it("allocates proportionally and re-sums EXACTLY to the total", () => {
    // A plan whose lines add to 19.99 against a 20.00 target sends somebody
    // hunting for the penny.
    const plan = planReduction(components, d("20.00"), "PROPORTIONAL", 2, "HALF_EVEN");
    const summed = plan.targets.reduce((acc, t) => acc + Number(toString(t.reduction)), 0);
    expect(summed).toBeCloseTo(20, 10);
  });

  it("concentrates the whole reduction on what can actually move", () => {
    const plan = planReduction(components, d("14.00"), "ADDRESSABLE_ONLY", 2, "HALF_EVEN");
    expect(plan.targets.map((t) => t.componentId)).toEqual(["fab", "finish"]);
    expect(plan.warnings.join()).toContain("consequence of the marking, not a judgement by the engine");
  });

  it("names the basis's trade-off rather than presenting it as correct", () => {
    expect(planReduction(components, d("10"), "PROPORTIONAL", 2, "HALF_EVEN").basisNote).toContain(
      "almost never true",
    );
    expect(planReduction(components, d("10"), "EQUAL", 2, "HALF_EVEN").basisNote).toContain(
      "usually impossible on the small one",
    );
  });

  it("WARNS when the reduction exceeds what those components cost in total", () => {
    // No allocation makes this reachable, and scaling it to fit would hide that.
    const plan = planReduction(components, d("200.00"), "ADDRESSABLE_ONLY", 2, "HALF_EVEN");
    expect(plan.warnings.join()).toContain("No allocation makes this reachable");
  });

  it("shows a component driven below zero rather than clipping it", () => {
    const plan = planReduction(components, d("100.00"), "EQUAL", 2, "HALF_EVEN");
    expect(plan.warnings.join()).toContain("fall below zero");
    expect(plan.targets.some((t) => Number(toString(t.targetCost)) < 0)).toBe(true);
  });

  it("returns nothing to plan when the cost is already within target", () => {
    const plan = planReduction(components, d("0"), "PROPORTIONAL", 2, "HALF_EVEN");
    expect(plan.targets).toEqual([]);
    expect(plan.warnings.join()).toContain("already within target");
  });

  it("says so when nothing is addressable, instead of returning an empty plan silently", () => {
    const fixed = components.map((c) => ({ ...c, addressable: false }));
    const plan = planReduction(fixed, d("10"), "ADDRESSABLE_ONLY", 2, "HALF_EVEN");
    expect(plan.targets).toEqual([]);
    expect(plan.warnings.join()).toContain("not reachable by trimming");
  });

  it("falls back to equal shares when every eligible component is free", () => {
    const free = components.map((c) => ({ ...c, cost: d("0") }));
    const plan = planReduction(free, d("9.00"), "PROPORTIONAL", 2, "HALF_EVEN");
    expect(plan.warnings.join()).toContain("nothing to be proportional to");
    expect(plan.targets.map((t) => n(t.reduction))).toEqual(["3", "3", "3"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const make = (over: Partial<MakeOption> = {}): MakeOption => ({
  avoidableVariableCostPerUnit: d("8.00"),
  avoidableFixedCost: d("0"),
  unavoidableAbsorbedOverhead: d("400.00"),
  opportunityCostPerUnit: d("0"),
  ...over,
});

const buy = (over: Partial<BuyOption> = {}): BuyOption => ({
  supplierPricePerUnit: d("9.00"),
  acquisitionCostPerUnit: d("0.50"),
  transitionCost: d("0"),
  nonCostConsequences: [],
  ...over,
});

describe("make or buy, on the cost that actually changes", () => {
  it("compares avoidable cost, not absorbed cost", () => {
    // Make: 8.00 x 100 = 800. Buy: 9.50 x 100 = 950. Making is cheaper.
    const r = compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN");
    expect(n(r.makeAvoidableTotal)).toBe("800");
    expect(n(r.buyTotal)).toBe("950");
    expect(r.cheaperOnAvoidableCost).toBe("MAKE");
  });

  it("CATCHES the absorbed-cost error and names it", () => {
    // With 400 of overhead loaded on, making looks like 1,200 against 950 and
    // the part gets outsourced. The overhead does not go away; it moves onto
    // everything else the shop makes.
    const r = compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN");
    expect(r.absorbedComparisonWouldSay).toBe("BUY");
    expect(r.cheaperOnAvoidableCost).toBe("MAKE");
    expect(r.absorbedCostMisleads).toBe(true);
    expect(r.warnings.join()).toContain("does not go away if it is bought");
    expect(r.warnings.join()).toContain("most expensive routine error");
  });

  it("does not flag a disagreement when there is none", () => {
    const r = compareMakeBuy(make({ unavoidableAbsorbedOverhead: d("10.00") }), buy(), d("100"), 6, "HALF_EVEN");
    expect(r.absorbedCostMisleads).toBe(false);
  });

  it("never nets the unavoidable overhead off either side", () => {
    const r = compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN");
    expect(n(r.overheadThatDoesNotGoAway)).toBe("400");
    // 800, not 800 - 400 or 800 + 400.
    expect(n(r.makeAvoidableTotal)).toBe("800");
    expect(r.explanation).toContain("excluded from both sides");
  });

  it("counts displaced work as a cost of making", () => {
    // Idle capacity is free; scarce capacity is not, and the difference decides
    // the answer here.
    const idle = compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN");
    const scarce = compareMakeBuy(
      make({ opportunityCostPerUnit: d("3.00") }),
      buy(),
      d("100"),
      6,
      "HALF_EVEN",
    );
    expect(idle.cheaperOnAvoidableCost).toBe("MAKE");
    expect(scarce.cheaperOnAvoidableCost).toBe("BUY");
  });

  it("challenges a zero opportunity cost rather than accepting it quietly", () => {
    expect(compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN").warnings.join()).toContain(
      "would otherwise sit idle",
    );
  });

  it("challenges a zero unavoidable overhead, which is rarely true", () => {
    const r = compareMakeBuy(make({ unavoidableAbsorbedOverhead: d("0") }), buy(), d("100"), 6, "HALF_EVEN");
    expect(r.warnings.join()).toContain("rarely fall when one part is outsourced");
  });

  it("treats the supplier's price as separate from the cost of buying", () => {
    const noAcquisition = compareMakeBuy(make(), buy({ acquisitionCostPerUnit: d("0") }), d("100"), 6, "HALF_EVEN");
    expect(n(noAcquisition.buyTotal)).toBe("900");
  });

  it("says how many units repay the switching cost", () => {
    // Buy saves 1.50/unit against a make cost of 11. Transition 300 → 200 units.
    const r = compareMakeBuy(
      make({ avoidableVariableCostPerUnit: d("11.00") }),
      buy({ transitionCost: d("300.00") }),
      d("100"),
      6,
      "HALF_EVEN",
    );
    expect(n(r.breakEvenUnits)).toBe("200");
    expect(r.explanation).toContain("repaid after 200");
  });

  it("counts the switching cost IN the buy total, not only in the payback", () => {
    // A one-off cost left out of the comparison flips this verdict: without the
    // 300, buying is 950 against 1,100 and looks cheaper. With it, buying is
    // 1,250 and making wins at this quantity. The payback figure alone does not
    // catch that — the total has to carry it.
    const r = compareMakeBuy(
      make({ avoidableVariableCostPerUnit: d("11.00") }),
      buy({ transitionCost: d("300.00") }),
      d("100"),
      6,
      "HALF_EVEN",
    );
    expect(n(r.buyTotal)).toBe("1250");
    expect(r.cheaperOnAvoidableCost).toBe("MAKE");
  });

  it("spreads the avoidable fixed cost over the quantity when computing payback", () => {
    // 500 of avoidable fixed cost is 5 per unit at 100 units, not 500. Treating
    // the lump as per-unit makes the switch look like it repays almost
    // immediately — 0.6 units instead of 46.
    const r = compareMakeBuy(
      make({ avoidableVariableCostPerUnit: d("11.00"), avoidableFixedCost: d("500.00") }),
      buy({ transitionCost: d("300.00") }),
      d("100"),
      6,
      "HALF_EVEN",
    );
    // (11 + 500/100) - 9.50 = 6.50 saved per unit. 300 / 6.50 = 46.153846.
    expect(n(r.breakEvenUnits)).toBe("46.153846");
  });

  it("says a switching cost is never repaid when buying saves nothing", () => {
    const r = compareMakeBuy(make(), buy({ transitionCost: d("300.00") }), d("100"), 6, "HALF_EVEN");
    expect(r.breakEvenUnits).toBeNull();
    expect(r.explanation).toContain("never repaid");
  });

  it("spreads the avoidable fixed cost across the quantity", () => {
    const small = compareMakeBuy(make({ avoidableFixedCost: d("500.00") }), buy(), d("100"), 6, "HALF_EVEN");
    const large = compareMakeBuy(make({ avoidableFixedCost: d("500.00") }), buy(), d("1000"), 6, "HALF_EVEN");
    expect(small.cheaperOnAvoidableCost).toBe("BUY");
    expect(large.cheaperOnAvoidableCost).toBe("MAKE");
  });

  it("carries the non-cost consequences it cannot price", () => {
    const r = compareMakeBuy(
      make(),
      buy({ nonCostConsequences: ["Single source", "Twelve-week lead time"] }),
      d("100"),
      6,
      "HALF_EVEN",
    );
    expect(r.nonCostConsequences).toEqual(["Single source", "Twelve-week lead time"]);
  });

  it("says the sourcing decision is not CostIQ's", () => {
    expect(compareMakeBuy(make(), buy(), d("100"), 6, "HALF_EVEN").explanation).toContain(
      "CostIQ does not own",
    );
  });

  it("reports a genuine tie rather than picking a side", () => {
    const r = compareMakeBuy(make(), buy({ supplierPricePerUnit: d("7.50") }), d("100"), 6, "HALF_EVEN");
    expect(r.cheaperOnAvoidableCost).toBe("NEITHER");
    expect(r.explanation).toContain("identical");
  });

  it("refuses a comparison with no quantity", () => {
    expect(() => compareMakeBuy(make(), buy(), d("0"), 6, "HALF_EVEN")).toThrow(/needs a quantity/);
  });

  it("refuses a negative cost rather than modelling a hidden credit", () => {
    expect(() =>
      compareMakeBuy(make({ avoidableVariableCostPerUnit: d("-1") }), buy(), d("100"), 6, "HALF_EVEN"),
    ).toThrow(/model it as a separate credit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const driver = (id: string, amount: string, included = true): DriverInput => ({
  componentId: id,
  label: id,
  amount: d(amount),
  included,
});

describe("what the cost is made of", () => {
  const components = [driver("steel", "55"), driver("labour", "25"), driver("finish", "15"), driver("pack", "5")];

  it("ranks by contribution and reports cumulative share", () => {
    const a = analyzeDrivers(components, d("0.8"), 4, "HALF_EVEN");
    expect(a.contributions.map((c) => c.componentId)).toEqual(["steel", "labour", "finish", "pack"]);
    expect(n(a.contributions[0]!.share)).toBe("0.55");
    expect(n(a.contributions[1]!.cumulativeShare)).toBe("0.8");
  });

  it("says how few components carry most of the cost", () => {
    const a = analyzeDrivers(components, d("0.8"), 4, "HALF_EVEN");
    expect(a.componentsCarryingMost).toBe(2);
    expect(a.concentrationNote).toContain("says nothing about whether any of it can be changed");
  });

  it("says when the cost is SPREAD rather than concentrated", () => {
    // Four equal components: it takes three of the four to reach 80%. That is
    // a flat cost, and calling it concentrated because the threshold was
    // technically reached would be useless.
    const flat = [driver("a", "25"), driver("b", "25"), driver("c", "25"), driver("d", "25")];
    const a = analyzeDrivers(flat, d("0.8"), 4, "HALF_EVEN");
    expect(a.isSpread).toBe(true);
    expect(a.componentsCarryingMost).toBe(4);
    expect(a.concentrationNote).toContain("harder to attack");
  });

  it("does not call a concentrated cost spread", () => {
    const a = analyzeDrivers(components, d("0.8"), 4, "HALF_EVEN");
    expect(a.isSpread).toBe(false);
  });

  it("refuses to answer a threshold above 1 rather than reporting the whole set", () => {
    const a = analyzeDrivers(components, d("1.5"), 4, "HALF_EVEN");
    expect(a.isSpread).toBe(false);
    expect(a.concentrationNote).toContain("needs restating");
  });

  it("breaks ties by id so the ranking does not wobble between runs", () => {
    const tied = [driver("zulu", "10"), driver("alpha", "10")];
    expect(analyzeDrivers(tied, d("0.8"), 4, "HALF_EVEN").contributions.map((c) => c.componentId)).toEqual([
      "alpha",
      "zulu",
    ]);
  });

  it("names excluded components rather than dropping them silently", () => {
    const a = analyzeDrivers([...components, driver("optional", "40", false)], d("0.8"), 4, "HALF_EVEN");
    expect(a.excluded.map((e) => e.componentId)).toEqual(["optional"]);
    expect(n(a.total)).toBe("100");
    expect(a.warnings.join()).toContain("Their money is real");
  });

  it("refuses to report shares of a zero total", () => {
    const a = analyzeDrivers([driver("a", "0")], d("0.8"), 4, "HALF_EVEN");
    expect(a.contributions).toEqual([]);
    expect(a.concentrationNote).toContain("dividing by nothing");
  });

  it("warns that a negative component breaks the parts-of-a-whole reading", () => {
    const a = analyzeDrivers([driver("a", "100"), driver("credit", "-20")], d("0.8"), 4, "HALF_EVEN");
    expect(a.warnings.join()).toContain("cumulative column can move backwards");
  });

  it("handles an empty model without inventing a driver", () => {
    expect(analyzeDrivers([], d("0.8"), 4, "HALF_EVEN").contributions).toEqual([]);
  });
});

describe("where contribution and sensitivity disagree", () => {
  const sensitivity = (id: string, swing: string): SensitivityRanking => ({
    componentId: id,
    label: id,
    low: d("0"),
    high: d("0"),
    swing: d(swing),
    swingFraction: d("0"),
  });

  const contributions = analyzeDrivers(
    [driver("steel", "55"), driver("labour", "25"), driver("finish", "15"), driver("pack", "5")],
    d("0.8"),
    4,
    "HALF_EVEN",
  ).contributions;

  it("calls out a component that is large and trusted", () => {
    // Steel is 1st by size, last by uncertainty. That is a negotiation.
    const findings = compareDriverRankings(
      contributions,
      [sensitivity("steel", "1"), sensitivity("labour", "2"), sensitivity("finish", "3"), sensitivity("pack", "40")],
      2,
      1,
    );
    const steel = findings.find((f) => f.componentId === "steel")!;
    expect(steel.kind).toBe("BIG_BUT_STABLE");
    expect(steel.note).toContain("a negotiation, not a measurement");
  });

  it("calls out a component that is small and volatile", () => {
    const findings = compareDriverRankings(
      contributions,
      [sensitivity("steel", "1"), sensitivity("labour", "2"), sensitivity("finish", "3"), sensitivity("pack", "40")],
      2,
      1,
    );
    const pack = findings.find((f) => f.componentId === "pack")!;
    expect(pack.kind).toBe("SMALL_BUT_VOLATILE");
    expect(pack.note).toContain("not worth a cost-reduction project");
  });

  it("puts a component that is BOTH at the top", () => {
    const findings = compareDriverRankings(contributions, [sensitivity("steel", "99")], 2, 1);
    expect(findings[0]!.kind).toBe("BIG_AND_VOLATILE");
    expect(findings[0]!.note).toContain("first thing to nail down");
  });

  it("stays quiet about ranks that barely differ", () => {
    // Ranked in the same order by both measures. Nothing here disagrees with
    // itself, and reporting a one-place shuffle would be noise.
    const findings = compareDriverRankings(
      contributions,
      [sensitivity("steel", "40"), sensitivity("labour", "30"), sensitivity("finish", "20"), sensitivity("pack", "10")],
      2,
      0,
    );
    expect(findings).toEqual([]);
  });

  it("says nothing about a component nobody asked a sensitivity question about", () => {
    // Only steel and pack were asked about, so only they can be ranked. Silence
    // on the others is not a finding, and inventing a rank for them would be
    // inventing evidence.
    const findings = compareDriverRankings(
      contributions,
      [sensitivity("pack", "40"), sensitivity("steel", "1")],
      2,
      0,
    );
    // Steel is 1st by size and 2nd by uncertainty — no real disagreement, so it
    // is correctly silent too. What matters is that labour and finish, which
    // nobody asked about, cannot appear at all.
    const named = findings.map((f) => f.componentId);
    expect(named).toContain("pack");
    expect(named).not.toContain("labour");
    expect(named).not.toContain("finish");
  });
});

describe("how much of the number we actually know", () => {
  const parts = [
    { amount: d("60"), included: true, sourceStrength: 90 },
    { amount: d("30"), included: true, sourceStrength: 25 },
    { amount: d("10"), included: true, sourceStrength: 5 },
    { amount: d("500"), included: false, sourceStrength: 5 },
  ];

  it("reports weak evidence as an AMOUNT, not a count", () => {
    // Ten weakly-evidenced fasteners and one weakly-evidenced casting are not
    // the same problem.
    const r = costOnWeakEvidence(parts, 40, 4, "HALF_EVEN");
    expect(n(r.amount)).toBe("40");
    expect(n(r.fraction)).toBe("0.4");
  });

  it("ignores excluded components, which are not in the total either", () => {
    expect(n(costOnWeakEvidence(parts, 40, 4, "HALF_EVEN").amount)).toBe("40");
  });

  it("does not present a zero total as reassurance", () => {
    const r = costOnWeakEvidence([{ amount: d("0"), included: true, sourceStrength: 1 }], 40, 4, "HALF_EVEN");
    expect(r.note).toContain("arithmetic, not reassurance");
  });

  it("separates evidence quality from arithmetic correctness", () => {
    expect(costOnWeakEvidence(parts, 40, 4, "HALF_EVEN").note).toContain(
      "separate question from whether the arithmetic is right",
    );
  });
});
