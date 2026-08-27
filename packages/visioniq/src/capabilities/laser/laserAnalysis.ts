// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import { type PixelBuffer } from "../../core/pixelBuffer.js";
import type { LaserAnalysisIssue, LaserAnalysisResult } from "./LaserAnalysisResult.js";
import {
  getLaserMaterialProcessPreset,
  type LaserMachinePreset,
  type LaserMaterialPreset,
  type LaserPrepConfig,
} from "./LaserPrepConfig.js";

function issue(type: string, severity: LaserAnalysisIssue["severity"], message: string): LaserAnalysisIssue {
  return { type, severity, message };
}

interface AnalysisInput {
  imageData: PixelBuffer;
  naturalWidth: number;
  naturalHeight: number;
  fileType: string;
  config: LaserPrepConfig;
}

function expectedMinDpi(machine: LaserMachinePreset, material: LaserMaterialPreset): number {
  const base = machine === "fiber" ? 300 : machine === "co2" ? 254 : 220;
  if (material === "glass" || material === "anodized_aluminum") return base + 30;
  return base;
}

export function analyzeLaserReadiness(input: AnalysisInput): LaserAnalysisResult {
  const { imageData, naturalWidth, naturalHeight, fileType, config } = input;
  const { data } = imageData;
  let minLuma = 255;
  let maxLuma = 0;
  let edgeCount = 0;
  let redLikePixels = 0;
  let blackFillPixels = 0;
  let alphaWeakPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < minLuma) minLuma = luma;
    if (luma > maxLuma) maxLuma = luma;
    if (Math.abs(r - g) + Math.abs(g - b) > 40) edgeCount += 1;
    if (r > 210 && g < 90 && b < 90) redLikePixels += 1;
    if (r < 30 && g < 30 && b < 30) blackFillPixels += 1;
    if ((data[i + 3] ?? 255) < 245) alphaWeakPixels += 1;
  }

  const dpiEstimate = Math.round(
    Math.min(naturalWidth / Math.max(0.1, config.targetWidthIn), naturalHeight / Math.max(0.1, config.targetHeightIn)),
  );
  const contrastLevel = Math.round(maxLuma - minLuma);
  const detailDensity = edgeCount / Math.max(1, data.length / 4);
  const lineThicknessEstimate = Math.max(0.2, (1 - detailDensity) * 2.5);
  const cutLineDetected = redLikePixels > data.length / 4 * 0.002;
  const backgroundCoverage = Number((alphaWeakPixels / Math.max(1, data.length / 4)).toFixed(3));
  const materialPreset = getLaserMaterialProcessPreset(config.material);

  const issues: LaserAnalysisIssue[] = [];
  const recommendations: string[] = [];
  const processHints: string[] = [];
  const minDpi = expectedMinDpi(config.machine, config.material);
  const effectiveTargetDpi = Math.max(minDpi, config.targetDpi);

  if (config.workflowMode === "vector" && !fileType.includes("svg") && !fileType.includes("pdf")) {
    issues.push(issue("vector_source_missing", "critical", "Vector mode requires SVG/PDF source artwork."));
    recommendations.push("Switch to raster/combo mode or import true vector artwork.");
  }
  if (config.workflowMode === "depth_map" && !config.grayscale) {
    issues.push(issue("depth_requires_grayscale", "critical", "Depth-map mode requires grayscale processing."));
    recommendations.push("Enable grayscale for depth-map engraving.");
  }
  if (config.linesPerInch * 2 > Math.max(1, dpiEstimate)) {
    issues.push(issue("lpi_over_dpi", "warning", "LPI is too high for source DPI and may cause banding/moire."));
    recommendations.push("Lower LPI or increase source DPI to keep at least 2 pixels per line.");
  }
  if (Math.abs(config.powerPercent - materialPreset.powerPercent) > 30) {
    issues.push(issue("power_out_of_band", "warning", "Power differs significantly from material preset baseline."));
    recommendations.push("Review power % against tested material profile before production run.");
  }
  if (Math.abs(config.speedMmPerSec - materialPreset.speedMmPerSec) > 350) {
    issues.push(issue("speed_out_of_band", "warning", "Speed differs significantly from material preset baseline."));
    recommendations.push("Review speed against material profile to avoid incomplete or overburn results.");
  }

  if (dpiEstimate < minDpi) {
    issues.push(issue("low_dpi", "critical", "Image resolution too low for reliable engraving output."));
    recommendations.push("Use higher resolution source artwork or engrave at larger physical size.");
  }
  if (dpiEstimate < effectiveTargetDpi) {
    issues.push(issue("below_target_dpi", "warning", "Source DPI is below configured target DPI."));
    recommendations.push("Reduce target size or increase source resolution for cleaner detail.");
  }
  if (contrastLevel < 70) {
    issues.push(issue("weak_contrast", "warning", "Contrast too weak for consistent engraving depth."));
    recommendations.push("Increase contrast and consider threshold mode for cleaner burn separation.");
  }
  if (lineThicknessEstimate < 0.5) {
    issues.push(issue("thin_lines", "warning", "Lines appear too thin for stable laser output."));
    recommendations.push("Thicken strokes or reduce detail for target engraving size.");
  }
  if (detailDensity > 0.45) {
    issues.push(issue("detail_density_high", "warning", "Too much detail for current engraving size."));
    recommendations.push("Reduce detail, simplify vectors, or increase engraving dimensions.");
  }
  if (!cutLineDetected) {
    issues.push(issue("missing_cut_lines", "info", "No pure red cut lines detected."));
    recommendations.push("Add red contour cut lines if cut operations are expected.");
  }
  if (blackFillPixels > data.length / 4 * 0.7) {
    issues.push(issue("burn_fill_risk", "warning", "Large black fill regions may cause burn/fill issues."));
    recommendations.push("Reduce fill density or use dither to limit overheating.");
  }

  if (config.machine === "diode" && contrastLevel < 90) {
    issues.push(issue("diode_contrast", "warning", "Diode lasers usually need stronger contrast."));
  }
  if (config.material === "powder_coated_tumbler" && config.workflowMode !== "vector") {
    recommendations.push("Tumblers are typically most stable in vector mode with minimal raster fill.");
  }
  if (config.material === "glass" && !config.invert) {
    recommendations.push("Consider invert for certain glass engraving workflows.");
  }
  if (config.passes > 1) {
    processHints.push("Multi-pass enabled: verify part cooling and registration between passes.");
  }
  processHints.push(`Material baseline: ${materialPreset.powerPercent}% power / ${materialPreset.speedMmPerSec} mm/s.`);
  processHints.push(`Configured process: ${config.powerPercent}% power / ${config.speedMmPerSec} mm/s / ${config.linesPerInch} LPI.`);

  const vectorDetected = fileType.includes("svg") || fileType.includes("pdf");
  const rasterDetected = !vectorDetected;
  const areaInSqIn = Math.max(0.1, config.targetWidthIn * config.targetHeightIn);
  const speedFactor = Math.max(0.35, config.speedMmPerSec / 350);
  const runtimeBase = (areaInSqIn / 8.5) * (config.linesPerInch / 300);
  const estimatedRuntimeMinutes = Number(((runtimeBase / speedFactor) * Math.max(1, config.passes)).toFixed(1));

  let readinessScore = 100;
  for (const item of issues) {
    readinessScore -= item.severity === "critical" ? 30 : item.severity === "warning" ? 12 : 5;
  }
  readinessScore = Math.max(0, Math.min(100, readinessScore));

  return {
    readinessScore,
    issues,
    recommendations,
    rasterDetected,
    vectorDetected,
    workflowMode: config.workflowMode,
    dpiEstimate,
    contrastLevel,
    lineThicknessEstimate: Number(lineThicknessEstimate.toFixed(2)),
    detailDensity: Number(detailDensity.toFixed(3)),
    cutLineDetected,
    backgroundCoverage,
    estimatedRuntimeMinutes,
    processHints,
    outputSupport: {
      png: true,
      svg: vectorDetected || config.workflowMode !== "raster",
      recipeSnapshot: true,
    },
  };
}
