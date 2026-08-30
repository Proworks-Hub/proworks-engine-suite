// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  applyIncompletePolicy,
  margin,
  rankByMargin,
  reconcileToEntityTotal,
  sumAmounts,
  whaleCurve,
  type Amount,
  type DimensionFacts,
} from "../kernel.js";

const known = (minor: bigint): Amount => ({ state: "known", minor });
const unknown = (reason: string): Amount => ({ state: "unknown", reason });

const facts = (overrides?: Partial<DimensionFacts>): DimensionFacts => ({
  memberRef: "cust-A",
  revenue: known(100_000n),
  variableCost: known(40_000n),
  costOfGoods: known(60_000n),
  attributableOperating: known(15_000n),
  allocatedShared: known(10_000n),
  ...overrides,
});

describe("the unknown-propagation algebra — a hole is a named hole, never a zero", () => {
  it("sums propagate unknowns as partials with the known floor", () => {
    const total = sumAmounts([known(100n), unknown("CostIQ unavailable for SKU-9"), known(50n)]);
    expect(total.state).toBe("partial");
    if (total.state === "partial") {
      expect(total.knownFloorMinor).toBe(150n);
      expect(total.holes).toEqual(["CostIQ unavailable for SKU-9"]);
    }
  });
  it("the four margin definitions are NAMED on every result and differ on the same facts", () => {
    const f = facts();
    const contribution = margin(f, "contribution");
    const fullyLoaded = margin(f, "fully-loaded");
    expect(contribution.state === "known" && contribution.marginMinor).toBe(60_000n);
    expect(fullyLoaded.state === "known" && fullyLoaded.marginMinor).toBe(15_000n);
    expect(contribution.definition).toBe("contribution");
  });
  it("a hole in the basis makes the margin partial; the policy offers the only two honest answers", () => {
    const holed = margin(facts({ allocatedShared: unknown("allocation run not complete") }), "fully-loaded");
    expect(holed.state).toBe("partial");
    const refused = applyIncompletePolicy(holed, "refuse");
    expect(!refused.ok && refused.refusal.kind).toBe("COST_BASIS_INCOMPLETE");
    const partial = applyIncompletePolicy(holed, "partial-with-coverage");
    expect(partial.ok && partial.value.state).toBe("partial");
    // But the contribution margin over the SAME facts is fully known:
    const contribution = margin(facts({ allocatedShared: unknown("allocation run not complete") }), "contribution");
    expect(contribution.state).toBe("known");
  });
});

describe("ranking and concentration — partials are EXCLUDED, never ranked as floors", () => {
  it("ranks known margins and lists partials with their holes", () => {
    const { ranked, excluded } = rankByMargin([
      { memberRef: "a", result: { state: "known", marginMinor: 500n, definition: "gross" } },
      { memberRef: "b", result: { state: "partial", knownFloorMinor: 900n, holes: ["h"], definition: "gross" } },
      { memberRef: "c", result: { state: "known", marginMinor: 700n, definition: "gross" } },
    ]);
    expect(ranked.map((r) => r.memberRef)).toEqual(["c", "a"]);
    expect(excluded[0]?.memberRef).toBe("b");
  });
  it("the whale curve accumulates over the ranked set", () => {
    const curve = whaleCurve([
      { memberRef: "a", marginMinor: 700n },
      { memberRef: "b", marginMinor: 500n },
      { memberRef: "c", marginMinor: -200n },
    ]);
    expect(curve[0]?.cumulativeMinor).toBe(700n);
    expect(curve[1]?.cumulativeMinor).toBe(1200n);
    expect(curve[2]?.cumulativeMinor).toBe(1000n);
    // The peak exceeds the total — the whale-curve shape.
    expect(curve[1]!.cumulativeBpsOfTotal).toBe(12000);
  });
});

describe("reconciliation — the gap is NAMED, never spread to force a tie", () => {
  it("computes the unexplained difference against a supplied entity total", () => {
    const outcome = reconcileToEntityTotal(
      [
        { memberRef: "a", result: { state: "known", marginMinor: 700n, definition: "operating" } },
        { memberRef: "b", result: { state: "known", marginMinor: 500n, definition: "operating" } },
      ],
      1_250n,
    );
    expect(outcome.ok && outcome.value.unexplainedMinor).toBe(50n);
  });
  it("refuses a reconciliation over partial members — a floor against a total lies both ways", () => {
    const outcome = reconcileToEntityTotal(
      [{ memberRef: "a", result: { state: "partial", knownFloorMinor: 700n, holes: ["h"], definition: "operating" } }],
      1_000n,
    );
    expect(!outcome.ok && outcome.refusal.kind).toBe("COST_BASIS_INCOMPLETE");
  });
});
