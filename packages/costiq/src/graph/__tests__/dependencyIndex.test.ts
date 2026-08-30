/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { normalize, toString } from "../../domain/decimal.js";
import type { Provenance } from "../../domain/provenance.js";
import {
  assessFreshness,
  buildDependencyIndex,
  changeImpact,
  planRecalculation,
  type EstimateDependencies,
} from "../dependencyIndex.js";

// ─────────────────────────────────────────────────────────────────────────────
// "Steel went up. What does that affect?"
//
// Without an index the answer is "recompute everything and see", which is both
// slow and wrong — wrong because recomputing an approved estimate destroys the
// record of what was actually quoted.
// ─────────────────────────────────────────────────────────────────────────────

const n = (x: { units: bigint; scale: number }) => toString(normalize(x));

const estimate = (over: Partial<EstimateDependencies> & { estimateId: string }): EstimateDependencies => ({
  version: 1,
  frozen: false,
  basisIds: ["basis.steel"],
  rateIds: ["rate.steel"],
  methodId: "DIRECT_JOB",
  methodVersion: "1.0.0",
  policyId: "p",
  computedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const provenance = (observedAt: string): Provenance => ({
  sourceKind: "CONTRACT",
  sourceRef: "x",
  sourceSystem: "test",
  observedAt,
  caveats: [],
  unitConverted: false,
});

const ASOF = new Date("2026-08-30T00:00:00.000Z");

describe("the index answers in the useful direction", () => {
  const index = buildDependencyIndex([
    estimate({ estimateId: "e1" }),
    estimate({ estimateId: "e2", basisIds: ["basis.steel", "basis.labour"], rateIds: ["rate.steel", "rate.labour"] }),
    estimate({ estimateId: "e3", basisIds: ["basis.paint"], rateIds: ["rate.paint"] }),
  ]);

  it("finds every estimate that used a basis", () => {
    expect(index.dependentsOfBasis("basis.steel").map((e) => e.estimateId)).toEqual(["e1", "e2"]);
  });

  it("finds nothing for a basis nobody used", () => {
    expect(index.dependentsOfBasis("basis.unused")).toEqual([]);
  });

  it("finds estimates by rate and by method version", () => {
    expect(index.dependentsOfRate("rate.labour").map((e) => e.estimateId)).toEqual(["e2"]);
    expect(index.dependentsOfMethod("DIRECT_JOB", "1.0.0")).toHaveLength(3);
    expect(index.dependentsOfMethod("DIRECT_JOB", "2.0.0")).toEqual([]);
  });

  it("returns a stable order, so a queue built from it is reproducible", () => {
    // A recalculation queue from an unstable listing would process in a
    // different order each run and be impossible to reason about.
    const forward = index.dependentsOfBasis("basis.steel").map((e) => e.estimateId);
    const rebuilt = buildDependencyIndex([
      estimate({ estimateId: "e2", basisIds: ["basis.steel", "basis.labour"], rateIds: [] }),
      estimate({ estimateId: "e1" }),
    ]);
    expect(rebuilt.dependentsOfBasis("basis.steel").map((e) => e.estimateId)).toEqual(forward);
  });

  it("traces the path from an estimate down to its rates", () => {
    const path = index.rootPath("e2", 1);
    expect(path[0]).toBe("estimate:e2@1");
    expect(path).toContain("basis.steel".replace(/^/, "basis:"));
    expect(path).toContain("rate:rate.labour");
    expect(path[path.length - 1]).toBe("method:DIRECT_JOB@1.0.0");
  });

  it("returns an empty path for an estimate it does not know", () => {
    expect(index.rootPath("nope", 1)).toEqual([]);
  });
});

describe("freshness is a state, not a boolean", () => {
  const freshnessOf = (over: Partial<Parameters<typeof assessFreshness>[0]> = {}) =>
    assessFreshness({
      estimate: estimate({ estimateId: "e1" }),
      evidence: new Map([["basis.steel", provenance("2026-08-29T00:00:00.000Z")]]),
      supersededBasisIds: new Set(),
      freshnessWindowDays: 90,
      asOf: ASOF,
      ...over,
    });

  it("reports FROZEN for an approved estimate, and says why that is not staleness", () => {
    // The important one. Marking an approved estimate stale invites somebody
    // to "fix" it, and fixing it destroys the baseline every variance is
    // measured against.
    const result = freshnessOf({
      estimate: estimate({ estimateId: "e1", frozen: true }),
      evidence: new Map([["basis.steel", provenance("2020-01-01T00:00:00.000Z")]]),
    });
    expect(result.state).toBe("FROZEN");
    expect(result.reason).toContain("record of what was quoted");
  });

  it("checks FROZEN before anything else", () => {
    // Even with superseded inputs AND ancient evidence.
    const result = freshnessOf({
      estimate: estimate({ estimateId: "e1", frozen: true }),
      evidence: new Map([["basis.steel", provenance("2020-01-01T00:00:00.000Z")]]),
      supersededBasisIds: new Set(["basis.steel"]),
    });
    expect(result.state).toBe("FROZEN");
  });

  it("distinguishes SUPERSEDED from STALE", () => {
    // A changed input beats an old one: "superseded" says something happened,
    // "stale" only says time passed.
    const result = freshnessOf({ supersededBasisIds: new Set(["basis.steel"]) });
    expect(result.state).toBe("SUPERSEDED");
    expect(result.reason).toContain("actually changed, not merely aged");
    expect(result.implicatedBasisIds).toEqual(["basis.steel"]);
  });

  it("reports STALE past the window, naming the bases", () => {
    const result = freshnessOf({
      evidence: new Map([["basis.steel", provenance("2026-01-01T00:00:00.000Z")]]),
    });
    expect(result.state).toBe("STALE");
    expect(result.implicatedBasisIds).toEqual(["basis.steel"]);
    expect(result.oldestEvidenceDays).toBeGreaterThan(90);
  });

  it("reports AGING inside the window but past three quarters of it", () => {
    // 75 days into a 90-day window: past three quarters (67), inside the
    // limit. Far enough through that somebody planning a refresh should know,
    // not so far that the number is suspect.
    const result = freshnessOf({
      evidence: new Map([["basis.steel", provenance("2026-06-16T00:00:00.000Z")]]),
    });
    expect(result.state).toBe("AGING");
    expect(result.reason).toContain("worth refreshing");
  });

  it("treats evidence at EXACTLY the window boundary as still within it", () => {
    // 2026-06-01 is exactly 90 days before the calculation instant. A 90-day
    // window that excluded day 90 would be an 89-day window, and the
    // off-by-one would show up as estimates going stale a day early with no
    // explanation.
    const result = freshnessOf({
      evidence: new Map([["basis.steel", provenance("2026-06-01T00:00:00.000Z")]]),
    });
    expect(result.oldestEvidenceDays).toBe(90);
    expect(result.state).toBe("AGING");
  });

  it("treats one day past the window as stale", () => {
    const result = freshnessOf({
      evidence: new Map([["basis.steel", provenance("2026-05-31T00:00:00.000Z")]]),
    });
    expect(result.oldestEvidenceDays).toBe(91);
    expect(result.state).toBe("STALE");
  });

  it("reports CURRENT for recent evidence", () => {
    expect(freshnessOf().state).toBe("CURRENT");
  });

  it("reports CURRENT with no evidence at all rather than guessing", () => {
    const result = freshnessOf({
      estimate: estimate({ estimateId: "e1", basisIds: [] }),
      evidence: new Map(),
    });
    expect(result.state).toBe("CURRENT");
    expect(result.oldestEvidenceDays).toBeNull();
  });
});

describe("a rate change does not recompute the past", () => {
  const index = buildDependencyIndex([
    estimate({ estimateId: "draft-1" }),
    estimate({ estimateId: "approved-1", frozen: true }),
    estimate({ estimateId: "other", basisIds: ["basis.paint"], rateIds: [] }),
  ]);

  const events = [{ eventId: "ev1", basisId: "basis.steel", observedAt: "2026-08-30T00:00:00.000Z" }];

  it("REFUSES to recompute an approved estimate", () => {
    // The rule the whole engine rests on.
    const decisions = planRecalculation(events, index, { recalculateDrafts: true });
    const approved = decisions.find((d) => d.estimateId === "approved-1")!;
    expect(approved.action).toBe("IGNORE_FROZEN");
    expect(approved.reason).toContain("rewrite what was quoted");
  });

  it("recomputes a draft when the policy says so", () => {
    const decisions = planRecalculation(events, index, { recalculateDrafts: true });
    expect(decisions.find((d) => d.estimateId === "draft-1")!.action).toBe("RECALCULATE");
  });

  it("flags rather than recomputes when the policy leaves it to a person", () => {
    const decisions = planRecalculation(events, index, { recalculateDrafts: false });
    expect(decisions.find((d) => d.estimateId === "draft-1")!.action).toBe("FLAG_ONLY");
  });

  it("touches nothing that did not use the changed basis", () => {
    const decisions = planRecalculation(events, index, { recalculateDrafts: true });
    expect(decisions.some((d) => d.estimateId === "other")).toBe(false);
  });

  it("COALESCES many changes into one decision per estimate", () => {
    // A supplier price-list import changes forty rates at once. Without
    // coalescing that is forty recalculations of the same estimate.
    const many = [
      { eventId: "a", basisId: "basis.steel", observedAt: "t" },
      { eventId: "b", basisId: "basis.steel", observedAt: "t" },
      { eventId: "c", basisId: "basis.steel", observedAt: "t" },
    ];
    const decisions = planRecalculation(many, index, { recalculateDrafts: true });
    expect(decisions.filter((d) => d.estimateId === "draft-1")).toHaveLength(1);
  });

  it("names every basis that changed in the one decision", () => {
    const multi = buildDependencyIndex([
      estimate({ estimateId: "e", basisIds: ["basis.steel", "basis.labour"], rateIds: [] }),
    ]);
    const decisions = planRecalculation(
      [
        { eventId: "a", basisId: "basis.steel", observedAt: "t" },
        { eventId: "b", basisId: "basis.labour", observedAt: "t" },
      ],
      multi,
      { recalculateDrafts: true },
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.reason).toContain("basis.labour, basis.steel");
  });

  it("is IDEMPOTENT — a redelivered event contributes nothing", () => {
    // Event transports redeliver. An engine that queued work per delivery
    // would do the same work twice for reasons entirely outside its control.
    const decisions = planRecalculation(events, index, { recalculateDrafts: true }, new Set(["ev1"]));
    expect(decisions).toEqual([]);
  });

  it("produces a deterministic queue order", () => {
    const forward = planRecalculation(events, index, { recalculateDrafts: true }).map((d) => d.estimateId);
    const reversed = planRecalculation([...events].reverse(), index, { recalculateDrafts: true }).map((d) => d.estimateId);
    expect(reversed).toEqual(forward);
  });
});

describe("impact says whether a change is routine or an event", () => {
  it("counts what a basis touches, and how much of it is frozen", () => {
    // One estimate is a Tuesday. Four thousand is a conversation before
    // anybody presses anything.
    const index = buildDependencyIndex([
      estimate({ estimateId: "a" }),
      estimate({ estimateId: "b", frozen: true }),
      estimate({ estimateId: "c", basisIds: ["basis.other"], rateIds: [] }),
      estimate({ estimateId: "d", basisIds: ["basis.other"], rateIds: [] }),
    ]);
    const impact = changeImpact("basis.steel", index, 4);
    expect(impact.affected).toBe(2);
    expect(impact.frozen).toBe(1);
    expect(n(impact.ofCatalogue)).toBe("50");
  });

  it("reports zero for an empty catalogue rather than dividing by nothing", () => {
    expect(n(changeImpact("x", buildDependencyIndex([]), 4).ofCatalogue)).toBe("0");
  });
});
