// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

import type { DtfAnalysisResult, DtfIssue } from "./DtfAnalysisResult.js";
import type { DtfDesign } from "./DtfDesign.js";
import type { DtfSheet } from "./DtfSheet.js";

function issue(type: string, severity: DtfIssue["severity"], message: string): DtfIssue {
  return { type, severity, message };
}

function bounds(design: DtfDesign): { x1: number; y1: number; x2: number; y2: number } {
  const width = design.rotation === 90 ? design.heightIn : design.widthIn;
  const height = design.rotation === 90 ? design.widthIn : design.heightIn;
  return {
    x1: design.xIn,
    y1: design.yIn,
    x2: design.xIn + width,
    y2: design.yIn + height,
  };
}

function overlap(a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function calcCoverage(
  cellX1: number,
  cellY1: number,
  cellX2: number,
  cellY2: number,
  designBounds: ReturnType<typeof bounds>,
): number {
  const xOverlap = Math.max(0, Math.min(cellX2, designBounds.x2) - Math.max(cellX1, designBounds.x1));
  const yOverlap = Math.max(0, Math.min(cellY2, designBounds.y2) - Math.max(cellY1, designBounds.y1));
  return xOverlap * yOverlap;
}

export function analyzeDtfSheet(sheet: DtfSheet, designs: DtfDesign[]): DtfAnalysisResult {
  const issues: DtfIssue[] = [];
  const nonTransparentCount = designs.filter((design) => !design.hasTransparency).length;
  const cutSafe = Math.max(0, sheet.cutSafeMarginIn ?? 0);
  const boundsCache = new Map<string, ReturnType<typeof bounds>>();

  if (!sheet.whiteLayer.enabled && nonTransparentCount > 0) {
    issues.push(
      issue(
        "white_underbase_disabled",
        "critical",
        "White underbase is disabled while some designs are not transparent.",
      ),
    );
  }
  if (sheet.whiteLayer.highlightBoost && sheet.whiteLayer.maxWhitePercent > 90) {
    issues.push(
      issue(
        "max_white_aggressive",
        "warning",
        "Highlight boost with high max-white coverage may produce stiff prints.",
      ),
    );
  }
  if (sheet.exportDpi < 300) {
    issues.push(issue("export_dpi_low", "warning", "Export DPI below 300 may reduce transfer quality."));
  }
  if (sheet.recipeProfile === "uv-dtf-hard-surface" && sheet.exportFormat !== "tiff") {
    issues.push(issue("export_format_mismatch", "warning", "UV DTF profile typically targets TIFF exports."));
  }

  for (const design of designs) {
    const b = bounds(design);
    boundsCache.set(design.id, b);
    if (design.dpiEstimate < 220) {
      issues.push(issue("low_resolution", "critical", `${design.name}: low DPI for transfer output.`));
    }
    if (!design.hasTransparency) {
      issues.push(issue("transparency_missing", "warning", `${design.name}: background may print unexpectedly.`));
    }
    if (design.widthIn < 1 || design.heightIn < 1) {
      issues.push(issue("too_small", "warning", `${design.name}: design is very small and may lose detail.`));
    }
    if (Math.min(design.widthIn, design.heightIn) < 0.7 || (design.detailComplexityScore ?? 0.5) > 0.85) {
      issues.push(issue("detail_too_small", "warning", `${design.name}: fine detail may not transfer cleanly.`));
    }
    if ((design.transparencyQuality ?? 1) < 0.45 || !design.hasTransparency) {
      issues.push(issue("poor_transparency", "warning", `${design.name}: transparency quality is likely poor.`));
    }
    if ((design.edgeContaminationRisk ?? 0) > 0.55) {
      issues.push(issue("edge_contamination", "warning", `${design.name}: edge contamination risk detected.`));
    }
    if (design.rotationSensitive && design.rotation === 90) {
      issues.push(issue("rotation_sensitive", "warning", `${design.name}: rotated but flagged as orientation sensitive.`));
    }
    if (design.mirrorSafe === false) {
      issues.push(issue("mirror_sensitive", "warning", `${design.name}: verify mirroring before print handoff.`));
    }
    if (b.x2 > sheet.widthIn || b.y2 > sheet.heightIn || b.x1 < 0 || b.y1 < 0) {
      issues.push(issue("overflow", "critical", `${design.name}: item exceeds sheet boundaries.`));
    }
    if (b.x1 < cutSafe || b.y1 < cutSafe || b.x2 > sheet.widthIn - cutSafe || b.y2 > sheet.heightIn - cutSafe) {
      issues.push(issue("cut_safe_margin", "warning", `${design.name}: outside cut-safe margin (${cutSafe.toFixed(2)} in).`));
    }
  }

  for (let i = 0; i < designs.length; i += 1) {
    for (let j = i + 1; j < designs.length; j += 1) {
      const a = bounds(designs[i]);
      const b = bounds(designs[j]);
      if (overlap(a, b)) {
        issues.push(issue("overlap", "critical", `${designs[i].name} overlaps ${designs[j].name}.`));
      } else {
        const xGap = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2));
        const yGap = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2));
        const minGap = Math.min(xGap, yGap);
        if (minGap > 0 && minGap < sheet.spacingIn) {
          issues.push(
            issue(
              "spacing_too_tight",
              "warning",
              `${designs[i].name} and ${designs[j].name} are closer than spacing target.`,
            ),
          );
        }
      }
    }
  }

  const usedAreaIn2 = designs.reduce((sum, design) => sum + design.widthIn * design.heightIn, 0);
  const sheetAreaIn2 = sheet.widthIn * sheet.heightIn;
  const usagePercent = sheetAreaIn2 > 0 ? Math.min(100, (usedAreaIn2 / sheetAreaIn2) * 100) : 0;
  const wastedPercent = Math.max(0, 100 - usagePercent);
  const utilizationBand = usagePercent >= 75 ? "high" : usagePercent >= 55 ? "medium" : "low";

  const cols = 8;
  const rows = 10;
  const cellWidth = sheet.widthIn / cols;
  const cellHeight = sheet.heightIn / rows;
  const heatmap: DtfAnalysisResult["heatmap"] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x1 = col * cellWidth;
      const y1 = row * cellHeight;
      const x2 = x1 + cellWidth;
      const y2 = y1 + cellHeight;
      let occupied = 0;
      for (const design of designs) {
        const b = boundsCache.get(design.id) ?? bounds(design);
        occupied += calcCoverage(x1, y1, x2, y2, b);
      }
      const cellArea = cellWidth * cellHeight;
      const occupancyPercent = cellArea > 0 ? clamp((occupied / cellArea) * 100, 0, 100) : 0;
      heatmap.push({ col, row, occupancyPercent: Number(occupancyPercent.toFixed(1)) });
    }
  }

  const setupFee = sheet.costing?.setupFee ?? 0;
  const areaRatePerIn2 = sheet.costing?.areaRatePerIn2 ?? 0;
  const wasteFactorPercent = (sheet.costing?.wasteFactorPercent ?? 0) / 100;
  const rushMultiplier = sheet.rushOrder ? (sheet.costing?.rushMultiplier ?? 1) : 1;
  const designSurcharge = (sheet.costing?.perDesignSurcharge ?? 0) * designs.length;
  const usedAreaCost = usedAreaIn2 * areaRatePerIn2;
  const wasteCost = usedAreaCost * wasteFactorPercent;
  const preRush = setupFee + usedAreaCost + wasteCost + designSurcharge;
  const total = preRush * rushMultiplier;
  const rushFee = total - preRush;

  const recommendations: string[] = [];
  if (usagePercent < 55) {
    recommendations.push("Use Auto Arrange to improve sheet usage.");
  }
  if (issues.some((item) => item.type === "low_resolution")) {
    recommendations.push("Replace low-resolution designs before printing.");
  }
  if (issues.some((item) => item.type === "transparency_missing")) {
    recommendations.push("Remove non-transparent backgrounds for cleaner transfers.");
  }
  if (issues.some((item) => item.type === "spacing_too_tight")) {
    recommendations.push("Increase spacing or spread designs to prevent transfer merge.");
  }
  if (issues.some((item) => item.type === "white_underbase_disabled")) {
    recommendations.push("Enable white underbase for opaque regions before production export.");
  }
  if (issues.some((item) => item.type === "max_white_aggressive")) {
    recommendations.push("Lower max white coverage or disable highlight boost for softer hand feel.");
  }
  if (issues.some((item) => item.type === "export_dpi_low")) {
    recommendations.push("Use 300 DPI or higher for production-ready transfer quality.");
  }
  if (issues.some((item) => item.type === "export_format_mismatch")) {
    recommendations.push("Switch export format to TIFF when running UV DTF hard-surface profile.");
  }
  if (issues.some((item) => item.type === "cut_safe_margin")) {
    recommendations.push("Move designs inside cut-safe margins before approving the sheet.");
  }
  if (issues.some((item) => item.type === "rotation_sensitive")) {
    recommendations.push("Lock orientation-sensitive designs before running auto arrange.");
  }
  if (issues.some((item) => item.type === "poor_transparency")) {
    recommendations.push("Run background cleanup for assets with poor transparency edges.");
  }

  let readinessScore = 100;
  for (const item of issues) {
    readinessScore -= item.severity === "critical" ? 25 : item.severity === "warning" ? 10 : 5;
  }
  readinessScore = Math.max(0, Math.min(100, readinessScore));

  const baseCoverage = 100 - Math.min(100, Math.round((nonTransparentCount / Math.max(designs.length, 1)) * 100));
  const whiteLayerCoveragePercent = sheet.whiteLayer.enabled
    ? Math.max(30, Math.min(sheet.whiteLayer.maxWhitePercent, baseCoverage + (sheet.whiteLayer.highlightBoost ? 15 : 5)))
    : 0;
  const whiteLayerSummary = sheet.whiteLayer.enabled
    ? `Underbase on, choke ${sheet.whiteLayer.chokePx}px, max ${sheet.whiteLayer.maxWhitePercent}%${sheet.whiteLayer.highlightBoost ? ", highlight boost" : ""}.`
    : "Underbase off.";

  return {
    readinessScore,
    issues,
    recommendations,
    utilizationBand,
    whiteLayerCoveragePercent,
    whiteLayerSummary,
    recipeProfile: sheet.recipeProfile,
    exportFormat: sheet.exportFormat,
    exportDpi: sheet.exportDpi,
    totalDesigns: designs.length,
    usedAreaIn2: Number(usedAreaIn2.toFixed(2)),
    sheetAreaIn2: Number(sheetAreaIn2.toFixed(2)),
    usagePercent: Number(usagePercent.toFixed(1)),
    wastedPercent: Number(wastedPercent.toFixed(1)),
    groupedDesignCount: new Set(designs.map((design) => design.groupId ?? design.setId).filter(Boolean)).size,
    lockedDesignCount: designs.filter((design) => design.locked).length,
    heatmap,
    pricing: {
      setupFee: Number(setupFee.toFixed(2)),
      usedAreaCost: Number(usedAreaCost.toFixed(2)),
      wasteCost: Number(wasteCost.toFixed(2)),
      rushFee: Number(rushFee.toFixed(2)),
      designSurcharge: Number(designSurcharge.toFixed(2)),
      total: Number(total.toFixed(2)),
    },
  };
}
