/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import type { Provenance } from "../../domain/provenance.js";
import {
  breakEvenQuantity,
  decisionFlipThreshold,
  evaluateAlternative,
  rankAlternatives,
  whyNot,
  type CostAlternative,
} from "../alternativesAndBreakEven.js";
import {
  assessModelHealth,
  healthTrend,
  type HealthPolicy,
  type ModelComponentHealth,
} from "../costModelHealth.js";

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// The two failure modes these modules exist for: a recommendation presented as
// certain when it is a coin toss, and a model that has quietly stopped being
// true while continuing to compute.
// ─────────────────────────────────────────────────────────────────────────────

const alternative = (over: Partial<CostAlternative> & Pick<CostAlternative, "id">): CostAlternative => ({
  label: over.id,
  fixedCost: d("0"),
  variableCostPerUnit: d("1"),
  nonCostConstraints: [],
  ...over,
});

describe("break-even is the answer to a question one quantity cannot answer", () => {
  // Hand tooling: cheap to set up, expensive per part.
  const manual = alternative({ id: "manual", fixedCost: d("0"), variableCostPerUnit: d("12") });
  // Hard tooling: £2,000 to make, £2 per part.
  const tooled = alternative({ id: "tooled", fixedCost: d("2000"), variableCostPerUnit: d("2") });

  it("finds the exact crossing", () => {
    // 0 + 12q = 2000 + 2q  ->  10q = 2000  ->  q = 200.
    const result = breakEvenQuantity(manual, tooled, 6, "HALF_EVEN");
    expect(n(result.quantity!)).toBe("200");
  });

  it("gives opposite answers either side of it", () => {
    const below = rankAlternatives([manual, tooled], d("100"), 6, "HALF_EVEN", d("0.05"));
    const above = rankAlternatives([manual, tooled], d("500"), 6, "HALF_EVEN", d("0.05"));
    expect(below.ranked[0]!.id).toBe("manual");
    expect(above.ranked[0]!.id).toBe("tooled");
  });

  it("returns no crossing when the per-unit costs are identical", () => {
    // Parallel lines. Reporting a break-even here would be reporting a number
    // for a question that has no answer.
    const a = alternative({ id: "a", fixedCost: d("100"), variableCostPerUnit: d("5") });
    const b = alternative({ id: "b", fixedCost: d("300"), variableCostPerUnit: d("5") });
    const result = breakEvenQuantity(a, b, 6, "HALF_EVEN");
    expect(result.quantity).toBeNull();
    expect(result.note).toContain("never cross");
    expect(result.note).toContain("cheaper at every quantity");
  });

  it("names which one is always cheaper when they never cross", () => {
    const a = alternative({ id: "a", fixedCost: d("100"), variableCostPerUnit: d("5") });
    const b = alternative({ id: "b", fixedCost: d("300"), variableCostPerUnit: d("5") });
    expect(breakEvenQuantity(a, b, 6, "HALF_EVEN").note).toContain('"a" is cheaper');
    // And from the other direction, so the answer does not depend on argument order.
    expect(breakEvenQuantity(b, a, 6, "HALF_EVEN").note).toContain('"a" is cheaper');
  });

  it("says so when two options are identical rather than picking one", () => {
    const a = alternative({ id: "a", fixedCost: d("100"), variableCostPerUnit: d("5") });
    const b = alternative({ id: "b", fixedCost: d("100"), variableCostPerUnit: d("5") });
    expect(breakEvenQuantity(a, b, 6, "HALF_EVEN").note).toContain("not a cost decision");
  });

  it("refuses to report a crossing at a negative quantity", () => {
    // Real algebra, useless answer. One option is cheaper everywhere you could
    // actually produce, and "they cross at -40" invites somebody to act on it.
    const cheapEverywhere = alternative({ id: "cheap", fixedCost: d("10"), variableCostPerUnit: d("1") });
    const dearEverywhere = alternative({ id: "dear", fixedCost: d("100"), variableCostPerUnit: d("5") });
    const result = breakEvenQuantity(cheapEverywhere, dearEverywhere, 6, "HALF_EVEN");
    expect(result.quantity).toBeNull();
    expect(result.note).toContain("negative quantity");
  });

  it("warns that the exact crossing may fall between makeable quantities", () => {
    const a = alternative({ id: "a", fixedCost: d("0"), variableCostPerUnit: d("3") });
    const b = alternative({ id: "b", fixedCost: d("10"), variableCostPerUnit: d("1") });
    expect(breakEvenQuantity(a, b, 6, "HALF_EVEN").note).toContain("between two makeable quantities");
  });
});

describe("evaluating one alternative", () => {
  it("spreads fixed cost across the quantity", () => {
    const result = evaluateAlternative(
      alternative({ id: "t", fixedCost: d("2000"), variableCostPerUnit: d("2") }),
      d("100"),
      6,
      "HALF_EVEN",
    );
    expect(n(result.totalCost)).toBe("2200");
    expect(n(result.unitCost)).toBe("22");
    expect(n(result.fixedShare)).toBe("20");
  });

  it("refuses a zero quantity rather than dividing", () => {
    expect(() => evaluateAlternative(alternative({ id: "t" }), d("0"), 6, "HALF_EVEN")).toThrow(
      /spread over nothing/,
    );
  });

  it("refuses a negative quantity", () => {
    expect(() => evaluateAlternative(alternative({ id: "t" }), d("-5"), 6, "HALF_EVEN")).toThrow(
      /cannot be evaluated at quantity/,
    );
  });
});

describe("why-not answers the question people actually ask", () => {
  const chosen = alternative({ id: "chosen", label: "In-house", fixedCost: d("100"), variableCostPerUnit: d("4") });
  const dearer = alternative({ id: "dearer", label: "Subcontract", fixedCost: d("0"), variableCostPerUnit: d("6") });

  it("states the gap in both money and per-unit terms", () => {
    const answer = whyNot(dearer, chosen, d("100"), 6, "HALF_EVEN");
    // dearer: 600. chosen: 500. Gap 100.
    expect(n(answer.costDifference)).toBe("100");
    expect(answer.explanation).toContain("costs 100 more");
    expect(answer.explanation).toContain("6.000000 vs 5.000000 per unit");
  });

  it("reports the difference as a fraction of the chosen option", () => {
    expect(n(whyNot(dearer, chosen, d("100"), 6, "HALF_EVEN").costDifferenceFraction)).toBe("0.2");
  });

  it("ADMITS when the rejected option was actually cheaper", () => {
    // The case that matters. A cheaper option that lost must have lost on
    // something else, and pretending otherwise makes the decision unauditable.
    const answer = whyNot(chosen, dearer, d("100"), 6, "HALF_EVEN");
    expect(answer.cheaperButRejected).toBe(true);
    expect(answer.explanation).toContain("CHEAPER");
  });

  it("says plainly when a cheaper option was rejected for no recorded reason", () => {
    const answer = whyNot(chosen, dearer, d("100"), 6, "HALF_EVEN");
    expect(answer.explanation).toContain("no non-cost reason was recorded");
    expect(answer.explanation).toContain("not explained");
  });

  it("quotes the recorded non-cost reason when there is one", () => {
    const constrained = { ...chosen, nonCostConstraints: ["The press is booked until March"] };
    const answer = whyNot(constrained, dearer, d("100"), 6, "HALF_EVEN");
    expect(answer.explanation).toContain("The press is booked until March");
  });

  it("says cost does not decide it when the two are equal", () => {
    const twin = { ...chosen, id: "twin" };
    expect(whyNot(twin, chosen, d("100"), 6, "HALF_EVEN").explanation).toContain("Cost does not decide");
  });

  it("carries the break-even alongside, because the answer is quantity-dependent", () => {
    const answer = whyNot(dearer, chosen, d("100"), 6, "HALF_EVEN");
    // 0 + 6q = 100 + 4q -> q = 50. Below 50 the subcontractor wins.
    expect(n(answer.breakEvenQuantity!)).toBe("50");
    expect(answer.explanation).toContain("50.000000 units");
  });
});

describe("ranking reports how close the decision was", () => {
  const near = [
    alternative({ id: "a", label: "A", fixedCost: d("0"), variableCostPerUnit: d("10.00") }),
    alternative({ id: "b", label: "B", fixedCost: d("0"), variableCostPerUnit: d("10.02") }),
  ];

  it("calls a 0.2% gap too close to call", () => {
    // The whole point. A ranking inside the error bar of the model is not a
    // recommendation, and presenting it as one is worse than saying nothing.
    const result = rankAlternatives(near, d("100"), 6, "HALF_EVEN", d("0.05"));
    expect(result.robustnessNote).toContain("TOO CLOSE TO CALL");
    expect(n(result.decisionMarginFraction!)).toBe("0.002");
  });

  it("stands behind a wide gap", () => {
    const wide = [
      alternative({ id: "a", label: "A", variableCostPerUnit: d("10") }),
      alternative({ id: "b", label: "B", variableCostPerUnit: d("20") }),
    ];
    const result = rankAlternatives(wide, d("100"), 6, "HALF_EVEN", d("0.05"));
    expect(result.robustnessNote).not.toContain("TOO CLOSE");
    expect(result.robustnessNote).toContain("holds unless a cost input is wrong");
  });

  it("breaks cost ties by id so a replay does not report a phantom change", () => {
    const tied = [
      alternative({ id: "zulu", variableCostPerUnit: d("5") }),
      alternative({ id: "alpha", variableCostPerUnit: d("5") }),
    ];
    // Fixture deliberately NOT in the expected order, so a mutation removing
    // the tie-break cannot pass by accident.
    expect(rankAlternatives(tied, d("10"), 6, "HALF_EVEN", d("0.05")).ranked.map((r) => r.id)).toEqual([
      "alpha",
      "zulu",
    ]);
  });

  it("explains every rejection, not just the runner-up", () => {
    const three = [
      alternative({ id: "a", variableCostPerUnit: d("10") }),
      alternative({ id: "b", variableCostPerUnit: d("20") }),
      alternative({ id: "c", variableCostPerUnit: d("30") }),
    ];
    const result = rankAlternatives(three, d("10"), 6, "HALF_EVEN", d("0.05"));
    expect(result.whyNotEach.map((w) => w.rejectedId)).toEqual(["b", "c"]);
    expect(result.whyNotEach.every((w) => w.chosenId === "a")).toBe(true);
  });

  it("refuses to rank nothing rather than inventing a winner", () => {
    expect(() => rankAlternatives([], d("10"), 6, "HALF_EVEN", d("0.05"))).toThrow(/no alternatives to rank/);
  });

  it("says a single alternative wins by default, which is not the same as being good", () => {
    const result = rankAlternatives([alternative({ id: "only" })], d("10"), 6, "HALF_EVEN", d("0.05"));
    expect(result.decisionMarginFraction).toBeNull();
    expect(result.robustnessNote).toContain("not the same as being a good option");
  });
});

describe("how wrong an input would have to be to flip the decision", () => {
  const winner = alternative({ id: "w", label: "Winner", fixedCost: d("100"), variableCostPerUnit: d("4") });
  const runnerUp = alternative({ id: "r", label: "Runner", fixedCost: d("0"), variableCostPerUnit: d("6") });

  it("reports the fixed and per-unit thresholds", () => {
    // winner 500, runner 600 at q=100. Gap 100, or 1 per unit.
    const result = decisionFlipThreshold(winner, runnerUp, d("100"), 6, "HALF_EVEN");
    expect(n(result.fixedCostIncrease)).toBe("100");
    expect(n(result.variableCostIncrease!)).toBe("1");
  });

  it("refuses to give a threshold for an option that is not winning", () => {
    const result = decisionFlipThreshold(runnerUp, winner, d("100"), 6, "HALF_EVEN");
    expect(result.variableCostIncrease).toBeNull();
    expect(result.note).toContain("does not currently win");
  });

  it("refuses a threshold when the two are exactly tied", () => {
    // A gap of zero is not a win. Reporting "it stops winning if its cost rises
    // by 0" reads as a real threshold and is nonsense — the boundary has to be
    // exclusive, and a mutation loosening it survived until this existed.
    const twin = { ...runnerUp, id: "twin", fixedCost: d("100"), variableCostPerUnit: d("4") };
    const result = decisionFlipThreshold(winner, twin, d("100"), 6, "HALF_EVEN");
    expect(result.variableCostIncrease).toBeNull();
    expect(result.note).toContain("does not currently win");
  });

  it("says the judgement about input uncertainty is not the engine's", () => {
    expect(decisionFlipThreshold(winner, runnerUp, d("100"), 6, "HALF_EVEN").note).toContain(
      "the engine cannot judge that for you",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-30T00:00:00.000Z");

const provenance = (over: Partial<Provenance> = {}): Provenance => ({
  sourceKind: "OBSERVED_TRANSACTION",
  sourceRef: "INV-1",
  sourceSystem: "ReceiptIQ",
  observedAt: "2026-08-01T00:00:00.000Z",
  caveats: [],
  unitConverted: false,
  ...over,
});

const policy: HealthPolicy = {
  staleAfterDays: 90,
  veryStaleAfterDays: 365,
  minimumSourceStrength: 40,
  maximumUnpricedFraction: fromString("0.1"),
  minimumCoverageFraction: fromString("0.8"),
  scale: 4,
  mode: "HALF_EVEN",
};

const component = (over: Partial<ModelComponentHealth> & Pick<ModelComponentHealth, "ref">): ModelComponentHealth => ({
  label: over.ref,
  provenance: provenance(),
  coverageFraction: fromString("1"),
  valueShareFraction: fromString("1"),
  ...over,
});

describe("model health notices what does not throw an error", () => {
  it("finds nothing wrong with a healthy model", () => {
    const report = assessModelHealth([component({ ref: "steel" })], policy, NOW);
    expect(report.findings).toEqual([]);
    expect(n(report.score)).toBe("100");
    expect(report.usable).toBe(true);
  });

  it("flags an unpriced component as serious", () => {
    const report = assessModelHealth(
      [
        component({ ref: "steel", valueShareFraction: fromString("0.95") }),
        component({ ref: "finishing", provenance: null, valueShareFraction: fromString("0.05") }),
      ],
      policy,
      NOW,
    );
    const finding = report.findings.find((f) => f.code === "UNPRICED_COMPONENT")!;
    expect(finding.severity).toBe("SERIOUS");
    expect(finding.message).toContain("no cost evidence at all");
    expect(finding.message).toContain("5.00%");
  });

  it("refuses to call a model usable when too much of it is unpriced", () => {
    // Not an estimate. A partial sum being presented as one.
    const report = assessModelHealth(
      [
        component({ ref: "priced", valueShareFraction: fromString("0.5") }),
        component({ ref: "guessed", provenance: null, valueShareFraction: fromString("0.5") }),
      ],
      policy,
      NOW,
    );
    expect(report.usable).toBe(false);
    expect(report.worstSeverity).toBe("CRITICAL");
    expect(report.findings.some((f) => f.code === "TOO_MUCH_UNPRICED")).toBe(true);
  });

  it("separates aging from very stale, because they need different responses", () => {
    const aging = assessModelHealth(
      [component({ ref: "r", provenance: provenance({ observedAt: "2026-04-01T00:00:00.000Z" }) })],
      policy,
      NOW,
    );
    const dead = assessModelHealth(
      [component({ ref: "r", provenance: provenance({ observedAt: "2024-01-01T00:00:00.000Z" }) })],
      policy,
      NOW,
    );
    expect(aging.findings[0]!.code).toBe("EVIDENCE_AGING");
    expect(aging.findings[0]!.severity).toBe("WARNING");
    expect(dead.findings[0]!.code).toBe("EVIDENCE_VERY_STALE");
    expect(dead.findings[0]!.severity).toBe("SERIOUS");
  });

  it("treats the stale threshold as exclusive at the boundary", () => {
    // Exactly 90 days is not yet past 90 days. Off-by-one here would make every
    // rate look one day worse than it is, and the alerts stop meaning anything.
    const exactly90 = new Date("2026-08-01T00:00:00.000Z");
    exactly90.setUTCDate(exactly90.getUTCDate() + 90);
    expect(assessModelHealth([component({ ref: "r" })], policy, exactly90).findings).toEqual([]);

    const day91 = new Date(exactly90);
    day91.setUTCDate(day91.getUTCDate() + 1);
    expect(assessModelHealth([component({ ref: "r" })], policy, day91).findings[0]!.code).toBe("EVIDENCE_AGING");
  });

  it("flags a weak source even when it is current", () => {
    const report = assessModelHealth(
      [component({ ref: "r", provenance: provenance({ sourceKind: "FALLBACK_DEFAULT" }) })],
      policy,
      NOW,
    );
    const finding = report.findings.find((f) => f.code === "WEAK_SOURCE")!;
    expect(finding.message).toContain("placeholder being treated as a fact");
  });

  it("flags thin coverage even when the source is strong", () => {
    // A contract price covering 30% of the value is a strong source for 30% of
    // the value. The other 70% is extrapolation.
    const report = assessModelHealth(
      [
        component({
          ref: "r",
          provenance: provenance({ sourceKind: "CONTRACT" }),
          coverageFraction: fromString("0.3"),
        }),
      ],
      policy,
      NOW,
    );
    expect(report.findings.map((f) => f.code)).toEqual(["THIN_COVERAGE"]);
    expect(report.findings[0]!.message).toContain("30.00%");
  });

  it("WEIGHTS the score by value share, not by count", () => {
    // Two models with one stale rate each. The one where the stale rate covers
    // most of the cost must score worse — a flat count would rate them equal.
    const bigStale = assessModelHealth(
      [
        component({ ref: "big", provenance: provenance({ observedAt: "2026-01-01T00:00:00.000Z" }), valueShareFraction: fromString("0.9") }),
        component({ ref: "small", valueShareFraction: fromString("0.1") }),
      ],
      policy,
      NOW,
    );
    const smallStale = assessModelHealth(
      [
        component({ ref: "big", valueShareFraction: fromString("0.9") }),
        component({ ref: "small", provenance: provenance({ observedAt: "2026-01-01T00:00:00.000Z" }), valueShareFraction: fromString("0.1") }),
      ],
      policy,
      NOW,
    );
    expect(Number(toString(bigStale.score))).toBeLessThan(Number(toString(smallStale.score)));
  });

  it("weights the UNPRICED penalty by value share too", () => {
    // The aging path was covered; this one was not, and a mutation dropping the
    // weight from it survived. An unpriced component carrying 90% of the cost
    // is a different problem from one carrying 5%.
    const big = assessModelHealth(
      [
        component({ ref: "big", provenance: null, valueShareFraction: fromString("0.9") }),
        component({ ref: "rest", valueShareFraction: fromString("0.1") }),
      ],
      policy,
      NOW,
    );
    const small = assessModelHealth(
      [
        component({ ref: "big", valueShareFraction: fromString("0.9") }),
        component({ ref: "rest", provenance: null, valueShareFraction: fromString("0.1") }),
      ],
      policy,
      NOW,
    );
    expect(Number(toString(big.score))).toBeLessThan(Number(toString(small.score)));
  });

  it("weights the VERY STALE penalty by value share too", () => {
    const ancient = (share: string) =>
      component({
        ref: "old",
        provenance: provenance({ observedAt: "2020-01-01T00:00:00.000Z" }),
        valueShareFraction: fromString(share),
      });
    const big = assessModelHealth([ancient("0.9"), component({ ref: "rest", valueShareFraction: fromString("0.1") })], policy, NOW);
    const small = assessModelHealth([ancient("0.1"), component({ ref: "rest", valueShareFraction: fromString("0.9") })], policy, NOW);
    expect(Number(toString(big.score))).toBeLessThan(Number(toString(small.score)));
  });

  it("treats the VERY STALE threshold as exclusive at the boundary", () => {
    const base = new Date("2026-08-01T00:00:00.000Z");
    const exactly365 = new Date(base);
    exactly365.setUTCDate(exactly365.getUTCDate() + 365);
    expect(assessModelHealth([component({ ref: "r" })], policy, exactly365).findings[0]!.code).toBe(
      "EVIDENCE_AGING",
    );

    const day366 = new Date(exactly365);
    day366.setUTCDate(day366.getUTCDate() + 1);
    expect(assessModelHealth([component({ ref: "r" })], policy, day366).findings[0]!.code).toBe(
      "EVIDENCE_VERY_STALE",
    );
  });

  it("floors the score at zero rather than reporting a negative one", () => {
    // The earlier fixture summed to exactly 100 penalty, so the raw score was
    // zero and the floor was never reached. This one drives it well below.
    const wrecked = assessModelHealth(
      [
        component({ ref: "a", provenance: null, valueShareFraction: fromString("1") }),
        component({
          ref: "b",
          provenance: provenance({ sourceKind: "FALLBACK_DEFAULT", observedAt: "2020-01-01T00:00:00.000Z" }),
          coverageFraction: fromString("0.1"),
          valueShareFraction: fromString("1"),
        }),
      ],
      policy,
      NOW,
    );
    expect(n(wrecked.score)).toBe("0");
  });

  it("orders findings worst-first and deterministically", () => {
    // The codes are chosen so severity order and alphabetical code order
    // DISAGREE: EVIDENCE_AGING (WARNING) sorts before UNPRICED_COMPONENT
    // (SERIOUS) by code. A fixture where they agreed let a mutation removing
    // the severity sort survive.
    const report = assessModelHealth(
      [
        component({ ref: "aging", provenance: provenance({ observedAt: "2026-01-01T00:00:00.000Z" }), valueShareFraction: fromString("0.3") }),
        component({ ref: "z-unpriced", provenance: null, valueShareFraction: fromString("0.05") }),
        component({ ref: "m-weak", provenance: provenance({ sourceKind: "FALLBACK_DEFAULT" }), valueShareFraction: fromString("0.3") }),
      ],
      policy,
      NOW,
    );
    expect(report.findings.map((f) => `${f.severity}:${f.code}`)).toEqual([
      "SERIOUS:UNPRICED_COMPONENT",
      "WARNING:EVIDENCE_AGING",
      "WARNING:WEAK_SOURCE",
    ]);
    // And the summary reports the worst, which is read off the ordered list.
    expect(report.worstSeverity).toBe("SERIOUS");
  });

  it("breaks ties within a code by subject, so the order never wobbles", () => {
    // Deliberately supplied in the wrong order. Without the subject tie-break
    // these two findings could come out either way, and a report that reorders
    // itself between runs trains people to ignore its diffs.
    const report = assessModelHealth(
      [
        component({ ref: "z-second", provenance: provenance({ sourceKind: "FALLBACK_DEFAULT" }), valueShareFraction: fromString("0.5") }),
        component({ ref: "a-first", provenance: provenance({ sourceKind: "FALLBACK_DEFAULT" }), valueShareFraction: fromString("0.5") }),
      ],
      policy,
      NOW,
    );
    expect(report.findings.map((f) => f.subjectRef)).toEqual(["a-first", "z-second"]);
  });

  it("refuses to grade an empty model as healthy", () => {
    // A model with nothing in it computes a total of zero and never errors.
    const report = assessModelHealth([], policy, NOW);
    expect(report.usable).toBe(false);
    expect(report.findings[0]!.message).toContain("does not say anything");
  });

  it("tells the reader to read the findings rather than the score", () => {
    const report = assessModelHealth([component({ ref: "r", provenance: null })], policy, NOW);
    expect(report.summary).toContain("read the findings, not the score");
  });

  it("takes `now` as an argument so the report can be replayed", () => {
    const a = assessModelHealth([component({ ref: "r" })], policy, NOW);
    const b = assessModelHealth([component({ ref: "r" })], policy, NOW);
    expect(b).toEqual(a);
    expect(a.assessedAt).toBe(NOW.toISOString());
  });
});

describe("health trend answers whether it is getting better or worse", () => {
  const healthy = assessModelHealth([component({ ref: "r" })], policy, NOW);
  const sick = assessModelHealth([component({ ref: "r", provenance: null })], policy, NOW);

  it("reports improvement", () => {
    const trend = healthTrend(sick, healthy);
    expect(trend.direction).toBe("IMPROVING");
    // Both findings clear together: pricing the only component removes the
    // component-level finding AND takes the model back under the unpriced cap.
    expect(trend.resolved.map((f) => f.code).sort()).toEqual(["TOO_MUCH_UNPRICED", "UNPRICED_COMPONENT"]);
  });

  it("reports degradation", () => {
    expect(healthTrend(healthy, sick).direction).toBe("DEGRADING");
  });

  it("reports churn even when the score has not moved", () => {
    // Two findings of equal weight, one fixed and one new, nets to zero. Saying
    // only "unchanged" would hide real movement in both directions.
    const before = assessModelHealth(
      [
        component({ ref: "a", provenance: null, valueShareFraction: fromString("0.05") }),
        component({ ref: "b", valueShareFraction: fromString("0.95") }),
      ],
      policy,
      NOW,
    );
    const after = assessModelHealth(
      [
        component({ ref: "a", valueShareFraction: fromString("0.05") }),
        component({ ref: "b", provenance: null, valueShareFraction: fromString("0.05") }),
      ],
      policy,
      NOW,
    );
    const trend = healthTrend(before, after);
    expect(trend.resolved.length).toBeGreaterThan(0);
    expect(trend.introduced.length).toBeGreaterThan(0);
    expect(trend.note).toContain("resolved");
  });

  it("says explicitly when nothing changed", () => {
    expect(healthTrend(healthy, healthy).note).toContain("No findings changed");
  });
});
