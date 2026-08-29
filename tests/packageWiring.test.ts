// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// A package must be wired into every list, or it is wired into none of them
// usefully.
//
// This test exists because the same bug happened three times. Adding a package
// requires touching six places — workspaces, the build script, the clean
// script, tsconfig paths, tsconfig references, and the vitest alias — and
// `resources-core`, `governance-engine` and `foundation-core` each ended up in
// some but not all. Nothing failed. `npm install --workspaces` silently skipped
// them, and the packages worked anyway because tsconfig paths resolved them, so
// the drift was invisible until somebody looked.
//
// `workspaces` is now `packages/*`, which cannot drift. The remaining five
// lists are still explicit — the build script needs an order, and tsconfig
// needs paths — so this test checks them instead of trusting the next person to
// remember.
// ─────────────────────────────────────────────────────────────────────────────

const root = process.cwd();
const packagesDir = join(root, "packages");

const onDisk = readdirSync(packagesDir)
  .filter((name) => statSync(join(packagesDir, name)).isDirectory())
  .filter((name) => existsSync(join(packagesDir, name, "package.json")))
  .sort();

const readText = (file: string): string => readFileSync(join(root, file), "utf8");
const rootPackage = JSON.parse(readText("package.json")) as {
  workspaces: string[];
  scripts: Record<string, string>;
};

const namesIn = (script: string): Set<string> =>
  new Set([...script.matchAll(/packages\/([a-z0-9-]+)/g)].map((m) => m[1]!));

describe("every package is wired into every list", () => {
  it("has at least the packages this suite is known to contain", () => {
    // A floor, so an empty or broken read fails loudly rather than passing
    // vacuously with zero packages to check.
    expect(onDisk.length).toBeGreaterThanOrEqual(24);
  });

  it("declares workspaces as a glob, not a hand-maintained list", () => {
    // The durable half of the fix. A list drifts; a glob cannot.
    expect(rootPackage.workspaces).toEqual(["packages/*"]);
  });

  it("builds every package on disk", () => {
    const missing = onDisk.filter((n) => !namesIn(rootPackage.scripts["build"]!).has(n));
    expect(missing, `not in the build script: ${missing.join(", ")}`).toEqual([]);
  });

  it("cleans exactly what it builds", () => {
    // Asymmetry here leaves stale build output that a later build silently
    // reuses — the kind of failure that reproduces on one machine only.
    const build = [...namesIn(rootPackage.scripts["build"]!)].sort();
    const clean = [...namesIn(rootPackage.scripts["clean"]!)].sort();
    expect(clean).toEqual(build);
  });

  it("gives every package a tsconfig path mapping", () => {
    // Checks the KEY, not the target. forgeiq and control-plane legitimately
    // point at src/core/index.ts rather than src/index.ts — an earlier version
    // of this test asserted the target and reported both as drift when the
    // repository was right and the test was wrong.
    const tsconfig = readText("tsconfig.json");
    const missing = onDisk.filter((n) => !tsconfig.includes(`"@proworks-hub/${n}":`));
    expect(missing, `no tsconfig path mapping: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every buildable package its own tsconfig", () => {
    // The root tsconfig has no `references` array — project references live in
    // each package's own tsconfig. Checking the root for them found all 24
    // "missing", which was the test misunderstanding the layout.
    const missing = onDisk.filter((n) => !existsSync(join(packagesDir, n, "tsconfig.json")));
    expect(missing, `no tsconfig: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every package a vitest alias", () => {
    // Without this a test importing the package resolves to the built dist —
    // or to nothing — and passes against stale code.
    const vitest = readText("vitest.config.ts");
    const missing = onDisk.filter((n) => !vitest.includes(`pkg("${n}"`));
    expect(missing, `no vitest alias: ${missing.join(", ")}`).toEqual([]);
  });

  it("gives every package a name matching its directory", () => {
    // A directory and package name that disagree make every other list in this
    // file ambiguous about which one it refers to.
    for (const name of onDisk) {
      const pkg = JSON.parse(
        readFileSync(join(packagesDir, name, "package.json"), "utf8"),
      ) as { name: string };
      expect(pkg.name, name).toBe(`@proworks-hub/${name}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One suite version, and internal dependencies that state it.
//
// Every package inside the suite used to depend on its siblings with `"*"`.
// That is harmless while the whole suite is published together — a consumer
// installing `prime@0.19.0` gets `contracts@latest`, which is also 0.19.0 — and
// it stops being harmless the moment ONE package is published alone. `"*"`
// means "whatever is newest", so a single hotfix to contracts would silently
// re-point every installed engine at it, across a boundary nobody declared.
//
// The suite ships as a coordinated release, so the honest range is the version
// the suite is on. `^0.19.0` rather than an exact pin: exact would force a
// lockstep republish of all 31 packages for any single fix, and atomicity
// already comes from publishing together — pinning exactly makes the boundary
// rigid without making it safer.
//
// These two tests are the enforcement. The first would have caught the `"*"`
// convention; the second catches the more likely future mistake, which is
// bumping the suite version and leaving the ranges behind.
// ─────────────────────────────────────────────────────────────────────────────

describe("the suite is one version, and says so in its own dependencies", () => {
  const manifests = onDisk.map((name) => ({
    name,
    json: JSON.parse(
      readFileSync(join(packagesDir, name, "package.json"), "utf8"),
    ) as {
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    },
  }));

  it("gives every package the same version", () => {
    // "What version is the Hive" needs an answer. Before this there were six
    // version lines across 31 packages and the question had none.
    const versions = [...new Set(manifests.map((m) => m.json.version))];
    expect(versions).toHaveLength(1);
  });

  it("never depends on a sibling with a wildcard", () => {
    // `"*"` resolves to whatever is newest, which is a dependency on time
    // rather than on a version.
    const wildcards: string[] = [];
    for (const { name, json } of manifests) {
      for (const field of ["dependencies", "peerDependencies"] as const) {
        for (const [dep, range] of Object.entries(json[field] ?? {})) {
          if (dep.startsWith("@proworks-hub/") && (range === "*" || range === "latest")) {
            wildcards.push(`${name} -> ${dep}: ${range}`);
          }
        }
      }
    }
    expect(wildcards).toEqual([]);
  });

  it("states the suite version in every internal range", () => {
    // The failure this catches: somebody bumps the suite to 0.20.0 and leaves
    // the ranges at ^0.19.0. Nothing breaks locally — the workspace resolves
    // siblings by path — and the mistake ships, so a published 0.20.0 package
    // declares it works with 0.19.0 engines it was never built against.
    const wrong: string[] = [];
    for (const { name, json } of manifests) {
      const expectedRange = `^${json.version}`;
      for (const field of ["dependencies", "peerDependencies"] as const) {
        for (const [dep, range] of Object.entries(json[field] ?? {})) {
          if (dep.startsWith("@proworks-hub/") && range !== expectedRange) {
            wrong.push(`${name} -> ${dep}: ${range} (expected ${expectedRange})`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
