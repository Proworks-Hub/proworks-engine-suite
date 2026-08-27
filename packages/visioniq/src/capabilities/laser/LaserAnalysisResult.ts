// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

export interface LaserAnalysisIssue {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface LaserAnalysisResult {
  readinessScore: number;
  issues: LaserAnalysisIssue[];
  recommendations: string[];
  workflowMode: "raster" | "vector" | "combo" | "depth_map";
  rasterDetected: boolean;
  vectorDetected: boolean;
  dpiEstimate: number;
  contrastLevel: number;
  lineThicknessEstimate: number;
  detailDensity: number;
  cutLineDetected: boolean;
  backgroundCoverage: number;
  estimatedRuntimeMinutes: number;
  processHints: string[];
  outputSupport: {
    png: boolean;
    svg: boolean;
    recipeSnapshot: boolean;
  };
}

export interface LaserPrepResult {
  processedFileUrl: string;
  previewUrl: string;
  readinessScore: number;
  issues: LaserAnalysisIssue[];
  material: string;
  machine: string;
  workflowMode: "raster" | "vector" | "combo" | "depth_map";
  outputMode: "png" | "svg" | "both";
  recipeSnapshot: Record<string, unknown>;
  exportPlan: {
    formats: string[];
    includeVector: boolean;
  };
  settingsUsed: Record<string, unknown>;
}
