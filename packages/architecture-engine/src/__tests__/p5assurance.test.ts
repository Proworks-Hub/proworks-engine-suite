// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { conformanceFindingSchema, type ConformanceFinding } from "@proworks-hub/hive-runtime";
import { describe, expect, it } from "vitest";

import {
  assessComparativeClaim,
  certify,
  describeBenchmark,
  type BenchmarkProfile,
  type CertificationProfile,
} from "../modules/certification.js";
import {
  REQUIRED_BOOKS,
  assessKnowledgePackage,
  detectArchitectureDrift,
  findProvenanceGaps,
} from "../modules/knowledge.js";

const finding = (ruleId: string, status: ConformanceFinding["status"]): ConformanceFinding =>
  conformanceFindingSchema.parse({
    ruleId,
    subjectId: "hive.subject",
    status,
    observedAt: "2026-08-31",
    facts: status === "PASS" ? [] : ["observed"],
  });

const PROFILE: CertificationProfile = {
  profileId: "profile.m5",
  version: "1.0.0",
  requiredRuleIds: ["ARCH-A", "ARCH-B"],
  requiredEvidenceKinds: ["test:", "adr:"],
};

describe("CertificationIQ", () => {
  it("certifies when every rule passed and every evidence kind is present", () => {
    const result = certify(PROFILE, "hive.subject", [finding("ARCH-A", "PASS"), finding("ARCH-B", "PASS")], [
      "test:a",
      "adr:b",
    ]);
    expect(result.status).toBe("CERTIFIED");
  });

  it("reports INCOMPLETE, not CERTIFIED, when a required rule was never evaluated", () => {
    // The value that earns this module its place. Treating an unevaluated rule
    // as satisfied is how certification stops meaning anything, and it fails
    // silently in the flattering direction.
    const result = certify(PROFILE, "hive.subject", [finding("ARCH-A", "PASS")], ["test:a", "adr:b"]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingRuleIds).toEqual(["ARCH-B"]);
  });

  it("treats UNKNOWN as unevaluated rather than as addressed", () => {
    const result = certify(
      PROFILE,
      "hive.subject",
      [finding("ARCH-A", "PASS"), finding("ARCH-B", "UNKNOWN")],
      ["test:a", "adr:b"],
    );
    expect(result.status).toBe("INCOMPLETE");
  });

  it("accepts NOT_APPLICABLE as addressed, because somebody decided", () => {
    const result = certify(
      PROFILE,
      "hive.subject",
      [
        finding("ARCH-A", "PASS"),
        conformanceFindingSchema.parse({
          ruleId: "ARCH-B",
          subjectId: "hive.subject",
          status: "NOT_APPLICABLE",
          observedAt: "2026-08-31",
          facts: ["no persistence layer, so the rule cannot apply"],
        }),
      ],
      ["test:a", "adr:b"],
    );
    expect(result.status).toBe("CERTIFIED");
  });

  it("reports INCOMPLETE when evidence is missing even though nothing failed", () => {
    const result = certify(PROFILE, "hive.subject", [finding("ARCH-A", "PASS"), finding("ARCH-B", "PASS")], [
      "test:a",
    ]);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.missingEvidenceKinds).toEqual(["adr:"]);
  });

  it("never claims to approve anything", () => {
    // A certification engine that could block a release would hold a power
    // nobody granted it, and the pressure to make it say PASS would arrive the
    // first time a release was urgent.
    const result = certify(PROFILE, "hive.subject", [], []);
    expect(result.note).toContain("not permission");
    expect(result.note).toContain("Governance decides");
  });
});

describe("BenchmarkIQ", () => {
  const bench: BenchmarkProfile = {
    profileId: "bench.rollup",
    domain: "finance",
    workload: "100k cost rollups",
    dataset: "synthetic",
    environment: "local",
    metric: "latency",
    unit: "ms",
    percentiles: { p50: 41, p99: 418 },
    runs: 5,
    limitations: ["single machine", "synthetic data"],
  };

  it("refuses a comparative claim from a single run", () => {
    const out = assessComparativeClaim({ ...bench, runs: 1 }, { claim: "faster", comparedTo: "X", publicSourceRef: "s" });
    expect(out.verdict).toBe("UNSUPPORTED");
    expect(out.reasons.join()).toContain("not reproducible");
  });

  it("refuses a comparison against a system nobody measured", () => {
    const out = assessComparativeClaim(bench, { claim: "faster", comparedTo: "X" });
    expect(out.verdict).toBe("UNSUPPORTED");
    expect(out.reasons.join()).toContain("no public source");
  });

  it("refuses a benchmark that records no limitations", () => {
    const out = assessComparativeClaim(
      { ...bench, limitations: [] },
      { claim: "faster", comparedTo: "X", publicSourceRef: "s" },
    );
    expect(out.verdict).toBe("UNSUPPORTED");
  });

  it("reports every reason at once rather than short-circuiting", () => {
    // So a caller fixing one is told about the others instead of discovering
    // them one release at a time.
    const out = assessComparativeClaim({ ...bench, runs: 1, limitations: [] }, { claim: "faster", comparedTo: "X" });
    expect(out.reasons).toHaveLength(3);
  });

  it("supports a claim once all three conditions hold", () => {
    expect(
      assessComparativeClaim(bench, { claim: "faster", comparedTo: "X", publicSourceRef: "https://example" })
        .verdict,
    ).toBe("SUPPORTED");
  });

  it("describes your own measurement without any gate, and states the limitations", () => {
    // Measuring your own system is always legitimate; it is the COMPARISON
    // that needs the other party's number.
    const text = describeBenchmark(bench);
    expect(text).toContain("p99=418ms");
    expect(text).toContain("single machine");
  });
});

describe("KnowledgePackageIQ", () => {
  it("names the limiting book rather than only a percentage", () => {
    // A completeness number tells an author nothing about what to write next.
    const status = assessKnowledgePackage("hive.x", REQUIRED_BOOKS.filter((b) => !b.startsWith("Charter")));
    expect(status.limitingDimension).toBe("Charter / Constitutional Role");
    expect(status.completeness).toBeCloseTo(0.92, 2);
  });

  it("orders the limiting dimension by what stops a reader first", () => {
    // Security outranks the Contract Atlas: you can read a component without
    // its interaction map, but you should not run one whose threat model
    // nobody wrote.
    const status = assessKnowledgePackage(
      "hive.x",
      REQUIRED_BOOKS.filter((b) => !b.startsWith("Security") && !b.startsWith("Interaction")),
    );
    expect(status.limitingDimension).toBe("Security / Threat Model");
  });

  it("reports no limiting dimension for a complete package", () => {
    expect(assessKnowledgePackage("hive.x", REQUIRED_BOOKS).limitingDimension).toBeNull();
  });
});

describe("ArchitectureDriftIQ", () => {
  it("reports a map entry with no package as implementation drift", () => {
    // The more misleading direction: it makes the Hive look more built than
    // it is.
    const drift = detectArchitectureDrift([{ id: "ghost", packageName: "@x/ghost" }], []);
    expect(drift[0]?.category).toBe("IMPLEMENTATION_DRIFT");
  });

  it("reports a package with no map entry as documentation drift", () => {
    const drift = detectArchitectureDrift([], [{ packageName: "@x/real", dependencies: [] }]);
    expect(drift[0]?.category).toBe("DOCUMENTATION_DRIFT");
    expect(drift[0]?.authoritative).toBe("REPOSITORY");
  });

  it("declines to say which side is right when it cannot know", () => {
    // A drift tool that always blamed the documentation would be used to
    // justify whatever the code happened to do.
    const drift = detectArchitectureDrift([{ id: "ghost", packageName: "@x/ghost" }], []);
    expect(drift[0]?.authoritative).toBe("UNKNOWN");
  });
});

describe("ArchitectureProvenanceIQ", () => {
  it("flags code that exists with no decision behind it", () => {
    const gaps = findProvenanceGaps([
      { subject: "featureX", links: { IMPLEMENTATION: "src/x.ts", TEST: "x.test.ts" } },
    ]);
    expect(gaps[0]?.implementedWithoutDecision).toBe(true);
  });

  it("does not flag code that traces to a manifesto rule", () => {
    const gaps = findProvenanceGaps([
      { subject: "featureY", links: { IMPLEMENTATION: "src/y.ts", MANIFESTO_RULE: "TR-004" } },
    ]);
    expect(gaps[0]?.implementedWithoutDecision).toBe(false);
  });

  it("reports the gap rather than inventing the missing link", () => {
    // Writing history backwards from the implementation would make every
    // decision look like it was made on purpose.
    const gaps = findProvenanceGaps([{ subject: "z", links: { IMPLEMENTATION: "src/z.ts" } }]);
    expect(gaps[0]?.missing).toContain("ADR");
    expect(gaps[0]?.missing).toContain("CONSTITUTION");
  });

  it("returns nothing for a complete chain", () => {
    expect(
      findProvenanceGaps([
        {
          subject: "complete",
          links: {
            CONSTITUTION: "c",
            MANIFESTO_RULE: "TR-004",
            ARCHITECTURE_RULE: "ARCH-GOV-FIRST",
            ADR: "ADR-1",
            IMPLEMENTATION: "src",
            TEST: "t",
            EVIDENCE: "e",
          },
        },
      ]),
    ).toEqual([]);
  });
});
