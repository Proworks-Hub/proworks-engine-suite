/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { fromString, normalize, toString } from "../../domain/decimal.js";
import {
  actualCostInputSchema,
  actualCostMethod,
  assessCompleteness,
  type ActualCostInput,
} from "../actualCostMethod.js";

const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

// ─────────────────────────────────────────────────────────────────────────────
// An actual cost feels like the one number in costing that is simply true. It
// is assembled from whatever got recorded, and what gets recorded is
// incomplete in the same direction every time.
// ─────────────────────────────────────────────────────────────────────────────

const posting = (over: Record<string, unknown> = {}) => ({
  postingId: "p1",
  kind: "LABOR",
  label: "Fabrication",
  quantity: "4",
  quantityUnit: "hour",
  unitRate: "40.00",
  currency: "GBP",
  postedAt: "2026-08-20T09:00:00.000Z",
  reconstructed: false,
  ...over,
});

const input = (over: Record<string, unknown> = {}): ActualCostInput =>
  actualCostInputSchema.parse({
    subjectId: "job-1",
    currency: "GBP",
    postings: [posting()],
    expectedKinds: ["LABOR"],
    scale: 2,
    ...over,
  });

const run = (i: ActualCostInput) =>
  actualCostMethod.compute(i, {
    policy: {} as never,
    asOf: new Date("2026-08-30T00:00:00.000Z"),
    units: {} as never,
    currencyPrecision: {} as never,
  });

describe("the actual is summed at the rate each posting was booked at", () => {
  it("multiplies quantity by the recorded rate", () => {
    const r = run(input());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.components[0]!.amount).toBe("160.00");
  });

  it("uses the rate recorded THEN, not a rate supplied now", () => {
    // The difference between what a job cost and what it would cost to repeat.
    // Nothing in the context can change the answer.
    const a = run(input());
    const b = actualCostMethod.compute(input(), {
      policy: {} as never,
      asOf: new Date("2030-01-01T00:00:00.000Z"),
      units: {} as never,
      currencyPrecision: {} as never,
    });
    expect(b).toEqual(a);
  });

  it("carries the quantity and unit through, so the number can be checked", () => {
    const r = run(input());
    if (r.ok) {
      expect(r.output.components[0]!.quantity).toBe("4");
      expect(r.output.components[0]!.quantityUnit).toBe("hour");
    }
  });

  it("REFUSES postings in a currency other than the job's", () => {
    // An actual that quietly converted would not be reproducible.
    expect(
      actualCostInputSchema.safeParse({
        subjectId: "job-1",
        currency: "GBP",
        postings: [posting({ currency: "USD" })],
        expectedKinds: [],
        scale: 2,
      }).success,
    ).toBe(false);
  });

  it("refuses a posting amount that is not a decimal string", () => {
    expect(
      actualCostInputSchema.safeParse({
        subjectId: "job-1",
        currency: "GBP",
        postings: [posting({ unitRate: 40 })],
        expectedKinds: [],
        scale: 2,
      }).success,
    ).toBe(false);
  });
});

describe("what the actual is missing", () => {
  it("says a job with no postings has no actual cost, not a cost of zero", () => {
    const r = run(input({ postings: [], expectedKinds: [] }));
    if (r.ok) {
      expect(r.output.components).toEqual([]);
      expect(r.output.diagnostics.join()).toContain("different from having cost nothing");
    }
  });

  it("NAMES a category the estimate had and the actual does not", () => {
    // The loop this breaks: unbooked work makes the actual look low, the
    // variance reports the estimate as pessimistic, and somebody trims it.
    const r = run(input({ expectedKinds: ["LABOR", "MATERIAL", "FREIGHT"] }));
    if (r.ok) {
      expect(r.output.diagnostics.join()).toContain("MATERIAL");
      expect(r.output.diagnostics.join()).toContain("FREIGHT");
      expect(r.output.diagnostics.join()).toContain("unknown, not zero");
    }
  });

  it("says nothing about missing categories when none are missing", () => {
    const r = run(input());
    if (r.ok) expect(r.output.diagnostics.join()).not.toContain("unknown, not zero");
  });

  it("flags postings that were written up rather than recorded", () => {
    const r = run(input({ postings: [posting(), posting({ postingId: "p2", reconstructed: true })] }));
    if (r.ok) {
      expect(r.output.diagnostics.join()).toContain("rounder numbers than the truth");
      expect(r.output.components[1]!.notes.join()).toContain("Reconstructed from memory");
    }
  });

  it("leaves recorded postings unannotated", () => {
    const r = run(input());
    if (r.ok) expect(r.output.components[0]!.notes).toEqual([]);
  });
});

describe("whether an actual is safe to compute a variance against", () => {
  it("is safe when every expected category has postings", () => {
    const c = assessCompleteness(input(), 4);
    expect(c.safeForVariance).toBe(true);
    expect(c.silentKinds).toEqual([]);
  });

  it("is NOT safe when a category is silent", () => {
    const c = assessCompleteness(input({ expectedKinds: ["LABOR", "MATERIAL"] }), 4);
    expect(c.safeForVariance).toBe(false);
    expect(c.silentKinds).toEqual(["MATERIAL"]);
    expect(c.note).toContain("attribute the whole of that category to the estimate being wrong");
  });

  it("is not safe when there are no postings at all", () => {
    const c = assessCompleteness(input({ postings: [], expectedKinds: [] }), 4);
    expect(c.safeForVariance).toBe(false);
    expect(c.note).toContain("no actual cost here to compare anything against");
  });

  it("reports how much of the total was reconstructed", () => {
    const c = assessCompleteness(
      input({
        postings: [posting(), posting({ postingId: "p2", quantity: "1", reconstructed: true })],
      }),
      4,
    );
    // 40 reconstructed of 200 total.
    expect(n(c.reconstructedShare)).toBe("0.2");
    expect(c.reconstructedKinds).toEqual(["LABOR"]);
  });

  it("mentions reconstruction in the note even when the actual is otherwise complete", () => {
    const c = assessCompleteness(
      input({ postings: [posting({ reconstructed: true })] }),
      4,
    );
    expect(c.safeForVariance).toBe(true);
    expect(c.note).toContain("written up after the fact");
  });

  it("does not mention reconstruction when there was none", () => {
    expect(assessCompleteness(input(), 4).note).not.toContain("written up after the fact");
  });

  it("reports a zero reconstructed share against a zero total rather than dividing", () => {
    const c = assessCompleteness(input({ postings: [posting({ quantity: "0" })] }), 4);
    expect(n(c.reconstructedShare)).toBe("0");
  });

  it("lists silent and reconstructed kinds in a stable order", () => {
    const c = assessCompleteness(
      input({
        postings: [
          posting({ postingId: "z", kind: "TOOLING", reconstructed: true }),
          posting({ postingId: "a", kind: "LABOR", reconstructed: true }),
        ],
        expectedKinds: ["LABOR", "TOOLING", "SCRAP", "FREIGHT"],
      }),
      4,
    );
    expect(c.reconstructedKinds).toEqual(["LABOR", "TOOLING"]);
    expect(c.silentKinds).toEqual(["SCRAP", "FREIGHT"]);
  });
});

describe("the method is registrable like any other", () => {
  it("declares an id and a formula version", () => {
    expect(actualCostMethod.id).toBe("actual-cost");
    expect(actualCostMethod.version).toBe("1.0.0");
  });

  it("says in its summary that a silent category is not zero", () => {
    // The specification is generated from these summaries, so this is what a
    // consumer reads before deciding to trust the number.
    expect(actualCostMethod.summary).toContain("silent category is unknown, not zero");
  });
});
