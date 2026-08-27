// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type {
  LaserToneBuilderConfig,
  LaserToneMachinePreset,
  LaserToneMaterialPreset,
} from "./LaserToneBuilderTypes.js";

export const DEFAULT_LASER_TONE_CONFIG: LaserToneBuilderConfig = {
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

export const MACHINE_TONE_DEFAULTS: Record<LaserToneMachinePreset, Partial<LaserToneBuilderConfig>> = {
  co2: { mode: "hybrid", gamma: 1.05, threshold: 135, diffusionStrength: 0.8 },
  diode: { mode: "error_diffusion", gamma: 1.12, contrast: 16, threshold: 144, diffusionStrength: 1 },
  fiber: { mode: "threshold", gamma: 0.95, contrast: 24, threshold: 156, edgeProtection: 0.8 },
  mopa: { mode: "ordered_dither", gamma: 0.98, contrast: 20, threshold: 150, matrixSize: 8 },
};

export const MATERIAL_TONE_DEFAULTS: Record<LaserToneMaterialPreset, Partial<LaserToneBuilderConfig>> = {
  wood: { mode: "hybrid", threshold: 132, adaptiveStrength: 0.55, detailProtection: 0.6 },
  slate: { mode: "error_diffusion", threshold: 148, diffusionStrength: 1, edgeProtection: 0.72 },
  anodized_metal: { mode: "threshold", threshold: 160, sharpen: 20, edgeProtection: 0.78 },
  acrylic: { mode: "halftone_lines", threshold: 144, lineSpacing: 6, lineThickness: 2 },
  leather: { mode: "halftone_dots", threshold: 136, dotSize: 7, minDotSize: 1.2, shadowLift: 12 },
  coated_metal: { mode: "ordered_dither", threshold: 150, matrixSize: 8, edgeProtection: 0.76 },
};

export function mergeToneDefaults(
  machinePreset: LaserToneMachinePreset,
  materialPreset: LaserToneMaterialPreset,
): LaserToneBuilderConfig {
  return {
    ...DEFAULT_LASER_TONE_CONFIG,
    ...(MACHINE_TONE_DEFAULTS[machinePreset] ?? {}),
    ...(MATERIAL_TONE_DEFAULTS[materialPreset] ?? {}),
  };
}
