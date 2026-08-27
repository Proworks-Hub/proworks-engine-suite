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
const SUITE_PACKAGES = /^@proworks-hub\/(contracts|forgeiq|costiq|prime|receiptiq|platform-events|platform-runtime|workorder)(\/|$)/;

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
    // Tests import vitest; the shipped contract does not. The distinction that
    // matters is what a CONSUMER pulls in, and `files: ["dist"]` plus the
    // tsconfig exclude keep tests out of the published package entirely.
    const shipped = sourceFiles.filter(
      (f) =>
        f.relative.startsWith("contracts/") &&
        !f.relative.includes("__tests__/") &&
        !f.relative.includes("/tests/"),
    );
    for (const file of shipped) {
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
        f.relative.startsWith("receiptiq/") ||
        f.relative.startsWith("workorder/"),
    )) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith("@proworks-hub/forgeiq")) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const name of ["costiq", "prime", "receiptiq", "workorder", "platform-events", "platform-runtime"]) {
      expect(Object.keys(pkgJson(name).dependencies ?? {})).not.toContain("@proworks-hub/forgeiq");
    }
  });

  it("keeps the engines depending on the port, never on an adapter", () => {
    // The engines publish through the EventBus PORT, which lives in contracts.
    // platform-events is one implementation of it. An engine that depended on
    // the implementation could no longer be lifted out without the in-memory
    // bus coming too — which is the exact coupling the bus was added to remove.
    //
    // A host wires the adapter in. An engine must never reach for it.
    const ENGINES = ["forgeiq", "costiq", "prime", "receiptiq", "workorder"];
    for (const name of ENGINES) {
      const deps = Object.keys(pkgJson(name).dependencies ?? {});
      expect(deps).not.toContain("@proworks-hub/platform-events");
      expect(deps).not.toContain("@proworks-hub/platform-runtime");
      // Contracts is the only suite package an engine may depend on at runtime.
      expect(deps.filter((d) => d.startsWith("@proworks-hub/"))).toEqual([
        "@proworks-hub/contracts",
      ]);
    }

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const pkg = file.relative.split("/")[0]!;
      if (!ENGINES.includes(pkg)) continue;
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith("@proworks-hub/platform-events") || spec.startsWith("@proworks-hub/platform-runtime")) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Prime out of the work-order domain, and WorkOrder out of Prime", () => {
    // The whole point of the extraction. Prime decides; WorkOrder executes.
    // If Prime imports the work-order engine it has started owning the record
    // again, and a maker who wants a printable work order is back to needing an
    // orchestrator. If WorkOrder imports Prime, it cannot be used alone at all.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const pkg = file.relative.split("/")[0]!;
      for (const spec of importSpecifiers(file.text)) {
        if (pkg === "prime" && spec.startsWith("@proworks-hub/workorder")) {
          offenders.push(`${file.relative} → ${spec}`);
        }
        if (pkg === "workorder" && spec.startsWith("@proworks-hub/prime")) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    for (const [name, forbidden] of [
      ["prime", "@proworks-hub/workorder"],
      ["workorder", "@proworks-hub/prime"],
    ] as const) {
      expect(Object.keys(pkgJson(name).dependencies ?? {})).not.toContain(forbidden);
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

  it("keeps the pure engines free of I/O and host frameworks", () => {
    // Prime, CostIQ and ReceiptIQ hold no state and open no connections. That
    // is what lets them be consumed as libraries today and deployed as
    // services later without touching their domain code.
    //
    // Until now it was true by discipline rather than by any check, which made
    // it the property most likely to be lost by accident — and the hardest to
    // recover once a database call is three layers deep. The hardening
    // directive asks for durable workflow state in Prime; this guard is what
    // makes sure that arrives as a PORT with the host supplying storage,
    // rather than as a connection inside the engine.
    //
    // ForgeIQ is deliberately absent: it ships optional `server` and `react`
    // layers, and its `core` purity is covered by its own test above.
    const PURE_PACKAGES = ["prime", "costiq", "receiptiq", "contracts", "workorder", "platform-events", "platform-runtime"];

    const bannedExact = [
      "express",
      "drizzle-orm",
      "react",
      "react-dom",
      "pg",
      "postgres",
      "mysql2",
      "sqlite3",
      "better-sqlite3",
      "mongodb",
      "redis",
      "ioredis",
      "idb",
      "@supabase/supabase-js",
      "@tanstack/react-query",
      "axios",
      "node-fetch",
    ];
    // Node builtins, with or without the `node:` prefix.
    const bannedBuiltins = [
      "fs", "path", "os", "http", "https", "net", "dns", "child_process",
      "worker_threads", "cluster", "crypto", "stream", "zlib", "tls",
    ];

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const pkg = file.relative.split("/")[0]!;
      if (!PURE_PACKAGES.includes(pkg)) continue;
      // Tests may reach for timers and fixtures; the shipped code may not.
      if (file.relative.includes("__tests__/") || file.relative.includes("/tests/")) continue;

      for (const spec of importSpecifiers(file.text)) {
        const bare = spec.startsWith("node:") ? spec.slice("node:".length) : spec;
        const root = bare.split("/")[0]!;
        if (bannedExact.some((b) => spec === b || spec.startsWith(`${b}/`))) {
          offenders.push(`${file.relative} → ${spec}`);
        } else if (spec.startsWith("node:") || bannedBuiltins.includes(root)) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps global state and ambient I/O out of the pure engines", () => {
    // A package can stay import-clean and still reach for a browser or Node
    // global. These are the ones that would quietly tie an engine to one
    // runtime, or give it hidden state that does not survive being moved.
    const PURE_PACKAGES = ["prime", "costiq", "receiptiq", "contracts", "workorder", "platform-events", "platform-runtime"];
    const bannedGlobals = [
      /\blocalStorage\b/,
      /\bsessionStorage\b/,
      /\bindexedDB\b/,
      // Require an identifier after the dot. "window." also occurs in prose —
      // "beyond the 90-day window." — and a guard that fires on English is a
      // guard somebody switches off.
      /\bdocument\.[A-Za-z_$]/,
      /\bwindow\.[A-Za-z_$]/,
      /\bprocess\.env\b/,
      // `globalThis.crypto` is allowed, and only that. Prime feature-detects it
      // for default id generation, with a Math.random fallback and an
      // `IdGenerator` port for callers who need determinism — a defaulted
      // dependency, not a hidden one. Any OTHER reach into globalThis is
      // ambient state and is refused.
      /\bglobalThis\.(?!crypto\b)[A-Za-z_$]/,
    ];

    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const pkg = file.relative.split("/")[0]!;
      if (!PURE_PACKAGES.includes(pkg)) continue;
      if (file.relative.includes("__tests__/") || file.relative.includes("/tests/")) continue;

      for (const pattern of bannedGlobals) {
        // Ignore prose: these files carry long explanatory headers.
        const code = file.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        if (pattern.test(code)) offenders.push(`${file.relative} → ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares only suite packages and zod as runtime dependencies", () => {
    // A host framework appearing here would make the engine un-liftable; the
    // host-facing layers declare theirs as optional peers instead.
    for (const name of ["contracts", "forgeiq", "costiq", "prime", "receiptiq", "workorder", "platform-events", "platform-runtime"]) {
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
