// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { conformanceFindingSchema, type ConformanceFinding } from "@proworks-hub/hive-runtime";
import { describe, expect, it } from "vitest";

import { ARCHITECTURE_STATES, architectureHeadline, summarizeArchitecture } from "../architecture.js";

const f = (over: Partial<ConformanceFinding> & { status: ConformanceFinding["status"] }) =>
  conformanceFindingSchema.parse({
    ruleId: "ARCH-X",
    subjectId: "@x/a",
    observedAt: "2026-08-31",
    facts: over.status === "PASS" ? [] : ["observed"],
    ...over,
  });

describe("the architecture read model", () => {
  it("imports nothing from the Architecture Engine", () => {
    // Not an oversight: ARCH-DEP-ENGINE-ISOLATION would fail the build. A
    // console that ran the evaluator would make conformance depend on the
    // console being up, which inverts which of the two is infrastructure.
    const source = readFileSync(join(__dirname, "..", "architecture.ts"), "utf8");
    expect(source).not.toContain("architecture-engine");
    expect(source).not.toContain("evaluateConformance");
  });

  it("accepts findings built by the real standard, so the structural type cannot drift", () => {
    // The guard that makes the structural type safe. This file builds its
    // fixtures with `conformanceFindingSchema` from the standard itself, so a
    // real finding must satisfy `ReadableFinding` for any of these tests to
    // compile and run. If the standard renamed `waiverAdrId`, this breaks --
    // which is the whole point of not hand-writing the fixtures.
    const real = conformanceFindingSchema.parse({
      ruleId: "ARCH-REAL",
      subjectId: "@x/real",
      status: "FAIL",
      observedAt: "2026-08-31",
      facts: ["produced by the actual schema"],
      waiverAdrId: null,
    });
    const overview = summarizeArchitecture([real]);
    expect(overview.subjects[0]?.blockingFailures).toEqual(["ARCH-REAL"]);
  });

  it("says no report is loaded rather than implying everything passed", () => {
    const overview = summarizeArchitecture([]);
    expect(overview.adoptionRatio).toBeNull();
    expect(architectureHeadline(overview)).toBe("No conformance report loaded.");
  });

  it("keeps unevaluated separate from passing and failing, all the way out", () => {
    const overview = summarizeArchitecture([f({ status: "PASS" }), f({ status: "UNKNOWN", ruleId: "ARCH-Y" })]);
    const subject = overview.subjects[0]!;
    expect(subject.passing).toBe(1);
    expect(subject.failing).toBe(0);
    expect(subject.unevaluated).toBe(1);
    expect(subject.state).toBe("unevaluated");
  });

  it("makes 'not evaluated' demand attention, like an engine with no telemetry", () => {
    expect(ARCHITECTURE_STATES.unevaluated.demandsAttention).toBe(true);
    expect(ARCHITECTURE_STATES.conformant.demandsAttention).toBe(false);
  });

  it("ranks not-evaluated between conformant and violations, never as either", () => {
    expect(ARCHITECTURE_STATES.unevaluated.severity).toBeGreaterThan(
      ARCHITECTURE_STATES.conformant.severity,
    );
    expect(ARCHITECTURE_STATES.unevaluated.severity).toBeLessThan(
      ARCHITECTURE_STATES.attention.severity,
    );
  });

  it("reports an unadopted subject as out-of-scope rather than conformant", () => {
    const overview = summarizeArchitecture([f({ status: "NOT_APPLICABLE" })]);
    expect(overview.subjects[0]?.state).toBe("out-of-scope");
    expect(overview.adoptedSubjects).toBe(0);
  });

  it("shows a waived failure instead of hiding it, and does not call it blocking", () => {
    // A waiver is a decision somebody made and can revisit; a suppression is a
    // decision nobody can find.
    const overview = summarizeArchitecture([f({ status: "FAIL", waiverAdrId: "ADR-9" })]);
    const subject = overview.subjects[0]!;
    expect(subject.blockingFailures).toEqual([]);
    expect(subject.waived).toEqual(["ARCH-X (ADR-9)"]);
    expect(subject.failing).toBe(1);
  });

  it("puts the unevaluated count in the headline, never a bare conformant count", () => {
    // A header reading "42 conformant" while 20 rules went unevaluated is the
    // specific dishonesty this program exists to refuse.
    const headline = architectureHeadline(
      summarizeArchitecture([f({ status: "PASS" }), f({ status: "UNKNOWN", ruleId: "ARCH-Y" })]),
    );
    expect(headline).toContain("1 rules unevaluated");
  });

  it("counts violations across subjects", () => {
    const overview = summarizeArchitecture([
      f({ status: "FAIL" }),
      f({ status: "FAIL", subjectId: "@x/b" }),
      f({ status: "PASS", subjectId: "@x/c" }),
    ]);
    expect(overview.failingSubjects).toBe(2);
    expect(architectureHeadline(overview)).toContain("2 with violations");
  });
});
