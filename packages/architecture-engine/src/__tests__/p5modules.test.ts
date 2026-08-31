// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { PackageFacts } from "../chambers/conformance.js";
import { architectureEngineRuntime } from "../chambers/goldenReference.js";
import {
  buildDependencyGraph,
  findCycles,
  findDependencyViolations,
} from "../modules/dependencyAssurance.js";
import { compareContracts, type ContractShape } from "../modules/contractCompatibility.js";
import { collectPackages } from "../modules/collector.js";

const REPO_PACKAGES = join(__dirname, "..", "..", "..");

const pkg = (name: string, deps: string[]): PackageFacts => ({
  packageName: name,
  dependencies: deps,
});

describe("DependencyAssuranceIQ", () => {
  it("includes external packages as nodes, so the suite is not shown as more self-contained than it is", () => {
    const graph = buildDependencyGraph([pkg("a", ["zod"])]);
    expect(graph.nodes).toContain("zod");
  });

  it("classifies an undeclared dependency as PROVIDER rather than REQUIRED", () => {
    // PROVIDER says "replaceable bridge to something outside", which is true
    // of an npm package. Calling it REQUIRED would assert a coupling stronger
    // than the evidence supports.
    const graph = buildDependencyGraph([pkg("a", ["zod"])]);
    expect(graph.edges[0]?.dependencyClass).toBe("PROVIDER");
  });

  it("returns the actual ring of a cycle, not a boolean", () => {
    const cycles = findCycles(buildDependencyGraph([pkg("a", ["b"]), pkg("b", ["c"]), pkg("c", ["a"])]));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b", "c", "a"]);
  });

  it("finds no cycle in an acyclic graph", () => {
    expect(findCycles(buildDependencyGraph([pkg("a", ["b"]), pkg("b", ["c"])]))).toEqual([]);
  });

  it("survives a deep chain without recursing off the stack", () => {
    // An assurance tool that crashes on a large repository is one that gets
    // switched off, so the traversal is iterative.
    const deep = Array.from({ length: 5000 }, (_, i) => pkg(`p${i}`, [`p${i + 1}`]));
    expect(() => findCycles(buildDependencyGraph(deep))).not.toThrow();
    expect(findCycles(buildDependencyGraph(deep))).toEqual([]);
  });

  it("reports a dependency the collaboration contract never mentions", () => {
    const violations = findDependencyViolations([
      { ...pkg("a", ["@proworks-hub/eventiq"]), participant: architectureEngineRuntime },
    ]);
    expect(violations.map((v) => v.kind)).toContain("UNDECLARED_REQUIRED");
  });

  it("reports a promised relationship the package does not have", () => {
    // Harmless today and misleading forever: usually a dependency removed
    // while the contract was left behind.
    const withPromise: PackageFacts = {
      ...pkg("a", []),
      participant: {
        ...architectureEngineRuntime,
        collaboration: {
          ...architectureEngineRuntime.collaboration,
          requires: [
            {
              dependencyId: "@proworks-hub/gone",
              dependencyClass: "DEGRADABLE",
              whenUnavailable: "continues without it",
            },
          ],
        },
      },
    };
    expect(findDependencyViolations([withPromise]).map((v) => v.kind)).toContain("DECLARED_BUT_ABSENT");
  });

  it("finds no cycles in the real workspace", () => {
    expect(findCycles(buildDependencyGraph(collectPackages(REPO_PACKAGES)))).toEqual([]);
  });
});

describe("ContractCompatibilityIQ", () => {
  const base: ContractShape = {
    contractId: "manufacturing.package",
    version: "1.0.0",
    fields: [
      { name: "id", type: "string", required: true },
      { name: "note", type: "string", required: false },
    ],
    enums: { status: ["DRAFT", "FINAL"] },
  };
  const at = (over: Partial<ContractShape>): ContractShape => ({ ...base, version: "2.0.0", ...over });

  it("calls an unchanged contract fully compatible", () => {
    expect(compareContracts(base, at({})).classification).toBe("FULLY_COMPATIBLE");
  });

  it("treats a new required field as forward compatible, so writers deploy first", () => {
    // Worth spelling out, because the first instinct is the wrong one. A NEW
    // reader cannot read OLD data that lacks the field — so backward
    // compatibility is broken and readers must go LAST, not first. An OLD
    // reader ignores the extra field, so forward compatibility holds, and the
    // writer can safely go first.
    const result = compareContracts(
      base,
      at({ fields: [...base.fields, { name: "owner", type: "string", required: true }] }),
    );
    expect(result.classification).toBe("FORWARD_COMPATIBLE");
    expect(result.deploymentGuidance).toContain("writers before readers");
  });

  it("treats enum widening as forward INcompatible, against instinct", () => {
    // The case most often got wrong. Adding a value feels additive and safe;
    // an old reader with no branch for the new member breaks on it.
    const result = compareContracts(base, at({ enums: { status: ["DRAFT", "FINAL", "VOID"] } }));
    expect(result.changes.some((c) => c.kind === "ENUM_WIDENED")).toBe(true);
    expect(result.classification).toBe("BACKWARD_COMPATIBLE");
    expect(result.deploymentGuidance).toContain("readers before writers");
  });

  it("treats enum narrowing as the opposite direction", () => {
    const result = compareContracts(base, at({ enums: { status: ["DRAFT"] } }));
    expect(result.classification).toBe("FORWARD_COMPATIBLE");
    expect(result.deploymentGuidance).toContain("writers before readers");
  });

  it("calls a type change BREAKING, since nothing bridges it by defaulting", () => {
    const result = compareContracts(
      base,
      at({ fields: [{ name: "id", type: "number", required: true }, base.fields[1]!] }),
    );
    expect(result.classification).toBe("BREAKING");
  });

  it("names the artifacts a breaking change requires, on the finding itself", () => {
    // So the requirement travels with the finding rather than living in a
    // document somebody has to remember to open.
    const result = compareContracts(
      base,
      at({ fields: [{ name: "id", type: "number", required: true }, base.fields[1]!] }),
    );
    expect(result.requiredArtifacts).toContain("ADR recording the decision");
    expect(result.requiredArtifacts).toContain("migration plan");
  });

  it("asks for an adapter when both directions break but no type changed", () => {
    const result = compareContracts(
      base,
      at({
        fields: [
          { name: "note", type: "string", required: true },
          { name: "extra", type: "string", required: true },
        ],
      }),
    );
    expect(result.classification).toBe("ADAPTER_REQUIRED");
  });

  it("requires no artifacts for a compatible change", () => {
    expect(compareContracts(base, at({})).requiredArtifacts).toEqual([]);
  });
});
