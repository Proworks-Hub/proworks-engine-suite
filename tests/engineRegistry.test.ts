// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  RUNTIME_MANIFEST_VERSION,
  createRuntimeRegistry,
  type RuntimeEngineManifest,
} from "@proworks-hub/contracts";

// ─────────────────────────────────────────────────────────────────────────────
// The registry answers what exists. Governance answers what is permitted.
//
//   authority established → GOVERNANCE permits → registry resolves → execute
//
// A registry that also authorized would make discovery and permission the same
// act — the leak DEC-024 closed in the coordinator, reintroduced one layer down.
// ─────────────────────────────────────────────────────────────────────────────

const manifest = (over: Partial<RuntimeEngineManifest> = {}): unknown => ({
  manifestVersion: RUNTIME_MANIFEST_VERSION,
  engineId: "hive.inventoryiq",
  canonicalName: "InventoryIQ",
  classification: "SPECIALIZED",
  lifecycleState: "PRODUCTION",
  versions: { implementationVersion: "0.13.0" },
  charter: {
    charterId: "charter.specialized.inventoryiq",
    charterVersion: "1.0",
    charterLocation: "library/InventoryIQ_Charter_V1_0.docx",
  },
  constitutionCompatibility: ["1.0"],
  capabilities: ["check_availability", "reserve_material"],
  contractsProvided: [],
  contractsConsumed: [],
  eventsPublished: [],
  eventsConsumed: [],
  dependencies: [],
  sourceOfTruth: [
    {
      domain: "stock_position",
      description: "What is on hand and reserved.",
      notAuthoritativeFor: ["material cost — CostIQ"],
    },
  ],
  authorityRequirements: [],
  requiresGovernance: true,
  health: {
    reportableStates: ["healthy", "degraded", "unavailable"],
    degradedMeans: "Readable, but a recent ledger write failed.",
  },
  sentinelHooks: [],
  portability: { requiresHostBindings: [], providerDependencies: [], portabilityCaveats: [] },
  ...over,
});

const other = (over: Partial<RuntimeEngineManifest> = {}) =>
  manifest({
    engineId: "hive.costiq",
    canonicalName: "CostIQ",
    capabilities: ["calculate_cost"],
    sourceOfTruth: [
      { domain: "job_cost", description: "What a job costs.", notAuthoritativeFor: ["stock — InventoryIQ"] },
    ],
    ...over,
  });

describe("what exists, and at what version", () => {
  it("loads valid manifests", () => {
    const registry = createRuntimeRegistry([manifest(), other()]);
    expect(registry.problems()).toEqual([]);
    expect(registry.all()).toHaveLength(2);
    expect(registry.byEngineId("hive.costiq")?.canonicalName).toBe("CostIQ");
  });

  it("resolves a capability to its providers, with version", () => {
    const providers = createRuntimeRegistry([manifest()]).providersOf("reserve_material");
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      engineId: "hive.inventoryiq",
      implementationVersion: "0.13.0",
      trusted: true,
    });
  });

  it("returns untrusted providers too, flagged rather than hidden", () => {
    // Filtering here would hide from an operator that an untrusted engine
    // claims the capability — exactly what they need to see when nothing
    // answers and they are trying to work out why.
    const registry = createRuntimeRegistry([manifest({ lifecycleState: "EXPERIMENTAL" })]);
    const [provider] = registry.providersOf("reserve_material");
    expect(provider!.trusted).toBe(false);
    expect(provider!.lifecycleState).toBe("EXPERIMENTAL");
  });

  it("names the charter governing an engine", () => {
    expect(createRuntimeRegistry([manifest()]).charterFor("hive.inventoryiq")?.charterId).toBe(
      "charter.specialized.inventoryiq",
    );
    expect(createRuntimeRegistry([]).charterFor("hive.nothing")).toBeNull();
  });

  it("collects every problem rather than stopping at the first", () => {
    const registry = createRuntimeRegistry([{ broken: true }, { alsoBroken: true }, manifest()]);
    expect(registry.problems()).toHaveLength(2);
    expect(registry.all()).toHaveLength(1);
  });
});

describe("source-of-truth conflict is fatal", () => {
  it("rejects EVERY claimant of a contested domain", () => {
    // Not the second one. Keeping the first would pick a winner by load order,
    // and the entire problem is that nobody agreed which should win.
    const rival = other({
      engineId: "hive.rival",
      sourceOfTruth: [
        { domain: "stock_position", description: "also stock", notAuthoritativeFor: ["x"] },
      ],
    });
    const registry = createRuntimeRegistry([manifest(), rival]);

    expect(registry.all()).toEqual([]);
    expect(registry.problems()).toHaveLength(2);
    expect(registry.problems().every((p) => p.fatal)).toBe(true);
    expect(registry.problems()[0]!.reason).toContain("stock_position");
  });

  it("names the other claimant in each problem", () => {
    const rival = other({
      engineId: "hive.rival",
      sourceOfTruth: [{ domain: "stock_position", description: "also", notAuthoritativeFor: ["x"] }],
    });
    const problems = createRuntimeRegistry([manifest(), rival]).problems();
    expect(problems.find((p) => p.engineId === "hive.inventoryiq")!.reason).toContain("hive.rival");
    expect(problems.find((p) => p.engineId === "hive.rival")!.reason).toContain("hive.inventoryiq");
  });

  it("names one owner per domain when there is no conflict", () => {
    const registry = createRuntimeRegistry([manifest(), other()]);
    expect(registry.ownerOfDomain("stock_position")).toBe("hive.inventoryiq");
    expect(registry.ownerOfDomain("job_cost")).toBe("hive.costiq");
    expect(registry.ownerOfDomain("nobody_owns_this")).toBeNull();
  });

  it("rejects a duplicate engineId", () => {
    const registry = createRuntimeRegistry([manifest(), manifest()]);
    expect(registry.all()).toHaveLength(1);
    expect(registry.problems()[0]!.reason).toContain("Duplicate engineId");
  });
});

describe("health is reported, not assumed", () => {
  it("accepts a state the manifest declares", () => {
    const registry = createRuntimeRegistry([manifest()]);
    expect(registry.reportHealth("hive.inventoryiq", "degraded").accepted).toBe(true);
    expect(registry.healthOf("hive.inventoryiq")).toBe("degraded");
  });

  it("refuses a state the engine never said it could report", () => {
    // Either the manifest is wrong or this is not that engine. Both are worth
    // refusing; silently accepting would record a fiction.
    const registry = createRuntimeRegistry([manifest()]);
    const result = registry.reportHealth("hive.inventoryiq", "isolated");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("does not list as reportable");
  });

  it("refuses a report from an unregistered engine", () => {
    // An unregistered component must not acquire standing by reporting health.
    const result = createRuntimeRegistry([]).reportHealth("hive.ghost", "healthy");
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("cannot acquire standing");
  });

  it("treats no report as unknown, never as healthy", () => {
    const registry = createRuntimeRegistry([manifest()]);
    expect(registry.healthOf("hive.inventoryiq")).toBeNull();
    expect(registry.readyForWork("hive.inventoryiq")).toBe(false);
  });
});

describe("readiness needs all three conditions", () => {
  const ready = (over: Partial<RuntimeEngineManifest>, state?: "healthy" | "degraded" | "unavailable") => {
    const registry = createRuntimeRegistry([manifest(over)]);
    if (state) registry.reportHealth("hive.inventoryiq", state);
    return registry.readyForWork("hive.inventoryiq");
  };

  it("is ready when registered, trusted and healthy", () => {
    expect(ready({}, "healthy")).toBe(true);
  });

  it("is ready when degraded — reduced capability, not reduced authority", () => {
    expect(ready({}, "degraded")).toBe(true);
  });

  it("is not ready when unavailable", () => {
    expect(ready({}, "unavailable")).toBe(false);
  });

  it("is not ready when untrusted, however healthy", () => {
    // Health and trust are different questions. An EXPERIMENTAL engine
    // reporting healthy is working correctly and still must not be given
    // consequential work.
    expect(ready({ lifecycleState: "EXPERIMENTAL" }, "healthy")).toBe(false);
  });

  it("is not ready when it does not require Governance, however healthy", () => {
    // Caught at parse: such a manifest never loads, so it can never be ready.
    const registry = createRuntimeRegistry([manifest({ requiresGovernance: false })]);
    expect(registry.problems()).toHaveLength(1);
    expect(registry.readyForWork("hive.inventoryiq")).toBe(false);
  });

  it("is not ready when unregistered", () => {
    expect(createRuntimeRegistry([]).readyForWork("hive.anything")).toBe(false);
  });
});

describe("the registry does not authorize", () => {
  it("exposes no method that takes an actor", () => {
    // The structural guarantee. A registry that could answer "may this actor
    // invoke it" would make discovery and permission the same act.
    const registry = createRuntimeRegistry([manifest()]);
    const methods = Object.keys(registry);
    expect(methods.sort()).toEqual([
      "all", "byEngineId", "charterFor", "healthOf",
      "ownerOfDomain", "problems", "providersOf", "readyForWork", "reportHealth",
    ]);
    for (const name of methods) {
      expect(name.toLowerCase(), name).not.toMatch(/authoriz|permit|allow|actor|grant/);
    }
  });

  it("reports a provider as trusted without saying anyone may call it", () => {
    // `trusted` is about the ENGINE — is it built, validated, governed. It says
    // nothing about the caller, and conflating the two is the whole hazard.
    const [provider] = createRuntimeRegistry([manifest()]).providersOf("reserve_material");
    expect(provider!.trusted).toBe(true);
    expect(Object.keys(provider!)).not.toContain("permitted");
  });
});
