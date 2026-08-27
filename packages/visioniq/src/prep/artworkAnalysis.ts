// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's detectArtworkType. The scoring and
// classification are unchanged; only resampling and image loading stayed
// behind, because those genuinely need a browser and now arrive through ports.

import type { PixelBuffer } from "../core/pixelBuffer.js";
import type { ArtType, ArtTypeResult } from "./artworkTypes.js";


const SAMPLE_SIZE = 64;

function euclideanDist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function computeScores(imageData: PixelBuffer): {
  flatColorRatio: number;
  gradientScore: number;
  noiseScore: number;
  blockingScore: number;
  estimatedColorCount: number;
} {
  const { data, width, height } = imageData;

  const get = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  let flatCount = 0;
  let gradientSum = 0;
  let comparedPairs = 0;
  const colorBuckets = new Set<string>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = get(x, y);
      const bucket = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
      colorBuckets.add(bucket);

      if (x + 1 < width) {
        const [nr, ng, nb] = get(x + 1, y);
        const dist = euclideanDist(r, g, b, nr, ng, nb);
        gradientSum += dist;
        if (dist < 15) flatCount++;
        comparedPairs++;
      }

      if (y + 1 < height) {
        const [nr, ng, nb] = get(x, y + 1);
        const dist = euclideanDist(r, g, b, nr, ng, nb);
        gradientSum += dist;
        if (dist < 15) flatCount++;
        comparedPairs++;
      }
    }
  }

  const flatColorRatio = comparedPairs > 0 ? flatCount / comparedPairs : 0;
  const gradientScore = comparedPairs > 0 ? gradientSum / comparedPairs / 441 : 0;

  const blurred = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const [r, g, b] = get(nx, ny);
            rSum += r; gSum += g; bSum += b; count++;
          }
        }
      }
      const bi = (y * width + x) * 3;
      blurred[bi] = rSum / count;
      blurred[bi + 1] = gSum / count;
      blurred[bi + 2] = bSum / count;
    }
  }

  let noiseSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = get(x, y);
      const bi = (y * width + x) * 3;
      noiseSum += euclideanDist(r, g, b, blurred[bi], blurred[bi + 1], blurred[bi + 2]);
    }
  }
  const noiseScore = noiseSum / (width * height) / 30;

  const BLOCK = 8;
  let blockingSum = 0;
  let blockingCount = 0;
  for (let y = BLOCK; y < height - BLOCK; y += BLOCK) {
    for (let x = 0; x < width; x++) {
      const [r1, g1, b1] = get(x, y - 1);
      const [r2, g2, b2] = get(x, y);
      blockingSum += euclideanDist(r1, g1, b1, r2, g2, b2);
      blockingCount++;
    }
  }
  for (let x = BLOCK; x < width - BLOCK; x += BLOCK) {
    for (let y = 0; y < height; y++) {
      const [r1, g1, b1] = get(x - 1, y);
      const [r2, g2, b2] = get(x, y);
      blockingSum += euclideanDist(r1, g1, b1, r2, g2, b2);
      blockingCount++;
    }
  }
  const blockingScore = blockingCount > 0 ? Math.min(1, (blockingSum / blockingCount) / 30) : 0;

  return {
    flatColorRatio: Math.min(1, flatColorRatio),
    gradientScore: Math.min(1, gradientScore),
    noiseScore: Math.min(1, noiseScore),
    blockingScore,
    estimatedColorCount: colorBuckets.size,
  };
}

function inferColorMode(imageData: PixelBuffer): "RGB" | "Grayscale" {
  const { data, width, height } = imageData;
  const totalPixels = width * height;
  const checkEvery = Math.max(1, Math.floor(totalPixels / 200));
  let grayCount = 0;
  let checkedCount = 0;
  for (let i = 0; i < data.length; i += 4 * checkEvery) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && Math.abs(r - b) < 6) grayCount++;
    checkedCount++;
  }
  return checkedCount > 0 && grayCount / checkedCount > 0.85 ? "Grayscale" : "RGB";
}

function classify(scores: ReturnType<typeof computeScores>): { artType: ArtType; confidence: number; notes: string[] } {
  const { flatColorRatio, gradientScore, noiseScore, blockingScore, estimatedColorCount } = scores;
  const notes: string[] = [];

  notes.push(
    `Flat: ${flatColorRatio.toFixed(2)}, Gradient: ${gradientScore.toFixed(2)}, Noise: ${noiseScore.toFixed(2)}, Blocking: ${blockingScore.toFixed(2)}, Colors: ${estimatedColorCount}`
  );

  if (flatColorRatio > 0.85 && estimatedColorCount < 40) {
    const confidence = Math.min(1, flatColorRatio * 1.05 - 0.05 + (1 - Math.min(1, estimatedColorCount / 40)) * 0.2);
    notes.push("High flat-color ratio and low color count suggest logo or vector art.");
    return { artType: "logo", confidence, notes };
  }

  if (noiseScore > 0.25 && blockingScore > 0.2) {
    const confidence = Math.min(1, noiseScore * 0.7 + blockingScore * 0.8 - 0.2);
    notes.push("High-frequency noise combined with JPEG-block boundary discontinuities indicate a screenshot or compressed image.");
    return { artType: "screenshot", confidence, notes };
  }

  if (gradientScore > 0.25 && noiseScore < 0.25) {
    const confidence = Math.min(1, gradientScore * 1.2 + (1 - noiseScore) * 0.2 - 0.2);
    notes.push("Smooth continuous gradients with low noise suggest a photograph.");
    return { artType: "photo", confidence, notes };
  }

  if (noiseScore > 0.15 && flatColorRatio < 0.7 && gradientScore < 0.2) {
    const confidence = Math.min(1, 0.5 + noiseScore * 0.3 + (1 - flatColorRatio) * 0.2);
    notes.push("Mixed high-frequency texture with limited gradients suggests distressed or vintage artwork.");
    return { artType: "distress", confidence, notes };
  }

  const confidence = Math.min(1, 0.55 + flatColorRatio * 0.15 + gradientScore * 0.15);
  notes.push("Mixed signals — classified as illustrated graphic or distress-style artwork.");
  return { artType: "graphic", confidence, notes };
}



/**
 * How the engine gets a smaller image when it needs one.
 *
 * A PORT, because resampling is the one thing here that genuinely needed a
 * browser: the host did it by drawing to a canvas and reading it back. Writing
 * a resampler inside the engine would have changed results subtly — a different
 * filter is a different answer — and this analysis feeds classification
 * decisions, so "subtly different" is not acceptable for an extraction whose
 * whole promise is preserved behaviour.
 *
 * The host passes its canvas resampler. Canvas resampling stays canvas
 * resampling; the analysis around it becomes portable.
 */
export type PixelResampler = (
  source: PixelBuffer,
  targetWidth: number,
  targetHeight: number,
) => PixelBuffer;

/** The square sample every score below is computed against. */
export { SAMPLE_SIZE };

/**
 * Classifies artwork from an already-sampled buffer.
 *
 * Pure, and the half worth having. Requires the buffer to be SAMPLE_SIZE
 * square — callers that have a full-size image use `detectArtworkType` with a
 * resampler instead of scaling by hand, so the sampling stays consistent.
 */
export function analyzeArtworkSample(sample: PixelBuffer): ArtTypeResult {
  const scores = computeScores(sample);
  const { artType, confidence, notes } = classify(scores);
  const colorMode = inferColorMode(sample);

  // 72 in the original too: this path never learns the real DPI, and the
  // caller that does supplies it. Kept rather than "fixed", because inventing
  // a number here would be worse than an honest placeholder.
  const dpi = 72;

  return { artType, confidence, notes, dpi, colorMode, ...scores };
}

/**
 * Classifies artwork of any size, resampling through the host's port.
 *
 * Skips resampling when the buffer is already the sample size — the same
 * short-circuit the original had.
 */
export function detectArtworkType(
  input: PixelBuffer,
  resample: PixelResampler,
): ArtTypeResult {
  const sample =
    input.width === SAMPLE_SIZE && input.height === SAMPLE_SIZE
      ? input
      : resample(input, SAMPLE_SIZE, SAMPLE_SIZE);
  return analyzeArtworkSample(sample);
}


