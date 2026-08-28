// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CORE_ADMISSION_TEST,
  HIVE_MAP,
  checkDependency,
  componentsInCore,
  findOwnershipConflicts,
  hiveComponentSchema,
  hiveCoreSchema,
  summariseBuildStatus,
  type HiveComponent,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// Guarding the hierarchy.
//
// An architecture that lives only in a document is one that drifts the first
// time somebody is in a hurry. These tests are the enforcement — and they are
// deliberately about the SHAPE of the system rather than its behaviour, because
// the failures they catch do not surface as broken tests elsewhere. They
// surface eighteen months later as a Prime nobody can change.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(__dirname, "..");
const PACKAGES = join(ROOT, "packages");

const packageNames = readdirSync(PACKAGES).filter((name) =>
  statSync(join(PACKAGES, name)).isDirectory(),
);

const packageJson = (name: string): { name: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as never;

const byPackage = new Map(
  HIVE_MAP.filter((entry) => entry.packageName).map((entry) => [entry.packageName!, entry]),
);

describe("the map describes the repository that exists", () => {
  it("lists every package that is actually here", () => {
    // A package missing from the map is a component nobody has placed in the
    // hierarchy, which is how an unowned engine appears.
    const mapped = new Set([...byPackage.keys()]);
    const missing = packageNames.filter((name) => !mapped.has(`@proworks-hub/${name}`));
    expect(missing).toEqual([]);
  });

  it("does not claim a package exists when it does not", () => {
    // The opposite failure, and the more dangerous one: a map that promises
    // something built.
    const present = new Set(packageNames.map((name) => `@proworks-hub/${name}`));
    const phantom = HIVE_MAP.filter(
      (entry) => entry.status === "existing" && entry.packageName && !present.has(entry.packageName),
    );
    expect(phantom.map((entry) => entry.name)).toEqual([]);
  });

  it("marks anything unbuilt as planned or conceptual, never existing", () => {
    for (const entry of HIVE_MAP) {
      if (entry.status !== "existing") continue;
      // Every `existing` entry must have a package, or it is a claim with
      // nothing behind it.
      expect(entry.packageName, `${entry.name} claims to exist`).toBeTruthy();
    }
  });

  it("requires a partial component to say what is missing", () => {
    // A partial with no stated gap reads on a diagram exactly like a finished
    // one, which is the whole failure this field exists to prevent.
    expect(() =>
      hiveComponentSchema.parse({
        id: "x", name: "X", tier: "core", core: "finance", status: "partial",
        responsibility: "Something.",
      }),
    ).toThrow();
  });
});

describe("ownership", () => {
  it("gives every component exactly one Core", () => {
    // Shared ownership is how a capability gets implemented twice, with the two
    // copies disagreeing and nobody able to say which is authoritative.
    expect(findOwnershipConflicts(HIVE_MAP)).toEqual([]);
  });

  it("refuses a specialized engine with no Core", () => {
    expect(() =>
      hiveComponentSchema.parse({
        id: "orphan", name: "Orphan", tier: "specialized", status: "planned",
        responsibility: "Nobody owns this.",
      }),
    ).toThrow();
  });

  it("lets Prime and platform components sit outside a Core", () => {
    // Prime is not in a domain; the bus is not in a domain. Forcing them into
    // one would make the taxonomy lie to look tidy.
    expect(() =>
      hiveComponentSchema.parse({
        id: "prime", name: "Prime", tier: "prime", status: "existing",
        responsibility: "Coordinates.",
      }),
    ).not.toThrow();
  });

  it("keeps exactly one Prime", () => {
    expect(HIVE_MAP.filter((entry) => entry.tier === "prime")).toHaveLength(1);
  });

  it("has a Core component for each of the eight domains", () => {
    for (const core of hiveCoreSchema.options) {
      const coordinator = HIVE_MAP.find((entry) => entry.tier === "core" && entry.core === core);
      expect(coordinator, `no coordinator for ${core}`).toBeDefined();
    }
  });
});

describe("dependencies run downward", () => {
  const find = (id: string): HiveComponent => HIVE_MAP.find((entry) => entry.id === id)!;

  it("stops even Prime from importing a Core", () => {
    // Prime COORDINATES the Cores; it does not import them. A Prime that
    // imported eight Cores could not be tested without all eight, and would
    // pull the entire system into anything that touched it. The relationship is
    // real and travels through ports.
    expect(checkDependency(find("prime"), find("finance-core"))).not.toBeNull();
  });

  it("refuses a specialized engine depending on Prime", () => {
    // An engine that imports the orchestrator cannot be used without it, which
    // is the end of portability.
    expect(checkDependency(find("costiq"), find("prime"))).not.toBeNull();
  });

  it("refuses a specialized engine depending on its Core", () => {
    // It could then never be reused under a different one.
    expect(checkDependency(find("costiq"), find("finance-core"))).not.toBeNull();
  });

  it("refuses two Cores depending on each other", () => {
    const violation = checkDependency(find("finance-core"), find("operations-core"));
    expect(violation?.reason).toContain("peers must communicate through events");
  });

  it("refuses a specialized engine reaching into another domain", () => {
    // The subtle version: it compiles, and it welds two domains together where
    // a contract should have been.
    const violation = checkDependency(find("costiq"), find("workorderiq"));
    expect(violation?.reason).toContain("Cross-domain work goes through Prime");
  });

  it("refuses two engines importing each other even within one Core", () => {
    // Stricter than the tier table alone, and matching the portability guard
    // that already forbids any suite package importing another. Same-domain
    // engines still talk through events — the shared Core is a coordinator,
    // not a licence to couple.
    const violation = checkDependency(find("costiq"), find("receiptiq"));
    expect(violation?.reason).toContain("peers must communicate through events");
  });

  it("keeps an industry engine off its specialists too", () => {
    // Composition happens through registration, not imports — otherwise a
    // manufacturing pack drags costing into every bundle that renders a sign.
    expect(checkDependency(find("forgeiq"), find("costiq"))).not.toBeNull();
  });

  it("lets everything depend on the platform", () => {
    expect(checkDependency(find("costiq"), find("contracts"))).toBeNull();
    expect(checkDependency(find("finance-core"), find("platform-events"))).toBeNull();
  });

  it("keeps everything off the platform's back", () => {
    // Platform depends on nothing. Anything it imported would become required
    // infrastructure for the bus.
    expect(checkDependency(find("contracts"), find("prime"))).not.toBeNull();
  });
});

describe("the rules hold in the actual package manifests", () => {
  it("keeps Prime free of every specialized engine", () => {
    // Rule 2, checked against reality rather than intention. Prime accumulating
    // engine imports is the precise failure the hierarchy exists to prevent.
    const dependencies = Object.keys(packageJson("prime").dependencies ?? {});
    const specialized = dependencies.filter((dependency) => {
      const entry = byPackage.get(dependency);
      return entry?.tier === "specialized" || entry?.tier === "industry";
    });
    expect(specialized).toEqual([]);
  });

  it("lets no engine depend on the control plane", () => {
    // Rule 12 and the console's own hard requirement: if the Hive is offline,
    // every engine keeps working.
    for (const name of packageNames) {
      if (name === "control-plane") continue;
      const dependencies = Object.keys(packageJson(name).dependencies ?? {});
      expect(dependencies, name).not.toContain("@proworks-hub/control-plane");
    }
  });

  it("lets no engine depend on a host application", () => {
    // Rule 5. Hosts consume engines; they do not own them.
    for (const name of packageNames) {
      const declared = JSON.stringify(packageJson(name).dependencies ?? {});
      for (const host of ["prowork-hub", "ksix", "makerops", "family-table"]) {
        expect(declared.toLowerCase(), `${name} depends on ${host}`).not.toContain(host);
      }
    }
  });

  it("finds no cross-domain import between specialized engines", () => {
    for (const name of packageNames) {
      const entry = byPackage.get(`@proworks-hub/${name}`);
      if (entry?.tier !== "specialized") continue;

      for (const dependency of Object.keys(packageJson(name).dependencies ?? {})) {
        const target = byPackage.get(dependency);
        if (target?.tier !== "specialized") continue;
        expect(
          target.core,
          `${entry.name} (${entry.core}) imports ${target.name} (${target.core})`,
        ).toBe(entry.core);
      }
    }
  });
});

describe("the Core layer stays small", () => {
  it("has exactly eight Cores", () => {
    // The value of the layer comes entirely from this number staying small.
    // Every addition costs Prime a domain it must understand.
    expect(hiveCoreSchema.options).toHaveLength(8);
  });

  it("keeps the admission test available to quote", () => {
    // Remembered approximately, this bar erodes. Quoted verbatim in a review,
    // it does not.
    expect(CORE_ADMISSION_TEST).toHaveLength(5);
    expect(CORE_ADMISSION_TEST[0]).toContain("universal across most industries");
  });

  it("puts more than one specialist under most Cores", () => {
    // A Core with one engine beneath it is a wrapper, not a domain. Two are
    // legitimately thin today and are marked partial rather than pretended
    // otherwise.
    const populated = hiveCoreSchema.options.filter(
      (core) => componentsInCore(core).filter((entry) => entry.tier !== "core").length > 1,
    );
    expect(populated.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the map is honest about how much exists", () => {
  it("reports far more unbuilt than built, and says so", () => {
    const counts = summariseBuildStatus(HIVE_MAP);
    // Not an assertion about ambition — an assertion that the distinction is
    // being recorded at all. A map where everything reads `existing` is a map
    // nobody maintained.
    expect(counts.existing).toBeGreaterThan(0);
    expect(counts.planned + counts.conceptual + counts.partial).toBeGreaterThan(0);
  });

  it("does not describe the AI runtime as complete", () => {
    // No vendor adapter is configured. Calling this `existing` would tell a
    // reader the engines can reason, which they cannot yet.
    const runtime = HIVE_MAP.find((entry) => entry.id === "model-runtime")!;
    expect(runtime.status).toBe("partial");
    expect(runtime.gap).toContain("No real vendor adapter");
  });

  it("does not describe privacy-preserving generalized learning as solved", () => {
    // §35 rules this out explicitly, and it is the claim most tempting to make
    // because the boundary types exist.
    const senseiq = HIVE_MAP.find((entry) => entry.id === "senseiq")!;
    expect(senseiq.status).toBe("partial");
  });
});
