import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOperatorPresets,
  getOperatorRecipeVariant,
  resolveRecipeId,
  setOperatorRecipeVariant,
} from "../recipeEngine.js";

describe("recipeEngine", () => {
  beforeEach(() => {
    clearOperatorPresets();
  });

  it("migrates legacy v1 recipe ids to v2 ids", () => {
    expect(resolveRecipeId("dtf-standard-v1", "dtf")).toBe("dtf-standard-v2");
    expect(resolveRecipeId("uv-standard-v1", "uv_uvdtf")).toBe("uv-standard-v2");
  });

  it("applies operator variants on top of shared presets", () => {
    setOperatorRecipeVariant("operator_1", "dtf", {
      recipeId: "dtf-standard-v2",
      operatorId: "operator_1",
      customizations: {
        additionalMaterials: ["cold-peel"],
        advancedNotes: "Use softer pressure for thin PET stock.",
      },
    });

    const resolved = getOperatorRecipeVariant("dtf", "operator_1");

    expect(resolved.id).toBe("dtf-standard-v2");
    expect(resolved.materialDefaults).toContain("cold-peel");
    expect(resolved.operatorNotes).toContain("Use softer pressure");
  });
});
