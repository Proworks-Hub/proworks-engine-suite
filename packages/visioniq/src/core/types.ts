// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

export type PrepWorkflowId =
  | "laser_engraving"
  | "dtf_uvdtf_gangsheet"
  | "dtf_print"
  | "uv_uvdtf_print"
  | "sublimation_print"
  | "large_format_print"
  | "sign_fabrication"
  | "sticker_decal"
  | "uv_print"
  | "uv_print_laser_cut"
  | "sublimation"
  | "cnc_foundation"
  | "embroidery_foundation";

export interface PrepIngestInput {
  fileName: string;
  fileType: string;
  widthIn?: number;
  heightIn?: number;
  dpi?: number;
  hasTransparency?: boolean;
  colorCount?: number;
  vectorPaths?: number;
  rasterLayers?: number;
  spotColors?: string[];
}

export interface PrepIssue {
  type: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface PrepRecommendation {
  type: string;
  message: string;
}

export interface PrepMachinePreset {
  id: string;
  label: string;
  workflow: PrepWorkflowId;
}

export interface PrepResultSummary {
  readinessScore: number;
  issues: PrepIssue[];
  recommendations: PrepRecommendation[];
  exportPreset: string;
  generatedProof: boolean;
  metadata: Record<string, unknown>;
}

export interface PrepWorkflowDefinition {
  id: PrepWorkflowId;
  label: string;
  description: string;
  machinePresets: PrepMachinePreset[];
  materialPresets?: string[];
  analyze: (input: PrepIngestInput) => PrepResultSummary;
}
