// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type { LaserToneBuilderConfig } from "./LaserToneBuilderTypes.js";
import { runAdaptiveThreshold } from "./adaptiveThreshold.js";
import { runErrorDiffusion } from "./errorDiffusion.js";

export function runHybridTone(
  gray: Float32Array,
  width: number,
  height: number,
  config: LaserToneBuilderConfig,
): Float32Array {
  const adaptive = runAdaptiveThreshold(gray, width, height, config);
  const diffusion = runErrorDiffusion(gray, width, height, config);
  const output = new Float32Array(gray.length);

  for (let i = 0; i < gray.length; i += 1) {
    output[i] = gray[i] < 0.45 ? diffusion[i] : adaptive[i];
  }

  return output;
}
