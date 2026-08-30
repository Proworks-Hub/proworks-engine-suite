/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import {
  isFrozen,
  overlappingVersions,
  reviseCost,
  standardCostChange,
  transitionStatus,
  versionInForce,
  type CostVersion,
} from "../standardCostMethod.js";
import {
  priceFromMargin,
  priceFromMarkup,
  priceFromTarget,
  priceStillViable,
  priceTable,
  type PricingPolicy,
} from "../marginPricing.js";

const d = fromString;
const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// A standard that can be edited makes every variance in its period meaningless.
// A markup mistaken for a margin gives away a quarter of the price. Both are
// quiet failures that look like ordinary numbers.
// ─────────────────────────────────────────────────────────────────────────────

const version = (over: Partial<CostVersion> & { versionId: string }): CostVersion => ({
  kind: "STANDARD",
  status: "APPROVED",
  label: over.versionId,
  objectId: "firepit-24",
  unitCost: d("100.00"),
  currency: "GBP",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  sourceEstimateId: "est-1",
  sourceEstimateVersion: 1,
  approvedBy: "steven",
  approvedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("a standard is frozen; a planned version is not", () => {
  it("freezes an approved standard", () => {
    expect(isFrozen(version({ versionId: "v1" }))).toBe(true);
  });

  it("does not freeze a planned version, even approved", () => {
    // Approving a planning assumption means "this is what we are using", not
    // "this can no longer change". Freezing it would defeat the purpose.
    expect(isFrozen(version({ versionId: "v1", kind: "PLANNED" }))).toBe(false);
  });

  it("does not freeze a draft standard", () => {
    expect(isFrozen(version({ versionId: "v1", status: "DRAFT" }))).toBe(false);
  });

  it("REFUSES to revise an approved standard", () => {
    // Editing it would silently invalidate every variance in the period, and
    // nothing would record when it happened.
    const result = reviseCost(version({ versionId: "v1" }), d("120.00"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("silently invalidate");
    expect(result.reason).toContain("Supersede it");
  });

  it("allows a planned version to be revised freely", () => {
    const result = reviseCost(version({ versionId: "v1", kind: "PLANNED" }), d("120.00"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(n(result.version.unitCost)).toBe("120");
  });

  it("refuses APPROVED back to DRAFT", () => {
    const result = transitionStatus(version({ versionId: "v1" }), "DRAFT", "s", "t");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("rewrites that history");
  });

  it("records who approved it and when", () => {
    const result = transitionStatus(
      version({ versionId: "v1", status: "CANDIDATE", approvedBy: null, approvedAt: null }),
      "APPROVED",
      "steven",
      "2026-08-30T00:00:00.000Z",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version.approvedBy).toBe("steven");
    expect(result.version.approvedAt).toBe("2026-08-30T00:00:00.000Z");
  });
});

describe("which version is in force", () => {
  const versions = [
    version({ versionId: "h1", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-07-01T00:00:00.000Z", unitCost: d("100") }),
    version({ versionId: "h2", effectiveFrom: "2026-07-01T00:00:00.000Z", effectiveTo: null, unitCost: d("110") }),
  ];

  it("picks the one covering the instant", () => {
    expect(versionInForce(versions, "firepit-24", "STANDARD", new Date("2026-03-01T00:00:00.000Z"))!.versionId).toBe("h1");
    expect(versionInForce(versions, "firepit-24", "STANDARD", new Date("2026-08-01T00:00:00.000Z"))!.versionId).toBe("h2");
  });

  it("uses half-open periods so consecutive versions meet exactly", () => {
    // At the changeover instant the old one has ended and the new one has
    // started. Any other convention leaves a gap or an overlap.
    expect(versionInForce(versions, "firepit-24", "STANDARD", new Date("2026-07-01T00:00:00.000Z"))!.versionId).toBe("h2");
  });

  it("returns nothing once a period has ENDED, with no successor to mask it", () => {
    // The consecutive-versions test could not catch an inclusive end date: at
    // the changeover instant the later version wins the tie-break either way.
    // A lone version whose period ends exactly at the instant is the case that
    // exposes it — and a standard that outlived its period by one instant is a
    // cost being applied after it was retired.
    const ended = [
      version({
        versionId: "only",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-07-01T00:00:00.000Z",
      }),
    ];
    expect(versionInForce(ended, "firepit-24", "STANDARD", new Date("2026-07-01T00:00:00.000Z"))).toBeNull();
    // One millisecond earlier it is still in force.
    expect(
      versionInForce(ended, "firepit-24", "STANDARD", new Date("2026-06-30T23:59:59.999Z"))!.versionId,
    ).toBe("only");
  });

  it("returns nothing before the first version", () => {
    expect(versionInForce(versions, "firepit-24", "STANDARD", new Date("2025-01-01T00:00:00.000Z"))).toBeNull();
  });

  it("ignores versions that are not approved", () => {
    const drafts = [version({ versionId: "draft", status: "DRAFT" })];
    expect(versionInForce(drafts, "firepit-24", "STANDARD", new Date("2026-08-01T00:00:00.000Z"))).toBeNull();
  });

  it("does not confuse a planned version for a standard", () => {
    // The failure mode: a planning assumption quietly becoming the
    // measurement baseline.
    const planned = [version({ versionId: "p1", kind: "PLANNED" })];
    expect(versionInForce(planned, "firepit-24", "STANDARD", new Date("2026-08-01T00:00:00.000Z"))).toBeNull();
    expect(versionInForce(planned, "firepit-24", "PLANNED", new Date("2026-08-01T00:00:00.000Z"))!.versionId).toBe("p1");
  });

  it("FINDS overlapping approved versions rather than silently picking one", () => {
    // Two approved standards covering the same instant is a data problem, and
    // finding it is more useful than refusing to answer.
    const overlapping = [
      version({ versionId: "a", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: "2026-08-01T00:00:00.000Z" }),
      version({ versionId: "b", effectiveFrom: "2026-06-01T00:00:00.000Z", effectiveTo: null }),
    ];
    expect(overlappingVersions(overlapping)).toHaveLength(1);
    // And it still answers, taking the later start.
    expect(versionInForce(overlapping, "firepit-24", "STANDARD", new Date("2026-07-01T00:00:00.000Z"))!.versionId).toBe("b");
  });

  it("does not report consecutive versions as overlapping", () => {
    expect(overlappingVersions(versions)).toEqual([]);
  });
});

describe("a standard cost change is evidence, not an accounting entry", () => {
  it("reports the per-unit and extended difference", () => {
    const change = standardCostChange(
      version({ versionId: "old", unitCost: d("100.00") }),
      version({ versionId: "new", unitCost: d("112.00") }),
      d("500"),
      6,
      "HALF_EVEN",
    );
    expect(n(change.perUnit)).toBe("12");
    expect(n(change.percentChange)).toBe("12");
    expect(n(change.extendedAtQuantity)).toBe("6000");
  });

  it("says plainly that posting it is somebody else's authority", () => {
    // CostIQ producing "the revaluation amount" would be CostIQ deciding an
    // accounting treatment it does not own.
    const change = standardCostChange(
      version({ versionId: "old" }),
      version({ versionId: "new", unitCost: d("110") }),
      d("1"),
      6,
      "HALF_EVEN",
    );
    expect(change.note).toContain("Finance IQ's to decide and post");
  });

  it("refuses to compare across currencies", () => {
    expect(() =>
      standardCostChange(
        version({ versionId: "a" }),
        version({ versionId: "b", currency: "USD" }),
        d("1"),
        6,
        "HALF_EVEN",
      ),
    ).toThrow(/needs a rate, a date and a source/);
  });

  it("reports zero percent change from a zero baseline rather than dividing", () => {
    const change = standardCostChange(
      version({ versionId: "a", unitCost: d("0") }),
      version({ versionId: "b", unitCost: d("10") }),
      d("1"),
      6,
      "HALF_EVEN",
    );
    expect(n(change.percentChange)).toBe("0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const policy = (over: Partial<PricingPolicy> = {}): PricingPolicy => ({
  scale: 2,
  mode: "HALF_EVEN",
  minimumMarginFraction: null,
  priceFloor: null,
  ...over,
});

describe("markup and margin are different, and the difference costs money", () => {
  it("marks up on COST", () => {
    // £100 marked up 50% is £150.
    expect(n(priceFromMarkup(d("100"), d("0.5"), "GBP", policy()).price)).toBe("150");
  });

  it("takes a margin on PRICE", () => {
    // £100 at a 50% margin is £200 — not £150.
    expect(n(priceFromMargin(d("100"), d("0.5"), "GBP", policy()).price)).toBe("200");
  });

  it("shows the gap between them at the same stated percentage", () => {
    // Somebody who says "we work on 50%" and applies a markup has given away a
    // quarter of the price. This is the single most common pricing error.
    const markup = priceFromMarkup(d("100"), d("0.5"), "GBP", policy());
    const margin = priceFromMargin(d("100"), d("0.5"), "GBP", policy());
    expect(n(markup.price)).toBe("150");
    expect(n(margin.price)).toBe("200");
    // And a 50% markup yields only a 33% margin.
    expect(toString(markup.marginFraction).startsWith("0.3333")).toBe(true);
  });

  it("reports both realised fractions, so neither has to be inferred", () => {
    const result = priceFromMarkup(d("100"), d("0.25"), "GBP", policy());
    expect(n(result.markupFraction)).toBe("0.25");
    expect(n(result.marginFraction)).toBe("0.2");
  });

  it("REFUSES a margin of 100% or more", () => {
    // price = cost / 0 is not a price. A business asking for it has made an
    // arithmetic mistake rather than an ambitious request.
    expect(() => priceFromMargin(d("100"), d("1"), "GBP", policy())).toThrow(/must be below 1/);
    expect(() => priceFromMargin(d("100"), d("1.5"), "GBP", policy())).toThrow(/must be below 1/);
  });

  it("refuses a negative markup or margin, pointing at price floors instead", () => {
    expect(() => priceFromMarkup(d("100"), d("-0.1"), "GBP", policy())).toThrow(/price floor/);
    expect(() => priceFromMargin(d("100"), d("-0.1"), "GBP", policy())).toThrow(/price floor/);
  });
});

describe("floors are applied and named", () => {
  it("raises a price to the minimum margin", () => {
    const result = priceFromMarkup(d("100"), d("0.05"), "GBP", policy({ minimumMarginFraction: d("0.3") }));
    expect(n(result.price)).toBe("142.86");
    expect(result.floorApplied).toContain("minimum margin");
  });

  it("raises a price to an absolute floor", () => {
    const result = priceFromMarkup(d("10"), d("0.1"), "GBP", policy({ priceFloor: d("50") }));
    expect(n(result.price)).toBe("50");
    expect(result.floorApplied).toContain("absolute price floor");
  });

  it("leaves a price above both floors alone", () => {
    const result = priceFromMarkup(d("100"), d("1"), "GBP", policy({ minimumMarginFraction: d("0.2"), priceFloor: d("50") }));
    expect(n(result.price)).toBe("200");
    expect(result.floorApplied).toBeNull();
  });

  it("WARNS about a price below cost rather than correcting it", () => {
    // Selling below cost is sometimes deliberate, and an engine that silently
    // prevented it would be making a commercial choice it does not own.
    const result = priceFromTarget(d("100"), d("80"), "GBP", policy());
    expect(n(result.price)).toBe("80");
    expect(result.warnings.join()).toContain("BELOW cost");
  });
});

describe("pricing never changes the cost", () => {
  it("returns the cost it was given, untouched", () => {
    // An engine where pricing could adjust the cost would let a margin target
    // quietly rewrite what something costs to make.
    const cost = d("123.45");
    const before = JSON.stringify({ units: cost.units.toString(), scale: cost.scale });
    const result = priceFromMargin(cost, d("0.4"), "GBP", policy());
    expect(JSON.stringify({ units: result.cost.units.toString(), scale: result.cost.scale })).toBe(before);
    expect(JSON.stringify({ units: cost.units.toString(), scale: cost.scale })).toBe(before);
  });
});

describe("a price table follows the cost curve", () => {
  it("prices each quantity from its own cost", () => {
    const table = priceTable(
      [
        { quantity: d("1"), unitCost: d("100") },
        { quantity: d("10"), unitCost: d("60") },
      ],
      { kind: "MARGIN", fraction: d("0.4") },
      "GBP",
      policy(),
    );
    expect(n(table[0]!.unitPrice)).toBe("166.67");
    expect(n(table[1]!.unitPrice)).toBe("100");
  });

  it("sorts by quantity ascending", () => {
    const table = priceTable(
      [
        { quantity: d("10"), unitCost: d("60") },
        { quantity: d("1"), unitCost: d("100") },
      ],
      { kind: "MARKUP", fraction: d("0.5") },
      "GBP",
      policy(),
    );
    expect(table.map((r) => n(r.quantity))).toEqual(["1", "10"]);
  });
});

describe("whether an old quote still clears", () => {
  it("reports a quote now below cost", () => {
    const result = priceStillViable(d("100"), d("120"), policy());
    expect(result.viable).toBe(false);
    expect(result.reason).toContain("commercial decision, not a costing one");
  });

  it("reports a quote below the minimum margin", () => {
    const result = priceStillViable(d("100"), d("95"), policy({ minimumMarginFraction: d("0.2") }));
    expect(result.viable).toBe(false);
    expect(result.reason).toContain("below the minimum");
  });

  it("confirms a quote that still clears", () => {
    const result = priceStillViable(d("200"), d("100"), policy({ minimumMarginFraction: d("0.2") }));
    expect(result.viable).toBe(true);
    expect(n(result.currentMargin)).toBe("0.5");
  });
});
