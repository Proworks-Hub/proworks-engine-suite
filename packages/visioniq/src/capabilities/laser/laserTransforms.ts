// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import { type PixelBuffer } from "../../core/pixelBuffer.js";
import type { LaserPrepConfig } from "./LaserPrepConfig.js";
import { buildLaserToneImage } from "./laserToneBuilder.js";

export function transformLaserImage(imageData: PixelBuffer, config: LaserPrepConfig): PixelBuffer {
  return buildLaserToneImage(imageData, config.toneBuilder);
}

export function drawMirroredIfNeeded(
  ctx: CanvasRenderingContext2D,
  imageSource: CanvasImageSource,
  width: number,
  height: number,
  mirror: boolean,
) {
  if (!mirror) {
    ctx.drawImage(imageSource, 0, 0, width, height);
    return;
  }
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(imageSource, -width, 0, width, height);
  ctx.restore();
}
