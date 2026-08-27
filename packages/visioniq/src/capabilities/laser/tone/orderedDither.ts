// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneBuilderConfig } from "./LaserToneBuilderTypes.js";

const BAYER_2 = [
  [0, 2],
  [3, 1],
];
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

export function runOrderedDither(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  const matrix = config.matrixSize === 2 ? BAYER_2 : config.matrixSize === 4 ? BAYER_4 : BAYER_8;
  const maxValue = config.matrixSize * config.matrixSize;
  const output = new Float32Array(gray.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const threshold = (matrix[y % config.matrixSize][x % config.matrixSize] + 0.5) / maxValue;
      output[i] = gray[i] <= threshold ? 1 : 0;
    }
  }

  return output;
}
