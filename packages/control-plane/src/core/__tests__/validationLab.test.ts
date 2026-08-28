// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_TEST_PERMISSION,
  SANDBOX_TEST_PERMISSION,
  authorizeLabRun,
  findRegressions,
  labFixtureSchema,
  readinessFromLab,
  type LabFixture,
  type LabRun,
} from "../validationLab.js";

const fixture = (over: Partial<LabFixture> = {}): LabFixture =>
  labFixtureSchema.parse({
    id: "fx-1",
    description: "A standard sign order.",
    engineId: "forgeiq",
    provenance: "synthetic",
    input: { widthIn: 24 },
    baselineOutput: { parts: 3 },
    ...over,
  });

const run = (over: Partial<LabRun> = {}): LabRun => ({
  runId: "run-1",
  environment: "sandbox",
  engineId: "forgeiq",
  candidateVersion: "2.2.0",
  ranAt: "2026-08-27T12:00:00.000Z",
  requestedBy: "steven",
  results: [{ fixtureId: "fx-1", ok: true, output: { parts: 3 }, latencyMs: 12 }],
  passed: 1,
  failed: 0,
  ...over,
});

describe("fixtures state where their data came from", () => {
  it("accepts a synthetic fixture with nobody named", () => {
    expect(fixture().provenance).toBe("synthetic");
  });

  it("refuses a sanitised fixture that does not name who cleared it", () => {
    // "Somebody sanitised it" is not a provenance.
    expect(() =>
      labFixtureSchema.parse({
        id: "fx-2", description: "From a real order.", engineId: "forgeiq",
        provenance: "sanitised", input: {},
      }),
    ).toThrow();
  });

  it("accepts one that does", () => {
    expect(
      fixture({ id: "fx-2", provenance: "sanitised", clearedBy: "steven" }).clearedBy,
    ).toBe("steven");
  });
});

describe("a lab run cannot touch production by accident", () => {
  const base = {
    runId: "r", engineId: "forgeiq", candidateVersion: "2.2.0",
    fixtures: [fixture()], requestedBy: "steven",
  };

  it("allows a sandbox run with the sandbox permission", () => {
    const decision = authorizeLabRun({
      ...base, environment: "sandbox", permissions: [SANDBOX_TEST_PERMISSION],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.banner).toContain("SANDBOX");
  });

  it("refuses a production run without the production permission", () => {
    // Sandbox permission is deliberately not enough. They are separate
    // permissions precisely so holding one does not imply the other.
    const decision = authorizeLabRun({
      ...base, environment: "production", permissions: [SANDBOX_TEST_PERMISSION],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("production_not_permitted");
  });

  it("allows a production run only with the explicit permission, and shouts about it", () => {
    const decision = authorizeLabRun({
      ...base, environment: "production",
      permissions: [SANDBOX_TEST_PERMISSION, PRODUCTION_TEST_PERMISSION],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.banner).toContain("PRODUCTION");
    expect(decision.banner).toContain("real data");
  });

  it("refuses raw production data in the sandbox too", () => {
    // Raw production data does not become acceptable because the run is a
    // sandbox one — the copy has already happened by the time it gets here.
    const decision = authorizeLabRun({
      ...base,
      environment: "sandbox",
      permissions: [SANDBOX_TEST_PERMISSION],
      fixtures: [fixture({ id: "fx-raw", provenance: "production_raw", clearedBy: "steven" })],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("raw_production_data");
    expect(decision.reason).toContain("fx-raw");
  });

  it("refuses a run with no fixtures", () => {
    // It would prove nothing and report success.
    const decision = authorizeLabRun({
      ...base, environment: "sandbox", permissions: [SANDBOX_TEST_PERMISSION], fixtures: [],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe("no_fixtures");
  });
});

describe("finding what changed", () => {
  it("says nothing when the output matches the baseline", () => {
    expect(findRegressions(run(), [fixture()])).toEqual([]);
  });

  it("reports a changed output as a finding, not a failure", () => {
    // It may be the improvement the release was for. But "the numbers moved
    // and nobody noticed" is how a pricing change ships as a bug fix.
    const findings = findRegressions(
      run({ results: [{ fixtureId: "fx-1", ok: true, output: { parts: 4 }, latencyMs: 12 }] }),
      [fixture()],
    );
    expect(findings[0]?.kind).toBe("output_changed");
    expect(findings[0]?.before).toEqual({ parts: 3 });
    expect(findings[0]?.after).toEqual({ parts: 4 });
  });

  it("reports a fixture that used to pass and now fails", () => {
    const findings = findRegressions(
      run({ results: [{ fixtureId: "fx-1", ok: false, output: null, latencyMs: 5, error: "threw" }], passed: 0, failed: 1 }),
      [fixture()],
    );
    expect(findings[0]?.kind).toBe("now_failing");
  });

  it("does not treat an unbaselined fixture as a pass", () => {
    // Counting an unknown as green is how a suite reports confidence it has
    // not earned.
    const findings = findRegressions(run(), [fixture({ baselineOutput: undefined })]);
    expect(findings[0]?.kind).toBe("no_baseline");
  });
});

describe("what a lab run says about shipping", () => {
  it("fails readiness when something regressed", () => {
    const findings = findRegressions(
      run({ results: [{ fixtureId: "fx-1", ok: false, output: null, latencyMs: 5 }], passed: 0, failed: 1 }),
      [fixture()],
    );
    expect(readinessFromLab(run(), findings).state).toBe("fail");
  });

  it("warns rather than failing when output merely changed", () => {
    const findings = findRegressions(
      run({ results: [{ fixtureId: "fx-1", ok: true, output: { parts: 4 }, latencyMs: 5 }] }),
      [fixture()],
    );
    expect(readinessFromLab(run(), findings).state).toBe("warn");
  });

  it("is unknown when fixtures had no baseline", () => {
    const findings = findRegressions(run(), [fixture({ baselineOutput: undefined })]);
    expect(readinessFromLab(run(), findings).state).toBe("unknown");
  });

  it("passes a clean sandbox run", () => {
    expect(readinessFromLab(run(), []).state).toBe("pass");
  });

  it("refuses to let a production run certify a candidate", () => {
    // It exercised the version already deployed, not the one being assessed.
    const assessment = readinessFromLab(run({ environment: "production" }), []);
    expect(assessment.state).toBe("unknown");
    expect(assessment.detail).toContain("says nothing about the candidate");
  });
});
