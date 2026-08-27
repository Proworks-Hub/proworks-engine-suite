// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

import type { DtfSheet } from "./DtfSheet.js";

export interface DtfGangSheetTemplate {
  id: string;
  label: string;
  machineHint: string;
  materialHint: string;
  patch: Partial<DtfSheet>;
}

export const DTF_GANG_SHEET_TEMPLATES: DtfGangSheetTemplate[] = [
  {
    id: "dtf-roll-22-standard",
    label: "DTF 22in PET Film",
    machineHint: "dtf-roll-22",
    materialHint: "PET Film",
    patch: {
      widthIn: 13,
      heightIn: 36,
      spacingIn: 0.2,
      cutSafeMarginIn: 0.15,
      recipeProfile: "dtf-standard",
      exportFormat: "png",
      exportDpi: 300,
      colorProfileTarget: "DTF-Textile-CMYK-v2",
      layoutMode: "density",
      whiteLayer: {
        enabled: true,
        chokePx: 1,
        highlightBoost: false,
        maxWhitePercent: 85,
        strategy: "balanced",
      },
    },
  },
  {
    id: "dtf-soft-touch-apparel",
    label: "DTF Soft Touch Apparel",
    machineHint: "dtf-roll-22",
    materialHint: "Soft PET Film",
    patch: {
      widthIn: 13,
      heightIn: 24,
      spacingIn: 0.25,
      cutSafeMarginIn: 0.18,
      recipeProfile: "dtf-soft-hand",
      exportFormat: "png",
      exportDpi: 300,
      colorProfileTarget: "DTF-SoftHand-RGB2CMYK",
      layoutMode: "balanced",
      whiteLayer: {
        enabled: true,
        chokePx: 2,
        highlightBoost: false,
        maxWhitePercent: 72,
        strategy: "soft",
      },
    },
  },
  {
    id: "uvdtf-hard-surface",
    label: "UV DTF Hard Surface",
    machineHint: "uvdtf-roll-22",
    materialHint: "UV DTF A/B Film",
    patch: {
      widthIn: 22,
      heightIn: 24,
      spacingIn: 0.18,
      cutSafeMarginIn: 0.12,
      recipeProfile: "uv-dtf-hard-surface",
      exportFormat: "tiff",
      exportDpi: 360,
      colorProfileTarget: "UV-DTF-HardSurface-v4",
      layoutMode: "density",
      whiteLayer: {
        enabled: true,
        chokePx: 1,
        highlightBoost: true,
        maxWhitePercent: 92,
        strategy: "dense",
      },
    },
  },
];

export function getGangSheetTemplate(templateId?: string): DtfGangSheetTemplate | undefined {
  if (!templateId) return undefined;
  return DTF_GANG_SHEET_TEMPLATES.find((template) => template.id === templateId);
}
