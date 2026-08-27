// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneBuilderConfig } from "./LaserToneBuilderTypes.js";

export function runThreshold(gray: Float32Array, config: LaserToneBuilderConfig): Float32Array {
  const output = new Float32Array(gray.length);
  const threshold = Math.max(0, Math.min(1, config.threshold / 255));
  for (let i = 0; i < gray.length; i += 1) {
    output[i] = gray[i] <= threshold ? 1 : 0;
  }
  return output;
}
