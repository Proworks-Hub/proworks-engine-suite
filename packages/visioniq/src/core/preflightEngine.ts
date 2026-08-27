// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

import { issue, recommendation } from "./sharedChecks.js";
import type { PrepIngestInput, PrepIssue, PrepRecommendation } from "./types.js";
import type { PrepProfileDomain } from "./profileEngine.js";

export type SharedPrepDomain = PrepProfileDomain;

export interface SharedPreflightPlan {
  mode: "raster_preview" | "vector_preview";
  background: "transparent" | "white";
  proofEnabled: boolean;
  fixups: string[];
  validations: string[];
}

export interface PreflightOperatorResult {
  headline: string;
  checksRun: string[];
  fixupsQueued: string[];
  notes: string[];
}

export interface PreflightExecutionContext {
  workflowId: string;
  machinePreset: string;
  materialProfile: string;
  recipeLabel: string;
  colorProfile: string;
}

export interface PreflightExecutionResult {
  plan: SharedPreflightPlan;
  issues: PrepIssue[];
  recommendations: PrepRecommendation[];
  operatorResult: PreflightOperatorResult;
}

const PREFLIGHT_REGISTRY: Record<SharedPrepDomain, SharedPreflightPlan> = {
  laser: {
    mode: "vector_preview",
    background: "white",
    proofEnabled: true,
    fixups: ["normalize_stroke_width", "flatten_hidden_layers"],
    validations: ["cut_line_presence", "vector_path_integrity"],
  },
  dtf: {
    mode: "raster_preview",
    background: "transparent",
    proofEnabled: true,
    fixups: ["alpha_cleanup", "gangsheet_spacing"],
    validations: ["transparency_preserved", "roll_width_bounds"],
  },
  uv_uvdtf: {
    mode: "raster_preview",
    background: "transparent",
    proofEnabled: true,
    fixups: ["normalize_white_underbase", "flatten_effect_layers"],
    validations: ["white_ink_layer", "varnish_layer_bounds"],
  },
  sublimation: {
    mode: "raster_preview",
    background: "white",
    proofEnabled: true,
    fixups: ["apply_mirror_transform", "ink_limit_normalization"],
    validations: ["mirror_state", "transfer_profile_valid"],
  },
  large_format: {
    mode: "raster_preview",
    background: "white",
    proofEnabled: true,
    fixups: ["apply_bleed", "panelize_if_required"],
    validations: ["minimum_source_dpi", "trim_mark_alignment"],
  },
};

function buildWorkflowAwareChecks(
  domain: SharedPrepDomain,
  input: PrepIngestInput,
): { issues: PrepIssue[]; recommendations: PrepRecommendation[] } {
  const issues: PrepIssue[] = [];
  const recommendations: PrepRecommendation[] = [];

  if (domain === "laser") {
    const spotColors = (input.spotColors ?? []).map((value) => value.toLowerCase());
    const hasCutLineColor = spotColors.some(
      (value) => value.includes("cut") || value.includes("magenta") || value === "#ff00ff",
    );
    if (!hasCutLineColor) {
      issues.push(issue("missing_cut_colors", "warning", "No cut-line color detected for contour/cut workflow."));
    }
    if ((input.vectorPaths ?? 0) === 0 && (input.rasterLayers ?? 0) > 0) {
      issues.push(issue("raster_only", "warning", "Raster-only art may limit precise cut operations."));
    }
    recommendations.push(
      recommendation("laser_mode", "Validate grayscale, threshold, and dither settings per material."),
      recommendation("layer_strategy", "Separate score, engrave, and cut into dedicated production layers."),
    );
  }

  if (domain === "dtf") {
    if (!input.hasTransparency) {
      issues.push(issue("transparency_missing", "warning", "DTF output should preserve transparency."));
    }
    if ((input.widthIn ?? 0) > 22) {
      issues.push(issue("roll_width_overflow", "critical", "Design exceeds 22in DTF roll width."));
    }
    recommendations.push(
      recommendation("gangsheet_nesting", "Enable auto nesting for DTF gang-sheet optimization."),
      recommendation("white_underbase", "Validate white underbase opacity before final export."),
    );
  }

  if (domain === "uv_uvdtf") {
    recommendations.push(
      recommendation("white_ink_underbase", "Validate white-underbase layers before UV export."),
      recommendation("varnish_layer", "Add varnish/clear layer only where substrate needs it."),
    );
  }

  if (domain === "sublimation") {
    recommendations.push(
      recommendation("mirror_export", "Use mirrored output for transfer workflow."),
      recommendation("ink_limit", "Use sublimation profile to prevent over-inking."),
    );
  }

  if (domain === "large_format") {
    if ((input.dpi ?? 0) > 0 && (input.dpi ?? 0) < 100) {
      issues.push(issue("large_format_dpi_risk", "warning", "Large format source is below 100 DPI."));
    }
    recommendations.push(
      recommendation("panelization", "Enable panelization for oversized production jobs."),
      recommendation("bleed", "Apply large format bleed and trim-safe area checks."),
    );
  }

  return { issues, recommendations };
}

function buildOperatorReadableResult(
  domain: SharedPrepDomain,
  plan: SharedPreflightPlan,
  context: PreflightExecutionContext,
): PreflightOperatorResult {
  return {
    headline: `Preflight ready for ${domain.replace("_", " ")} on ${context.machinePreset}`,
    checksRun: [...plan.validations],
    fixupsQueued: [...plan.fixups],
    notes: [
      `Recipe: ${context.recipeLabel}`,
      `Material profile: ${context.materialProfile}`,
      `Color profile: ${context.colorProfile}`,
      `Workflow: ${context.workflowId}`,
    ],
  };
}

export function getSharedPreflightPlan(domain: SharedPrepDomain): SharedPreflightPlan {
  return PREFLIGHT_REGISTRY[domain];
}

export function runWorkflowPreflight(
  domain: SharedPrepDomain,
  input: PrepIngestInput,
  context: PreflightExecutionContext,
): PreflightExecutionResult {
  const plan = getSharedPreflightPlan(domain);
  const workflowChecks = buildWorkflowAwareChecks(domain, input);
  const operatorResult = buildOperatorReadableResult(domain, plan, context);

  return {
    plan,
    issues: workflowChecks.issues,
    recommendations: workflowChecks.recommendations,
    operatorResult,
  };
}
