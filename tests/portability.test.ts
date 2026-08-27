import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Portability guard.
//
// The engine's independence is an architectural promise that is otherwise
// enforced only by convention — and conventions erode. These tests read the
// source and fail if host coupling appears, so a regression surfaces in CI
// rather than the day someone tries to move the engine.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sourceFiles = filesUnder(SRC).map((path) => ({
  path,
  relative: path.slice(SRC.length + 1).replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));

/** Import specifiers only — comments and prose are allowed to name hosts. */
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

describe("engine portability", () => {
  it("finds the engine source", () => {
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("never imports host application code", () => {
    // Host aliases from KSix and any future ProWorks/MakerOps host.
    const forbidden = [/^@\//, /^@shared\//, /^@assets\//, /^@forgeiq\//, /^@proworks\//, /^@makerops\//];
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const spec of importSpecifiers(file.text)) {
        if (forbidden.some((p) => p.test(spec))) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never reaches outside its own package", () => {
    const escapes: string[] = [];
    for (const file of sourceFiles) {
      for (const spec of importSpecifiers(file.text)) {
        if (!spec.startsWith(".")) continue;
        const depth = file.relative.split("/").length - 1;
        const up = (spec.match(/\.\.\//g) ?? []).length;
        if (up > depth) escapes.push(`${file.relative} → ${spec}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  it("keeps core pure: no express, drizzle, or react", () => {
    const banned = ["express", "drizzle-orm", "react", "react-dom", "@tanstack/react-query"];
    const offenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("core/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (banned.some((b) => spec === b || spec.startsWith(`${b}/`))) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the server layer free of React and the react layer free of server deps", () => {
    const serverOffenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("server/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec === "react" || spec.startsWith("react/") || spec.startsWith("@tanstack/")) {
          serverOffenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(serverOffenders).toEqual([]);

    const reactOffenders: string[] = [];
    for (const file of sourceFiles.filter((f) => f.relative.startsWith("react/"))) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec === "express" || spec === "drizzle-orm" || spec.startsWith("drizzle-orm/")) {
          reactOffenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(reactOffenders).toEqual([]);
  });

  it("contains no host-specific branching in the engine core", () => {
    // Guards against `if (host === "ksix")` creeping into portable code.
    const pattern = /\b(host|tenant|org|organization|client)\s*===\s*["'`](ksix|proworks|makerops)/i;
    const offenders = sourceFiles
      .filter((f) => pattern.test(f.text))
      .map((f) => f.relative);
    expect(offenders).toEqual([]);
  });

  it("declares only peer dependencies, so hosts own the runtime", () => {
    const pkg = JSON.parse(
      readFileSync(join(SRC, "..", "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys((pkg.peerDependencies ?? {}) as object).length).toBeGreaterThan(0);
  });

  it("keeps CostIQ and Prime free of any runtime dependency on ForgeIQ", () => {
    // The sibling engines may reference the shared contracts, but only as
    // types — `import type` is erased at compile time, so neither engine
    // pulls a line of ForgeIQ code into its bundle. That is what makes them
    // liftable on their own.
    const offenders: string[] = [];
    for (const file of sourceFiles.filter(
      (f) => f.relative.startsWith("costiq/") || f.relative.startsWith("prime/"),
    )) {
      // Value imports crossing out of the engine's own directory.
      const valueImports = [...file.text.matchAll(
        /(?:^|\n)\s*import\s+(?!type\b)([^;]*?)from\s+["'](\.\.\/[^"']+)["']/g,
      )];
      for (const match of valueImports) offenders.push(`${file.relative} → ${match[2]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps CostIQ and Prime out of ForgeIQ's private implementation", () => {
    // Even as types, the sibling engines may only touch the published
    // contract directories — never pricing, validation, schemas, or the UI.
    const allowed = /^\.\.\/core\/(manufacturing|cost|decision)\//;
    const offenders: string[] = [];
    for (const file of sourceFiles.filter(
      (f) => f.relative.startsWith("costiq/") || f.relative.startsWith("prime/"),
    )) {
      for (const spec of importSpecifiers(file.text)) {
        if (!spec.startsWith("..")) continue;
        if (!allowed.test(spec)) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exposes the suite contracts from the core barrel", () => {
    const barrel = sourceFiles.find((f) => f.relative === "core/index.ts")!.text;
    for (const contract of [
      "./manufacturing/manufacturingPlan",
      "./cost/costEngine",
      "./decision/decisionEngine",
    ]) {
      expect(barrel).toContain(contract);
    }
  });
});
