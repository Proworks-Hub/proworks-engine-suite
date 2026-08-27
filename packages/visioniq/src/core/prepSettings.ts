// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// The preparation vocabulary.
//
// WHY THESE ARE DEFINED HERE RATHER THAN IMPORTED.
//
// In the host these types come from `@workspace/api-client-react` — specifically
// `lib/api-client-react/src/generated/api.schemas.ts`, an OpenAPI-generated
// file. That makes an HTTP API the source of truth for what "cleanup" means,
// which is backwards: background removal strength and halftone cell size are
// domain concepts that happen to travel over HTTP, not HTTP concepts that
// happen to describe a domain.
//
// A portable engine cannot depend on a generated client either. A licensee
// calling VisionIQ from their own Node service has no `@workspace` package.
//
// So these are declared here, STRUCTURALLY IDENTICAL to the generated shapes.
// Every field, every optionality, every union member matches. The host can pass
// its generated types straight in and TypeScript accepts them — that is what
// makes this an extraction rather than a rewrite, and what lets the host
// migrate when it chooses instead of when this package lands.
//
// Every import in the machine layer was `import type`, so all of it erased at
// runtime. Nothing here changes behaviour.
// ─────────────────────────────────────────────────────────────────────────────

export type BackgroundSettingsMode = string;

/** Removing or knocking out a background. */
export interface BackgroundSettings {
  enabled?: boolean;
  mode?: BackgroundSettingsMode;
  strength?: number;
  edgeFeather?: number;
  whiteThreshold?: number;
  darkThreshold?: number;
  /** Removes the halo a knockout leaves behind on a coloured background. */
  decontaminateFringe?: boolean;
  /** Keeps smoke, hair and shadow gradients from becoming hard edges. */
  preserveSoftFades?: boolean;
}

/** Cleaning an image up before it is prepared for a process. */
export interface CleanupSettings {
  aggression?: number;
  edgeHardness?: number;
  noiseCleanup?: boolean;
  compressionReduction?: boolean;
  sharpen?: number;
  contrast?: number;
  saturation?: number;
  posterize?: number;
  /** Small text is the first thing aggressive cleanup destroys. */
  protectSmallText?: boolean;
  /** Distress texture looks like noise to a denoiser, and is not. */
  protectDistressTexture?: boolean;
  /** Lifts dark shadow so a print is not muddy. 0 disables. */
  shadowLift?: number;
  /** Alpha below this goes fully transparent, above fully opaque. 0 disables. */
  flattenSemiTransparency?: number;
  /** Laser only: pure black and white, no midtones and no dithering. */
  thresholdMode?: boolean;
}

export type ColorMappingMode = "preserve_shading" | "flat_replace";

export interface ColorSettings {
  enabled?: boolean;
  mappingMode?: ColorMappingMode;
  preserveShading?: boolean;
  forcePaletteMapping?: boolean;
  colorTolerance?: number;
  replaceBlackWithRichBlack?: boolean;
  replaceWhiteWithCleanWhite?: boolean;
  ignoreNeutrals?: boolean;
  onlyReplaceSelected?: boolean;
  selectedColorIndices?: number[];
}

export type HalftoneSettingsType = "dot" | "line" | "angle_dot" | "grayscale";

export interface HalftoneSettings {
  enabled?: boolean;
  type?: HalftoneSettingsType;
  cellSize?: number;
  strength?: number;
  angle?: number;
  monochrome?: boolean;
  preserveTransparency?: boolean;
  applyToDuplicate?: boolean;
}

export interface VectorSettings {
  enabled?: boolean;
  flatColorSimplification?: number;
  shapeThreshold?: number;
  cornerCleanup?: boolean;
  retainSmallDetails?: boolean;
}

export type ExportFormat = "PNG" | "TIFF" | "PSD" | "SVG" | "JSON";

export interface ExportSettings {
  namingTemplate?: string;
  exportFolder?: string;
  transparency?: boolean;
  flattenExport?: boolean;
  resolution?: number;
  fileSuffix?: string;
  saveWorkingPsd?: boolean;
  formats?: ExportFormat[];
}

/**
 * What the engine needs to know about the job being prepared.
 *
 * A structural minimum, not the host's whole `Job`. The host's type carries
 * customer names, timestamps, status and much else the engine has no business
 * reading — and a portable engine that accepted the full record would quietly
 * acquire a dependency on every field the host later adds.
 *
 * `sourceDpi` and the source dimensions allow `null` as well as `undefined`
 * because the generated type does, and narrowing that would reject the host's
 * own objects.
 */
export interface PrepJob {
  sourceDpi?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
  machinePreset?: string;
  // No `| null` on the settings, matching the host exactly. My first cut added
  // it "to be permissive" and broke assignability at five call sites — being
  // looser than the source is not the same as being compatible with it.
  backgroundSettings?: BackgroundSettings;
  cleanupSettings?: CleanupSettings;
  colorSettings?: ColorSettings;
  halftoneSettings?: HalftoneSettings;
  vectorSettings?: VectorSettings;
  exportSettings?: ExportSettings;
}

/**
 * What the engine needs to know about a machine.
 *
 * A structural minimum — the whole of what the machine layer actually reads
 * from the host's `Machine`. Everything else (its schedule, its maintenance,
 * who is standing at it) belongs to the host.
 *
 * `id` is `string | number` because the host's is numeric and the engine only
 * ever stringifies it. Narrowing to one would reject a real caller for no gain.
 */
export interface PrepMachine {
  id?: string | number;
  /** Whether the shop currently has it available. */
  active?: boolean | null;
  name?: string | null;
  displayName?: string | null;
  description?: string | null;
  /** Catalogue identifier. Process family is inferred from it when present. */
  catalogMachineId?: string | null;
}
