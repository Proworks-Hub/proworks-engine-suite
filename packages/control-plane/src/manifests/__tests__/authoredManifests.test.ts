// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { SUITE_MANIFESTS } from "../index.js";
import { CONSTITUTIONAL_MANIFESTS, sentinelIqManifest } from "../constitutional.js";
import { FINANCE_MANIFESTS, ledgerIqManifest } from "../finance.js";
import { parseEngineManifest } from "../../core/manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The thirty manifests authored under DEC-025/026/028, checked against the
// real schema rather than merely written.
//
// A manifest that has never been parsed is a plausible-looking object literal.
// TypeScript accepts it because the shape matches; the refinements — which are
// where the Core rule and the layer rule live — only run at parse time.
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORED = [...FINANCE_MANIFESTS, ...CONSTITUTIONAL_MANIFESTS];

describe("the authored manifests parse", () => {
  it("all thirty pass the real schema, refinements included", () => {
    expect(AUTHORED).toHaveLength(30);
    for (const manifest of AUTHORED) {
      const result = parseEngineManifest(manifest);
      expect(result.ok, `${manifest.id}: ${result.ok ? "" : result.error}`).toBe(true);
      if (result.ok) expect(result.droppedFields, manifest.id).toEqual([]);
    }
  });
  it("ids are unique and match the package name", () => {
    const ids = AUTHORED.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const manifest of AUTHORED) {
      expect(manifest.packageName, manifest.id).toBe(`@proworks-hub/${manifest.id}`);
    }
  });
  it("no id collides with an existing suite manifest", () => {
    const existing = new Set(SUITE_MANIFESTS.map((m) => m.id));
    for (const manifest of AUTHORED) {
      expect(existing.has(manifest.id), `${manifest.id} already in SUITE_MANIFESTS`).toBe(false);
    }
  });
});

describe("layer and Core placement", () => {
  it("the twenty-nine finance engines are specialized and name the finance Core", () => {
    expect(FINANCE_MANIFESTS).toHaveLength(29);
    for (const manifest of FINANCE_MANIFESTS) {
      expect(manifest.layer, manifest.id).toBe("specialized");
      expect(manifest.coreDomain, manifest.id).toBe("finance");
    }
  });
  it("Sentinel is constitutional and names NO Core — it sits outside the hierarchy", () => {
    expect(sentinelIqManifest.layer).toBe("constitutional");
    expect(sentinelIqManifest.coreDomain).toBeNull();
  });
  it("the schema refuses a constitutional component that claims a Core", () => {
    const wrong = parseEngineManifest({ ...sentinelIqManifest, coreDomain: "finance" });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain("must not name a Core");
  });
  it("the schema refuses a specialized engine with no Core", () => {
    const wrong = parseEngineManifest({ ...ledgerIqManifest, coreDomain: null });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain("must name the Core");
  });
});

describe("what these manifests deliberately do NOT claim", () => {
  it("every one declares zero event mappings — nothing emits, so nothing is drawn", () => {
    // CC-ADR-002 makes event mappings the only source of DATA edges. Every
    // engine here is kernel-scope with platform-events publication in its
    // stated gap, so zero edges is the true topology. A mapping added before
    // its emitter is an invented edge.
    for (const manifest of AUTHORED) {
      expect(manifest.eventMappings, manifest.id).toEqual([]);
    }
  });
  it("every one declares zero metrics — nothing is measured, and an empty tile reads as zero", () => {
    for (const manifest of AUTHORED) {
      expect(manifest.metrics, manifest.id).toEqual([]);
    }
  });
  it("only LedgerIQ names capabilities, because only its names are registered (PC-5)", () => {
    expect(ledgerIqManifest.capabilities).toContain("post_accounting_entry");
    expect(ledgerIqManifest.capabilities).toHaveLength(9);
    for (const manifest of AUTHORED.filter((m) => m.id !== "ledgeriq")) {
      expect(manifest.capabilities, manifest.id).toEqual([]);
    }
  });
  it("only the overview panel is claimed — no permanently empty tabs", () => {
    for (const manifest of AUTHORED) {
      expect(manifest.supportedAdminPanels, manifest.id).toEqual(["overview"]);
    }
  });
});

describe("integration is a deliberate act, not a side effect", () => {
  it("the authored manifests are NOT in SUITE_MANIFESTS", () => {
    // The console counts eight engines by a decision recorded in its own
    // test. Wiring thirty more in changes what it counts, what the layout
    // draws and what fleet health divides by — console questions, owned by
    // the console. This test fails the day someone wires them without
    // deciding, which is the point.
    expect(SUITE_MANIFESTS).toHaveLength(11);
    const suiteIds = new Set(SUITE_MANIFESTS.map((m) => m.id));
    expect(AUTHORED.every((m) => !suiteIds.has(m.id))).toBe(true);
  });
});
