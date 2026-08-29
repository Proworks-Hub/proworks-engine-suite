// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RUNTIME_MANIFEST_VERSION,
  claimedDomains,
  isTrustedForConsequentialWork,
  parseRuntimeManifest,
  runtimeEngineManifestSchema,
  type RuntimeEngineManifest,
} from "@proworks-hub/contracts";
import { createEngineRegistry } from "@proworks-hub/control-plane";

// ─────────────────────────────────────────────────────────────────────────────
// Constitution §2.5 — an engine must be able to say what it is, what it can do,
// what authority it needs, what it owns, and how its health may be judged.
//
// The manifest below is InventoryIQ's REAL one, written from its charter and
// its code rather than invented for the test. A schema exercised only by
// fixtures shaped to please it proves the fixtures.
// ─────────────────────────────────────────────────────────────────────────────

const inventoryIq: RuntimeEngineManifest = runtimeEngineManifestSchema.parse({
  manifestVersion: RUNTIME_MANIFEST_VERSION,

  engineId: "hive.inventoryiq",
  canonicalName: "InventoryIQ",
  classification: "SPECIALIZED",
  lifecycleState: "EXPERIMENTAL",

  versions: {
    implementationVersion: "0.13.0",
    contractVersion: "1.0.0",
    charterVersion: "1.0",
    constitutionVersion: "1.0",
  },
  charter: {
    charterId: "charter.specialized.inventoryiq",
    charterVersion: "1.0",
    charterLocation: "Hive Charter Library/InventoryIQ_Charter_V1_0.docx",
  },
  constitutionCompatibility: ["1.0"],

  capabilities: [
    "check_availability",
    "detect_shortages",
    "detect_reorder_signals",
    "reserve_material",
    "release_reservation",
    "consume_material",
  ],
  contractsProvided: [
    { contractId: "inventory.availability", version: "1.0.0", summary: "What is on hand, reserved and available." },
    { contractId: "inventory.reservation", version: "1.0.0", summary: "A hold against a work order." },
  ],
  contractsConsumed: [
    { contractId: "foundation.identity", version: "1.0.0", summary: "Canonical identifiers and references." },
  ],
  eventsPublished: ["inventory.adjusted", "inventory.reserved", "material.oversold"],
  eventsConsumed: [],

  dependencies: [
    {
      engineId: "hive.governance-engine",
      strength: "constitutional",
      consequenceIfUnavailable: "No consequential inventory action is authorized. Readings and writes both stop.",
    },
    {
      engineId: "hive.foundation-core",
      strength: "conditional",
      consequenceIfUnavailable: "Identifier validation falls back to local checks; canonical references cannot be resolved.",
    },
  ],

  sourceOfTruth: [
    {
      domain: "stock_position",
      description: "What is on hand, what is reserved, and where it physically is.",
      // The half that gets skipped. InventoryIQ's own charter says it holds no
      // cost: "What a shop paid for a roll belongs to CostIQ and ReceiptIQ; a
      // price here would be a second answer that quietly diverges."
      notAuthoritativeFor: [
        "material cost or price — CostIQ and ReceiptIQ",
        "purchase orders and supplier terms",
        "the work order a reservation is held for — WorkOrderIQ",
      ],
    },
  ],

  authorityRequirements: [
    {
      action: "reserve_material",
      purpose: "hold stock for an authorized work order",
      justification: "Reserving changes what other work may consume, so it is consequential and must be permitted.",
    },
  ],
  requiresGovernance: true,

  health: {
    reportableStates: ["healthy", "degraded", "unavailable"],
    expectedIntervalMs: 30_000,
    degradedMeans:
      "Stock positions are readable but a ledger write failed recently, so reservations may be rejected.",
  },
  sentinelHooks: [
    { hook: "consequential_actions", implemented: false },
    { hook: "state_transitions", implemented: false },
  ],

  portability: {
    requiresHostBindings: ["StockLedger", "ReservationStore"],
    providerDependencies: [],
    portabilityCaveats: [
      "Quantities are unit-typed; a host whose stock has no unit cannot bind the ledger without deciding one.",
    ],
  },
});

describe("a real engine can describe itself", () => {
  it("parses InventoryIQ's manifest", () => {
    expect(inventoryIq.engineId).toBe("hive.inventoryiq");
    expect(inventoryIq.capabilities).toHaveLength(6);
  });

  it("names what it is NOT authoritative for", () => {
    // §23.6's required half, and the one that gets skipped: an engine listing
    // only what it owns reads as owning everything nearby.
    const [stock] = inventoryIq.sourceOfTruth;
    expect(stock!.notAuthoritativeFor.some((s) => /CostIQ/.test(s))).toBe(true);
    expect(claimedDomains(inventoryIq)).toEqual(["stock_position"]);
  });

  it("refuses a source-of-truth claim with no exclusions", () => {
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      sourceOfTruth: [{ domain: "everything", description: "all of it", notAuthoritativeFor: [] }],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("a manifest declares; it does not grant", () => {
  it("states authority as a requirement with a justification", () => {
    // A request Governance answers, never a grant. The field is named
    // `authorityRequirements` for the same reason `permissions` was renamed:
    // a field called permissions is eventually read as one.
    const [need] = inventoryIq.authorityRequirements;
    expect(need!.justification.length).toBeGreaterThan(0);
    expect(JSON.stringify(inventoryIq)).not.toContain("granted");
  });

  it("refuses an implemented non-platform engine that does not require Governance", () => {
    // Constitution §1.9 made structural. An engine that acts without an
    // authorization decision is precisely the leak that rule closes.
    const parsed = parseRuntimeManifest({ ...inventoryIq, requiresGovernance: false });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.reason).toContain("Capability does not imply permission");
  });

  it("allows a chartered-but-unbuilt engine to defer both", () => {
    // A charter is a specification. Requiring an unimplemented engine to
    // declare Governance and source-of-truth would force invented answers.
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      lifecycleState: "CHARTERED",
      requiresGovernance: false,
      sourceOfTruth: [],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("dependencies say what breaks", () => {
  it("requires a consequence for anything above optional", () => {
    // An unexplained dependency is one nobody can triage when it goes down.
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      dependencies: [{ engineId: "hive.governance-engine", strength: "required" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("lets an optional dependency stay unexplained", () => {
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      dependencies: [{ engineId: "hive.searchiq", strength: "optional" }],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("health means something specific", () => {
  it("requires the engine to say what degraded means HERE", () => {
    // "Degraded" alone sends somebody digging. The word means different things
    // in a costing engine and a device gateway, and only this engine can say.
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      health: { ...inventoryIq.health, degradedMeans: "" },
    });
    expect(parsed.ok).toBe(false);
  });

  it("refuses an engine that cannot report healthy", () => {
    const parsed = parseRuntimeManifest({
      ...inventoryIq,
      health: { ...inventoryIq.health, reportableStates: ["degraded", "unavailable"] },
    });
    expect(parsed.ok).toBe(false);
  });

  it("does not require every engine to report all five states", () => {
    // InventoryIQ cannot meaningfully report `isolated` about itself —
    // isolation is Sentinel's word, applied from outside.
    expect(inventoryIq.health.reportableStates).not.toContain("isolated");
  });
});

describe("portability is declared, not assumed", () => {
  it("names host bindings and has no provider dependencies", () => {
    // Empty `providerDependencies` is the target state, and stating it is the
    // difference between an engine that is portable and one nobody checked.
    expect(inventoryIq.portability.requiresHostBindings).toContain("StockLedger");
    expect(inventoryIq.portability.providerDependencies).toEqual([]);
  });

  it("states caveats rather than implying none exist", () => {
    expect(inventoryIq.portability.portabilityCaveats.length).toBeGreaterThan(0);
  });
});

describe("trust is not a label", () => {
  it("does not trust an EXPERIMENTAL engine for consequential work", () => {
    expect(isTrustedForConsequentialWork(inventoryIq)).toBe(false);
  });

  it("trusts a PRODUCTION engine that requires Governance", () => {
    expect(
      isTrustedForConsequentialWork({ ...inventoryIq, lifecycleState: "PRODUCTION" }),
    ).toBe(true);
  });

  it("does not trust a PRODUCTION engine that does not require Governance", () => {
    // Lifecycle alone is not enough. A PRODUCTION label on an engine that acts
    // without authorization describes a bigger problem, not a smaller one.
    expect(
      isTrustedForConsequentialWork({
        ...inventoryIq,
        lifecycleState: "PRODUCTION",
        requiresGovernance: false,
      }),
    ).toBe(false);
  });
});

describe("two manifests, one identity", () => {
  it("keeps the presentation manifest working, unchanged", () => {
    // The Hive console at /hive consumes control-plane's EngineManifest. This
    // change must not touch it — extending it with twenty constitutional fields
    // would break the console whenever the constitutional shape moved.
    const registry = createEngineRegistry([]);
    // `problems` is a property here, not a method — control-plane's registry
    // and the charter registry differ, and assuming they matched is what this
    // line originally got wrong.
    expect(registry.problems).toEqual([]);
  });

  it("joins the two by engineId, and by nothing else", () => {
    // The only field they must agree on. Everything else is each manifest's own
    // concern, which is why they can evolve independently.
    expect(inventoryIq.engineId).toBe("hive.inventoryiq");
    expect(Object.keys(inventoryIq)).not.toContain("icon");
    expect(Object.keys(inventoryIq)).not.toContain("visualizationType");
  });
});

describe("the manifest refuses a typo", () => {
  it("rejects an unknown field rather than ignoring it", () => {
    // `charterVerison` would silently mean "no charter version", and an
    // engine's charter binding is exactly what must not go quietly missing.
    const parsed = parseRuntimeManifest({ ...inventoryIq, charterVerison: "1.0" });
    expect(parsed.ok).toBe(false);
  });

  it("names the engine in the failure, when it can", () => {
    const parsed = parseRuntimeManifest({ ...inventoryIq, health: null });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.engineId).toBe("hive.inventoryiq");
  });

  it("reports <unidentified> when it cannot", () => {
    const parsed = parseRuntimeManifest({ nothing: "useful" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.engineId).toBe("<unidentified>");
  });
});

describe("the manifest agrees with the charter registry", () => {
  const registry = JSON.parse(
    readFileSync(join(process.cwd(), "charters/registry.json"), "utf8"),
  ) as Array<{ canonicalEngineId?: string; charterId: string; charterVersion: string }>;

  it("references a charter that actually exists", () => {
    // A manifest pointing at a charter nobody has is a binding to nothing.
    const record = registry.find((r) => r.canonicalEngineId === inventoryIq.engineId);
    expect(record, "InventoryIQ must be in the charter registry").toBeTruthy();
    expect(inventoryIq.charter.charterId).toBe(record!.charterId);
    expect(inventoryIq.charter.charterVersion).toBe(record!.charterVersion);
  });
});
