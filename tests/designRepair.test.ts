import { describe, expect, it } from "vitest";
import { runValidation } from "../src/core/validation/validationEngine";
import { applyRepairs, suggestRepairs } from "../src/core/repair/designRepair";
import { bridgeClosedPath, suggestBridgeCount } from "../src/core/export/bridges";
import type { ProductConfiguration, SurfaceElement } from "../src/core/schemas/configuration";
import { baseConfig, definition, machine, materials } from "./helpers";

const validate = (config: ProductConfiguration, def = definition) =>
  runValidation({ definition: def, configuration: config, materials, machine });

const repairsFor = (config: ProductConfiguration, def = definition) =>
  suggestRepairs(validate(config, def).issues, { definition: def, configuration: config });

describe("design repair service", () => {
  it("enlarges text below the minimum cut height", () => {
    const config = baseConfig({
      surfaces: {
        front: [
          { id: "t1", type: "text", text: "SMITH", fontFamily: "Arial", xIn: 6, yIn: 6, heightIn: 0.2, rotationDeg: 0 },
        ],
      },
    });
    expect(validate(config).valid).toBe(false);

    const repairs = repairsFor(config);
    const repair = repairs.find((r) => r.rule === "text-min-height");
    expect(repair?.label).toBe("Enlarge text");

    const fixed = applyRepairs(config, repairs);
    const el = fixed.surfaces.front[0];
    expect(el.type === "text" && el.heightIn).toBe(definition.constraints.minTextHeightIn);
    expect(validate(fixed).valid).toBe(true);
    // The original configuration is untouched.
    expect(config.surfaces.front[0].heightIn).toBe(0.2);
  });

  it("moves an out-of-bounds element back inside the safe area", () => {
    const config = baseConfig({
      surfaces: {
        front: [
          { id: "i1", type: "image", url: "/u/a.png", naturalWidthPx: 3000, naturalHeightPx: 3000, xIn: 21, yIn: 2, widthIn: 5, heightIn: 5, rotationDeg: 0 },
        ],
      },
    });
    expect(validate(config).valid).toBe(false);

    const fixed = applyRepairs(config, repairsFor(config));
    const el = fixed.surfaces.front[0] as Extract<SurfaceElement, { type: "image" }>;
    // 24" panel, 0.75" safe area, 5" wide → must sit at or left of 18.25"
    expect(el.xIn).toBeLessThanOrEqual(18.25);
    expect(el.widthIn).toBe(5); // moved, not resized
    expect(validate(fixed).valid).toBe(true);
  });

  it("resizes an element too large for the panel instead of moving it", () => {
    const config = baseConfig({
      surfaces: {
        front: [
          { id: "i1", type: "image", url: "/u/a.png", naturalWidthPx: 6000, naturalHeightPx: 6000, xIn: 0, yIn: 0, widthIn: 30, heightIn: 30, rotationDeg: 0 },
        ],
      },
    });
    const repair = repairsFor(config).find((r) => r.rule === "surface-bounds");
    expect(repair?.label).toBe("Resize to fit");

    const fixed = applyRepairs(config, repairsFor(config));
    const el = fixed.surfaces.front[0] as Extract<SurfaceElement, { type: "image" }>;
    expect(el.widthIn).toBeLessThanOrEqual(22.5); // 24 − 2×0.75
    expect(validate(fixed).valid).toBe(true);
  });

  it("shrinks low-resolution artwork to reach the minimum DPI", () => {
    const config = baseConfig({
      surfaces: {
        front: [
          { id: "i1", type: "image", url: "/u/small.png", naturalWidthPx: 300, naturalHeightPx: 300, xIn: 2, yIn: 2, widthIn: 6, heightIn: 6, rotationDeg: 0 },
        ],
      },
    });
    expect(validate(config).issues.some((i) => i.rule === "image-resolution")).toBe(true);

    const fixed = applyRepairs(config, repairsFor(config));
    const el = fixed.surfaces.front[0] as Extract<SurfaceElement, { type: "image" }>;
    // 300px at 150 DPI minimum → 2" maximum
    expect(el.widthIn).toBeCloseTo(2, 2);
    expect(validate(fixed).issues.some((i) => i.rule === "image-resolution")).toBe(false);
  });

  it("switches to a smaller size when panels exceed the machine", () => {
    const smallMachine = { ...machine, workAreaWidthIn: 20, workAreaHeightIn: 20 };
    const config = baseConfig();
    const issues = runValidation({
      definition,
      configuration: config,
      materials,
      machine: smallMachine,
    }).issues;
    const repairs = suggestRepairs(issues, { definition, configuration: config });
    const repair = repairs.find((r) => r.rule === "machine-work-area");
    expect(repair?.label).toBe('Switch to 20"');

    const fixed = repair!.apply(config);
    expect(fixed.selections.size).toBe("size_20");
    expect(
      runValidation({ definition, configuration: fixed, materials, machine: smallMachine }).valid,
    ).toBe(true);
  });

  it("offers nothing when the design is already clean", () => {
    expect(repairsFor(baseConfig())).toEqual([]);
  });
});

describe("bridge generation", () => {
  // 4" square ring hole, in inch space.
  const square: { x: number; y: number }[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ];

  it("splits a closed path into open runs separated by tabs", () => {
    const runs = bridgeClosedPath(square, { bridgeWidthIn: 0.1 });
    // 16" perimeter → 6 bridges → 6 cut runs
    expect(suggestBridgeCount(16)).toBe(6);
    expect(runs).toHaveLength(6);
    // Every run is open (no Z) and has real length.
    for (const run of runs) expect(run.length).toBeGreaterThan(1);
  });

  it("leaves total cut length close to the perimeter minus the tabs", () => {
    const runs = bridgeClosedPath(square, { bridgeWidthIn: 0.1 });
    const cutLength = runs.reduce((sum, run) => {
      let d = 0;
      for (let i = 1; i < run.length; i++) {
        d += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
      }
      return sum + d;
    }, 0);
    // 16" perimeter − 6 tabs × 0.1" = 15.4", within sampling tolerance
    expect(cutLength).toBeGreaterThan(15.0);
    expect(cutLength).toBeLessThan(15.8);
  });

  it("does not bridge a shape too small to survive tabs", () => {
    const tiny = [
      { x: 0, y: 0 },
      { x: 0.1, y: 0 },
      { x: 0.1, y: 0.1 },
      { x: 0, y: 0.1 },
    ];
    const runs = bridgeClosedPath(tiny, { bridgeWidthIn: 0.1 });
    expect(runs).toHaveLength(1); // single closed ring, untouched
  });
});
