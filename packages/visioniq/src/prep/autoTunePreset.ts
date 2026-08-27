// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import type { ArtTypeResult } from "./artworkTypes.js";
import type { MachinePresetConfig } from "../machines/machinePresets.js";
import type { BackgroundSettings, CleanupSettings, ColorSettings } from "../core/prepSettings.js";

export interface AutoTuneResult {
  backgroundSettings: BackgroundSettings;
  cleanupSettings: CleanupSettings;
  colorSettings: ColorSettings;
  adjustments: string[];
}

export function autoTunePreset(
  artResult: ArtTypeResult,
  preset: MachinePresetConfig
): AutoTuneResult {
  const bg = { ...preset.backgroundSettings };
  const cl = { ...preset.cleanupSettings };
  const co = { ...preset.colorSettings };
  const adjustments: string[] = [];

  const { artType, flatColorRatio, gradientScore, noiseScore, estimatedColorCount } = artResult;

  switch (artType) {
    case "logo": {
      bg.mode = "logo" as any;
      bg.edgeFeather = Math.min(bg.edgeFeather ?? 2, 1);
      bg.strength = Math.max(bg.strength ?? 80, 88);
      bg.preserveSoftFades = false;
      cl.edgeHardness = Math.min(100, (cl.edgeHardness ?? 50) + 20);
      cl.aggression = Math.min(100, (cl.aggression ?? 60) + 15);
      cl.noiseCleanup = true;
      co.forcePaletteMapping = true;
      co.colorTolerance = Math.min(co.colorTolerance ?? 12, 8);
      adjustments.push("Hard edges for logo (edgeHardness +" + 20 + ")");
      adjustments.push("Logo-mode background removal with min feather");
      adjustments.push("Tighter color tolerance for flat fills");
      break;
    }
    case "photo": {
      bg.edgeFeather = Math.max(bg.edgeFeather ?? 3, 5);
      bg.preserveSoftFades = true;
      cl.edgeHardness = Math.max(10, (cl.edgeHardness ?? 50) - 20);
      cl.noiseCleanup = false;
      cl.protectDistressTexture = true;
      co.preserveShading = true;
      co.forcePaletteMapping = preset.key !== "FINE_ART" && preset.key !== "POSTER";
      adjustments.push("Soft feather for photo edges (feather +" + Math.max(0, 5 - (preset.backgroundSettings.edgeFeather ?? 3)) + ")");
      adjustments.push("Gradient preservation enabled");
      adjustments.push("Noise cleanup disabled to protect photo detail");
      break;
    }
    case "screenshot": {
      cl.compressionReduction = true;
      cl.noiseCleanup = true;
      cl.aggression = Math.min(100, (cl.aggression ?? 60) + 10);
      cl.sharpen = Math.max(cl.sharpen ?? 50, 60);
      co.colorTolerance = Math.min(co.colorTolerance ?? 12, 15);
      adjustments.push("Compression artifact reduction enabled");
      adjustments.push("Sharpen boosted for screenshot aliasing");
      adjustments.push("Noise cleanup enabled for JPEG artifacts");
      break;
    }
    case "graphic": {
      cl.protectDistressTexture = true;
      cl.noiseCleanup = false;
      cl.aggression = Math.max(20, (cl.aggression ?? 60) - 15);
      co.preserveShading = true;
      adjustments.push("Distress texture protection enabled");
      adjustments.push("Reduced cleanup aggression for mixed artwork");
      adjustments.push("Shading preserved for graphic/illustrative style");
      break;
    }
    case "distress": {
      cl.protectDistressTexture = true;
      cl.noiseCleanup = false;
      cl.aggression = Math.max(15, (cl.aggression ?? 60) - 20);
      cl.sharpen = Math.max(cl.sharpen ?? 30, 30);
      co.preserveShading = true;
      bg.preserveSoftFades = true;
      bg.edgeFeather = Math.max(bg.edgeFeather ?? 2, 3);
      adjustments.push("Distress texture protection enabled (vintage/grunge preserved)");
      adjustments.push("Noise cleanup disabled — high-frequency texture intentional");
      adjustments.push("Soft edge feather to preserve worn-edge detail");
      adjustments.push("Low aggression cleanup to prevent flattening distress effect");
      break;
    }
  }

  if (preset.key === "UVDTF" && artType === "photo") {
    adjustments.push("Warning: Photo artwork on UVDTF may lose gradients due to hard-edge processing");
  }

  if (preset.key === "DTF" || preset.key === "UVDTF") {
    if (!bg.enabled) {
      bg.enabled = true;
      adjustments.push("Background removal enabled (required for " + preset.key + ")");
    }
  }

  if (gradientScore < 0.1 && flatColorRatio > 0.8) {
    cl.posterize = 0;
    adjustments.push("Posterize disabled — artwork already has flat colors");
  }

  if (estimatedColorCount > 128) {
    adjustments.push("High color count (" + estimatedColorCount + " buckets) — palette mapping will simplify colors");
  }

  return {
    backgroundSettings: bg,
    cleanupSettings: cl,
    colorSettings: co,
    adjustments,
  };
}

export interface PrepSuggestion {
  severity: "info" | "warning" | "error";
  message: string;
}

export function generateSuggestions(
  artResult: ArtTypeResult,
  preset: MachinePresetConfig,
  adjustments: string[],
  sourceDpi?: number
): PrepSuggestion[] {
  const suggestions: PrepSuggestion[] = [];

  const { artType, estimatedColorCount, noiseScore, gradientScore, dpi } = artResult;

  const effectiveDpi = sourceDpi ?? dpi ?? 72;

  if (artResult.confidence < 0.5) {
    suggestions.push({
      severity: "info",
      message: `Art type detection confidence is low (${Math.round(artResult.confidence * 100)}%). You may want to manually select the correct mode.`,
    });
  }

  if (effectiveDpi < preset.dpiTarget) {
    const severity = effectiveDpi < preset.dpiTarget * 0.5 ? "error" : "warning";
    suggestions.push({
      severity,
      message: `Source DPI (${effectiveDpi}) is below target (${preset.dpiTarget} DPI for ${preset.label}). Upscaling or re-exporting from a higher-resolution source is recommended.`,
    });
  }

  if ((preset.key === "DTF" || preset.key === "UVDTF") && !preset.backgroundSettings.enabled && artType !== "logo") {
    suggestions.push({
      severity: "warning",
      message: `${preset.label} printing requires a transparent background. Verify background removal is enabled before exporting.`,
    });
  }

  if (preset.key === "UVDTF" && artType === "photo") {
    suggestions.push({
      severity: "warning",
      message: "Photo artwork on UVDTF: gradients may be clipped by tight color mapping. Consider converting to a logo/graphic style first.",
    });
  }

  if ((preset.key === "DTF" || preset.key === "UVDTF") && artType !== "logo" && artType !== "graphic" && artType !== "distress") {
    suggestions.push({
      severity: "info",
      message: `${artType === "photo" ? "Photo" : "Screenshot"} artwork on ${preset.key}: background removal may leave halo artifacts on soft edges. Review the result carefully.`,
    });
  }

  if (artType === "screenshot") {
    suggestions.push({
      severity: "warning",
      message: "Screenshot artwork detected. Re-exporting from the original vector or layered source file will produce significantly better print quality.",
    });
  }

  if (artType === "screenshot" && (preset.key === "DTF" || preset.key === "UVDTF" || preset.key === "UV")) {
    suggestions.push({
      severity: "warning",
      message: "Screenshot source on a print preset: consider upscaling to at least " + preset.dpiTarget + " DPI or sourcing from vector before printing.",
    });
  }

  if (estimatedColorCount > 128) {
    suggestions.push({
      severity: "warning",
      message: `High color count detected (${estimatedColorCount}+ color buckets). KSix palette mapping will reduce this significantly — preview before exporting.`,
    });
  }

  if (noiseScore > 0.4) {
    suggestions.push({
      severity: "warning",
      message: "High noise or JPEG compression artifacts detected. Export from a lossless source (PNG or PSD) for best results.",
    });
  }

  if (gradientScore < 0.05 && preset.key === "FINE_ART") {
    suggestions.push({
      severity: "info",
      message: "Artwork appears to be flat-color. Fine Art preset is optimized for photos and gradients — consider DTF or UVDTF for logos.",
    });
  }

  return suggestions;
}
