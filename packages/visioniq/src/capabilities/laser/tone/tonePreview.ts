// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import { createPixelBuffer, type PixelBuffer } from "../../../core/pixelBuffer.js";
import type {
  LaserToneBuilderConfig,
  LaserTonePipelineInput,
  LaserTonePipelineResult,
} from "./LaserToneBuilderTypes.js";
import { runThreshold } from "./threshold.js";
import { runAdaptiveThreshold } from "./adaptiveThreshold.js";
import { runErrorDiffusion } from "./errorDiffusion.js";
import { runOrderedDither } from "./orderedDither.js";
import { runHalftoneDots } from "./halftoneDots.js";
import { runHalftoneLines } from "./halftoneLines.js";
import { runHybridTone } from "./hybridTone.js";
import { calculateImageStats } from "./imageStats.js";
import { buildToneWarnings } from "./warnings.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function grayscaleFromImage(imageData: PixelBuffer): Float32Array {
  const pixels = imageData.width * imageData.height;
  const gray = new Float32Array(pixels);
  for (let i = 0, p = 0; p < pixels; p += 1, i += 4) {
    gray[p] = (0.2126 * imageData.data[i] + 0.7152 * imageData.data[i + 1] + 0.0722 * imageData.data[i + 2]) / 255;
  }
  return gray;
}

function blur3x3(input: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += input[ny * width + nx];
          count += 1;
        }
      }
      output[y * width + x] = count > 0 ? sum / count : input[y * width + x];
    }
  }
  return output;
}

function applyGlobalTone(gray: Float32Array, width: number, height: number, config: LaserToneBuilderConfig): Float32Array {
  let output = gray;
  if (config.denoise > 0) {
    output = blur3x3(output, width, height);
  }

  const next = new Float32Array(output.length);
  const brightness = config.brightness / 100;
  const contrast = 1 + config.contrast / 100;
  const gamma = Math.max(0.2, config.gamma);
  const shadowLift = config.shadowLift / 100;
  const highlightCompression = config.highlightCompression / 100;

  for (let i = 0; i < output.length; i += 1) {
    let value = output[i] + brightness;
    value = (value - 0.5) * contrast + 0.5;
    value = Math.pow(clamp01(value), 1 / gamma);
    value = value + (1 - value) * shadowLift * (1 - value);
    value = value - highlightCompression * value * value;
    next[i] = clamp01(value);
  }

  return next;
}

function toImageData(binary: Float32Array, width: number, height: number, invert: boolean): PixelBuffer {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < binary.length; p += 1, i += 4) {
    const engrave = clamp01(binary[p]);
    const tone = invert ? Math.round(engrave * 255) : Math.round((1 - engrave) * 255);
    rgba[i] = tone;
    rgba[i + 1] = tone;
    rgba[i + 2] = tone;
    rgba[i + 3] = 255;
  }
  return createPixelBuffer(rgba, width, height);
}

function chooseMethod(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  switch (config.mode) {
    case "threshold":
      return runThreshold(gray, config);
    case "adaptive_threshold":
      return runAdaptiveThreshold(gray, width, height, config);
    case "error_diffusion":
      return runErrorDiffusion(gray, width, height, config);
    case "ordered_dither":
      return runOrderedDither(gray, width, height, config);
    case "halftone_dots":
      return runHalftoneDots(gray, width, height, config);
    case "halftone_lines":
      return runHalftoneLines(gray, width, height, config);
    case "hybrid":
      return runHybridTone(gray, width, height, config);
    default:
      return runThreshold(gray, config);
  }
}

export function buildLaserTonePreview(input: LaserTonePipelineInput): LaserTonePipelineResult {
  const width = input.imageData.width;
  const height = input.imageData.height;
  const gray = grayscaleFromImage(input.imageData);
  const adjusted = applyGlobalTone(gray, width, height, input.config);
  const binary = chooseMethod(adjusted, width, height, input.config);
  const stats = calculateImageStats(adjusted, width, height);
  const warnings = buildToneWarnings(stats, input.config);

  return {
    imageData: toImageData(binary, width, height, input.config.invert),
    stats,
    warnings,
  };
}
