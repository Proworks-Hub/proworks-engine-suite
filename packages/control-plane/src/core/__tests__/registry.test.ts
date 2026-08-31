// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { MANIFEST_VERSION, parseEngineManifest } from "../manifest.js";
import { computeHiveLayout, declaredRelationshipSchema } from "../topology.js";
import { createEngineRegistry } from "../registry.js";
import { SUITE_MANIFESTS, primeManifest, forgeIqManifest } from "../../manifests/index.js";

const minimal = {
  id: "newthing",
  name: "New Thing",
  description: "Does a new thing",
  colorToken: "engine-teal",
  icon: "box",
  visualizationType: "generic",
};

describe("reading a manifest", () => {
  it("fills in the defaults so a small manifest is a valid one", () => {
    const result = parseEngineManifest(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe("engine");
    expect(result.manifest.hivePlacement).toBe("ring");
    expect(result.manifest.supportedAdminPanels).toEqual(["overview", "events"]);
  });

  it("upgrades a manifest that predates classification instead of refusing it", () => {
    // The centre hint is the one piece of real information a v1 manifest holds,
    // and it only ever meant Prime.
    const centre = parseEngineManifest({ ...minimal, hivePlacement: "core" });
    expect(centre.ok).toBe(true);
    if (!centre.ok) return;
    expect(centre.manifest.layer).toBe("prime");

    // Everything else is genuinely unclassified, and says so rather than
    // acquiring a plausible band. `specialized` would render better and would
    // be invented.
    const ring = parseEngineManifest({ ...minimal, hivePlacement: "ring" });
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;
    expect(ring.manifest.layer).toBe("plane");
    expect(ring.manifest.coreDomain).toBeNull();
  });

  it("refuses a capability-plane manifest that names no Core", () => {
    // Unplaceable: the console would have to pick a Core for it, and picking is
    // the failure. All 54 capability rows in the hive map name one.
    for (const layer of ["core", "specialized", "industry"] as const) {
      const result = parseEngineManifest({ ...minimal, layer, coreDomain: null });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("coreDomain");
    }
  });

  it("refuses a component outside the hierarchy that claims a Core", () => {
    // A constitutional component naming a Core asserts a hierarchy position it
    // does not hold — Governance does not sit under a Core, it acts across all
    // of them.
    for (const layer of ["prime", "constitutional", "platform", "plane"] as const) {
      const result = parseEngineManifest({ ...minimal, layer, coreDomain: "finance" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("coreDomain");
    }
  });

  it("refuses a typo at the current version", () => {
    // `colourToken` sitting there spelt wrong and silently ignored is how an
    // engine renders grey while its manifest looks correct.
    const result = parseEngineManifest({ ...minimal, colourToken: "engine-teal" });
    expect(result.ok).toBe(false);
  });

  it("accepts a manifest from a newer console, dropping what it cannot read", () => {
    // One upgraded engine must not blank the dashboard — including the seven
    // engines that are fine.
    const result = parseEngineManifest({
      ...minimal,
      manifestVersion: MANIFEST_VERSION + 1,
      soundProfile: "hum",
      threeDModel: "engine.glb",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedFields.sort()).toEqual(["soundProfile", "threeDModel"]);
    expect(result.manifest.name).toBe("New Thing");
  });

  it("still refuses a newer manifest whose known fields are wrong", () => {
    // Forward tolerance is about fields, not about validity. A future manifest
    // with an unusable id is unusable now.
    const result = parseEngineManifest({
      ...minimal,
      manifestVersion: MANIFEST_VERSION + 1,
      id: "Not A Valid Id",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses things that are not manifests", () => {
    for (const junk of [null, undefined, 42, "prime", [], [minimal]]) {
      expect(parseEngineManifest(junk).ok, JSON.stringify(junk)).toBe(false);
    }
  });
});

describe("the registry", () => {
  it("keeps rendering the good manifests when one is broken", () => {
    const registry = createEngineRegistry([primeManifest, { id: "??" }, forgeIqManifest]);
    expect(registry.all.map((m) => m.id)).toEqual(["prime", "forgeiq"]);
    expect(registry.problems).toHaveLength(1);
    expect(registry.problems[0]?.at).toBe("??");
  });

  it("keeps the first of two manifests claiming one id, and says so", () => {
    // Otherwise telemetry from that engine lights up whichever the loop reached
    // first, which is a coin toss dressed as a dashboard.
    const registry = createEngineRegistry([primeManifest, { ...primeManifest, name: "Impostor" }]);
    expect(registry.all).toHaveLength(1);
    expect(registry.all[0]?.name).toBe("Prime");
    expect(registry.problems[0]?.error).toContain("Duplicate");
  });

  it("counts engines as engines and nothing else", () => {
    // Tracking and notifications were deliberately not made engines. "8 of 8
    // engines online" has to mean engines, or the decision was cosmetic.
    const registry = createEngineRegistry(SUITE_MANIFESTS);
    expect(registry.engines).toHaveLength(8);
    expect(registry.engines.map((m) => m.id)).toEqual([
      "prime", "forgeiq", "costiq", "visioniq",
      "workorderiq", "receiptiq", "inventoryiq", "order-ingestion",
    ]);
    expect(registry.services.map((m) => m.id)).toEqual(["tracking", "notifications"]);
    expect(registry.all.some((m) => m.kind === "intelligence")).toBe(true);
    expect(registry.problems).toEqual([]);
  });

  it("returns nothing for an engine it has never heard of", () => {
    expect(createEngineRegistry(SUITE_MANIFESTS).get("crystalball")).toBeUndefined();
  });
});

describe("the hive layout", () => {
  const registry = createEngineRegistry(SUITE_MANIFESTS);

  it("puts the one core manifest at the centre and rings the rest", () => {
    const layout = computeHiveLayout(registry);
    expect(layout.core?.engineId).toBe("prime");
    expect(layout.core).toMatchObject({ x: 0, y: 0 });
    expect(layout.ring).toHaveLength(7);
  });

  it("spaces the ring evenly for any number of engines", () => {
    // The reason positions are computed. A layout that only works for seven is
    // a layout that breaks on the eighth, and then somebody puts the new engine
    // in whichever gap looked empty.
    for (const count of [1, 3, 6, 7, 12]) {
      const manifests = [
        primeManifest,
        ...Array.from({ length: count }, (_, i) => ({ ...forgeIqManifest, id: `e${i}` })),
      ];
      const layout = computeHiveLayout(createEngineRegistry(manifests));
      expect(layout.ring, `${count} engines`).toHaveLength(count);
      for (const node of layout.ring) {
        expect(Math.hypot(node.x, node.y)).toBeCloseTo(1, 2);
      }
    }
  });

  it("starts every band at the top, so the arrangement is reproducible", () => {
    // The claim is about ANGLE, not distance: each band opens straight up so
    // the picture is identical run to run. The radius is the band's, and the
    // hive now has more than one.
    const layout = computeHiveLayout(registry);
    for (const band of layout.bands) {
      expect(band.nodes[0]?.x, band.layer).toBeCloseTo(0, 3);
      expect(band.nodes[0]?.y, band.layer).toBeCloseTo(-band.radius, 3);
    }
  });

  it("nests the bands at distinct increasing radii, out to the requested one", () => {
    // Asserting only that the outermost lands on 1 is not enough: a layout that
    // puts EVERY band at 1 satisfies that and has no nesting at all. The
    // distinctness is the claim.
    const layout = computeHiveLayout(registry);
    const radii = layout.bands.map((b) => b.radius);
    expect(radii.length).toBeGreaterThan(1);
    expect(new Set(radii).size).toBe(radii.length);
    expect([...radii]).toEqual([...radii].sort((a, b) => a - b));
    expect(radii.at(-1)).toBeCloseTo(1, 3);
    // Two occupied bands means the inner one sits halfway out, exactly.
    expect(radii).toEqual([0.5, 1]);
  });

  it("collapses to the single ring the hive has always drawn when one band is occupied", () => {
    // The compatibility property: nesting appears only once there is something
    // to nest, so classifying nothing changes nothing.
    const oneBand = createEngineRegistry([
      primeManifest,
      ...Array.from({ length: 4 }, (_, i) => ({ ...forgeIqManifest, id: `e${i}` })),
    ]);
    const layout = computeHiveLayout(oneBand);
    expect(layout.bands).toHaveLength(1);
    for (const node of layout.ring) expect(Math.hypot(node.x, node.y)).toBeCloseTo(1, 3);
  });

  it("orders the bands outward by distance from Prime in the work hierarchy", () => {
    // The band ORDER carries meaning: Cores sit closest to Prime, their
    // engines outside them, packs outside those. `plane` is outermost because
    // an unclassified component has no place in the structure and should look
    // like it. A reordering here would silently redraw those relationships.
    const layered = createEngineRegistry([
      primeManifest,
      { ...forgeIqManifest, id: "unclassified", layer: "plane" as const, coreDomain: null },
      { ...forgeIqManifest, id: "a-core", layer: "core" as const, coreDomain: "finance" as const },
      { ...forgeIqManifest, id: "a-spec", layer: "specialized" as const, coreDomain: "finance" as const },
      { ...forgeIqManifest, id: "a-pack" },
    ]);
    expect(computeHiveLayout(layered).bands.map((b) => b.layer)).toEqual([
      "core",
      "specialized",
      "industry",
      "plane",
    ]);
  });

  it("orders a band by Core, so engines under one Core sit together", () => {
    // Angular adjacency is all the layout may say about the Core relationship
    // from the manifests alone — and it is ordered rather than file-ordered, so
    // moving a manifest in the file does not move the engine on the board.
    const layout = computeHiveLayout(registry);
    const specialized = layout.bands.find((b) => b.layer === "specialized");
    const cores = specialized?.nodes.map((n) => n.coreDomain) ?? [];
    expect(cores.length).toBeGreaterThan(1);
    expect([...cores]).toEqual([...cores].sort());
  });

  it("leaves the hive empty rather than inventing a centre", () => {
    const noCore = createEngineRegistry([{ ...forgeIqManifest, hivePlacement: "ring" }]);
    expect(computeHiveLayout(noCore).core).toBeUndefined();
  });

  it("draws only connections the manifests actually declare", () => {
    // The diagram is the manifests. It cannot claim a connection the system
    // does not have, which is the failure every hand-drawn architecture diagram
    // eventually develops.
    const layout = computeHiveLayout(registry);
    const forgeToCost = layout.edges.find((e) => e.from === "forgeiq" && e.to === "costiq");
    expect(forgeToCost?.eventTypes).toContain("manufacturing.plan.generated");
    expect(layout.edges.some((e) => e.from === "forgeiq" && e.to === "inventoryiq")).toBe(false);
  });

  it("separates edges pointing at an engine that is not deployed", () => {
    // A real condition rather than a bug to hide: one engine deployed, another
    // not. Drawing it anyway would imply a link that is not there.
    const partial = createEngineRegistry([primeManifest, forgeIqManifest]);
    const layout = computeHiveLayout(partial);
    expect(layout.edges.every((e) => e.to !== "inventoryiq")).toBe(true);
    expect(layout.danglingEdges.some((e) => e.to === "inventoryiq")).toBe(true);
  });

  it("types every derived edge and names the source that produced it", () => {
    const layout = computeHiveLayout(registry);
    expect(layout.edges.length).toBeGreaterThan(0);
    for (const edge of layout.edges) {
      expect(edge.relationshipType).toBe("DATA");
      expect(edge.derivedFrom).toBe("manifest.eventMappings");
      // A declared mapping says a route exists, not that anything travelled it.
      expect(edge.active).toBe(false);
    }
  });

  it("reports the five relationship types with no read model bound", () => {
    // The difference the console must not lose: "no authority relationships
    // exist" and "no authority read model is bound" look identical as an empty
    // view, and only one of them is true.
    const layout = computeHiveLayout(registry);
    expect([...layout.unboundRelationshipTypes].sort()).toEqual([
      "AUTHORITY",
      "DEPENDENCY",
      "EVOLUTION",
      "INTERCONNECT",
      "OBSERVATION",
    ]);
  });

  it("draws an authority edge only where a source declared one", () => {
    // Governance authorising an engine is a call the ENGINE makes outward, so
    // event flow would draw this arrow backwards. It is drawn from Governance's
    // own records, pointing authority → subject, or it is not drawn.
    const withAuthority = computeHiveLayout(registry, {
      relationships: [
        {
          from: "prime",
          to: "forgeiq",
          relationshipType: "AUTHORITY",
          derivedFrom: "governance.policies",
          active: false,
        },
      ],
    });
    const authority = withAuthority.edges.filter((e) => e.relationshipType === "AUTHORITY");
    expect(authority).toHaveLength(1);
    expect(authority[0]).toMatchObject({ from: "prime", to: "forgeiq" });
    expect(withAuthority.unboundRelationshipTypes).not.toContain("AUTHORITY");
    // And nothing invents the rest just because one type became available.
    expect(withAuthority.unboundRelationshipTypes).toContain("OBSERVATION");
  });

  it("refuses a relationship whose source cannot produce its type", () => {
    // The rule that makes `derivedFrom` worth having: event mappings cannot
    // produce an authority relationship, so a record claiming they did is
    // rejected rather than drawn with a plausible-looking provenance.
    const result = declaredRelationshipSchema.safeParse({
      from: "prime",
      to: "forgeiq",
      relationshipType: "AUTHORITY",
      derivedFrom: "manifest.eventMappings",
    });
    expect(result.success).toBe(false);
  });

  it("keeps services and the intelligence layer out of the hive", () => {
    const layout = computeHiveLayout(registry);
    const ids = layout.nodes.map((n) => n.engineId);
    expect(ids).not.toContain("tracking");
    expect(ids).not.toContain("ai-intelligence");
  });
});

describe("the shipped manifests", () => {
  it("all parse, so a bad edit fails here rather than on the dashboard", () => {
    for (const manifest of SUITE_MANIFESTS) {
      const result = parseEngineManifest(manifest);
      expect(result.ok, `${manifest.id}: ${result.ok ? "" : result.error}`).toBe(true);
    }
  });

  it("gives each engine its own colour, so two are never confused", () => {
    const engines = SUITE_MANIFESTS.filter((m) => m.kind === "engine");
    const colours = engines.map((m) => m.colorToken);
    expect(new Set(colours).size).toBe(engines.length);
  });

  it("points every event mapping at an engine that exists", () => {
    const ids = new Set(SUITE_MANIFESTS.map((m) => m.id));
    for (const manifest of SUITE_MANIFESTS) {
      for (const mapping of manifest.eventMappings) {
        if (!mapping.to) continue;
        expect(ids.has(mapping.to), `${manifest.id} → ${mapping.to}`).toBe(true);
      }
    }
  });

  it("offers the intelligence panel only where something actually learns", () => {
    // A tab with nothing behind it teaches people the console is decorative.
    const withPanel = SUITE_MANIFESTS
      .filter((m) => m.supportedAdminPanels.includes("intelligence"))
      .map((m) => m.id)
      .sort();
    expect(withPanel).toEqual(["ai-intelligence", "forgeiq", "receiptiq", "visioniq"]);
  });

  it("claims exactly one hive core", () => {
    expect(SUITE_MANIFESTS.filter((m) => m.hivePlacement === "core").map((m) => m.id)).toEqual(["prime"]);
  });
});
