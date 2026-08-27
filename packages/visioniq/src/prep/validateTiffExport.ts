// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change.

export interface TiffValidationOptions {
  dpi: number;
  colorMode: "RGB" | "CMYK" | "Grayscale" | "Lab" | string;
  bitDepth: 8 | 16 | 32;
  hasAlpha: boolean;
  layers: number;
  presetKey: string;
}

export interface TiffValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  recommendations: string[];
}

const PRESET_DPI_REQUIREMENTS: Record<string, number> = {
  DTF: 300,
  UVDTF: 300,
  UV: 360,
  FINE_ART: 600,
  POSTER: 150,
  LASER_ENGRAVING: 500,
};

const PRESET_COLOR_MODE: Record<string, string[]> = {
  DTF: ["RGB", "CMYK"],
  UVDTF: ["RGB", "CMYK"],
  UV: ["RGB", "CMYK"],
  FINE_ART: ["RGB", "CMYK", "Lab"],
  POSTER: ["RGB", "CMYK"],
  LASER_ENGRAVING: ["Grayscale", "RGB"],
};

export function validateTiffExport(opts: TiffValidationOptions): TiffValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  const minDpi = PRESET_DPI_REQUIREMENTS[opts.presetKey] ?? 300;
  if (opts.dpi < minDpi) {
    errors.push(`DPI ${opts.dpi} is below the minimum ${minDpi} DPI required for ${opts.presetKey}.`);
  } else if (opts.dpi < minDpi * 1.2) {
    warnings.push(`DPI ${opts.dpi} meets the minimum but ${Math.round(minDpi * 1.5)} DPI is recommended for best quality.`);
  }

  const allowedModes = PRESET_COLOR_MODE[opts.presetKey] ?? ["RGB", "CMYK"];
  if (!allowedModes.includes(opts.colorMode)) {
    errors.push(`Color mode "${opts.colorMode}" is not supported for ${opts.presetKey}. Use: ${allowedModes.join(", ")}.`);
  }

  if (opts.bitDepth === 32) {
    warnings.push("32-bit depth detected — flatten to 16-bit or 8-bit for RIP compatibility.");
  }

  if (opts.hasAlpha && opts.presetKey !== "DTF" && opts.presetKey !== "UVDTF") {
    warnings.push("Alpha channel detected — some workflows require a flattened file without transparency.");
  }

  if (opts.layers > 1) {
    recommendations.push(`Flatten ${opts.layers} layers before TIFF export for maximum compatibility.`);
  }

  if (opts.presetKey === "LASER_ENGRAVING" && opts.colorMode !== "Grayscale") {
    recommendations.push("Convert to Grayscale before exporting for laser engraving depth map accuracy.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    recommendations,
  };
}
