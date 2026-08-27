import { describe, expect, it } from "vitest";
import { runValidation } from "../src/core/validation/validationEngine";
import type { SurfaceElement } from "../src/core/schemas/configuration";
import { baseConfig, definition, machine, materials } from "./helpers";

const validate = (config = baseConfig(), def = definition, mach = machine) =>
  runValidation({ definition: def, configuration: config, materials, machine: mach });

// Counter-free text ("SMITH") so the text-enclosed-counters warning doesn't
// fire in tests that expect a clean result.
const text = (over: Partial<Extract<SurfaceElement, { type: "text" }>> = {}): SurfaceElement => ({
  id: "t1",
  type: "text",
  text: "SMITH",
  fontFamily: "Arial",
  xIn: 6,
  yIn: 6,
  heightIn: 2,
  rotationDeg: 0,
  ...over,
});

const image = (over: Partial<Extract<SurfaceElement, { type: "image" }>> = {}): SurfaceElement => ({
  id: "i1",
  type: "image",
  url: "/u/x.png",
  naturalWidthPx: 3000,
  naturalHeightPx: 1500,
  xIn: 6,
  yIn: 6,
  widthIn: 6,
  heightIn: 3,
  rotationDeg: 0,
  ...over,
});

describe("validation rules", () => {
  it("passes a clean configuration", () => {
    const r = validate(baseConfig({ surfaces: { front: [text(), image()] } }));
    expect(r.issues).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("surface-bounds: errors off-surface, warns inside safe area", () => {
    const off = validate(baseConfig({ surfaces: { front: [text({ xIn: 20, yIn: 6 })] } }));
    expect(off.valid).toBe(false);
    expect(off.issues[0]).toMatchObject({ rule: "surface-bounds", severity: "error", surfaceId: "front", elementId: "t1" });

    const nearEdge = validate(baseConfig({ surfaces: { front: [image({ xIn: 0.1, yIn: 6 })] } }));
    expect(nearEdge.valid).toBe(true);
    expect(nearEdge.issues[0]).toMatchObject({ rule: "surface-bounds", severity: "warning" });
  });

  it("surface-bounds: rotation expands the bounding box", () => {
    // A 6×3 image near the right edge fits unrotated; rotated 45° its AABB
    // (half-width (6+3)·cos45°/2 ≈ 3.18") crosses the 24" panel edge.
    const el = image({ xIn: 17.9, yIn: 6, widthIn: 6, heightIn: 3 });
    expect(validate(baseConfig({ surfaces: { front: [el] } })).valid).toBe(true);
    const rotated = { ...el, rotationDeg: 45 };
    const r = validate(baseConfig({ surfaces: { front: [rotated] } }));
    expect(r.issues.some((i) => i.rule === "surface-bounds" && i.severity === "error")).toBe(true);
  });

  it("text-min-height: errors below the constraint", () => {
    const r = validate(baseConfig({ surfaces: { front: [text({ heightIn: 0.25 })] } }));
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.rule === "text-min-height")).toBe(true);
    expect(validate(baseConfig({ surfaces: { front: [text({ heightIn: 0.375 })] } })).valid).toBe(true);
  });

  it("image-resolution: warns on low DPI", () => {
    const r = validate(
      baseConfig({ surfaces: { front: [image({ naturalWidthPx: 300, naturalHeightPx: 150 })] } }),
    );
    expect(r.valid).toBe(true); // warning only
    expect(r.issues.some((i) => i.rule === "image-resolution" && i.severity === "warning")).toBe(true);
  });

  it("material-allowed: errors when the selected material is not in the allow list", () => {
    const def = structuredClone(definition);
    def.allowedMaterialProfileIds = [999];
    const r = validate(baseConfig(), def);
    expect(r.issues.some((i) => i.rule === "material-allowed" && i.severity === "error")).toBe(true);
  });

  it("machine-material-compat: errors on category and thickness mismatches", () => {
    const wrongCat = validate(baseConfig(), definition, {
      ...machine,
      compatibleMaterialCategories: ["acrylic"],
    });
    expect(wrongCat.issues.some((i) => i.rule === "machine-material-compat")).toBe(true);

    const tooThick = validate(baseConfig(), definition, {
      ...machine,
      maxMaterialThicknessIn: 0.1,
    });
    expect(tooThick.issues.some((i) => i.rule === "machine-material-compat")).toBe(true);
  });

  it("machine-work-area: errors when a panel cannot fit in any orientation", () => {
    const small = validate(baseConfig(), definition, {
      ...machine,
      workAreaWidthIn: 20,
      workAreaHeightIn: 20,
    });
    expect(small.issues.some((i) => i.rule === "machine-work-area" && i.severity === "error")).toBe(true);

    // 24×18 panel fits a 18×24 machine via rotation.
    const rotatedFit = validate(baseConfig(), definition, {
      ...machine,
      workAreaWidthIn: 18,
      workAreaHeightIn: 24,
    });
    expect(rotatedFit.issues.some((i) => i.rule === "machine-work-area")).toBe(false);
  });
});
