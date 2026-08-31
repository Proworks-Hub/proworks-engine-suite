// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  OVERWATCH_MEMBERS,
  hiveClassificationSchema,
  hiveLayerSchema,
  isConstitutional,
  layerFor,
  requiresCoreDomain,
  tierFor,
  type HiveClassification,
} from "../hiveClassification.js";

const ALL = hiveClassificationSchema.options as readonly HiveClassification[];

describe("layerFor", () => {
  it("is total over every classification", () => {
    // Not a loop for its own sake: the point is that no classification falls
    // through to the `never` branch, which is the only way a component could
    // reach the console with no band.
    for (const c of ALL) {
      expect(hiveLayerSchema.safeParse(layerFor(c)).success).toBe(true);
    }
  });

  it("maps an unratified component to `plane` rather than guessing", () => {
    // Neural Fabric's PROPOSED_COORDINATION_PLANE is deliberately absent from
    // the enum. `plane` is how it renders truthfully without being assigned a
    // classification it does not hold.
    expect(layerFor(null)).toBe("plane");
  });

  it("gives orchestration its own band, separate from the constitutional four", () => {
    // Prime is subordinate to Governance and Sentinel. Sharing a band with the
    // systems that constrain it would be an authority claim made by layout.
    expect(layerFor("CONSTITUTIONAL_ORCHESTRATION")).toBe("prime");
    expect(layerFor("CONSTITUTIONAL_GOVERNANCE")).toBe("constitutional");
  });

  it("puts ARIA in `constitutional` — a band it can hold — and never in an Overwatch one", () => {
    // The defect this guards: ARIA is NOT an Overwatch member. A band named for
    // Overwatch containing ARIA would assert by placement that ARIA holds
    // constraining authority, when it advises and never authorizes.
    expect(OVERWATCH_MEMBERS).toHaveLength(3);
    expect(OVERWATCH_MEMBERS).not.toContain("CONSTITUTIONAL_INTELLIGENCE");
    expect(layerFor("CONSTITUTIONAL_INTELLIGENCE")).toBe("constitutional");
    expect(hiveLayerSchema.options).not.toContain("overwatch");
  });

  it("agrees with tierFor wherever tierFor has an answer", () => {
    // Two derivations over one vocabulary must not disagree. Where a tier
    // exists, the layer carries the same name; where it does not, the layer
    // still exists, which is the whole reason this function was added.
    for (const c of ALL) {
      const tier = tierFor(c);
      if (tier !== null) expect(layerFor(c)).toBe(tier);
      else expect(isConstitutional(c)).toBe(true);
    }
  });
});

describe("requiresCoreDomain", () => {
  it("requires a Core for exactly the capability plane", () => {
    // Matches hiveMap at 58d5e84 with no exceptions: core 9/9, specialized
    // 44/44, industry 1/1 name a Core; platform 0/14 and prime 0/1 do not.
    const required = hiveLayerSchema.options.filter(requiresCoreDomain);
    expect([...required].sort()).toEqual(["core", "industry", "specialized"]);
  });

  it("forbids a Core for every constitutional classification", () => {
    for (const c of ALL) {
      if (isConstitutional(c)) expect(requiresCoreDomain(layerFor(c))).toBe(false);
    }
  });
});
