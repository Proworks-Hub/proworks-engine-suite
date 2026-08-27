// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import { createPixelBuffer, type PixelBuffer } from "../../core/pixelBuffer.js";
import type { LaserToneBuilderConfig } from "./LaserPrepConfig.js";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function lumaOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function toGrayBuffer(imageData: PixelBuffer): Float32Array {
  const px = imageData.width * imageData.height;
  const out = new Float32Array(px);
  for (let i = 0, p = 0; p < px; p += 1, i += 4) {
    out[p] = lumaOf(imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]);
  }
  return out;
}

function writeBinaryToImageData(buffer: Float32Array, width: number, height: number, invert: boolean): PixelBuffer {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < buffer.length; p += 1, i += 4) {
    const engraveValue = clamp01(buffer[p]);
    const tone = invert ? Math.round(engraveValue * 255) : Math.round((1 - engraveValue) * 255);
    out[i] = tone;
    out[i + 1] = tone;
    out[i + 2] = tone;
    out[i + 3] = 255;
  }
  return createPixelBuffer(out, width, height);
}

function blur3x3(input: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let weight = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const nx = x + kx;
          const ny = y + ky;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += input[ny * width + nx];
          weight += 1;
        }
      }
      out[y * width + x] = weight > 0 ? sum / weight : input[y * width + x];
    }
  }
  return out;
}

function sharpen(input: Float32Array, width: number, height: number, strength: number): Float32Array {
  if (strength <= 0) return input;
  const blurred = blur3x3(input, width, height);
  const factor = strength / 100;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const detail = input[i] - blurred[i];
    out[i] = clamp01(input[i] + detail * factor * 2);
  }
  return out;
}

function applyGlobalTone(input: Float32Array, width: number, height: number, cfg: LaserToneBuilderConfig): Float32Array {
  let out = input;
  if (cfg.denoise > 0) {
    out = blur3x3(out, width, height);
  }

  const next = new Float32Array(out.length);
  const brightnessOffset = cfg.brightness / 100;
  const contrastFactor = 1 + cfg.contrast / 100;
  const gamma = Math.max(0.2, cfg.gamma);
  const shadowLift = cfg.shadowLift / 100;
  const highlightCompression = cfg.highlightCompression / 100;

  for (let i = 0; i < out.length; i += 1) {
    let value = out[i] + brightnessOffset;
    value = (value - 0.5) * contrastFactor + 0.5;
    value = Math.pow(clamp01(value), 1 / gamma);
    value = value + (1 - value) * shadowLift * (1 - value);
    value = value - highlightCompression * value * value;
    next[i] = clamp01(value);
  }

  return sharpen(next, width, height, cfg.sharpen);
}

function toEdges(input: Float32Array, width: number, height: number): Float32Array {
  const edges = new Float32Array(input.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const gx =
        input[idx + 1 - width] + 2 * input[idx + 1] + input[idx + 1 + width] -
        (input[idx - 1 - width] + 2 * input[idx - 1] + input[idx - 1 + width]);
      const gy =
        input[idx - 1 + width] + 2 * input[idx + width] + input[idx + 1 + width] -
        (input[idx - 1 - width] + 2 * input[idx - width] + input[idx + 1 - width]);
      edges[idx] = clamp01(Math.sqrt(gx * gx + gy * gy));
    }
  }
  return edges;
}

function fixedThreshold(input: Float32Array, threshold: number): Float32Array {
  const out = new Float32Array(input.length);
  const t = clamp01(threshold / 255);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] <= t ? 1 : 0;
  }
  return out;
}

function adaptiveThreshold(
  input: Float32Array,
  width: number,
  height: number,
  windowSize: number,
  strength: number,
): Float32Array {
  const out = new Float32Array(input.length);
  const half = Math.max(1, Math.floor(windowSize / 2));
  const bias = (strength - 0.5) * 0.25;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let ky = -half; ky <= half; ky += 1) {
        for (let kx = -half; kx <= half; kx += 1) {
          const nx = x + kx;
          const ny = y + ky;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += input[ny * width + nx];
          count += 1;
        }
      }
      const local = count > 0 ? sum / count : input[y * width + x];
      const t = clamp01(local - bias);
      out[y * width + x] = input[y * width + x] <= t ? 1 : 0;
    }
  }
  return out;
}

function errorDiffusion(input: Float32Array, width: number, height: number, strength: number): Float32Array {
  const work = new Float32Array(input);
  const out = new Float32Array(input.length);
  const w = clamp01(strength);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const old = work[idx];
      const next = old <= 0.5 ? 1 : 0;
      out[idx] = next;
      const quant = old - (next === 1 ? 0 : 1);

      const distribute = (dx: number, dy: number, factor: number) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const nidx = ny * width + nx;
        work[nidx] = clamp01(work[nidx] + quant * factor * w);
      };

      distribute(1, 0, 7 / 16);
      distribute(-1, 1, 3 / 16);
      distribute(0, 1, 5 / 16);
      distribute(1, 1, 1 / 16);
    }
  }
  return out;
}

function orderedDither(input: Float32Array, width: number, height: number, matrixSize: 2 | 4 | 8): Float32Array {
  const matrices: Record<number, number[][]> = {
    2: [
      [0, 2],
      [3, 1],
    ],
    4: [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ],
    8: [
      [0, 32, 8, 40, 2, 34, 10, 42],
      [48, 16, 56, 24, 50, 18, 58, 26],
      [12, 44, 4, 36, 14, 46, 6, 38],
      [60, 28, 52, 20, 62, 30, 54, 22],
      [3, 35, 11, 43, 1, 33, 9, 41],
      [51, 19, 59, 27, 49, 17, 57, 25],
      [15, 47, 7, 39, 13, 45, 5, 37],
      [63, 31, 55, 23, 61, 29, 53, 21],
    ],
  };
  const matrix = matrices[matrixSize];
  const max = matrixSize * matrixSize;
  const out = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const threshold = (matrix[y % matrixSize][x % matrixSize] + 0.5) / max;
      out[idx] = input[idx] <= threshold ? 1 : 0;
    }
  }
  return out;
}

function rotatePoint(x: number, y: number, angleDeg: number): { x: number; y: number } {
  const r = (angleDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    x: x * c - y * s,
    y: x * s + y * c,
  };
}

function halftoneDots(
  input: Float32Array,
  width: number,
  height: number,
  dotSize: number,
  minDotSize: number,
  angle: number,
): Float32Array {
  const out = new Float32Array(input.length);
  const step = Math.max(2, Math.round(dotSize));
  const minRadius = Math.max(0, minDotSize / 2);

  for (let cy = 0; cy < height; cy += step) {
    for (let cx = 0; cx < width; cx += step) {
      let sum = 0;
      let count = 0;
      for (let y = cy; y < Math.min(cy + step, height); y += 1) {
        for (let x = cx; x < Math.min(cx + step, width); x += 1) {
          sum += input[y * width + x];
          count += 1;
        }
      }
      const mean = count > 0 ? sum / count : 1;
      const darkness = 1 - mean;
      const radius = Math.max(minRadius, darkness * (step / 2));
      const centerX = cx + step / 2;
      const centerY = cy + step / 2;
      for (let y = cy; y < Math.min(cy + step, height); y += 1) {
        for (let x = cx; x < Math.min(cx + step, width); x += 1) {
          const p = rotatePoint(x - centerX, y - centerY, angle);
          const inside = p.x * p.x + p.y * p.y <= radius * radius;
          out[y * width + x] = inside ? 1 : 0;
        }
      }
    }
  }
  return out;
}

function halftoneLines(
  input: Float32Array,
  width: number,
  height: number,
  spacing: number,
  thickness: number,
  angle: number,
  crossLine: boolean,
): Float32Array {
  const out = new Float32Array(input.length);
  const lineGap = Math.max(2, Math.round(spacing));
  const lineWidth = Math.max(1, thickness);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x;
      const meanDarkness = 1 - input[idx];
      const p = rotatePoint(x - width / 2, y - height / 2, angle);
      const stripe = Math.abs(((p.y % lineGap) + lineGap) % lineGap - lineGap / 2);
      const allowPrimary = stripe <= (lineWidth / 2) * (0.25 + meanDarkness);
      if (!crossLine) {
        out[idx] = allowPrimary ? 1 : 0;
        continue;
      }
      const q = rotatePoint(x - width / 2, y - height / 2, angle + 90);
      const stripe2 = Math.abs(((q.y % lineGap) + lineGap) % lineGap - lineGap / 2);
      const allowSecondary = stripe2 <= (lineWidth / 2) * (0.2 + meanDarkness * 0.8);
      out[idx] = allowPrimary || allowSecondary ? 1 : 0;
    }
  }
  return out;
}

function applyProtection(
  binary: Float32Array,
  source: Float32Array,
  width: number,
  height: number,
  edgeProtection: number,
  detailProtection: number,
): Float32Array {
  if (edgeProtection <= 0 && detailProtection <= 0) return binary;
  const edges = toEdges(source, width, height);
  const out = new Float32Array(binary.length);
  const edgeGate = clamp01(edgeProtection);
  const detailGate = clamp01(detailProtection);
  for (let i = 0; i < binary.length; i += 1) {
    const edge = edges[i];
    const sourceDark = 1 - source[i];
    const preserve = Math.max(edge * edgeGate, sourceDark * detailGate * 0.35);
    if (preserve > 0.65) {
      out[i] = source[i] <= 0.55 ? 1 : binary[i];
    } else {
      out[i] = binary[i];
    }
  }
  return out;
}

export function buildLaserToneImage(imageData: PixelBuffer, cfg: LaserToneBuilderConfig): PixelBuffer {
  const width = imageData.width;
  const height = imageData.height;
  const gray = toGrayBuffer(imageData);
  const adjusted = applyGlobalTone(gray, width, height, cfg);

  let binary: Float32Array;
  switch (cfg.mode) {
    case "threshold":
      binary = fixedThreshold(adjusted, cfg.threshold);
      break;
    case "adaptive_threshold":
      binary = adaptiveThreshold(adjusted, width, height, cfg.adaptiveWindow, cfg.adaptiveStrength);
      break;
    case "error_diffusion":
      binary = errorDiffusion(adjusted, width, height, cfg.diffusionStrength);
      break;
    case "ordered_dither":
      binary = orderedDither(adjusted, width, height, cfg.matrixSize);
      break;
    case "halftone_dots":
      binary = halftoneDots(adjusted, width, height, cfg.dotSize, cfg.minDotSize, cfg.angle);
      break;
    case "halftone_lines":
      binary = halftoneLines(
        adjusted,
        width,
        height,
        cfg.lineSpacing,
        cfg.lineThickness,
        cfg.angle,
        cfg.crossLine,
      );
      break;
    case "hybrid": {
      const adaptive = adaptiveThreshold(adjusted, width, height, cfg.adaptiveWindow, cfg.adaptiveStrength);
      const diffusion = errorDiffusion(adjusted, width, height, cfg.diffusionStrength);
      binary = new Float32Array(adaptive.length);
      for (let i = 0; i < adaptive.length; i += 1) {
        binary[i] = adjusted[i] < 0.45 ? diffusion[i] : adaptive[i];
      }
      break;
    }
    default:
      binary = fixedThreshold(adjusted, cfg.threshold);
      break;
  }

  const protectedBinary = applyProtection(
    binary,
    adjusted,
    width,
    height,
    cfg.edgeProtection,
    cfg.detailProtection,
  );

  return writeBinaryToImageData(protectedBinary, width, height, cfg.invert);
}

export function estimateToneBuilderWarnings(
  imageData: PixelBuffer,
  cfg: LaserToneBuilderConfig,
): string[] {
  const gray = toGrayBuffer(imageData);
  let dark = 0;
  let bright = 0;
  let edges = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i];
    if (v < 0.2) dark += 1;
    if (v > 0.85) bright += 1;
  }
  const edgeMap = toEdges(gray, imageData.width, imageData.height);
  for (let i = 0; i < edgeMap.length; i += 1) {
    if (edgeMap[i] > 0.35) edges += 1;
  }
  const total = Math.max(1, gray.length);
  const darkRatio = dark / total;
  const brightRatio = bright / total;
  const edgeRatio = edges / total;

  const warnings: string[] = [];
  if (brightRatio > 0.55 && cfg.highlightCompression < 20) {
    warnings.push("Highlight blowout risk. Increase highlight compression.");
  }
  if (darkRatio > 0.45 && cfg.shadowLift < 10) {
    warnings.push("Shadow detail risk. Raise shadow lift.");
  }
  if (edgeRatio > 0.5 && cfg.detailProtection < 0.4) {
    warnings.push("Tiny detail loss risk. Increase detail protection.");
  }
  if ((cfg.mode === "halftone_dots" || cfg.mode === "halftone_lines") && cfg.lineSpacing < 3) {
    warnings.push("Pattern may be too fine for output resolution.");
  }
  if (edgeRatio < 0.18 && cfg.mode === "threshold") {
    warnings.push("Portrait-like tonal range detected. Error diffusion can improve skin gradients.");
  }
  if (edgeRatio > 0.42 && (cfg.mode === "error_diffusion" || cfg.mode === "hybrid")) {
    warnings.push("Logo-like edges detected. Threshold mode may produce cleaner boundaries.");
  }

  return warnings;
}

export function toImageDataFromGray(gray: Float32Array, width: number, height: number): PixelBuffer {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    const v = clamp255(Math.round(gray[p] * 255));
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return createPixelBuffer(out, width, height);
}