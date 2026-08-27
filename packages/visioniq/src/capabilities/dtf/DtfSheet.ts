// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

export type DtfRecipeProfile = "dtf-standard" | "dtf-soft-hand" | "uv-dtf-hard-surface";

export type DtfExportFormat = "png" | "tiff";

export interface DtfWhiteLayerConfig {
  enabled: boolean;
  chokePx: number;
  highlightBoost: boolean;
  maxWhitePercent: number;
  strategy?: "balanced" | "dense" | "soft";
}

export type DtfLayoutMode = "balanced" | "density";

export interface DtfCostingConfig {
  setupFee: number;
  areaRatePerIn2: number;
  wasteFactorPercent: number;
  rushMultiplier: number;
  perDesignSurcharge: number;
}

export interface DtfSheet {
  widthIn: number;
  heightIn: number;
  spacingIn: number;
  cutSafeMarginIn: number;
  materialId?: string;
  machineId?: string;
  processKey?: string;
  templateId?: string;
  colorProfileTarget?: string;
  layoutMode?: DtfLayoutMode;
  recipeProfile: DtfRecipeProfile;
  exportFormat: DtfExportFormat;
  exportDpi: number;
  rushOrder?: boolean;
  costing: DtfCostingConfig;
  whiteLayer: DtfWhiteLayerConfig;
}

export const DEFAULT_DTF_SHEET: DtfSheet = {
  widthIn: 13,
  heightIn: 24,
  spacingIn: 0.25,
  cutSafeMarginIn: 0.15,
  templateId: "dtf-roll-22-standard",
  colorProfileTarget: "DTF-Textile-CMYK-v2",
  layoutMode: "density",
  recipeProfile: "dtf-standard",
  exportFormat: "png",
  exportDpi: 300,
  rushOrder: false,
  costing: {
    setupFee: 6,
    areaRatePerIn2: 0.095,
    wasteFactorPercent: 8,
    rushMultiplier: 1.35,
    perDesignSurcharge: 0.35,
  },
  whiteLayer: {
    enabled: true,
    chokePx: 1,
    highlightBoost: false,
    maxWhitePercent: 85,
    strategy: "balanced",
  },
};
