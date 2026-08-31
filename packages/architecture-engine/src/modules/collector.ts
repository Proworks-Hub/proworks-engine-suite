// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { PackageFacts } from "../chambers/conformance.js";

// ─────────────────────────────────────────────────────────────────────────────
// Reading the real workspace.
//
// Separated from the evaluator so the evaluator stays pure and testable
// without a filesystem — the chamber can be given a hand-built world in a
// test, and given this one in CI, and it cannot tell the difference.
//
// Only `dependencies` is read, never `devDependencies`. A dev dependency is
// absent at runtime, so counting one as a runtime coupling would report a
// violation that cannot occur in production and train people to ignore the
// rule.
// ─────────────────────────────────────────────────────────────────────────────

/** Reads every workspace package's name and runtime dependencies. */
export function collectPackages(packagesDir: string): readonly PackageFacts[] {
  const out: PackageFacts[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      const pkg = raw as { name?: unknown; dependencies?: Record<string, unknown> };
      if (typeof pkg.name !== "string") continue;
      out.push({ packageName: pkg.name, dependencies: Object.keys(pkg.dependencies ?? {}) });
    } catch {
      // A package.json that will not parse is a real condition, but it is the
      // build's to report, not the architecture report's — inventing a
      // conformance finding for a syntax error would misattribute it.
      continue;
    }
  }
  return out.sort((a, b) => a.packageName.localeCompare(b.packageName));
}
