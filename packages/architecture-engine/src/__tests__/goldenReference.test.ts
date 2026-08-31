// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { participantRuntimeSchema } from "@proworks-hub/hive-runtime";
import { describe, expect, it } from "vitest";

import { goldenReferenceRuntime, normalize, record } from "../chambers/goldenReference.js";

const CORRELATION = "corr-1";

describe("the Golden Reference Engine", () => {
  it("declares a runtime that satisfies the standard it demonstrates", () => {
    // If the reference does not parse, nothing else in this package means
    // anything: it is the worked example every other engine is pointed at.
    expect(participantRuntimeSchema.safeParse(goldenReferenceRuntime).success).toBe(true);
  });

  it("performs its unprotected capability", () => {
    expect(normalize("  Hello   WORLD ", CORRELATION)).toMatchObject({
      ok: true,
      value: "hello world",
      correlationId: CORRELATION,
    });
  });

  it("refuses the protected capability to an unauthorized caller", () => {
    const out = record("x", CORRELATION, { authorized: false, eventBusAvailable: true });
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("Denied.");
  });

  it("tells an unauthorized caller nothing about whether the capability exists", () => {
    // Governance-first is only worth having if the refusal is uninformative.
    // A refusal that named the capability would confirm its existence to
    // exactly the caller who was not allowed to know.
    const refused = record("x", CORRELATION, { authorized: false, eventBusAvailable: true });
    expect(refused.refusal).not.toContain("reference.record");
    expect(refused.value).toBeUndefined();
  });

  it("performs the protected capability once authorized", () => {
    expect(record("  A B  ", CORRELATION, { authorized: true, eventBusAvailable: true })).toMatchObject({
      ok: true,
      value: "a b",
    });
  });

  it("degrades exactly as its collaboration contract says when EventIQ is gone", () => {
    // The contract promises normalization continues and recording is refused
    // rather than silently dropped. Both halves are asserted, because the
    // dangerous failure is the one that returns ok and writes nothing.
    const degraded = record("x", CORRELATION, { authorized: true, eventBusAvailable: false });
    expect(degraded.ok).toBe(false);
    expect(degraded.refusal).toContain("retry");
    expect(normalize("  Still  Works ", CORRELATION).ok).toBe(true);
  });

  it("does not import the Conformance Chamber", () => {
    // The constitutional one. If the reference engine needed the evaluator to
    // run, the Architecture Engine would be a runtime parent and its outage
    // would be everyone's. Asserted against the source text, because a mocked
    // import would pass while the real dependency existed.
    const source = readFileSync(
      join(__dirname, "..", "chambers", "goldenReference.ts"),
      "utf8",
    );
    expect(source).not.toContain("./conformance.js");
    expect(source).not.toContain("evaluateConformance");
  });

  it("claims a maturity it can evidence", () => {
    expect(goldenReferenceRuntime.maturity).toBe("INTEGRATED");
    expect(goldenReferenceRuntime.evidenceRefs.length).toBeGreaterThan(0);
  });
});
