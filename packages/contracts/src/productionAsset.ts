// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Production assets — the files that actually reach a machine.
//
// WHAT THIS REPLACES, AND WHY IT IS NOT SPECULATION.
//
// KSix routes production files to machines by running a regex cascade over
// FILENAMES: `-cutline.svg` goes to a laser, `cutcontour.svg` to the plotter,
// `-engrave-` to whichever laser the material implies. It works, and it is
// fragile in a specific way — the producer knew exactly what the file was for,
// and threw that knowledge away, leaving a consumer to reconstruct it from a
// string. Rename a file and the work goes to the wrong machine, silently.
//
// A manifest inverts that: whatever generates an asset DECLARES its role, and
// nothing downstream ever parses a filename to find out.
//
// WHAT THIS IS NOT. It is not VisionIQ. VisionIQ is an engine that has not been
// specified yet, and guessing its domain would be the expensive kind of wrong.
// This is the SEAM — the contract a producer emits and a host consumes. ForgeIQ
// already produces cut lines and engrave layers; it can emit manifests today.
// When VisionIQ exists it emits the same shape.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a file is FOR. Declared by whatever made it.
 *
 * Deliberately about intent rather than format: an SVG can be a cut line, an
 * engrave layer or a proof, and the format cannot tell them apart. That is
 * precisely the ambiguity filename-sniffing has to guess at.
 */
export const assetRoleSchema = z.enum([
  /** Vector geometry a machine cuts along. */
  "cutline",
  /** Vector or raster to be engraved or etched. */
  "engrave",
  /** Artwork to be printed. */
  "print",
  /** The contour a plotter follows around a printed sheet. */
  "cut_contour",
  /** A registration or alignment aid. */
  "registration",
  /** Shown to a customer for approval. Never sent to a machine. */
  "proof",
  /** Read by a person: job sheets, packing lists, order info. */
  "document",
  /** Internal preview or thumbnail. */
  "preview",
  /** Produced but not yet classified. Requires a human before it runs. */
  "unclassified",
]);
export type AssetRole = z.infer<typeof assetRoleSchema>;

/**
 * The CLASS of machine an asset is destined for — never a specific machine.
 *
 * Which physical laser runs a job depends on what is free, what is already set
 * up, and who is on shift. That is a scheduling decision a host makes with
 * live information, and an engine that named a machine would be guessing at
 * facts it cannot see. The same rule that keeps routing separate from dispatch.
 */
export const machineClassSchema = z.enum([
  "fiber_laser",
  "co2_laser",
  "diode_laser",
  "uv_printer",
  "dtf_printer",
  "sticker_printer",
  "wide_format_printer",
  "sublimation",
  "cutter",
  "cnc_router",
  "embroidery",
  /** Deliberate: a person, not a machine. Proofs and documents land here. */
  "none",
]);
export type MachineClass = z.infer<typeof machineClassSchema>;

/** Physical size, carried explicitly so nobody re-derives it from a viewBox. */
export const assetDimensionsSchema = z
  .object({
    widthIn: z.number().positive(),
    heightIn: z.number().positive(),
  })
  .strict();
export type AssetDimensions = z.infer<typeof assetDimensionsSchema>;

export const productionAssetSchema = z
  .object({
    /** Stable id for this asset, independent of where the bytes live. */
    assetId: z.string().min(1),
    role: assetRoleSchema,
    machineClass: machineClassSchema,
    /** Where the bytes are. A URI the host resolves; engines never fetch it. */
    uri: z.string().min(1),
    /** For humans and for a downloaded folder. Never parsed for meaning. */
    filename: z.string().min(1),
    mediaType: z.string().min(1),
    byteSize: z.number().int().nonnegative().optional(),
    dimensions: assetDimensionsSchema.optional(),
    /** Effective resolution, where the asset is raster. */
    dpi: z.number().positive().optional(),
    /** Which line item or panel it belongs to. */
    lineItemId: z.string().optional(),
    surfaceId: z.string().optional(),
    /**
     * Version of THIS asset's content.
     *
     * Monotonic per assetId. A revised proof is a new version of the same
     * asset, not a new asset — otherwise "which proof did the customer
     * approve" has no answer.
     */
    version: z.number().int().positive(),
    /**
     * Content hash. The thing that makes a cached copy verifiable.
     *
     * A station holding a local copy can prove it matches the authoritative
     * artifact instead of assuming it. Without this, a stale cached file and a
     * current one are indistinguishable, and the shop cuts the old one.
     */
    checksum: z.string().min(1).optional(),
    /** Anything the producer wants to carry that has no field yet. */
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
export type ProductionAsset = z.infer<typeof productionAssetSchema>;

export const productionAssetManifestSchema = z
  .object({
    manifestVersion: z.literal(1),
    organizationId: z.string().min(1),
    /** What the assets are for — an order, a work order, a configuration. */
    subjectRef: z.string().min(1),
    subjectType: z.enum(["order", "work_order", "configuration", "product_definition"]),
    /**
     * Which engine produced this, and at what version.
     *
     * Recorded because assets outlive the code that made them. When a cut line
     * turns out to be wrong six months later, the first question is what
     * generated it — and a manifest that cannot answer that leaves somebody
     * reading git history against a timestamp.
     */
    producedBy: z
      .object({ engine: z.string().min(1), version: z.string().min(1) })
      .strict(),
    generatedAt: z.string().datetime(),
    assets: z.array(productionAssetSchema),
  })
  .strict();
export type ProductionAssetManifest = z.infer<typeof productionAssetManifestSchema>;

export function validateProductionAssetManifest(input: unknown): ProductionAssetManifest {
  return productionAssetManifestSchema.parse(input);
}

/**
 * The assets one machine class needs, in manifest order.
 *
 * Order is preserved rather than sorted: a producer that emits a registration
 * mark before the print it registers meant that, and re-sorting on some
 * "sensible" key is how a downstream folder stops matching the run sheet.
 */
export function assetsForMachineClass(
  manifest: ProductionAssetManifest,
  machineClass: MachineClass,
): ProductionAsset[] {
  return manifest.assets.filter((asset) => asset.machineClass === machineClass);
}

/**
 * Assets that must not reach a machine.
 *
 * Proofs and documents are for people. Sending a proof to a laser is a
 * recoverable mistake; it is also an avoidable one, and the role field is what
 * avoids it.
 */
export function humanFacingAssets(manifest: ProductionAssetManifest): ProductionAsset[] {
  return manifest.assets.filter(
    (asset) => asset.role === "proof" || asset.role === "document" || asset.role === "preview",
  );
}

/**
 * Anything a human must look at before the job runs.
 *
 * `unclassified` exists so a producer can be honest rather than guessing. An
 * asset whose role nobody could determine is safer surfaced than silently
 * filed under a machine folder because its name matched a pattern.
 */
export function requiresReview(manifest: ProductionAssetManifest): ProductionAsset[] {
  return manifest.assets.filter(
    (asset) => asset.role === "unclassified" || asset.machineClass === "none",
  );
}

/**
 * Whether a cached copy still represents the authoritative asset.
 *
 * The local-first rule in one function: a station may hold a copy, but the
 * copy is a REPRESENTATION of a versioned artifact, never an independent
 * truth. A version bump or a checksum mismatch means re-fetch.
 */
export function isCachedAssetCurrent(
  cached: { version: number; checksum?: string },
  authoritative: ProductionAsset,
): boolean {
  if (cached.version !== authoritative.version) return false;
  // Only compared when both sides have one. A producer that omits a checksum
  // has not proven anything, and treating "absent" as "matching" would make
  // the check quietly meaningless.
  if (authoritative.checksum && cached.checksum) {
    return cached.checksum === authoritative.checksum;
  }
  return true;
}
