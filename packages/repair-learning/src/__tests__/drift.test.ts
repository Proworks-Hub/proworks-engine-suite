// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  UNDETECTABLE_INVARIANTS,
  detectDrift,
  driftFindingAuthorizesArchitectureChange,
  proposeScenarioFrom,
  type ActualComponent,
  type DeclaredComponent,
  type DriftFinding,
} from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Drift detection (§32) and regression-scenario generation (§33).
// ─────────────────────────────────────────────────────────────────────────────

const declared = (over: Partial<DeclaredComponent> = {}): DeclaredComponent => ({
  componentId: "hive.specialized.workorderiq",
  charterId: "charter.specialized.workorderiq",
  ownsSourceOfTruthFor: ["work_order"],
  dependsOn: ["hive.platform.eventiq"],
  contracts: { "workorder.intake": "1.2" },
  requiresGovernance: true,
  tenantScoped: true,
  ...over,
});

const actual = (over: Partial<ActualComponent> = {}): ActualComponent => ({
  componentId: "hive.specialized.workorderiq",
  ownsSourceOfTruthFor: ["work_order"],
  dependsOn: ["hive.platform.eventiq"],
  contracts: { "workorder.intake": "1.2" },
  callsGovernance: true,
  enforcesTenantScope: true,
  namedProviders: [],
  ...over,
});

const report = (d: Partial<DeclaredComponent> = {}, a: Partial<ActualComponent> = {}) =>
  detectDrift({ declared: [declared(d)], actual: [actual(a)] });

const findingOf = (kind: string, d = {}, a = {}) =>
  report(d, a).findings.find((f) => f.kind === kind);

describe("a matching architecture drifts in nothing", () => {
  it("reports clean when declared and actual agree", () => {
    const result = report();
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.componentsCompared).toBe(1);
  });
});

describe("§32's named findings", () => {
  it("finds a missing Governance hook, and calls it critical", () => {
    // The exact shape of the `if (!permSvc) return` failure this architecture
    // was built to prevent: an authorization gate that exists on paper only.
    const finding = findingOf("MISSING_GOVERNANCE_HOOK", {}, { callsGovernance: false })!;
    expect(finding.severity).toBe("CRITICAL");
    expect(finding.detail).toContain("an unenforced requirement is not a requirement");
    expect(finding.scenarioWorthy).toBe(true);
  });

  it("finds a tenant boundary regression", () => {
    const finding = findingOf("TENANT_BOUNDARY_REGRESSION", {}, { enforcesTenantScope: false })!;
    expect(finding.severity).toBe("CRITICAL");
    expect(finding.detail).toContain("everything downstream assumes it");
  });

  it("finds a component that has seized another's source of truth", () => {
    const finding = findingOf(
      "SOURCE_OF_TRUTH_OWNER_CHANGED",
      {},
      { ownsSourceOfTruthFor: ["work_order", "invoice"] },
    )!;
    expect(finding.severity).toBe("CRITICAL");
    expect(finding.actual).toContain("invoice");
    expect(finding.detail).toContain("a disagreement waiting to be discovered by a customer");
  });

  it("finds a component that has abandoned what it owns", () => {
    // The other direction, and quieter: something else may have taken over, or
    // nothing owns it now.
    const finding = findingOf("SOURCE_OF_TRUTH_OWNER_CHANGED", {}, { ownsSourceOfTruthFor: [] })!;
    expect(finding.severity).toBe("HIGH");
    expect(finding.detail).toContain("nothing owns it now");
  });

  it("finds an undeclared dependency", () => {
    const finding = findingOf(
      "UNDECLARED_DEPENDENCY",
      {},
      { dependsOn: ["hive.platform.eventiq", "hive.specialized.costiq"] },
    )!;
    expect(finding.severity).toBe("HIGH");
    expect(finding.detail).toContain("nobody checked against the dependency law");
  });

  it("treats a removed dependency as informational", () => {
    // A dependency that went away is usually good news. The finding exists so
    // the map catches up, not to raise an alarm.
    const finding = findingOf("REMOVED_DECLARED_DEPENDENCY", {}, { dependsOn: [] })!;
    expect(finding.severity).toBe("INFO");
    expect(finding.scenarioWorthy).toBe(false);
  });

  it("grades contract drift by whether the major version moved", () => {
    const minor = findingOf("CONTRACT_DRIFT", {}, { contracts: { "workorder.intake": "1.7" } })!;
    expect(minor.severity).toBe("MEDIUM");
    expect(minor.scenarioWorthy).toBe(false);

    const major = findingOf("CONTRACT_DRIFT", {}, { contracts: { "workorder.intake": "3.0" } })!;
    expect(major.severity).toBe("HIGH");
    expect(major.scenarioWorthy).toBe(true);
    expect(major.detail).toContain("may already be broken");
  });

  it("finds provider coupling but does not call it a violation", () => {
    // Naming a provider is fine behind an adapter and a problem in domain
    // logic. The finding says "named", not "coupled to", and a human decides.
    const finding = findingOf("PROVIDER_HARD_COUPLING", {}, { namedProviders: ["kafka", "s3"] })!;
    expect(finding.severity).toBe("MEDIUM");
    expect(finding.actual).toContain("kafka");
    expect(finding.detail).toContain("fine behind an adapter");
  });

  it("ignores a provider that is not portability-sensitive", () => {
    expect(findingOf("PROVIDER_HARD_COUPLING", {}, { namedProviders: ["zod", "vitest"] })).toBeUndefined();
  });

  it("finds a component citing a charter the registry does not have", () => {
    const result = detectDrift({
      declared: [declared({ charterId: "charter.invented.thing" })],
      actual: [actual()],
      knownCharterIds: ["charter.specialized.workorderiq"],
    });
    const finding = result.findings.find((f) => f.kind === "UNCHARTERED_COMPONENT")!;
    expect(finding.detail).toContain("governed by a document nobody can find is ungoverned");
  });

  it("does not check charters when no registry was supplied", () => {
    // Absence of a registry is not evidence that a charter is missing.
    expect(
      detectDrift({ declared: [declared({ charterId: "charter.invented" })], actual: [actual()] }).findings,
    ).toEqual([]);
  });
});

describe("components that exist on one side only", () => {
  it("finds something running that nothing declared", () => {
    const result = detectDrift({
      declared: [],
      actual: [actual({ componentId: "hive.specialized.mystery" })],
    });
    const finding = result.findings[0]!;
    expect(finding.kind).toBe("UNDECLARED_COMPONENT");
    expect(finding.detail).toContain("nothing has said what it is");
    expect(result.unmatched).toContain("hive.specialized.mystery");
  });

  it("finds something declared that is not there", () => {
    const result = detectDrift({ declared: [declared()], actual: [] });
    expect(result.findings[0]!.kind).toBe("MISSING_DECLARED_COMPONENT");
    expect(result.componentsCompared).toBe(0);
  });
});

describe("it answers the two invariants the runtime detectors refused to fake", () => {
  it("covers PORTABILITY, which the runtime detectors declared out of reach", () => {
    // `UNDETECTABLE_INVARIANTS` says PORTABILITY needs dependency and import
    // analysis rather than runtime evidence, and points here. This is that.
    expect(UNDETECTABLE_INVARIANTS["HIVE-INV-PORTABILITY-001"]).toContain("drift detector");
    expect(findingOf("PROVIDER_HARD_COUPLING", {}, { namedProviders: ["openai"] })).toBeDefined();
  });

  it("covers CHARTER for the same reason", () => {
    expect(UNDETECTABLE_INVARIANTS["HIVE-INV-CHARTER-001"]).toContain("drift");
    const result = detectDrift({
      declared: [declared({ charterId: "charter.nope" })],
      actual: [actual()],
      knownCharterIds: ["charter.specialized.workorderiq"],
    });
    expect(result.findings.some((f) => f.kind === "UNCHARTERED_COMPONENT")).toBe(true);
  });
});

describe("a drift finding may become a regression scenario", () => {
  const scenarioWorthy = (): DriftFinding =>
    findingOf("MISSING_GOVERNANCE_HOOK", {}, { callsGovernance: false })!;

  it("proposes a scenario from a governance-hook regression", () => {
    const proposal = proposeScenarioFrom(scenarioWorthy(), { candidateId: "cand_1" });
    expect(proposal.proposed).toBe(true);
    if (!proposal.proposed) return;

    expect(proposal.scenario.invariantsAtRisk).toEqual(["HIVE-INV-AUTHORITY-001"]);
    expect(proposal.scenario.components).toEqual(["hive.specialized.workorderiq"]);
  });

  it("produces a PROPOSED candidate with no SIM- id", () => {
    // §34: external AI may propose, and the Hive decides whether a scenario
    // becomes trusted validation material. The same rule applies to an
    // internally-generated one, for the same reason.
    const proposal = proposeScenarioFrom(scenarioWorthy(), { candidateId: "cand_1" });
    if (!proposal.proposed) throw new Error("expected a proposal");
    expect(proposal.scenario.status).toBe("PROPOSED");
    expect(proposal.scenario.candidateId).not.toMatch(/^SIM-/);
  });

  it("carries no tenant data, timestamp or identifier", () => {
    // §33: minimize before publishing. The easiest way to comply is to have
    // nothing to minimize.
    const proposal = proposeScenarioFrom(scenarioWorthy(), { candidateId: "cand_1" });
    if (!proposal.proposed) throw new Error("expected a proposal");

    const text = JSON.stringify(proposal.scenario);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(text.toLowerCase()).not.toContain("ksix");
    expect(text).not.toMatch(/\bwo[_-][a-z0-9]+\b/i);
  });

  it("refuses to make a scenario out of a documentation fix", () => {
    // A corpus full of stale-manifest entries protects nothing and slows every
    // run.
    const informational = findingOf("REMOVED_DECLARED_DEPENDENCY", {}, { dependsOn: [] })!;
    const proposal = proposeScenarioFrom(informational, { candidateId: "cand_2" });
    expect(proposal.proposed).toBe(false);
    if (!proposal.proposed) expect(proposal.reason).toContain("protects nothing while slowing every run");
  });

  it("refuses when the finding maps to no invariant", () => {
    const orphan: DriftFinding = {
      findingId: "drift_x",
      kind: "UNDECLARED_COMPONENT",
      severity: "HIGH",
      componentId: "c",
      declared: "d",
      actual: "a",
      detail: "detail",
      // Forced true to reach the invariant check.
      scenarioWorthy: true,
    };
    const proposal = proposeScenarioFrom(orphan, { candidateId: "cand_3" });
    expect(proposal.proposed).toBe(false);
    if (!proposal.proposed) expect(proposal.reason).toContain("assert nothing in particular");
  });

  it("states the engine-failure condition as the drifted behaviour", () => {
    const proposal = proposeScenarioFrom(scenarioWorthy(), { candidateId: "cand_1" });
    if (!proposal.proposed) throw new Error("expected a proposal");
    expect(proposal.scenario.mustFailTheEngineIf).toContain("does not call Governance");
    expect(proposal.scenario.mustPass[0]).toContain("requiresGovernance: true");
  });
});

describe("finding drift confers no authority to resolve it", () => {
  it("never authorizes changing the architecture to match reality", () => {
    // The fastest way to clear a drift report is to update the declaration,
    // which converts every finding into a rubber stamp. Charter §9, one level
    // down: identifying a problem does not make you its architect.
    expect(driftFindingAuthorizesArchitectureChange(findingOf("MISSING_GOVERNANCE_HOOK", {}, { callsGovernance: false })!)).toBe(false);
  });
});

describe("a realistic multi-component sweep", () => {
  it("finds several kinds at once and counts what it compared", () => {
    const result = detectDrift({
      declared: [
        declared(),
        declared({
          componentId: "hive.specialized.costiq",
          charterId: "charter.specialized.costiq",
          ownsSourceOfTruthFor: ["cost_result"],
          dependsOn: [],
          contracts: { "cost.result": "2.0" },
        }),
      ],
      actual: [
        actual({ callsGovernance: false }),
        actual({
          componentId: "hive.specialized.costiq",
          ownsSourceOfTruthFor: ["cost_result"],
          dependsOn: ["hive.specialized.inventoryiq"],
          contracts: { "cost.result": "2.1" },
          namedProviders: ["redis"],
        }),
      ],
      knownCharterIds: ["charter.specialized.workorderiq", "charter.specialized.costiq"],
    });

    expect(result.componentsCompared).toBe(2);
    expect(result.clean).toBe(false);

    const kinds = new Set(result.findings.map((f) => f.kind));
    expect(kinds).toContain("MISSING_GOVERNANCE_HOOK");
    expect(kinds).toContain("UNDECLARED_DEPENDENCY");
    expect(kinds).toContain("CONTRACT_DRIFT");
    expect(kinds).toContain("PROVIDER_HARD_COUPLING");

    // Only the ones worth a permanent test become scenarios.
    const proposals = result.findings
      .map((f, i) => proposeScenarioFrom(f, { candidateId: `cand_${i}` }))
      .filter((p) => p.proposed);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.length).toBeLessThan(result.findings.length);
  });
});
