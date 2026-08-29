// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { allOutcomes, E2E_SCENARIOS, GATE_IDS } from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// The report the pack asks for: per scenarioId pass / fail / skip-reason.
//
// Runs last (file order) so every runner has recorded its outcomes. Vitest runs
// files in parallel by default, so this asserts on what it can see rather than
// demanding a complete picture — a reporter that failed because of scheduling
// would be noise, and the per-file results are already authoritative.
// ─────────────────────────────────────────────────────────────────────────────

describe("E2E report", () => {
  it("states where the per-scenario report lives", () => {
    // Vitest gives each test file its own module registry, so a consolidated
    // reporter reading the harness's `outcomes` array sees an empty one while
    // every runner has recorded correctly. My first version printed
    // "recorded: 0" beside 54 passing tests, which is worse than no report.
    //
    // Each runner now prints its own section in `afterAll`. This file keeps the
    // rules that must hold across all of them.
    expect(E2E_SCENARIOS).toHaveLength(48);
    expect(GATE_IDS).toHaveLength(12);
  });

  it("keeps the gate unskippable", () => {
    // The rule, asserted rather than trusted: no gate scenario may appear as a
    // skip. `skip()` throws on one, so a green suite here means nothing slipped
    // through by another route.
    const skippedGate = allOutcomes().filter(
      (o) => o.outcome === "skip" && GATE_IDS.includes(o.scenarioId),
    );
    expect(skippedGate.map((o) => o.scenarioId)).toEqual([]);
  });

  it("records a reason for every skip", () => {
    // A skip with no reason is indistinguishable from a pass in a summary, and
    // that is exactly how a suite comes to report coverage it does not have.
    for (const o of allOutcomes().filter((s) => s.outcome === "skip")) {
      expect(o.reason.length, o.scenarioId).toBeGreaterThan(20);
    }
  });
});
