// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import { validateTiffExport } from "./validateTiffExport.js";

export interface PreflightInput {
  dpi: number;
  colorMode: string;
  bitDepth: 8 | 16 | 32;
  hasAlpha: boolean;
  layers: number;
  hasBackground: boolean;
  colorCount: number;
  presetKey: string;
  fileName: string;
  fileSizeMb?: number;
  exportFormat?: string;
  expectedExportFormat?: string;
  bleedMm?: number;
  machineFamily?: string;
  workOrderProcessFamily?: string;
  hasSpotChannels?: boolean;
  requiresSpotChannels?: boolean;
  materialProcess?: string;
}

export type PreflightIssueCategory =
  | "resolution"
  | "dimensions"
  | "transparency"
  | "color_mode"
  | "bleed_trim"
  | "export_format"
  | "machine_compatibility"
  | "spot_channels"
  | "laser"
  | "dtf"
  | "material_process";

export interface PreflightIssue {
  code: string;
  category: PreflightIssueCategory;
  severity: "error" | "warning" | "info";
  message: string;
  guidance?: string;
  autoFixable: boolean;
  blocking: boolean;
  // Kept as a compatibility alias for older UI surfaces.
  suggestion?: string;
}

export interface PreflightResult {
  passed: boolean;
  score: number;
  issues: PreflightIssue[];
  summary: string;
}

function addIssue(
  issues: PreflightIssue[],
  issue: Omit<PreflightIssue, "blocking"> & { blocking?: boolean },
): void {
  issues.push({
    ...issue,
    blocking: issue.blocking ?? issue.severity === "error",
  });
}

function normalizeValue(value?: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function runPreflightChecks(input: PreflightInput): PreflightResult {
  const issues: PreflightIssue[] = [];

  const tiffResult = validateTiffExport({
    dpi: input.dpi,
    colorMode: input.colorMode as any,
    bitDepth: input.bitDepth,
    hasAlpha: input.hasAlpha,
    layers: input.layers,
    presetKey: input.presetKey,
  });

  for (const e of tiffResult.errors) {
    addIssue(issues, {
      code: "TIFF_ERROR",
      category: "export_format",
      severity: "error",
      message: e,
      guidance: "Re-run export using validated TIFF settings.",
      autoFixable: false,
    });
  }
  for (const w of tiffResult.warnings) {
    addIssue(issues, {
      code: "TIFF_WARN",
      category: "export_format",
      severity: "warning",
      message: w,
      guidance: "Review TIFF channel and compression settings before release.",
      autoFixable: false,
    });
  }
  for (const r of tiffResult.recommendations) {
    addIssue(issues, {
      code: "TIFF_REC",
      category: "export_format",
      severity: "info",
      message: r,
      guidance: "Use this recommendation to improve downstream RIP consistency.",
      autoFixable: true,
      blocking: false,
    });
  }

  const dtfLike = ["DTF", "UVDTF"].includes(input.presetKey);
  if (dtfLike && input.hasBackground) {
    addIssue(issues, {
      code: "BG_NOT_REMOVED",
      category: "transparency",
      severity: "error",
      message: "Background must be removed for DTF/UVDTF printing.",
      guidance: "Run knockout/background removal before export.",
      autoFixable: true,
      suggestion: "Run background removal before export.",
    });
  }

  if (dtfLike && !input.hasAlpha) {
    addIssue(issues, {
      code: "DTF_ALPHA_REQUIRED",
      category: "dtf",
      severity: "error",
      message: "DTF workflows require transparency alpha channel output.",
      guidance: "Export with alpha enabled and transparent background.",
      autoFixable: false,
    });
  }

  if (input.presetKey === "LASER_ENGRAVING" && input.colorMode.toLowerCase() !== "grayscale") {
    addIssue(issues, {
      code: "LASER_GRAYSCALE_REQUIRED",
      category: "laser",
      severity: "warning",
      message: "Laser engraving performs best with grayscale source files.",
      guidance: "Convert the artwork to grayscale and verify tonal contrast.",
      autoFixable: true,
      blocking: false,
    });
  }

  if (input.colorCount > 16 && ["UVDTF", "LASER_ENGRAVING"].includes(input.presetKey)) {
    addIssue(issues, {
      code: "TOO_MANY_COLORS",
      category: input.presetKey === "LASER_ENGRAVING" ? "laser" : "color_mode",
      severity: "warning",
      message: `${input.colorCount} colors detected — ${input.presetKey} works best with 16 or fewer.`,
      guidance: "Apply color reduction / posterization before final export.",
      autoFixable: true,
      blocking: false,
      suggestion: "Run color mapping / posterization to reduce the palette.",
    });
  }

  if (input.fileSizeMb && input.fileSizeMb > 100) {
    addIssue(issues, {
      code: "FILE_TOO_LARGE",
      category: "dimensions",
      severity: "warning",
      message: `File is ${input.fileSizeMb.toFixed(1)} MB — very large files can slow RIP processing.`,
      guidance: "Flatten non-essential layers and trim excess canvas area.",
      autoFixable: false,
      blocking: false,
      suggestion: "Consider flattening or reducing canvas size.",
    });
  }

  if (input.dpi < 300) {
    addIssue(issues, {
      code: "LOW_RESOLUTION",
      category: "resolution",
      severity: "error",
      message: `Resolution is ${input.dpi} DPI; production minimum is 300 DPI.`,
      guidance: "Increase source resolution or recreate the asset at production size.",
      autoFixable: false,
    });
  }

  if ((input.bleedMm ?? 0) < 2) {
    addIssue(issues, {
      code: "BLEED_TOO_SMALL",
      category: "bleed_trim",
      severity: "warning",
      message: "Bleed is below 2mm and may reveal trim-edge artifacts.",
      guidance: "Add at least 2mm bleed on all trimmed edges.",
      autoFixable: false,
      blocking: false,
    });
  }

  const expectedExport = normalizeValue(input.expectedExportFormat);
  const actualExport = normalizeValue(input.exportFormat);
  if (expectedExport && expectedExport !== actualExport) {
    addIssue(issues, {
      code: "EXPORT_FORMAT_MISMATCH",
      category: "export_format",
      severity: "error",
      message: `Required export format is ${input.expectedExportFormat}, but ${input.exportFormat ?? "none"} was configured.`,
      guidance: "Switch export format to the required production setting.",
      autoFixable: false,
    });
  }

  const machineFamily = normalizeValue(input.machineFamily);
  const workOrderFamily = normalizeValue(input.workOrderProcessFamily);
  if (machineFamily && workOrderFamily && machineFamily !== workOrderFamily) {
    addIssue(issues, {
      code: "MACHINE_FAMILY_MISMATCH",
      category: "machine_compatibility",
      severity: "error",
      message: `Machine family ${input.machineFamily} conflicts with work-order process ${input.workOrderProcessFamily}.`,
      guidance: "Align preset family with the work-order process requirements.",
      autoFixable: false,
    });
  }

  if (input.requiresSpotChannels && !input.hasSpotChannels) {
    addIssue(issues, {
      code: "SPOT_CHANNELS_REQUIRED",
      category: "spot_channels",
      severity: "error",
      message: "Required spot channels are missing from this export.",
      guidance: "Add and map required spot channels before exporting.",
      autoFixable: false,
    });
  }

  if (input.materialProcess && workOrderFamily && normalizeValue(input.materialProcess) !== workOrderFamily) {
    addIssue(issues, {
      code: "MATERIAL_PROCESS_MISMATCH",
      category: "material_process",
      severity: "warning",
      message: `Material process ${input.materialProcess} differs from selected production process ${input.workOrderProcessFamily}.`,
      guidance: "Confirm material-process compatibility with the production spec.",
      autoFixable: false,
      blocking: false,
    });
  }

  if (!input.fileName || input.fileName === "untitled") {
    addIssue(issues, {
      code: "NO_FILENAME",
      category: "export_format",
      severity: "info",
      message: "File has no name — please name before export.",
      guidance: "Use a traceable filename containing order/work-order IDs.",
      autoFixable: true,
      blocking: false,
    });
  }

  const errors = issues.filter(i => i.severity === "error").length;
  const warnings = issues.filter(i => i.severity === "warning").length;
  const score = Math.max(0, 100 - errors * 25 - warnings * 10);
  const passed = errors === 0;

  return {
    passed,
    score,
    issues,
    summary: passed
      ? `Preflight passed with score ${score}/100.`
      : `Preflight failed: ${errors} error(s), ${warnings} warning(s).`,
  };
}
