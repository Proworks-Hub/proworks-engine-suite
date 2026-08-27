// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";
import {
  assetsForMachineClass,
  humanFacingAssets,
  isCachedAssetCurrent,
  requiresReview,
  validateProductionAssetManifest,
  type ProductionAsset,
  type ProductionAssetManifest,
} from "../productionAsset.js";

const asset = (over: Partial<ProductionAsset> = {}): ProductionAsset => ({
  assetId: "asset_1",
  role: "cutline",
  machineClass: "fiber_laser",
  uri: "s3://assets/asset_1.svg",
  filename: "firepit-panel-cutline.svg",
  mediaType: "image/svg+xml",
  version: 1,
  checksum: "sha256:abc",
  ...over,
});

const manifest = (assets: ProductionAsset[]): ProductionAssetManifest => ({
  manifestVersion: 1,
  organizationId: "org-a",
  subjectRef: "WO-10284",
  subjectType: "work_order",
  producedBy: { engine: "forgeiq", version: "0.9.0" },
  generatedAt: "2026-08-27T12:00:00.000Z",
  assets,
});

describe("declaring what a file is for", () => {
  it("routes on the declared role, never on the filename", () => {
    // The failure this replaces: KSix infers the machine by matching
    // `-cutline.svg` and friends against a regex cascade. Rename the file and
    // the work goes to the wrong machine, silently.
    const misleading = asset({
      filename: "final-print-ready-ARTWORK.svg",
      role: "cutline",
      machineClass: "fiber_laser",
    });

    const forLaser = assetsForMachineClass(manifest([misleading]), "fiber_laser");
    expect(forLaser).toHaveLength(1);
    // The name says print. The declaration says cutline, and the declaration wins.
    expect(assetsForMachineClass(manifest([misleading]), "uv_printer")).toHaveLength(0);
  });

  it("keeps proofs and documents away from machines", () => {
    // Sending a proof to a laser is recoverable and avoidable. The role field
    // is what avoids it.
    const assets = [
      asset({ assetId: "a1", role: "cutline", machineClass: "fiber_laser" }),
      asset({ assetId: "a2", role: "proof", machineClass: "none", filename: "proof.png" }),
      asset({ assetId: "a3", role: "document", machineClass: "none", filename: "order-info.txt" }),
    ];

    expect(assetsForMachineClass(manifest(assets), "fiber_laser").map((a) => a.assetId)).toEqual([
      "a1",
    ]);
    expect(humanFacingAssets(manifest(assets)).map((a) => a.assetId)).toEqual(["a2", "a3"]);
  });

  it("surfaces what nobody could classify instead of filing it somewhere", () => {
    // A producer that does not know should say so. Guessing a machine folder
    // from a filename is what put the wrong file on a machine in the first
    // place.
    const assets = [
      asset({ assetId: "a1" }),
      asset({ assetId: "a2", role: "unclassified", machineClass: "none" }),
    ];

    expect(requiresReview(manifest(assets)).map((a) => a.assetId)).toEqual(["a2"]);
  });

  it("preserves the order the producer emitted", () => {
    // A registration mark before the print it registers is deliberate.
    // Re-sorting on some sensible key is how a folder stops matching the run
    // sheet.
    const assets = [
      asset({ assetId: "reg", role: "registration", machineClass: "uv_printer" }),
      asset({ assetId: "art", role: "print", machineClass: "uv_printer" }),
    ];

    expect(assetsForMachineClass(manifest(assets), "uv_printer").map((a) => a.assetId)).toEqual([
      "reg",
      "art",
    ]);
  });

  it("names a machine CLASS, never a machine", () => {
    // Which physical laser runs it depends on what is free and who is on
    // shift — live facts an engine cannot see.
    expect(() =>
      validateProductionAssetManifest(
        manifest([asset({ machineClass: "fiber-laser-2" as never })]),
      ),
    ).toThrow();
  });

  it("records what produced it, because assets outlive the code that made them", () => {
    // When a cut line turns out wrong six months later, the first question is
    // what generated it.
    const parsed = validateProductionAssetManifest(manifest([asset()]));
    expect(parsed.producedBy).toEqual({ engine: "forgeiq", version: "0.9.0" });
  });

  it("refuses a field nobody declared", () => {
    expect(() =>
      validateProductionAssetManifest({ ...manifest([asset()]), machineId: "laser-2" }),
    ).toThrow();
  });
});

describe("a cached copy is a representation, not a truth", () => {
  it("accepts a copy that matches version and checksum", () => {
    expect(isCachedAssetCurrent({ version: 1, checksum: "sha256:abc" }, asset())).toBe(true);
  });

  it("rejects a copy of an older version", () => {
    // The station kept working through an outage and the artwork changed.
    expect(isCachedAssetCurrent({ version: 1, checksum: "sha256:abc" }, asset({ version: 2 }))).toBe(
      false,
    );
  });

  it("rejects a copy whose bytes disagree at the same version", () => {
    expect(
      isCachedAssetCurrent({ version: 1, checksum: "sha256:different" }, asset()),
    ).toBe(false);
  });

  it("does not treat a missing checksum as proof of anything", () => {
    // Only compared when both sides have one. Treating absent as matching
    // would make the check quietly meaningless — which is worse than not
    // having it, because somebody would trust it.
    expect(isCachedAssetCurrent({ version: 1 }, asset({ checksum: undefined }))).toBe(true);
    expect(isCachedAssetCurrent({ version: 2 }, asset({ checksum: undefined }))).toBe(false);
  });
});
