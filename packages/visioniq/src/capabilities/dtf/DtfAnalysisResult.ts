// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

export interface DtfIssue {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface DtfHeatmapCell {
  col: number;
  row: number;
  occupancyPercent: number;
}

export interface DtfPricingBreakdown {
  setupFee: number;
  usedAreaCost: number;
  wasteCost: number;
  rushFee: number;
  designSurcharge: number;
  total: number;
}

export interface DtfAnalysisResult {
  readinessScore: number;
  issues: DtfIssue[];
  recommendations: string[];
  utilizationBand: "low" | "medium" | "high";
  whiteLayerCoveragePercent: number;
  whiteLayerSummary: string;
  recipeProfile: string;
  exportFormat: string;
  exportDpi: number;
  totalDesigns: number;
  usedAreaIn2: number;
  sheetAreaIn2: number;
  usagePercent: number;
  wastedPercent: number;
  groupedDesignCount: number;
  lockedDesignCount: number;
  heatmap: DtfHeatmapCell[];
  pricing: DtfPricingBreakdown;
}

export interface DtfPrepResult {
  sheetImageUrl: string;
  previewUrl: string;
  manifest: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  readinessScore: number;
  issues: DtfIssue[];
  recommendations: string[];
  sheetDimensions: {
    widthIn: number;
    heightIn: number;
  };
  recipeProfile: string;
  exportFormat: string;
  exportDpi: number;
  whiteLayerSummary: string;
  whiteLayerCoveragePercent: number;
  designCount: number;
  estimatedPrice: number;
}
