import { describe, expect, it } from "vitest";
import { runValidation } from "../src/core/validation/validationEngine";
import type { SurfaceElement } from "../src/core/schemas/configuration";
import { baseConfig, definition, machine, materials } from "./helpers";

const validate = (surfaces: Record<string, SurfaceElement[]>, def = definition) =>
  runValidation({
    definition: def,
    configuration: baseConfig({ surfaces }),
    materials,
    machine,
  });

describe("artwork-islands rule", () => {
  const ringImage = (interiorIslands?: number): SurfaceElement => ({
    id: "i1",
    type: "image",
    url: "/uploads/ring.png",
    naturalWidthPx: 2000,
    naturalHeightPx: 2000,
    interiorIslands,
    xIn: 8,
    yIn: 6,
    widthIn: 5,
    heightIn: 5,
    rotationDeg: 0,
  });

  it("warns when traced artwork has enclosed holes", () => {
    const r = validate({ front: [ringImage(1)] });
    const issue = r.issues.find((i) => i.rule === "artwork-islands");
    expect(issue).toMatchObject({ severity: "warning", surfaceId: "front", elementId: "i1" });
    expect(issue?.message).toContain("1 enclosed area");
    expect(r.valid).toBe(true); // warning, not error
  });

  it("stays quiet with no holes or untraceable art", () => {
    expect(validate({ front: [ringImage(0)] }).issues.some((i) => i.rule === "artwork-islands")).toBe(false);
    expect(validate({ front: [ringImage(undefined)] }).issues.some((i) => i.rule === "artwork-islands")).toBe(false);
  });

  it("does not fire for non-cut processes", () => {
    const engraveDef = structuredClone(definition);
    engraveDef.manufacturingProcess = "uv-print";
    expect(
      validate({ front: [ringImage(3)] }, engraveDef).issues.some((i) => i.rule === "artwork-islands"),
    ).toBe(false);
  });
});

describe("text-enclosed-counters rule", () => {
  const text = (t: string): SurfaceElement => ({
    id: "t1",
    type: "text",
    text: t,
    fontFamily: "Arial",
    xIn: 6,
    yIn: 6,
    heightIn: 2,
    rotationDeg: 0,
  });

  it("warns for letters with enclosed counters", () => {
    const r = validate({ front: [text("THOMPSON")] }); // O has a counter
    const issue = r.issues.find((i) => i.rule === "text-enclosed-counters");
    expect(issue).toMatchObject({ severity: "warning", elementId: "t1" });
    expect(r.valid).toBe(true);
  });

  it("stays quiet for counter-free text", () => {
    expect(
      validate({ front: [text("SMITH")] }).issues.some((i) => i.rule === "text-enclosed-counters"),
    ).toBe(false);
  });
});
