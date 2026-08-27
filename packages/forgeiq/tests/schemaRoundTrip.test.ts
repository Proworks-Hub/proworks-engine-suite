import { describe, expect, it } from "vitest";
import { productDefinitionSchema } from "../src/core/schemas/productDefinition";
import { productConfigurationSchema } from "../src/core/schemas/configuration";
import { machineProfileSpecsSchema } from "../src/core/schemas/machineProfile";
import { materialProfileSpecsSchema } from "../src/core/schemas/materialProfile";
import { baseConfig, definition, machine, materials } from "./helpers";

describe("schema round trips", () => {
  it("accepts the demo fire pit definition", () => {
    const parsed = productDefinitionSchema.parse(definition);
    expect(parsed.slug).toBe("firepit-24");
    expect(parsed.surfaces).toHaveLength(4);
    expect(parsed.optionGroups.map((g) => g.id)).toEqual([
      "size",
      "material",
      "finish",
      "style",
    ]);
  });

  it("accepts demo machine and material specs", () => {
    expect(machineProfileSpecsSchema.parse(machine).process).toBe("fiber-laser");
    for (const specs of materials.values()) {
      expect(materialProfileSpecsSchema.parse(specs).thicknessIn).toBeGreaterThan(0);
    }
  });

  it("accepts a configuration with elements and applies defaults", () => {
    const parsed = productConfigurationSchema.parse({
      selections: baseConfig().selections,
      surfaces: {
        front: [
          { id: "t1", type: "text", text: "THOMPSON", xIn: 4, yIn: 5, heightIn: 3 },
          {
            id: "i1",
            type: "image",
            url: "/uploads/x.png",
            naturalWidthPx: 2000,
            naturalHeightPx: 1000,
            xIn: 2,
            yIn: 9,
            widthIn: 6,
            heightIn: 3,
          },
        ],
      },
      quantity: 1,
    });
    const text = parsed.surfaces.front[0];
    expect(text.type === "text" && text.fontFamily).toBe("Arial");
    expect(text.rotationDeg).toBe(0);
  });

  it("rejects a definition with a bad slug and a config with an unknown element type", () => {
    expect(
      productDefinitionSchema.safeParse({ ...definition, slug: "Fire Pit!" }).success,
    ).toBe(false);
    const bad = productConfigurationSchema.safeParse({
      selections: {},
      surfaces: { front: [{ id: "x", type: "video" }] },
      quantity: 1,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects zero/negative quantity", () => {
    expect(
      productConfigurationSchema.safeParse({ selections: {}, surfaces: {}, quantity: 0 })
        .success,
    ).toBe(false);
  });
});
