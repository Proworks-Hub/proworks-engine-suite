// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { ARCHITECTURE_RULES } from "../rules.js";
import {
  MANIFESTO_TRACEABILITY,
  traceabilityRule,
  uncoveredTraceabilityRules,
} from "../traceability/index.js";

describe("the manifesto traceability matrix", () => {
  it("ingests all 38 rules with their own ids", () => {
    expect(MANIFESTO_TRACEABILITY).toHaveLength(38);
    expect(MANIFESTO_TRACEABILITY[0]?.id).toBe("TR-001");
    expect(MANIFESTO_TRACEABILITY.at(-1)?.id).toBe("TR-038");
  });

  it("resolves every source an architecture rule cites", () => {
    // The traceability loop closed. A rule citing TR-099 would be citing
    // nothing, and the citation is what lets an engineer argue with the rule
    // rather than only with the tool that reported it.
    for (const rule of ARCHITECTURE_RULES) {
      if (!rule.source.startsWith("TR-")) continue;
      expect(traceabilityRule(rule.source), `${rule.id} cites ${rule.source}`).toBeDefined();
    }
  });

  it("reports honest coverage rather than only what is already covered", () => {
    // 38 manifesto rules exist and the catalog implements a fraction. A matrix
    // that listed only the covered ones would show 100% forever, which is the
    // shape of every traceability document nobody trusts.
    const cited = ARCHITECTURE_RULES.map((r) => r.source);
    const uncovered = uncoveredTraceabilityRules(cited);
    expect(uncovered.length).toBeGreaterThan(0);
    expect(uncovered.length + new Set(cited).size).toBe(38);
  });
});
