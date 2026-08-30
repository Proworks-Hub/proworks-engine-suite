/*
 * Copyright © 2026 Steven Kreutzer. All Rights Reserved.
 * Project: ProWorks Engine Suite — CostIQ
 * License: Proprietary — UNLICENSED.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COSTIQ_CHARTER,
  COSTIQ_CLASSIFICATION,
  COSTIQ_DOES_NOT_OWN,
  COSTIQ_OWNS,
  FORBIDDEN_EXPORT_FRAGMENTS,
} from "../charter.js";
import * as costiq from "../index.js";

// ─────────────────────────────────────────────────────────────────────────────
// The tests that stop CostIQ becoming the finance department.
//
// Scope creep in an engine is never a decision anybody makes. It arrives one
// reasonable request at a time: CostIQ already knows the cost, so it may as
// well know the margin; it already knows the margin, so it may as well pick
// the supplier. Each step is defensible on its own.
//
// A charter document does not stop that, because nobody reads a document while
// writing a function. These tests are read by CI on every commit.
//
// This file uses `node:fs` and lives in `__tests__`, which the portability
// guard permits — the SHIPPED package must stay runtime-neutral, and a test
// that reads the source tree is not shipped.
// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Source with comments and string literals removed.
 *
 * Necessary because a check for arithmetic that reads raw text finds it in
 * prose: JSDoc continuation stars and a hyphenated module path look exactly
 * like multiplication and division.
 */
function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""');
}

const ALL_SOURCE = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1).replace(/\\/g, "/"),
  text: readFileSync(path, "utf8"),
}));

describe("CostIQ stays SPECIALIZED", () => {
  it("does not promote itself to Core", () => {
    // Promotion would change what it is allowed to depend on and who is
    // allowed to depend on it. That is a constitutional change, not a CostIQ
    // one.
    expect(COSTIQ_CLASSIFICATION).toBe("SPECIALIZED");
  });

  it("states what it owns and what it does not, in machine-readable form", () => {
    expect(COSTIQ_OWNS.length).toBeGreaterThan(0);
    expect(COSTIQ_DOES_NOT_OWN.length).toBeGreaterThan(0);
    // Each exclusion names an owner. "Not ours" without "theirs" is a gap
    // rather than a boundary.
    for (const excluded of COSTIQ_DOES_NOT_OWN) {
      expect(excluded.ownedBy.length).toBeGreaterThan(0);
      expect(excluded.arrivesAs.length).toBeGreaterThan(0);
    }
  });

  it("excludes every responsibility the directive names", () => {
    // Pinned by id so an exclusion cannot quietly disappear during a refactor.
    const ids = new Set(COSTIQ_DOES_NOT_OWN.map((e) => e.id));
    for (const required of [
      "profitability",
      "budget",
      "ledger",
      "procurement.decision",
      "pricing.commercial",
      "organizational.health",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });
});

describe("the public surface respects the boundary", () => {
  it("exports nothing that decides what CostIQ may only inform", () => {
    // Blunt on purpose. A name is a weak signal and it is also what a reviewer
    // sees: an engine that grows `selectSupplier` has crossed a line whatever
    // its internals do.
    const exported = Object.keys(costiq).map((k) => k.toLowerCase());
    const crossings: string[] = [];
    for (const name of exported) {
      for (const fragment of FORBIDDEN_EXPORT_FRAGMENTS) {
        if (name.includes(fragment)) {
          const owner = COSTIQ_DOES_NOT_OWN.find((e) => fragment.includes(e.id.split(".")[0]!));
          crossings.push(`${name} (matches "${fragment}"${owner ? `, owned by ${owner.ownedBy}` : ""})`);
        }
      }
    }
    expect(crossings).toEqual([]);
  });

  it("exports a charter so consumers can read the boundary", () => {
    expect(COSTIQ_CHARTER.version).toBe("costiq.charter.v1");
  });
});

describe("the package stays portable", () => {
  it("imports no node builtin outside tests", () => {
    // CostIQ must run in a browser, a worker, an edge runtime or Node. A
    // single `node:fs` import in shipped code ends that, and it is the kind of
    // thing that arrives inside an otherwise reasonable change.
    const offenders = ALL_SOURCE.filter((f) => /from\s+["']node:/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("imports no host application", () => {
    // A cost engine that needs the Hub or KSix is not portable and cannot be
    // licensed to anybody else.
    const offenders = ALL_SOURCE.filter((f) =>
      /from\s+["'](\.\.\/){2,}|from\s+["']@?(prowork-hub|ksix)/i.test(f.text),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("imports no specialized engine implementation", () => {
    // Adapters translate other engines' CONTRACTS. Importing another engine's
    // implementation would couple CostIQ's release to theirs and break the
    // independence claim the suite makes.
    const forbidden = /["']@proworks-hub\/(forgeiq|receiptiq|workorderiq|prime|inventoryiq|visioniq|finance-core|profitability)/;
    const offenders = ALL_SOURCE.filter((f) => forbidden.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("depends only on contracts and zod", () => {
    // The dependency list is the portability claim in its shortest form.
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@proworks-hub/contracts", "zod"]);
  });
});

describe("authoritative arithmetic never uses floating point", () => {
  it("reaches for no floating-point primitive in the vNext domain", () => {
    // The rule the directive states as non-negotiable, checked against CODE
    // rather than prose — an earlier version of this test regex-matched raw
    // text and flagged the phrase "cost-iq-engine / domain" as a division.
    //
    // Comments and string literals are stripped first, then the specific
    // primitives that reintroduce binary floating point are looked for.
    //
    // Scoped to the vNext tree. v1 is knowingly float-based and is preserved
    // behind compatibility rather than corrected in place.
    const HAZARDS = ["parseFloat(", "parseInt(", "Math.round(", "Math.floor(", "Math.ceil(", ".toFixed("];

    const vnext = ALL_SOURCE.filter((f) => f.path.startsWith("domain/"));
    expect(vnext.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of vnext) {
      const code = stripCommentsAndStrings(file.text);
      for (const hazard of HAZARDS) {
        // `decimal.ts` owns the two documented edges where a JS number is
        // converted in or out, and nothing else may.
        if (code.includes(hazard) && file.path !== "domain/decimal.ts") {
          offenders.push(`${file.path} uses ${hazard}`);
        }
      }
      // `Number(` outside decimal.ts would mean an amount left exact math.
      if (file.path !== "domain/decimal.ts" && /Number\s*\(/.test(code)) {
        offenders.push(`${file.path} calls Number()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps toNumber greppable as the lossy escape hatch", () => {
    // Named so review can find it. Any authoritative calculation containing a
    // call to it has left exact arithmetic.
    const decimalSource = ALL_SOURCE.find((f) => f.path === "domain/decimal.ts");
    expect(decimalSource?.text).toContain("LOSSY BY CONSTRUCTION");
  });
});
