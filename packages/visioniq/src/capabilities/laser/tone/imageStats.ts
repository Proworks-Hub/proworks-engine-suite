// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneStats } from "./LaserToneBuilderTypes.js";

function estimateEdgeDensity(gray: Float32Array, width: number, height: number): number {
  let edges = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + width] - gray[i - width];
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude > 0.15) edges += 1;
      samples += 1;
    }
  }
  return samples > 0 ? edges / samples : 0;
}

export function calculateImageStats(gray: Float32Array, width: number, height: number): LaserToneStats {
  const total = Math.max(1, gray.length);
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  let bright = 0;

  for (let i = 0; i < gray.length; i += 1) {
    const value = gray[i];
    sum += value;
    sumSq += value * value;
    if (value < 0.2) dark += 1;
    if (value > 0.85) bright += 1;
  }

  const mean = sum / total;
  const variance = Math.max(0, sumSq / total - mean * mean);
  const edgeDensity = estimateEdgeDensity(gray, width, height);

  return {
    meanLuma: Number(mean.toFixed(4)),
    lumaVariance: Number(variance.toFixed(4)),
    darkRatio: Number((dark / total).toFixed(4)),
    brightRatio: Number((bright / total).toFixed(4)),
    edgeDensity: Number(edgeDensity.toFixed(4)),
    detailDensity: Number((edgeDensity * (1 + variance)).toFixed(4)),
  };
}
