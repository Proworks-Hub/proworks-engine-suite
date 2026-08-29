// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  CONSTITUTIONAL_REACH,
  NOT_CLASSIFIED,
  OVERWATCH_MEMBERS,
  charterReferenceSchema,
  hiveClassificationSchema,
  isConstitutional,
  lifecycleStateSchema,
  tierFor,
} from "@proworks-hub/contracts";
import { ALLOWED_DEPENDENCIES, hiveTierSchema } from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The constitutional plane, and its separation from the capability plane.
//
// These tests exist to stop one specific drift: somebody deciding that because
// Governance is important, it should sit at the top of the tier matrix. It
// cannot. A tier is a position in a dependency hierarchy; Governance's
// relationship is to the whole system, which is a different kind of statement.
// ─────────────────────────────────────────────────────────────────────────────

describe("the two planes stay separate", () => {
  it("gives the constitutional classes no capability tier", () => {
    // null is the answer, not a fallback. Returning a plausible tier would let
    // the dependency checker judge a relationship it has no basis to judge.
    for (const c of hiveClassificationSchema.options.filter(isConstitutional)) {
      expect(tierFor(c)).toBeNull();
    }
  });

  it("maps every capability class onto the existing tier vocabulary", () => {
    expect(tierFor("CORE")).toBe("core");
    expect(tierFor("SHARED_PLATFORM")).toBe("platform");
    expect(tierFor("SPECIALIZED")).toBe("specialized");
    expect(tierFor("INDUSTRY")).toBe("industry");
  });

  it("keeps HOST outside the dependency graph", () => {
    // A host consumes the Hive. It is classified so a manifest can describe
    // one, not so the tier law can rank one.
    expect(tierFor("HOST")).toBeNull();
    expect(hiveTierSchema.options).not.toContain("host");
  });

  it("leaves the existing dependency law untouched", () => {
    // The whole point of adding a plane rather than editing the matrix. If this
    // fails, the capability model was changed to accommodate the constitutional
    // one, which is the migration this design exists to avoid.
    expect(ALLOWED_DEPENDENCIES).toEqual({
      prime: ["platform"],
      core: ["platform"],
      specialized: ["platform"],
      industry: ["platform"],
      platform: [],
    });
  });
});

describe("Overwatch is not a component", () => {
  it("has no classification of its own", () => {
    expect(hiveClassificationSchema.options).not.toContain("CONSTITUTIONAL_OVERWATCH");
    expect(hiveClassificationSchema.options.some((c) => c.includes("OVERWATCH"))).toBe(false);
  });

  it("is exactly Governance, Sentinel and Foundry", () => {
    expect([...OVERWATCH_MEMBERS].sort()).toEqual([
      "CONSTITUTIONAL_EVOLUTION",
      "CONSTITUTIONAL_GOVERNANCE",
      "CONSTITUTIONAL_SENTINEL",
    ]);
  });

  it("does not include ARIA or Prime", () => {
    // ARIA sits alongside Overwatch and supports it; it is not one of its
    // authorities. Prime is coordinated BY Overwatch, not part of it.
    expect(OVERWATCH_MEMBERS).not.toContain("CONSTITUTIONAL_INTELLIGENCE");
    expect(OVERWATCH_MEMBERS).not.toContain("CONSTITUTIONAL_ORCHESTRATION");
  });

  it("records why it, RepairBots, the Fabric and IdentityIQ are unclassified", () => {
    for (const key of ["Overwatch", "RepairBot", "InformationFabric", "IdentityIQ"]) {
      expect(NOT_CLASSIFIED[key]).toBeTruthy();
    }
    expect(NOT_CLASSIFIED["IdentityIQ"]).toContain("SHARED_PLATFORM");
  });
});

describe("no hierarchy among the constitutional classes", () => {
  it("gives every constitutional class a stated reach and a stated limit", () => {
    // The limit is the load-bearing half. "Authorizes across the system" without
    // "does not execute or own state" is how a constitutional system becomes an
    // ordinary one with extra privileges.
    for (const c of hiveClassificationSchema.options.filter(isConstitutional)) {
      const reach = CONSTITUTIONAL_REACH[c];
      expect(reach, `${c} must declare its reach`).toBeTruthy();
      expect(reach!.verb.length).toBeGreaterThan(0);
      expect(reach!.limit.length).toBeGreaterThan(0);
    }
  });

  it("states that ARIA never authorizes", () => {
    expect(CONSTITUTIONAL_REACH["CONSTITUTIONAL_INTELLIGENCE"]!.limit).toMatch(/[Nn]ever authorizes/);
  });

  it("states that Prime is not the communication bus", () => {
    expect(CONSTITUTIONAL_REACH["CONSTITUTIONAL_ORCHESTRATION"]!.limit).toMatch(/not the communication bus/);
  });
});

describe("lifecycle and charter references", () => {
  it("distinguishes chartered from built from production", () => {
    // A chartered-but-unbuilt component and an experimental one are both
    // incomplete and must not be treated the same by a caller.
    const states = lifecycleStateSchema.options;
    expect(states).toContain("CHARTERED");
    expect(states).toContain("SCAFFOLDED");
    expect(states).toContain("PRODUCTION");
    expect(states).toContain("RETIRED");
  });

  it("accepts a charter reference without an integrity hash, for now", () => {
    const parsed = charterReferenceSchema.safeParse({
      charterId: "charter.governance",
      charterVersion: "0.1.0",
      charterLocation: "ProWorks-Ecosystem/charters/GOVERNANCE.md",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a charter reference with unknown fields", () => {
    // .strict() on purpose: a charter reference that silently accepts extra
    // fields is one where a typo'd `charterVerison` reads as version-less.
    const parsed = charterReferenceSchema.safeParse({
      charterId: "charter.governance",
      charterVersion: "0.1.0",
      charterLocation: "somewhere",
      charterVerison: "0.2.0",
    });
    expect(parsed.success).toBe(false);
  });
});
