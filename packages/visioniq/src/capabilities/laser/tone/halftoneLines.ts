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

export function runHalftoneLines(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  const output = new Float32Array(gray.length);
  const spacing = Math.max(2, Math.round(config.lineSpacing));
  const thickness = Math.max(0.5, config.lineThickness);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const darkness = 1 - gray[index];
      const primary = rotatePoint(x - width / 2, y - height / 2, config.angle);
      const stripeDistance = Math.abs(((primary.y % spacing) + spacing) % spacing - spacing / 2);
      const primaryActive = stripeDistance <= (thickness / 2) * (0.25 + darkness);

      if (!config.crossLine) {
        output[index] = primaryActive ? 1 : 0;
        continue;
      }

      const secondary = rotatePoint(x - width / 2, y - height / 2, config.angle + 90);
      const stripeDistanceB = Math.abs(((secondary.y % spacing) + spacing) % spacing - spacing / 2);
      const secondaryActive = stripeDistanceB <= (thickness / 2) * (0.2 + darkness * 0.8);
      output[index] = primaryActive || secondaryActive ? 1 : 0;
    }
  }

  return output;
}
