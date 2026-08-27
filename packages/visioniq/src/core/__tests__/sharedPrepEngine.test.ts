import { describe, expect, it } from "vitest";
import { runSharedWorkflowPrep, validateExportFormatForDomain } from "../sharedPrepEngine.js";

const DOMAIN_MATRIX = [
  {
    domain: "laser",
    workflowId: "laser_engraving",
    fallbackFormat: "svg",
    invalidFormat: "png",
    legacyRecipeId: "laser-standard-v1",
    expectedRecipeId: "laser-standard-v2",
  },
  {
    domain: "dtf",
    workflowId: "dtf_print",
    fallbackFormat: "png",
    invalidFormat: "svg",
    legacyRecipeId: "dtf-standard-v1",
    expectedRecipeId: "dtf-standard-v2",
  },
  {
    domain: "uv_uvdtf",
    workflowId: "uv_uvdtf_print",
    fallbackFormat: "tiff",
    invalidFormat: "svg",
    legacyRecipeId: "uv-standard-v1",
    expectedRecipeId: "uv-standard-v2",
  },
  {
    domain: "sublimation",
    workflowId: "sublimation_print",
    fallbackFormat: "png",
    invalidFormat: "svg",
    legacyRecipeId: "sublimation-standard-v1",
    expectedRecipeId: "sublimation-standard-v2",
  },
  {
    domain: "large_format",
    workflowId: "large_format_print",
    fallbackFormat: "pdf",
    invalidFormat: "svg",
    legacyRecipeId: "large-format-standard-v1",
    expectedRecipeId: "large-format-standard-v2",
  },
] as const;

describe("sharedPrepEngine export validation", () => {
  it("accepts supported domain formats", () => {
    const validation = validateExportFormatForDomain("dtf", "png");
    expect(validation.valid).toBe(true);
    expect(validation.resolvedFormat).toBe("png");
  });

  it("falls back to allowed export format when override is incompatible", () => {
    const result = runSharedWorkflowPrep(
      "dtf_print",
      "dtf",
      {
        fileName: "shirt-artwork.png",
        fileType: "image/png",
        widthIn: 12,
        heightIn: 12,
        dpi: 300,
      },
      {
        metadata: {
          exportFormat: "svg",
        },
      },
    );

    const exportPlan = result.metadata.exportPlan as { format: string };
    expect(exportPlan.format).toBe("png");
    expect(result.issues.some((issue) => issue.type === "export_format_mismatch")).toBe(true);
  });

  it("enforces export fallback and emits mismatch issue across all prep domains", () => {
    for (const domainCase of DOMAIN_MATRIX) {
      const result = runSharedWorkflowPrep(
        domainCase.workflowId,
        domainCase.domain,
        {
          fileName: `${domainCase.domain}-artwork.png`,
          fileType: "image/png",
          widthIn: 12,
          heightIn: 10,
          dpi: 300,
          hasTransparency: true,
          rasterLayers: 2,
        },
        {
          metadata: {
            exportFormat: domainCase.invalidFormat,
          },
        },
      );

      const exportPlan = result.metadata.exportPlan as { format: string };
      expect(exportPlan.format).toBe(domainCase.fallbackFormat);
      expect(result.issues.some((issue) => issue.type === "export_format_mismatch")).toBe(true);
    }
  });

  it("includes integrated color plan and preflight outputs for workflow execution", () => {
    const result = runSharedWorkflowPrep("dtf_print", "dtf", {
      fileName: "dtf-sheet.png",
      fileType: "image/png",
      widthIn: 12,
      heightIn: 10,
      dpi: 300,
      hasTransparency: true,
      rasterLayers: 2,
    });

    const colorPlan = result.metadata.colorPlan as { profileName: string; previewMode: string };
    const preflightPlan = result.metadata.preflightPlan as { validations: string[]; proofEnabled: boolean };
    const preflightResult = result.metadata.preflightResult as { notes: string[]; checksRun: string[] };

    expect(colorPlan.profileName).toBeTruthy();
    expect(colorPlan.previewMode).toBe("soft-proof");
    expect(preflightPlan.proofEnabled).toBe(true);
    expect(preflightPlan.validations.length).toBeGreaterThan(0);
    expect(preflightResult.checksRun.length).toBeGreaterThan(0);
    expect(preflightResult.notes.some((note) => note.startsWith("Recipe:"))).toBe(true);
  });

  it("reports recipe migration metadata when legacy recipe id is requested", () => {
    const result = runSharedWorkflowPrep(
      "dtf_print",
      "dtf",
      {
        fileName: "legacy-recipe-dtf.png",
        fileType: "image/png",
        widthIn: 11,
        heightIn: 11,
        dpi: 300,
      },
      {
        metadata: {
          recipeId: "dtf-standard-v1",
        },
      },
    );

    const recipe = result.metadata.recipe as { id: string };
    const migration = result.metadata.recipeMigration as { from: string; to: string } | null;

    expect(recipe.id).toBe("dtf-standard-v2");
    expect(result.metadata.requestedRecipeId).toBe("dtf-standard-v1");
    expect(result.metadata.resolvedRecipeId).toBe("dtf-standard-v2");
    expect(migration).toEqual({ from: "dtf-standard-v1", to: "dtf-standard-v2" });
  });

  it("includes integrated color and preflight metadata across all prep domains", () => {
    for (const domainCase of DOMAIN_MATRIX) {
      const result = runSharedWorkflowPrep(domainCase.workflowId, domainCase.domain, {
        fileName: `${domainCase.domain}-integration.png`,
        fileType: "image/png",
        widthIn: 11,
        heightIn: 9,
        dpi: 300,
        hasTransparency: true,
        rasterLayers: 2,
      });

      const colorPlan = result.metadata.colorPlan as { profileName: string; previewMode: string };
      const preflightPlan = result.metadata.preflightPlan as {
        validations: string[];
        proofEnabled: boolean;
      };
      const preflightResult = result.metadata.preflightResult as {
        notes: string[];
        checksRun: string[];
      };

      expect(colorPlan.profileName).toBeTruthy();
      expect(["soft-proof", "standard"]).toContain(colorPlan.previewMode);
      expect(typeof preflightPlan.proofEnabled).toBe("boolean");
      expect(preflightPlan.validations.length).toBeGreaterThan(0);
      expect(preflightResult.checksRun.length).toBeGreaterThan(0);
      expect(preflightResult.notes.some((note) => note.startsWith("Recipe:"))).toBe(true);
    }
  });

  it("resolves legacy recipe ids across all prep domains", () => {
    for (const domainCase of DOMAIN_MATRIX) {
      const result = runSharedWorkflowPrep(
        domainCase.workflowId,
        domainCase.domain,
        {
          fileName: `${domainCase.domain}-legacy-recipe.png`,
          fileType: "image/png",
          widthIn: 11,
          heightIn: 11,
          dpi: 300,
        },
        {
          metadata: {
            recipeId: domainCase.legacyRecipeId,
          },
        },
      );

      const recipe = result.metadata.recipe as { id: string };
      const migration = result.metadata.recipeMigration as { from: string; to: string } | null;

      expect(recipe.id).toBe(domainCase.expectedRecipeId);
      expect(result.metadata.requestedRecipeId).toBe(domainCase.legacyRecipeId);
      expect(result.metadata.resolvedRecipeId).toBe(domainCase.expectedRecipeId);
      expect(migration).toEqual({
        from: domainCase.legacyRecipeId,
        to: domainCase.expectedRecipeId,
      });
    }
  });
});
