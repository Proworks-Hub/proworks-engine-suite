// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten and the host's generated API types replaced with the structurally
// identical declarations in core/prepSettings.ts — every one of those imports
// was `import type`, so all of it erased at runtime.

import type { BackgroundSettings, CleanupSettings, ColorSettings } from "../core/prepSettings.js";

export type MachinePresetKey =
  | "DTF"
  | "UVDTF"
  | "UV"
  | "FINE_ART"
  | "POSTER"
  | "STICKER_VINYL"
  | "SUBLIMATION"
  | "CANVAS_PRINT"
  | "LASER_ENGRAVING";

export interface MachinePresetConfig {
  key: MachinePresetKey;
  label: string;
  description: string;
  dpiTarget: number;
  backgroundSettings: BackgroundSettings;
  cleanupSettings: CleanupSettings;
  colorSettings: ColorSettings;
}

export const PRESET_ORDER: MachinePresetKey[] = [
  "DTF",
  "UVDTF",
  "UV",
  "FINE_ART",
  "POSTER",
  "STICKER_VINYL",
  "SUBLIMATION",
  "CANVAS_PRINT",
  "LASER_ENGRAVING",
];

export const MACHINE_PRESETS: Record<MachinePresetKey, MachinePresetConfig> = {
  DTF: {
    key: "DTF",
    label: "DTF",
    description: "Direct-to-film transfer. Requires transparent background, sharp edges, and palette-mapped colors for vibrant prints.",
    dpiTarget: 300,
    backgroundSettings: {
      enabled: true,
      mode: "logo",
      strength: 85,
      edgeFeather: 3,
      decontaminateFringe: true,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 50,
      contrast: 8,
      saturation: 12,
      edgeHardness: 40,
      aggression: 60,
      noiseCleanup: true,
      protectDistressTexture: false,
      protectSmallText: true,
      compressionReduction: false,
      posterize: 0,
      shadowLift: 20,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 12,
      forcePaletteMapping: true,
      preserveShading: true,
      replaceBlackWithRichBlack: true,
      replaceWhiteWithCleanWhite: true,
    },
  },
  UVDTF: {
    key: "UVDTF",
    label: "UVDTF",
    description: "UV DTF gang sheets for hard surfaces. Hard edge mapping, limited palette, tight color tolerance.",
    dpiTarget: 300,
    backgroundSettings: {
      enabled: true,
      mode: "logo",
      strength: 90,
      edgeFeather: 1,
      decontaminateFringe: true,
      preserveSoftFades: false,
    },
    cleanupSettings: {
      sharpen: 60,
      contrast: 30,
      saturation: 15,
      edgeHardness: 90,
      aggression: 75,
      noiseCleanup: true,
      protectDistressTexture: false,
      compressionReduction: false,
      posterize: 3,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 5,
      forcePaletteMapping: true,
      preserveShading: false,
      replaceBlackWithRichBlack: true,
      replaceWhiteWithCleanWhite: true,
    },
  },
  UV: {
    key: "UV",
    label: "UV Print",
    description: "Direct UV printing on rigid substrates. High resolution, white underbase layer required for dark surfaces.",
    dpiTarget: 360,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 82,
      edgeFeather: 2,
      decontaminateFringe: false,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 80,
      contrast: 45,
      saturation: 18,
      edgeHardness: 92,
      aggression: 82,
      noiseCleanup: false,
      protectDistressTexture: false,
      compressionReduction: true,
      posterize: 0,
      flattenSemiTransparency: 30,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 22,
      forcePaletteMapping: true,
      preserveShading: false,
      replaceBlackWithRichBlack: true,
      replaceWhiteWithCleanWhite: true,
    },
  },
  FINE_ART: {
    key: "FINE_ART",
    label: "Fine Art",
    description: "Archival inkjet reproduction. Maximum color fidelity, soft gradients preserved, no palette forcing.",
    dpiTarget: 600,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 70,
      edgeFeather: 4,
      decontaminateFringe: false,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 15,
      contrast: 5,
      saturation: 5,
      edgeHardness: 20,
      aggression: 20,
      noiseCleanup: false,
      protectDistressTexture: true,
      compressionReduction: false,
      posterize: 0,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 30,
      forcePaletteMapping: false,
      preserveShading: true,
      replaceBlackWithRichBlack: false,
      replaceWhiteWithCleanWhite: false,
    },
  },
  POSTER: {
    key: "POSTER",
    label: "Poster / Banner",
    description: "Large format poster and banner printing. Viewed at distance — moderate sharpening, vibrant color output.",
    dpiTarget: 150,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 75,
      edgeFeather: 3,
      decontaminateFringe: false,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 35,
      contrast: 10,
      saturation: 10,
      edgeHardness: 30,
      aggression: 35,
      noiseCleanup: true,
      protectDistressTexture: false,
      compressionReduction: false,
      posterize: 0,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 18,
      forcePaletteMapping: false,
      preserveShading: true,
      replaceBlackWithRichBlack: true,
      replaceWhiteWithCleanWhite: false,
    },
  },
  STICKER_VINYL: {
    key: "STICKER_VINYL",
    label: "Sticker / Vinyl",
    description: "Contour-cut sticker and vinyl prep with crisp edges and transparent-safe output.",
    dpiTarget: 300,
    backgroundSettings: {
      enabled: true,
      mode: "logo",
      strength: 88,
      edgeFeather: 1,
      decontaminateFringe: true,
      preserveSoftFades: false,
    },
    cleanupSettings: {
      sharpen: 62,
      contrast: 24,
      saturation: 12,
      edgeHardness: 88,
      aggression: 72,
      noiseCleanup: true,
      protectDistressTexture: false,
      compressionReduction: true,
      posterize: 2,
      protectSmallText: true,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 8,
      forcePaletteMapping: true,
      preserveShading: false,
      replaceBlackWithRichBlack: true,
      replaceWhiteWithCleanWhite: true,
    },
  },
  SUBLIMATION: {
    key: "SUBLIMATION",
    label: "Sublimation",
    description: "High-vibrance sublimation prep with smoother gradients and mirrored-output friendly settings.",
    dpiTarget: 300,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 70,
      edgeFeather: 3,
      decontaminateFringe: false,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 28,
      contrast: 10,
      saturation: 18,
      edgeHardness: 36,
      aggression: 28,
      noiseCleanup: false,
      protectDistressTexture: true,
      compressionReduction: false,
      posterize: 0,
      shadowLift: 12,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 16,
      forcePaletteMapping: false,
      preserveShading: true,
      replaceBlackWithRichBlack: false,
      replaceWhiteWithCleanWhite: false,
    },
  },
  CANVAS_PRINT: {
    key: "CANVAS_PRINT",
    label: "Canvas Print",
    description: "Canvas texture-oriented prep with balanced contrast and detail retention for stretched prints.",
    dpiTarget: 300,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 72,
      edgeFeather: 4,
      decontaminateFringe: false,
      preserveSoftFades: true,
    },
    cleanupSettings: {
      sharpen: 24,
      contrast: 12,
      saturation: 8,
      edgeHardness: 26,
      aggression: 24,
      noiseCleanup: false,
      protectDistressTexture: true,
      compressionReduction: false,
      posterize: 0,
      shadowLift: 10,
    },
    colorSettings: {
      enabled: true,
      colorTolerance: 18,
      forcePaletteMapping: false,
      preserveShading: true,
      replaceBlackWithRichBlack: false,
      replaceWhiteWithCleanWhite: false,
    },
  },
  LASER_ENGRAVING: {
    key: "LASER_ENGRAVING",
    label: "Laser Engraving",
    description: "Laser engraving and cutting. Convert to grayscale depth map or pure black vector for optimal burn depth.",
    dpiTarget: 600,
    backgroundSettings: {
      enabled: false,
      mode: "auto",
      strength: 90,
      edgeFeather: 0,
      decontaminateFringe: false,
      preserveSoftFades: false,
    },
    cleanupSettings: {
      sharpen: 70,
      contrast: 80,
      saturation: 0,
      edgeHardness: 70,
      aggression: 60,
      noiseCleanup: true,
      protectDistressTexture: false,
      compressionReduction: true,
      posterize: 0,
      thresholdMode: true,
    },
    colorSettings: {
      enabled: false,
      colorTolerance: 10,
      forcePaletteMapping: false,
      preserveShading: false,
      replaceBlackWithRichBlack: false,
      replaceWhiteWithCleanWhite: false,
    },
  },
};
