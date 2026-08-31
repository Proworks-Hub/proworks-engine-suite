// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { join } from "node:path";

import { blocksBuild, summarize, type ConformanceFinding } from "@proworks-hub/hive-runtime";
import { describe, expect, it } from "vitest";

import { evaluateConformance, type ArchitectureWorld } from "../chambers/conformance.js";
import { architectureEngineRuntime, goldenReferenceRuntime } from "../chambers/goldenReference.js";
import { collectPackages } from "../modules/collector.js";
import { ARCHITECTURE_RULES } from "../rules.js";

const AT = "2026-08-31T00:00:00.000Z";
const REPO_PACKAGES = join(__dirname, "..", "..", "..");

const worldOf = (over: Partial<ArchitectureWorld>): ArchitectureWorld => ({
  packages: [],
  adopted: [],
  observedAt: AT,
  ...over,
});

const of = (findings: readonly ConformanceFinding[], ruleId: string, subjectId: string) =>
  findings.find((f) => f.ruleId === ruleId && f.subjectId === subjectId);

describe("the rule catalog", () => {
  it("gives every rule a stable ARCH id and a traceability source", () => {
    for (const rule of ARCHITECTURE_RULES) {
      expect(rule.id).toMatch(/^ARCH-[A-Z0-9.-]+$/);
      expect(rule.source).toMatch(/^(TR-\d+|ADR|§)/);
    }
  });

  it("has no duplicate rule ids, since findings resolve through them", () => {
    const ids = ARCHITECTURE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("dependency rules, which apply to every package from the first run", () => {
  it("fails a package that depends on the Control Center", () => {
    const findings = evaluateConformance(
      worldOf({
        packages: [{ packageName: "@proworks-hub/costiq", dependencies: ["@proworks-hub/control-plane"] }],
      }),
    );
    const f = of(findings, "ARCH-DEP-NO-CONTROL-CENTER", "@proworks-hub/costiq");
    expect(f?.status).toBe("FAIL");
    expect(f?.facts.join()).toContain("control-plane");
    expect(blocksBuild(findings)).toBe(true);
  });

  it("does not fail the Control Center for being itself", () => {
    const findings = evaluateConformance(
      worldOf({
        packages: [
          { packageName: "@proworks-hub/control-plane", dependencies: ["@proworks-hub/control-plane"] },
        ],
      }),
    );
    expect(of(findings, "ARCH-DEP-NO-CONTROL-CENTER", "@proworks-hub/control-plane")?.status).toBe("PASS");
  });

  it("fails a package that takes the Architecture Engine as a dependency", () => {
    // The self-test. An assurance system that engines must import in order to
    // run has stopped being assurance and become infrastructure.
    const findings = evaluateConformance(
      worldOf({
        packages: [
          { packageName: "@proworks-hub/forgeiq", dependencies: ["@proworks-hub/architecture-engine"] },
        ],
      }),
    );
    expect(of(findings, "ARCH-DEP-ENGINE-ISOLATION", "@proworks-hub/forgeiq")?.status).toBe("FAIL");
  });
});

describe("scope, and the difference between not-applicable and unknown", () => {
  const unadopted = worldOf({
    packages: [{ packageName: "@proworks-hub/legacy", dependencies: [] }],
  });

  it("reports an unadopted package as NOT_APPLICABLE, never as PASS", () => {
    // Marking it PASS would certify a component nobody checked, which is the
    // failure this whole program exists to prevent.
    const f = of(evaluateConformance(unadopted), "ARCH-RUNTIME-METADATA", "@proworks-hub/legacy");
    expect(f?.status).toBe("NOT_APPLICABLE");
    expect(f?.status).not.toBe("PASS");
  });

  it("says who put it out of scope, so NOT_APPLICABLE is a decision and not a label", () => {
    const f = of(evaluateConformance(unadopted), "ARCH-RUNTIME-METADATA", "@proworks-hub/legacy");
    expect(f?.facts.join(" ")).toContain("adoption register");
  });

  it("FAILS a package that claims adoption but produces no declaration", () => {
    // Different from unadopted in the way that matters: somebody asserted this
    // package had adopted the standard, and the artifact is not there.
    const findings = evaluateConformance(
      worldOf({
        packages: [{ packageName: "@proworks-hub/claims", dependencies: [] }],
        adopted: ["@proworks-hub/claims"],
      }),
    );
    expect(of(findings, "ARCH-RUNTIME-METADATA", "@proworks-hub/claims")?.status).toBe("FAIL");
  });
});

describe("governance-first, checked against the declaration", () => {
  const withCapability = (requiresAuthorization: boolean) =>
    evaluateConformance(
      worldOf({
        packages: [
          {
            packageName: "@proworks-hub/x",
            dependencies: [],
            participant: {
              ...goldenReferenceRuntime,
              collaboration: {
                ...goldenReferenceRuntime.collaboration,
                offers: [
                  {
                    capabilityId: "x.pay",
                    version: "1.0.0",
                    purpose: "Move money.",
                    requiresAuthorization,
                    dataClasses: ["CONFIDENTIAL"],
                    determinism: "DETERMINISTIC",
                    sideEffect: "FINANCIAL_CONSEQUENCE",
                    idempotent: true,
                  },
                ],
              },
            },
          },
        ],
        adopted: ["@proworks-hub/x"],
      }),
    );

  it("fails a consequential capability that requires no authorization", () => {
    const f = of(withCapability(false), "ARCH-GOV-FIRST", "@proworks-hub/x");
    expect(f?.status).toBe("FAIL");
    expect(f?.facts.join()).toContain("FINANCIAL_CONSEQUENCE");
  });

  it("passes once the same capability is protected", () => {
    expect(of(withCapability(true), "ARCH-GOV-FIRST", "@proworks-hub/x")?.status).toBe("PASS");
  });
});

describe("identity", () => {
  it("fails two packages that claim the same stable id", () => {
    const findings = evaluateConformance(
      worldOf({
        packages: [
          { packageName: "@proworks-hub/a", dependencies: [], participant: goldenReferenceRuntime },
          { packageName: "@proworks-hub/b", dependencies: [], participant: goldenReferenceRuntime },
        ],
        adopted: ["@proworks-hub/a", "@proworks-hub/b"],
      }),
    );
    const f = of(findings, "ARCH-ID-UNIQUE", goldenReferenceRuntime.identity.stableId);
    expect(f?.status).toBe("FAIL");
    expect(f?.facts.join()).toContain("2 packages");
  });

  it("fails an id that was retired and has been reissued", () => {
    const findings = evaluateConformance(
      worldOf({
        packages: [{ packageName: "@proworks-hub/a", dependencies: [], participant: goldenReferenceRuntime }],
        adopted: ["@proworks-hub/a"],
        retiredIds: [goldenReferenceRuntime.identity.stableId],
      }),
    );
    expect(of(findings, "ARCH-ID-NO-REUSE", goldenReferenceRuntime.identity.stableId)?.status).toBe("FAIL");
  });
});

describe("against the real repository", () => {
  // The point of the whole package. Everything above proves the evaluator
  // behaves; this proves the Hive currently satisfies the rules it declares.
  // The Architecture Engine is the first adopter, and evaluates itself through
  // the same chamber as everything else. A collector in a deployed Hive loads
  // each package's declaration; here the only one that exists is our own.
  const packages = collectPackages(REPO_PACKAGES).map((p) =>
    p.packageName === "@proworks-hub/architecture-engine"
      ? { ...p, participant: architectureEngineRuntime }
      : p,
  );
  const findings = evaluateConformance(
    worldOf({ packages, adopted: ["@proworks-hub/architecture-engine"] }),
  );

  it("finds every workspace package", () => {
    expect(packages.length).toBeGreaterThan(60);
  });

  it("passes every blocking architecture gate", () => {
    const blocking = findings.filter(
      (f) => f.status === "FAIL" && f.severity === "ENGINEERING_GATE" && f.waiverAdrId === null,
    );
    expect(
      blocking.map((f) => `${f.ruleId} ${f.subjectId}: ${f.facts.join("; ")}`),
    ).toEqual([]);
    expect(blocksBuild(findings)).toBe(false);
  });

  it("confirms no engine depends on the Control Center or the Architecture Engine", () => {
    for (const ruleId of ["ARCH-DEP-NO-CONTROL-CENTER", "ARCH-DEP-ENGINE-ISOLATION"] as const) {
      expect(findings.filter((f) => f.ruleId === ruleId && f.status === "FAIL")).toEqual([]);
    }
  });

  it("reports the adoption backlog honestly rather than as a pass", () => {
    // The number that should shrink over the P7 family migration. It must
    // never be zero by pretending, only by adopting.
    const counts = summarize(findings);
    expect(counts.NOT_APPLICABLE).toBeGreaterThan(0);
    expect(counts.UNKNOWN).toBe(0);
  });

  it("is deterministic, so two runs can be diffed", () => {
    const again = evaluateConformance(
      worldOf({ packages, adopted: ["@proworks-hub/architecture-engine"] }),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(findings));
  });
});
