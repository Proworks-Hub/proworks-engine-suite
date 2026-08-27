// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type {
  LaserToneBuilderConfig,
  LaserToneStats,
  LaserToneWarning,
} from "./LaserToneBuilderTypes.js";

export function buildToneWarnings(stats: LaserToneStats, config: LaserToneBuilderConfig): LaserToneWarning[] {
  const warnings: LaserToneWarning[] = [];

  if (stats.brightRatio > 0.55 && config.highlightCompression < 20) {
    warnings.push({
      id: "highlight-blowout",
      severity: "warning",
      message: "Highlight blowout risk detected.",
      suggestion: "Increase highlight compression.",
    });
  }
  if (stats.darkRatio > 0.45 && config.shadowLift < 10) {
    warnings.push({
      id: "shadow-detail",
      severity: "warning",
      message: "Shadow detail risk detected.",
      suggestion: "Increase shadow lift.",
    });
  }
  if (stats.edgeDensity > 0.42 && config.mode !== "threshold") {
    warnings.push({
      id: "logo-threshold-hint",
      severity: "info",
      message: "High-edge artwork resembles logo geometry.",
      suggestion: "Threshold mode may produce cleaner boundaries.",
    });
  }
  if (stats.edgeDensity < 0.18 && config.mode === "threshold") {
    warnings.push({
      id: "portrait-diffusion-hint",
      severity: "info",
      message: "Low-edge artwork resembles tonal portrait regions.",
      suggestion: "Error diffusion can preserve tonal transitions.",
    });
  }
  if (stats.detailDensity > 0.5 && config.detailProtection < 0.45) {
    warnings.push({
      id: "detail-loss",
      severity: "warning",
      message: "Tiny detail loss risk detected.",
      suggestion: "Increase detail protection.",
    });
  }
  if ((config.mode === "halftone_dots" || config.mode === "halftone_lines") && config.lineSpacing < 3) {
    warnings.push({
      id: "pattern-too-fine",
      severity: "warning",
      message: "Pattern may be too fine for output resolution.",
      suggestion: "Increase spacing or reduce output DPI.",
    });
  }

  return warnings;
}
