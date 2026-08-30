/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";

import { SHIPPED_SOURCES, certify, formatCertification, type CertificationSources } from "../../certification.js";
import { fromString, toString } from "../../domain/decimal.js";
import {
  COSTIQ_API_VERSION,
  SURFACE_CHANGES,
  breakingChangesSince,
  decimalStringFromNumber,
  migrateBatch,
  migrateEstimate,
  type LegacyEstimate,
} from "../versioning.js";

const legacy = (over: Partial<LegacyEstimate> = {}): LegacyEstimate => ({
  id: "est-1",
  totalCost: 412.8,
  currency: "GBP",
  methodVersion: "direct-job-cost@1.0.0",
  approvedAt: null,
  ...over,
});

describe("the dangerous migration is the one that compiles", () => {
  it("CONVERTS the stored total rather than recomputing it", () => {
    // Recomputing would produce v2's more correct number and silently replace
    // what a customer was quoted. Converting preserves the historical figure.
    const outcome = migrateEstimate(legacy());
    expect(outcome.migrated).toBe(true);
    if (outcome.migrated) expect(outcome.totalCost).toBe("412.8");
  });

  it("produces a string the decimal parser accepts", () => {
    const outcome = migrateEstimate(legacy({ totalCost: 1234.56 }));
    if (outcome.migrated) expect(toString(fromString(outcome.totalCost))).toBe("1234.56");
    else throw new Error("should have migrated");
  });

  it("REFUSES an estimate with no currency rather than defaulting one", () => {
    // Two decimal places is wrong for JPY, KWD and CLF, and wrong silently.
    const outcome = migrateEstimate(legacy({ currency: null }));
    expect(outcome.migrated).toBe(false);
    if (!outcome.migrated) {
      expect(outcome.reason).toContain("refuses to guess");
      expect(outcome.reason).toContain("JPY");
    }
  });

  it("REFUSES a stored infinity, which v1 could produce", () => {
    const outcome = migrateEstimate(legacy({ totalCost: Number.POSITIVE_INFINITY }));
    expect(outcome.migrated).toBe(false);
    if (!outcome.migrated) expect(outcome.reason).toContain("division by zero");
  });

  it("REFUSES a stored NaN", () => {
    expect(migrateEstimate(legacy({ totalCost: Number.NaN })).migrated).toBe(false);
  });

  it("WARNS that an estimate with no method version cannot be replayed", () => {
    // v1 had none, so this is the common case rather than the exception.
    const outcome = migrateEstimate(legacy({ methodVersion: null }));
    if (outcome.migrated) {
      expect(outcome.warnings.join()).toContain("CANNOT be replayed");
      expect(outcome.warnings.join()).toContain("historical evidence");
    } else {
      throw new Error("should have migrated with a warning");
    }
  });

  it("warns that an approved estimate arrives immutable", () => {
    const outcome = migrateEstimate(legacy({ approvedAt: "2026-01-01T00:00:00.000Z" }));
    if (outcome.migrated) expect(outcome.warnings.join()).toContain("will not be recomputed");
  });

  it("says nothing extra about a clean estimate", () => {
    const outcome = migrateEstimate(legacy());
    if (outcome.migrated) expect(outcome.warnings).toEqual([]);
  });

  it("keeps the successes and reports the failures", () => {
    const result = migrateBatch([legacy(), legacy({ id: "est-2", currency: null }), legacy({ id: "est-3", methodVersion: null })]);
    expect(result.migrated.map((m) => m.id)).toEqual(["est-1", "est-3"]);
    expect(result.failed.map((f) => f.id)).toEqual(["est-2"]);
    expect(result.summary).toContain("The refusals are the useful part");
  });

  it("counts how many migrated with warnings, which is the number worth reading", () => {
    const result = migrateBatch([legacy(), legacy({ id: "est-2", methodVersion: null })]);
    expect(result.summary).toContain("2 migrated (1 with warnings)");
  });
});

describe("converting a float to a decimal string", () => {
  it("uses the shortest round-tripping form", () => {
    expect(decimalStringFromNumber(412.8)).toBe("412.8");
    expect(decimalStringFromNumber(0.1)).toBe("0.1");
  });

  it("expands exponential notation, which the decimal parser does not accept", () => {
    // Otherwise a small value arrives as "1e-7" and fails at a confusing place.
    expect(decimalStringFromNumber(1e-7)).toBe("0.0000001");
    expect(decimalStringFromNumber(1.5e-7)).toBe("0.00000015");
    expect(decimalStringFromNumber(1e21)).toBe("1000000000000000000000");
  });

  it("handles negatives on both sides of the point", () => {
    expect(decimalStringFromNumber(-412.8)).toBe("-412.8");
    expect(decimalStringFromNumber(-1e-7)).toBe("-0.0000001");
    expect(decimalStringFromNumber(-1e21)).toBe("-1000000000000000000000");
  });

  it("produces strings the decimal parser accepts across the range", () => {
    for (const value of [0, 1, -1, 0.5, 412.8, -0.001, 1e-7, 1e21, -1.5e-7]) {
      expect(() => fromString(decimalStringFromNumber(value))).not.toThrow();
    }
  });

  it("handles zero", () => {
    expect(decimalStringFromNumber(0)).toBe("0");
  });
});

describe("breaking changes are documented, not just made", () => {
  it("lists what a consumer on 1.0.0 must act on", () => {
    const breaks = breakingChangesSince("1.0.0");
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks.every((c) => c.impact !== "NONE")).toBe(true);
  });

  it("puts behaviour changes above source breaks", () => {
    // A source break stops the build and gets fixed. A behaviour change
    // compiles and quietly returns a different number, which is worse.
    const breaks = breakingChangesSince("1.0.0");
    const firstSourceBreak = breaks.findIndex((c) => c.impact === "SOURCE_BREAKING");
    const lastBehaviourChange = breaks.map((c) => c.impact).lastIndexOf("BEHAVIOUR_CHANGING");
    expect(lastBehaviourChange).toBeLessThan(firstSourceBreak);
  });

  it("gives every breaking change an action and a reason", () => {
    for (const change of SURFACE_CHANGES.filter((c) => c.impact !== "NONE")) {
      expect(change.action.length).toBeGreaterThan(0);
      expect(change.rationale.length).toBeGreaterThan(0);
    }
  });

  it("records that v1 entry points still work", () => {
    // Removing the old path on the day the new one ships forces everybody to
    // migrate on the engine's schedule, and rushed migrations are how the
    // silently-changed-number problem actually happens.
    const kept = SURFACE_CHANGES.find((c) => c.what.includes("v1 entry points"))!;
    expect(kept.impact).toBe("NONE");
    expect(kept.rationale).toContain("rushed migration");
  });

  it("returns nothing for a consumer already on the current version", () => {
    expect(breakingChangesSince(COSTIQ_API_VERSION)).toEqual([]);
  });
});

describe("certification, which can fail", () => {
  const report = certify();

  it("passes every gate as the engine currently stands", () => {
    const failed = report.gates.filter((g) => !g.passed);
    expect(failed.map((g) => `${g.id}: ${g.evidence}`)).toEqual([]);
    expect(report.certified).toBe(true);
  });

  it("gives each gate real evidence rather than a bare boolean", () => {
    for (const gate of report.gates) {
      expect(gate.evidence.length).toBeGreaterThan(0);
      expect(gate.question.endsWith("?")).toBe(true);
    }
  });

  it("carries a remedy on failure and none on success", () => {
    for (const gate of report.gates) {
      if (gate.passed) expect(gate.remedy).toBeNull();
      else expect(gate.remedy).not.toBeNull();
    }
  });

  it("says in the summary that it does NOT certify the costing is correct", () => {
    // The claim this module most needs to avoid making.
    expect(report.summary).toContain("does not say the costing is correct");
  });

  it("states what it deliberately does not cover", () => {
    const notCovered = report.outOfScopeOfThisCertification.join(" ");
    expect(notCovered).toContain("Whether the arithmetic is correct");
    expect(notCovered).toContain("A clock port wired to a fixed date would pass every gate");
    expect(report.outOfScopeOfThisCertification.length).toBeGreaterThanOrEqual(4);
  });

  it("is pure — two runs produce the same report", () => {
    // A certification that reads a clock or a database would only run where
    // the infrastructure is, which is not where the mistakes get made.
    expect(certify()).toEqual(certify());
  });

  it("checks the gates that actually found problems", () => {
    // Contract completeness caught two unenforced charter exclusions, and the
    // budget gate caught figures that had not been measured on this machine.
    // Both are named here so a later refactor cannot quietly drop them.
    const ids = report.gates.map((g) => g.id);
    expect(ids).toContain("contracts.complete");
    expect(ids).toContain("performance.budgets_are_evidenced");
  });

  // ── Each gate proved capable of failing ─────────────────────────────────
  //
  // Without these, a mutation replacing any `passed:` expression with `true`
  // survives, because every other test only asserts the gates pass. Five such
  // mutations did survive the first run against this file.

  const broken = (over: Partial<CertificationSources>): CertificationSources => ({ ...SHIPPED_SOURCES, ...over });

  it("FAILS when an event type has no consequence contract", () => {
    const contracts = { ...SHIPPED_SOURCES.consequenceContracts } as Record<string, { doesNotEntitle: readonly string[] }>;
    delete contracts["costiq.variance.detected"];
    const result = certify(broken({ consequenceContracts: contracts }));
    expect(result.certified).toBe(false);
    expect(result.gates.find((g) => g.id === "contracts.complete")!.passed).toBe(false);
  });

  it("FAILS when an event states no prohibition", () => {
    const result = certify(
      broken({
        consequenceContracts: { ...SHIPPED_SOURCES.consequenceContracts, "costiq.variance.detected": { doesNotEntitle: [] } },
      }),
    );
    const gate = result.gates.find((g) => g.id === "events.state_their_limits")!;
    expect(gate.passed).toBe(false);
    expect(gate.evidence).toContain("costiq.variance.detected");
    expect(gate.remedy).toContain("wrong inference from an event is silent");
  });

  it("FAILS when an exclusion does not record how the boundary gets crossed", () => {
    const result = certify(broken({ exclusions: [{ id: "ledger", arrivesAs: "   " }] }));
    const gate = result.gates.find((g) => g.id === "charter.records_how_it_gets_crossed")!;
    expect(gate.passed).toBe(false);
    expect(gate.remedy).toContain("crossed by good ideas that belong somewhere else");
  });

  it("FAILS when a budget was never measured", () => {
    const result = certify(
      broken({ budgets: [{ operation: "made.up", atSize: 1, budgetMs: 1000, measuredMs: 0, measuredOn: "" }] }),
    );
    const gate = result.gates.find((g) => g.id === "performance.budgets_are_evidenced")!;
    expect(gate.passed).toBe(false);
    expect(gate.remedy).toContain("a number somebody invented");
  });

  it("FAILS when a budget sits below what was measured", () => {
    // A budget already exceeded on the machine it was set on is not a budget.
    const result = certify(
      broken({ budgets: [{ operation: "tight", atSize: 1, budgetMs: 10, measuredMs: 50, measuredOn: "here" }] }),
    );
    expect(result.gates.find((g) => g.id === "performance.budgets_are_evidenced")!.passed).toBe(false);
  });

  it("FAILS when a breaking change has no action or no reason", () => {
    const result = certify(
      broken({
        surfaceChanges: [{ what: "everything moved", impact: "BEHAVIOUR_CHANGING", action: "", rationale: "because" }],
      }),
    );
    const gate = result.gates.find((g) => g.id === "compatibility.breaks_are_documented")!;
    expect(gate.passed).toBe(false);
    expect(gate.remedy).toContain("invites a workaround");
  });

  it("does not fail a non-breaking change for having no action", () => {
    // "Nothing to do" is a legitimate action for an impact of NONE, and
    // requiring text there would teach people to write filler.
    const result = certify(
      broken({ surfaceChanges: [{ what: "v1 kept", impact: "NONE", action: "", rationale: "" }] }),
    );
    expect(result.gates.find((g) => g.id === "compatibility.breaks_are_documented")!.passed).toBe(true);
  });

  it("refuses to certify when ANY gate fails", () => {
    const result = certify(broken({ exclusions: [{ id: "x", arrivesAs: "" }] }));
    expect(result.certified).toBe(false);
    expect(result.summary).toContain("gates failed");
  });

  it("formats to something readable in a build log", () => {
    const text = formatCertification(report);
    expect(text).toContain("[PASS] contracts.complete");
    expect(text).toContain("Not covered by this certification:");
    expect(text).toContain(`API ${COSTIQ_API_VERSION}`);
  });
});
