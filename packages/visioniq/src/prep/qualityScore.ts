// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import type { PrepJob } from "../core/prepSettings.js";

export interface QualityScoreBreakdown {
  resolution: number;
  background: number;
  colorConsistency: number;
  edgeSharpness: number;
}

export interface QualityScoreResult {
  score: number;
  breakdown: QualityScoreBreakdown;
  warnings: string[];
}

const MAX_PRACTICAL_COLORS = 8;

export function computeQualityScore(job: PrepJob): QualityScoreResult {
  const warnings: string[] = [];

  const dpi = job.sourceDpi ?? 72;
  let resolution: number;
  if (dpi >= 300) {
    resolution = 30;
  } else {
    resolution = Math.round(Math.max(0, ((dpi - 72) / (300 - 72)) * 30));
  }
  resolution = Math.max(0, Math.min(30, resolution));
  if (dpi < 300) {
    warnings.push("Low Resolution");
  }

  const bg = job.backgroundSettings;
  let background = 0;
  if (bg?.enabled) {
    const strength = bg.strength ?? 50;
    background = Math.round(15 + (strength / 100) * 15);
  } else {
    background = 0;
    warnings.push("Poor Background Removal");
  }
  background = Math.max(0, Math.min(30, background));

  const colorSettings = job.colorSettings;
  let colorConsistency = 0;
  if (colorSettings?.enabled) {
    colorConsistency = 14;
    if (colorSettings.forcePaletteMapping) colorConsistency += 4;
    if (colorSettings.replaceBlackWithRichBlack) colorConsistency += 1;
    if (colorSettings.replaceWhiteWithCleanWhite) colorConsistency += 1;
  } else {
    colorConsistency = 8;
  }
  colorConsistency = Math.max(0, Math.min(20, colorConsistency));

  const colorTolerance = colorSettings?.colorTolerance ?? 50;
  const estimatedColorCount = Math.round((colorTolerance / 100) * 20);
  if (estimatedColorCount > MAX_PRACTICAL_COLORS) {
    warnings.push("Too Many Colors");
    colorConsistency = Math.max(0, colorConsistency - 5);
  }

  const cl = job.cleanupSettings;
  let edgeSharpness = 0;
  if (cl) {
    const edgeHardness = cl.edgeHardness ?? 50;
    const sharpen = cl.sharpen ?? 0;
    edgeSharpness = Math.round((edgeHardness / 100) * 12 + (sharpen / 100) * 8);
  } else {
    edgeSharpness = 6;
  }
  edgeSharpness = Math.max(0, Math.min(20, edgeSharpness));

  const score = Math.min(100, resolution + background + colorConsistency + edgeSharpness);

  return {
    score,
    breakdown: {
      resolution,
      background,
      colorConsistency,
      edgeSharpness,
    },
    warnings,
  };
}

export function scoreToGrade(score: number): "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function scoreToLabel(score: number): string {
  if (score >= 90) return "Print Ready";
  if (score >= 75) return "Good";
  if (score >= 55) return "Needs Review";
  if (score >= 35) return "Issues Found";
  return "Not Ready";
}

export function scoreToColor(score: number): string {
  if (score >= 85) return "text-green-400";
  if (score >= 65) return "text-yellow-400";
  if (score >= 45) return "text-orange-400";
  return "text-red-400";
}
