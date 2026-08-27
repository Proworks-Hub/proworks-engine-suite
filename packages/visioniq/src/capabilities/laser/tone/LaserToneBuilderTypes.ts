// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import { type PixelBuffer } from "../../../core/pixelBuffer.js";
export type LaserToneMethod =
  | "threshold"
  | "adaptive_threshold"
  | "error_diffusion"
  | "ordered_dither"
  | "halftone_dots"
  | "halftone_lines"
  | "hybrid";

export type LaserToneMachinePreset = "co2" | "diode" | "fiber" | "mopa";

export type LaserToneMaterialPreset =
  | "wood"
  | "slate"
  | "anodized_metal"
  | "acrylic"
  | "leather"
  | "coated_metal";

export type LaserTonePreviewMode = "split" | "processed" | "zoom_detail";

export interface LaserToneBuilderConfig {
  mode: LaserToneMethod;
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

export interface LaserToneStats {
  meanLuma: number;
  lumaVariance: number;
  darkRatio: number;
  brightRatio: number;
  edgeDensity: number;
  detailDensity: number;
}

export interface LaserToneWarning {
  id: string;
  severity: "info" | "warning";
  message: string;
  suggestion?: string;
}

export interface LaserToneRecipe {
  id: string;
  name: string;
  machinePreset: LaserToneMachinePreset;
  materialPreset: LaserToneMaterialPreset;
  config: LaserToneBuilderConfig;
  createdAt: string;
  updatedAt: string;
}

export interface LaserTonePipelineInput {
  imageData: PixelBuffer;
  config: LaserToneBuilderConfig;
}

export interface LaserTonePipelineResult {
  imageData: PixelBuffer;
  stats: LaserToneStats;
  warnings: LaserToneWarning[];
}
