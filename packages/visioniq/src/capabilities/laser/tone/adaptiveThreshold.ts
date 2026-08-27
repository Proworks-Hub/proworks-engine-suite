// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneBuilderConfig } from "./LaserToneBuilderTypes.js";

export function runAdaptiveThreshold(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  const output = new Float32Array(gray.length);
  const half = Math.max(1, Math.floor(config.adaptiveWindow / 2));
  const bias = (config.adaptiveStrength - 0.5) * 0.25;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = -half; oy <= half; oy += 1) {
        for (let ox = -half; ox <= half; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          sum += gray[ny * width + nx];
          count += 1;
        }
      }
      const localMean = count > 0 ? sum / count : gray[y * width + x];
      const localThreshold = Math.max(0, Math.min(1, localMean - bias));
      output[y * width + x] = gray[y * width + x] <= localThreshold ? 1 : 0;
    }
  }

  return output;
}
