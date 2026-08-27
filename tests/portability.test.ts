// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Portability guard.
//
// The suite's independence is an architectural promise otherwise enforced only
// by convention — and conventions erode. These tests read the source and fail
// if host coupling appears, so a regression surfaces in CI rather than the day
// someone tries to move an engine.
//
// The rule is about DIRECTION, not distance: the engines may depend on the
// shared contracts and on each other's published entry points, but nothing in
// this repository may depend on KSix, ProWorks, or MakerOps.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");

/** Published entry points the engines may import from one another. */
const SUITE_PACKAGES = /^@proworks-hub\/(contracts|forgeiq|costiq|prime|receiptiq)(\/|$)/;

/** Host applications. Nothing here may import from them, ever. */
const HOST_IMPORTS = [
  /^@\//, // KSix client alias
  /^@shared\//, // KSix shared alias
  /^@assets\//,
  /^@ksix\//,
  /^@prowork-hub\//,
  /^@makerops\//,
];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = filesUnder(PACKAGES).map((path) => ({
  path,
  relative: path.slice(PACKAGES.length + 1).replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));

/** Import specifiers only — comments and prose may name hosts freely. */
function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const pkgJson = (name: string) =>
  JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as {
    name: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

describe("engine suite portability", () => {
  it("finds the packages", () => {
    expect(sourceFiles.length).toBeGreaterThan(40);
  });

  it("never imports host application code", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const spec of importSpecifiers(file.text)) {
        if (HOST_IMPORTS.some((p) => p.test(spec))) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no host-specific branching", () => {
    const pattern =
      /\b(host|tenant|org|organization|client)\s*===\s*["'`](ksix|proworks|prowork|makerops)/i;
    expect(sourceFiles.filter((f) => pattern.test(f.text)).map((f) => f.relative)).toEqual([]);
  });

  it("keeps contracts dependent on nothing but zod", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("contracts/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith(".") || spec === "zod") continue;
        offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(pkgJson("contracts").dependencies ?? {})).toEqual(["zod"]);
  });

  it("keeps CostIQ and Prime independent of ForgeIQ", () => {
    // They may consume the shared contracts, but must never reach into the
    // engine that happens to produce them — another producer could.
    const offenders: string[] = [];
    for (const file of sourceFiles.filter(
      (f) =>
        f.relative.startsWith("costiq/") ||
        f.relative.startsWith("prime/") ||
        f.relative.startsWith("receiptiq/"),
    )) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith("@proworks-hub/forgeiq")) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const name of ["costiq", "prime", "receiptiq"]) {
      expect(Object.keys(pkgJson(name).dependencies ?? {})).not.toContain("@proworks-hub/forgeiq");
    }
  });

  it("keeps ForgeIQ core pure: no express, drizzle, or react", () => {
    const banned = ["express", "drizzle-orm", "react", "react-dom", "@tanstack/react-query"];
    const offenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("forgeiq/src/core/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (banned.some((b) => spec === b || spec.startsWith(`${b}/`))) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps ForgeIQ's server layer free of React and its react layer free of server deps", () => {
    const serverOffenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("forgeiq/src/server/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec === "react" || spec.startsWith("react/") || spec.startsWith("@tanstack/")) {
          serverOffenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(serverOffenders).toEqual([]);

    const reactOffenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("forgeiq/src/react/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec === "express" || spec === "drizzle-orm" || spec.startsWith("drizzle-orm/")) {
          reactOffenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(reactOffenders).toEqual([]);
  });

  it("declares only suite packages and zod as runtime dependencies", () => {
    // A host framework appearing here would make the engine un-liftable; the
    // host-facing layers declare theirs as optional peers instead.
    for (const name of ["contracts", "forgeiq", "costiq", "prime", "receiptiq"]) {
      for (const dep of Object.keys(pkgJson(name).dependencies ?? {})) {
        expect(dep === "zod" || SUITE_PACKAGES.test(dep)).toBe(true);
      }
    }
    expect(Object.keys(pkgJson("forgeiq").peerDependencies ?? {}).sort()).toEqual([
      "@tanstack/react-query",
      "drizzle-orm",
      "express",
      "react",
    ]);
  });
});
