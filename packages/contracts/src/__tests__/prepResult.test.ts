// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PREP_RESULT_SCHEMA_VERSION,
  blockingIssues,
  isProductionReady,
  prepResultToProductionAsset,
  prepResultsToManifest,
  validatePrepResult,
  type PrepResult,
} from "../prepResult.js";
import { validateProductionAssetManifest } from "../productionAsset.js";

const result = (over: Partial<PrepResult> = {}): PrepResult => ({
  id: "prep_1",
  schemaVersion: CURRENT_PREP_RESULT_SCHEMA_VERSION,
  workspaceId: "ws-1",
  source: "ksix-prep-studio",
  originalFileName: "family-photo.jpg",
  processedFileUrl: "s3://prepared/prep_1.png",
  fileType: "image/png",
  width: 3300,
  height: 2550,
  dpi: 300,
  machinePreset: "DTF",
  readinessScore: 88,
  issues: [],
  recommendations: [],
  recipeUsed: "dtf-standard-v2",
  createdAt: "2026-08-27T12:00:00.000Z",
  ...over,
});

describe("the contract both repos already agreed on", () => {
  it("accepts a result from either Studio", () => {
    expect(() => validatePrepResult(result())).not.toThrow();
    expect(() => validatePrepResult(result({ source: "prep-studio" }))).not.toThrow();
  });

  it("accepts a source neither Studio produced", () => {
    // The original union named two specific Studios. A closed list would make
    // the contract refuse the third-party licensee VisionIQ is being extracted
    // for — which is the opposite of the point.
    expect(() => validatePrepResult(result({ source: "acme-prep-service" }))).not.toThrow();
  });

  it("refuses a field nobody declared", () => {
    expect(() =>
      validatePrepResult({ ...result(), internalCostCents: 400 }),
    ).toThrow();
  });

  it("keeps the recipe migration trail", () => {
    // Recipes have already migrated once in the host. Losing which recipe was
    // asked for versus which ran would make a changed output unexplainable.
    const migrated = validatePrepResult(
      result({ recipeRequested: "dtf-standard-v1", recipeUsed: "dtf-standard-v2", recipeMigrationFrom: "dtf-standard-v1" }),
    );
    expect(migrated.recipeMigrationFrom).toBe("dtf-standard-v1");
  });
});

describe("deciding whether it can run", () => {
  it("clears a clean, confident result", () => {
    expect(isProductionReady(result())).toBe(true);
  });

  it("blocks on a critical issue however high the score", () => {
    // A high score alongside a critical issue means the scorer and the checker
    // disagree, and when they disagree the safe reading is the pessimistic one.
    const conflicted = result({
      readinessScore: 99,
      issues: [{ type: "resolution", severity: "critical", message: "72 DPI at 11 inches" }],
    });

    expect(isProductionReady(conflicted)).toBe(false);
    expect(blockingIssues(conflicted)).toHaveLength(1);
  });

  it("does not run on warnings alone", () => {
    const warned = result({
      readinessScore: 85,
      issues: [{ type: "contrast", severity: "warning", message: "low contrast for slate" }],
    });
    expect(isProductionReady(warned)).toBe(true);
    expect(blockingIssues(warned)).toEqual([]);
  });

  it("refuses to guess when nothing scored it", () => {
    // Absent is not the same as good. A result nobody scored is one a human
    // should look at.
    expect(isProductionReady(result({ readinessScore: undefined }))).toBe(false);
  });
});

describe("bridging to a production manifest", () => {
  it("derives physical size from pixels and effective DPI", () => {
    const asset = prepResultToProductionAsset(result(), "dtf_printer");

    expect(asset?.dimensions).toEqual({ widthIn: 11, heightIn: 8.5 });
    expect(asset?.dpi).toBe(300);
    expect(asset?.machineClass).toBe("dtf_printer");
  });

  it("takes the machine class from the caller, not from the preset name", () => {
    // A preset is a host's label — "DTF", whatever a shop typed. Inferring a
    // machine class from it is filename-sniffing wearing a different hat.
    const asset = prepResultToProductionAsset(
      result({ machinePreset: "DTF" }),
      "uv_printer",
    );
    expect(asset?.machineClass).toBe("uv_printer");
    expect(asset?.meta?.["machinePreset"]).toBe("DTF");
  });

  it("produces nothing when there is no processed file", () => {
    // A prep run that produced only findings has no asset. Inventing an entry
    // with an empty URI puts a broken row in front of an operator.
    expect(prepResultToProductionAsset(result({ processedFileUrl: "" }), "dtf_printer"))
      .toBeUndefined();
  });

  it("omits dimensions rather than dividing by a DPI it does not have", () => {
    const asset = prepResultToProductionAsset(result({ dpi: undefined }), "dtf_printer");
    expect(asset?.dimensions).toBeUndefined();
  });

  it("collects several results into one valid manifest", () => {
    const manifest = prepResultsToManifest(
      [
        { result: result(), machineClass: "dtf_printer" },
        { result: result({ id: "prep_2" }), machineClass: "co2_laser", role: "engrave" },
        // Contributes nothing — no processed file.
        { result: result({ id: "prep_3", processedFileUrl: "" }), machineClass: "cutter" },
      ],
      {
        organizationId: "ws-1",
        subjectRef: "WO-1",
        subjectType: "work_order",
        producedBy: { engine: "visioniq", version: "0.9.0" },
        generatedAt: "2026-08-27T12:00:00.000Z",
      },
    );

    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[1]?.role).toBe("engrave");
    expect(() => validateProductionAssetManifest(manifest)).not.toThrow();
  });
});
