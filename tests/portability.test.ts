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
const SUITE_PACKAGES = /^@proworks-hub\/(contracts|forgeiq|costiq|prime|receiptiq|platform-events|platform-runtime|workorderiq|tracking|inventoryiq|notifications|order-ingestion|visioniq|control-plane)(\/|$)/;

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
        f.relative.startsWith("workorderiq/"),
    )) {
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith("@proworks-hub/forgeiq")) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
    for (const name of ["costiq", "prime", "receiptiq", "workorderiq", "platform-events", "platform-runtime"]) {
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
    const ENGINES = ["forgeiq", "costiq", "prime", "receiptiq", "workorderiq", "inventoryiq", "visioniq"];
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
        if (pkg === "prime" && spec.startsWith("@proworks-hub/workorderiq")) {
          offenders.push(`${file.relative} → ${spec}`);
        }
        if (pkg === "workorderiq" && spec.startsWith("@proworks-hub/prime")) {
          offenders.push(`${file.relative} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    for (const [name, forbidden] of [
      ["prime", "@proworks-hub/workorderiq"],
      ["workorderiq", "@proworks-hub/prime"],
    ] as const) {
      expect(Object.keys(pkgJson(name).dependencies ?? {})).not.toContain(forbidden);
    }
  });

  it("lets no package in the suite import another, contracts excepted", () => {
    // The general form of the rule above, and the reason it is here: the
    // Prime/WorkOrder guard names a PAIR, so every package added afterwards is
    // unguarded by default. That is not hypothetical — tracking was added and
    // could import the work-order engine freely until this test existed.
    //
    // Contracts is the exception on purpose. It is the shared vocabulary and
    // depends on nothing but zod, so depending on it couples a package to a
    // set of types rather than to another package's behaviour.
    //
    // Tests are exempt. A test that wires two engines together to prove they
    // compose is demonstrating the seam, not violating it — it is the host's
    // job it is imitating.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/(^|\/)(__tests__|tests)\//.test(file.relative)) continue;
      const pkg = file.relative.split("/")[0]!;
      if (pkg === "contracts") continue;

      for (const spec of importSpecifiers(file.text)) {
        const match = SUITE_PACKAGES.exec(spec);
        if (!match) continue;
        const target = match[1];
        if (target === "contracts" || target === pkg) continue;
        offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);

    // And the same at the manifest level, so a dependency cannot be declared
    // ahead of the import that would use it.
    for (const name of ["forgeiq", "costiq", "prime", "receiptiq", "workorderiq", "tracking", "inventoryiq", "notifications", "order-ingestion", "visioniq", "platform-events", "platform-runtime", "control-plane"]) {
      const suiteDeps = Object.keys(pkgJson(name).dependencies ?? {}).filter((d) =>
        d.startsWith("@proworks-hub/"),
      );
      expect(suiteDeps).toEqual(["@proworks-hub/contracts"]);
    }
  });

  it("keeps the control plane optional: no engine may import it", () => {
    // §17, made structural. The engine control centre observes the engines; if
    // it were offline, or deleted, every engine must keep working exactly as it
    // does now.
    //
    // The general cross-package guard above already forbids this, but it
    // forbids it symmetrically — and the direction is the whole point. A
    // console importing an engine would be a bug; an ENGINE importing the
    // console would be an outage, because the observability layer would have
    // become load-bearing for production work.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/(^|\/)(__tests__|tests)\//.test(file.relative)) continue;
      const pkg = file.relative.split("/")[0]!;
      if (pkg === "control-plane") continue;
      for (const spec of importSpecifiers(file.text)) {
        if (spec.startsWith("@proworks-hub/control-plane")) offenders.push(`${file.relative} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);

    // And nothing may declare it as a dependency either, so it cannot be
    // brought in ahead of the import that would use it.
    for (const name of readdirSync(PACKAGES)) {
      if (name === "control-plane") continue;
      if (!statSync(join(PACKAGES, name)).isDirectory()) continue;
      const deps = { ...pkgJson(name).dependencies, ...pkgJson(name).peerDependencies };
      expect(Object.keys(deps), name).not.toContain("@proworks-hub/control-plane");
    }
  });

  it("gives every workspace package a vitest alias to its sources", () => {
    // The alias list is hand-maintained, and a package missing from it does not
    // fail loudly — it silently resolves to `dist`, which for a new package
    // does not exist and for an old one is stale. I added three packages and
    // missed all three; the vertical slice caught it, but only because it
    // imported them by name. A guard is cheaper than that coincidence.
    const packageNames = readdirSync(PACKAGES).filter((name) =>
      statSync(join(PACKAGES, name)).isDirectory(),
    );

    const vitestConfig = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(
      packageNames.filter((name) => !vitestConfig.includes(`"@proworks-hub/${name}"`)),
    ).toEqual([]);

    // The same list exists twice, and it has to agree with itself: tsconfig
    // resolves the typecheck, vitest resolves the run. When they disagree, the
    // symptom is a phantom "has no exported member" for code that plainly
    // exports it — because one of them is reading a stale `dist`.
    const rootTsconfig = readFileSync(join(ROOT, "tsconfig.json"), "utf8");
    expect(
      packageNames.filter((name) => !rootTsconfig.includes(`"@proworks-hub/${name}"`)),
    ).toEqual([]);
  });

  it("keeps the owning company out of the runtime architecture", () => {
    // Interaxis is the company that owns this software. It is not an engine, a
    // host, a runtime, a data model or a layer requests pass through, and a
    // contract named after it would make every consumer depend on a corporate
    // identity to describe a product.
    //
    // I got this wrong once: an earlier draft of the catalogue shipped
    // InteraxisSku, buildInteraxisSku and an IX- prefix. This is the test that
    // stops it coming back, in code and in the names code uses.
    //
    // Prose may discuss it — this file does, two paragraphs up — so only
    // identifiers and string literals are checked.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const withoutComments = file.text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (/interaxis/i.test(withoutComments)) {
        offenders.push(file.relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not name domain contracts after an application either", () => {
    // The other half of the same rule, and the easier mistake to make: solving
    // "do not call it Interaxis" by calling it ProWorks instead. A portable
    // engine cannot require the host that happens to ship first.
    //
    // Checked on exported type and function names only — an adapter may
    // legitimately mention a host in prose, and package names are scoped.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      if (/(^|\/)(__tests__|tests)\//.test(file.relative)) continue;
      if (file.relative.startsWith("contracts/")) {
        for (const match of file.text.matchAll(
          /export (?:interface|type|const|function|class) (\w+)/g,
        )) {
          if (/^(ProWorks|MakerOps|KSix|FabriOps)/i.test(match[1]!)) {
            offenders.push(`${file.relative} → ${match[1]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never defaults an application name inside an engine", () => {
    // The subtler form of host coupling, and the one the "no host-specific
    // branching" guard misses because it is not a branch.
    //
    // Two services defaulted `application` to "proworks". A MakerOps host that
    // forgot the parameter had its entitlements looked up under a product it
    // does not run — refused silently, or matched against a grant belonging to
    // a different application. The acceptance criterion "MakerOps consumes the
    // engines without ProWorks" was technically true and practically a trap.
    //
    // An omission must fail loudly. Requiring the field does that; this stops
    // the default coming back.
    const HOSTS = /"(proworks|makerops|ksix|fabriops)"/i;
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      if (/(^|\/)(__tests__|tests)\//.test(file.relative)) continue;
      for (const line of file.text.split("\n")) {
        // A host name used as the fallback of an `application` field.
        if (line.includes("application") && line.includes("??") && HOSTS.test(line)) {
          offenders.push(`${file.relative} → ${line.trim()}`);
          continue;
        }
      }
    }

    expect(offenders).toEqual([]);
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
    const PURE_PACKAGES = ["prime", "costiq", "receiptiq", "contracts", "workorderiq", "platform-events", "platform-runtime", "tracking", "inventoryiq", "notifications", "order-ingestion", "visioniq"];

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
    const PURE_PACKAGES = ["prime", "costiq", "receiptiq", "contracts", "workorderiq", "platform-events", "platform-runtime", "tracking", "inventoryiq", "notifications", "order-ingestion", "visioniq"];
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
    for (const name of ["contracts", "forgeiq", "costiq", "prime", "receiptiq", "workorderiq", "platform-events", "platform-runtime", "tracking", "inventoryiq", "notifications", "order-ingestion", "visioniq", "control-plane"]) {
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
