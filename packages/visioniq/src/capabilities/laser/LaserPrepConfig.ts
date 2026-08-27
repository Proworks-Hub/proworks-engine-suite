// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

export type LaserMaterialPreset =
  | "wood"
  | "acrylic"
  | "leather"
  | "slate"
  | "anodized_aluminum"
  | "coated_metal"
  | "glass"
  | "powder_coated_tumbler";

export type LaserMachinePreset = "co2" | "fiber" | "diode" | "mopa";
export type DitherMode = "none" | "floyd_steinberg";
export type LaserLayerRole = "cut" | "engrave" | "score";
export type LaserWorkflowMode = "raster" | "vector" | "combo" | "depth_map";
export type LaserOutputMode = "png" | "svg" | "both";

export type LaserToneMode =
  | "threshold"
  | "adaptive_threshold"
  | "error_diffusion"
  | "ordered_dither"
  | "halftone_dots"
  | "halftone_lines"
  | "hybrid";

export interface LaserToneBuilderConfig {
  mode: LaserToneMode;
  brightness: number;
  contrast: number;
  gamma: number;
  shadowLift: number;
  highlightCompression: number;
  invert: boolean;
  sharpen: number;
  denoise: number;
  threshold: number;
  adaptiveWindow: number;
  adaptiveStrength: number;
  diffusionStrength: number;
  matrixSize: 2 | 4 | 8;
  dotSize: number;
  minDotSize: number;
  lineSpacing: number;
  lineThickness: number;
  angle: number;
  crossLine: boolean;
  edgeProtection: number;
  detailProtection: number;
}

export type LaserMaterialTonePreset =
  | "wood"
  | "slate"
  | "anodized_metal"
  | "acrylic"
  | "leather"
  | "coated_metal";

export const LASER_MACHINE_TONE_DEFAULTS: Record<LaserMachinePreset, Partial<LaserToneBuilderConfig>> = {
  co2: {
    mode: "hybrid",
    gamma: 1.05,
    contrast: 10,
    threshold: 134,
    diffusionStrength: 0.8,
  },
  diode: {
    mode: "error_diffusion",
    gamma: 1.15,
    contrast: 18,
    threshold: 142,
    diffusionStrength: 1,
  },
  fiber: {
    mode: "threshold",
    gamma: 0.95,
    contrast: 24,
    threshold: 152,
    edgeProtection: 0.75,
  },
  mopa: {
    mode: "ordered_dither",
    gamma: 0.98,
    contrast: 20,
    threshold: 146,
    matrixSize: 8,
  },
};

export const LASER_MATERIAL_TONE_DEFAULTS: Record<LaserMaterialTonePreset, Partial<LaserToneBuilderConfig>> = {
  wood: {
    mode: "hybrid",
    threshold: 132,
    adaptiveStrength: 0.55,
    detailProtection: 0.6,
  },
  slate: {
    mode: "error_diffusion",
    threshold: 148,
    diffusionStrength: 1,
    edgeProtection: 0.7,
  },
  anodized_metal: {
    mode: "threshold",
    threshold: 158,
    edgeProtection: 0.8,
    sharpen: 22,
  },
  acrylic: {
    mode: "halftone_lines",
    threshold: 144,
    lineSpacing: 6,
    lineThickness: 2,
  },
  leather: {
    mode: "halftone_dots",
    threshold: 136,
    dotSize: 7,
    minDotSize: 1.2,
    shadowLift: 12,
  },
  coated_metal: {
    mode: "ordered_dither",
    threshold: 150,
    matrixSize: 8,
    edgeProtection: 0.78,
  },
};

export const DEFAULT_LASER_TONE_BUILDER_CONFIG: LaserToneBuilderConfig = {
  mode: "hybrid",
  brightness: 0,
  contrast: 0,
  gamma: 1,
  shadowLift: 0,
  highlightCompression: 0,
  invert: false,
  sharpen: 0,
  denoise: 0,
  threshold: 140,
  adaptiveWindow: 15,
  adaptiveStrength: 0.5,
  diffusionStrength: 1,
  matrixSize: 4,
  dotSize: 6,
  minDotSize: 1,
  lineSpacing: 5,
  lineThickness: 2,
  angle: 45,
  crossLine: false,
  edgeProtection: 0.5,
  detailProtection: 0.5,
};

export function materialToTonePreset(material: LaserMaterialPreset): LaserMaterialTonePreset {
  if (material === "anodized_aluminum") return "anodized_metal";
  if (material === "glass") return "slate";
  if (material === "powder_coated_tumbler") return "coated_metal";
  return material;
}

export function buildLaserToneDefaults(
  machine: LaserMachinePreset,
  material: LaserMaterialPreset,
): LaserToneBuilderConfig {
  return {
    ...DEFAULT_LASER_TONE_BUILDER_CONFIG,
    ...(LASER_MACHINE_TONE_DEFAULTS[machine] ?? {}),
    ...(LASER_MATERIAL_TONE_DEFAULTS[materialToTonePreset(material)] ?? {}),
  };
}

export interface LaserPrepConfig {
  workflowMode: LaserWorkflowMode;
  outputMode: LaserOutputMode;
  material: LaserMaterialPreset;
  machine: LaserMachinePreset;
  passes: number;
  powerPercent: number;
  speedMmPerSec: number;
  linesPerInch: number;
  targetDpi: number;
  toneBuilder: LaserToneBuilderConfig;
  grayscale: boolean;
  thresholdEnabled: boolean;
  threshold: number;
  ditherMode: DitherMode;
  contrast: number;
  brightness: number;
  sharpen: number;
  invert: boolean;
  mirror: boolean;
  redLineRole: LaserLayerRole;
  grayscaleRole: LaserLayerRole;
  blackFillRole: LaserLayerRole;
  targetWidthIn: number;
  targetHeightIn: number;
}

export interface LaserMaterialProcessPreset {
  material: LaserMaterialPreset;
  machine: LaserMachinePreset;
  workflowMode: LaserWorkflowMode;
  powerPercent: number;
  speedMmPerSec: number;
  linesPerInch: number;
  targetDpi: number;
  passes: number;
}

export const LASER_MATERIAL_PROCESS_PRESETS: Record<LaserMaterialPreset, LaserMaterialProcessPreset> = {
  wood: {
    material: "wood",
    machine: "co2",
    workflowMode: "depth_map",
    powerPercent: 62,
    speedMmPerSec: 280,
    linesPerInch: 300,
    targetDpi: 350,
    passes: 1,
  },
  acrylic: {
    material: "acrylic",
    machine: "co2",
    workflowMode: "combo",
    powerPercent: 72,
    speedMmPerSec: 240,
    linesPerInch: 280,
    targetDpi: 300,
    passes: 1,
  },
  leather: {
    material: "leather",
    machine: "diode",
    workflowMode: "raster",
    powerPercent: 45,
    speedMmPerSec: 320,
    linesPerInch: 260,
    targetDpi: 320,
    passes: 1,
  },
  slate: {
    material: "slate",
    machine: "co2",
    workflowMode: "raster",
    powerPercent: 55,
    speedMmPerSec: 230,
    linesPerInch: 340,
    targetDpi: 380,
    passes: 1,
  },
  anodized_aluminum: {
    material: "anodized_aluminum",
    machine: "fiber",
    workflowMode: "vector",
    powerPercent: 38,
    speedMmPerSec: 650,
    linesPerInch: 500,
    targetDpi: 450,
    passes: 1,
  },
  coated_metal: {
    material: "coated_metal",
    machine: "mopa",
    workflowMode: "vector",
    powerPercent: 42,
    speedMmPerSec: 520,
    linesPerInch: 460,
    targetDpi: 420,
    passes: 1,
  },
  glass: {
    material: "glass",
    machine: "co2",
    workflowMode: "depth_map",
    powerPercent: 30,
    speedMmPerSec: 180,
    linesPerInch: 420,
    targetDpi: 420,
    passes: 2,
  },
  powder_coated_tumbler: {
    material: "powder_coated_tumbler",
    machine: "fiber",
    workflowMode: "vector",
    powerPercent: 34,
    speedMmPerSec: 780,
    linesPerInch: 420,
    targetDpi: 400,
    passes: 1,
  },
};

export function getLaserMaterialProcessPreset(material: LaserMaterialPreset): LaserMaterialProcessPreset {
  return LASER_MATERIAL_PROCESS_PRESETS[material] ?? LASER_MATERIAL_PROCESS_PRESETS.wood;
}

export const DEFAULT_LASER_PREP_CONFIG: LaserPrepConfig = {
  workflowMode: "raster",
  outputMode: "png",
  material: "wood",
  machine: "co2",
  passes: 1,
  powerPercent: 62,
  speedMmPerSec: 280,
  linesPerInch: 300,
  targetDpi: 350,
  toneBuilder: buildLaserToneDefaults("co2", "wood"),
  grayscale: true,
  thresholdEnabled: false,
  threshold: 128,
  ditherMode: "none",
  contrast: 0,
  brightness: 0,
  sharpen: 0,
  invert: false,
  mirror: false,
  redLineRole: "cut",
  grayscaleRole: "engrave",
  blackFillRole: "score",
  targetWidthIn: 12,
  targetHeightIn: 8,
};
