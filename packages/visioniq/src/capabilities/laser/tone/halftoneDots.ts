// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneBuilderConfig } from "./LaserToneBuilderTypes.js";

function rotatePoint(x: number, y: number, angleDeg: number): { x: number; y: number } {
  const radians = (angleDeg * Math.PI) / 180;
  const cosValue = Math.cos(radians);
  const sinValue = Math.sin(radians);
  return {
    x: x * cosValue - y * sinValue,
    y: x * sinValue + y * cosValue,
  };
}

export function runHalftoneDots(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  const output = new Float32Array(gray.length);
  const cellSize = Math.max(2, Math.round(config.dotSize));
  const minRadius = Math.max(0, config.minDotSize * 0.5);

  for (let startY = 0; startY < height; startY += cellSize) {
    for (let startX = 0; startX < width; startX += cellSize) {
      let sum = 0;
      let count = 0;
      const endY = Math.min(height, startY + cellSize);
      const endX = Math.min(width, startX + cellSize);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          sum += gray[y * width + x];
          count += 1;
        }
      }

      const mean = count > 0 ? sum / count : 1;
      const darkness = 1 - mean;
      const radius = Math.max(minRadius, darkness * (cellSize / 2));
      const centerX = startX + cellSize / 2;
      const centerY = startY + cellSize / 2;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const point = rotatePoint(x - centerX, y - centerY, config.angle);
          const inside = point.x * point.x + point.y * point.y <= radius * radius;
          output[y * width + x] = inside ? 1 : 0;
        }
      }
    }
  }

  return output;
}
