// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

import { baseQualityChecks, computeReadiness } from "./sharedChecks.js";
import type { PrepIngestInput, PrepIssue, PrepRecommendation, PrepResultSummary, PrepWorkflowId } from "./types.js";
import {
  buildProfileMetadata,
  hydrateProfileSelection,
  resolveProfileBundle,
  type PrepProfileDomain,
  type ProfileSelection,
} from "./profileEngine.js";
import {
  buildColorMetadata,
  resolveWorkflowColorPlan,
  type SharedColorPlan,
} from "./colorEngine.js";
import {
  getSharedPreflightPlan as getSharedWorkflowPreflightPlan,
  runWorkflowPreflight,
  type SharedPreflightPlan as SharedWorkflowPreflightPlan,
} from "./preflightEngine.js";
import {
  getSharedRecipePresetById,
  getSharedRecipePreset as getRecipePresetFromEngine,
  resolveRecipeId,
  validateRecipeForDomain,
  type SharedRecipePreset as SharedRecipePresetType,
} from "./recipeEngine.js";

export type SharedPreflightPlan = SharedWorkflowPreflightPlan;

export type SharedPrepDomain = PrepProfileDomain;

export interface SharedProfile {
  id: string;
  domain: SharedPrepDomain;
  machinePreset: string;
  outputProfile: "cmyk" | "rgb";
  targetDpi: number;
  exportPreset: string;
  whiteInkSupport: boolean;
  mirroredOutput: boolean;
}

export type SharedRecipePreset = SharedRecipePresetType;

export interface SharedExportPlan {
  format: "png" | "tiff" | "pdf" | "svg";
  flattenOutput: boolean;
  preserveTransparency: boolean;
  includeCutLayer: boolean;
}

export interface SharedPrepOverrides {
  additionalIssues?: PrepIssue[];
  additionalRecommendations?: PrepRecommendation[];
  profileSelection?: ProfileSelection;
  metadata?: Record<string, unknown>;
  generatedProof?: boolean;
  exportPreset?: string;
}

// RECIPE_REGISTRY now managed by recipeEngine.ts
// This maintains backward compat exports for existing imports

const EXPORT_REGISTRY: Record<SharedPrepDomain, SharedExportPlan> = {
  laser: {
    format: "svg",
    flattenOutput: true,
    preserveTransparency: false,
    includeCutLayer: true,
  },
  dtf: {
    format: "png",
    flattenOutput: false,
    preserveTransparency: true,
    includeCutLayer: false,
  },
  uv_uvdtf: {
    format: "tiff",
    flattenOutput: false,
    preserveTransparency: true,
    includeCutLayer: false,
  },
  sublimation: {
    format: "png",
    flattenOutput: true,
    preserveTransparency: false,
    includeCutLayer: false,
  },
  large_format: {
    format: "pdf",
    flattenOutput: true,
    preserveTransparency: false,
    includeCutLayer: true,
  },
};

const EXPORT_FORMAT_ALLOWLIST: Record<SharedPrepDomain, SharedExportPlan["format"][]> = {
  laser: ["svg", "pdf"],
  dtf: ["png", "tiff"],
  uv_uvdtf: ["tiff", "png"],
  sublimation: ["png"],
  large_format: ["pdf", "tiff"],
};

export function validateExportFormatForDomain(
  domain: SharedPrepDomain,
  requestedFormat: SharedExportPlan["format"],
): { valid: boolean; resolvedFormat: SharedExportPlan["format"] } {
  const allowedFormats = EXPORT_FORMAT_ALLOWLIST[domain] ?? [EXPORT_REGISTRY[domain].format];
  if (allowedFormats.includes(requestedFormat)) {
    return { valid: true, resolvedFormat: requestedFormat };
  }
  return {
    valid: false,
    resolvedFormat: allowedFormats[0],
  };
}

export function getSharedProfile(domain: SharedPrepDomain): SharedProfile {
  const bundle = resolveProfileBundle(domain);
  return {
    id: `${domain}-shared-profile-v3`,
    domain,
    machinePreset: bundle.machine.machinePreset,
    outputProfile: bundle.output.colorSpace,
    targetDpi: bundle.machine.targetDpi,
    exportPreset: bundle.output.exportPreset,
    whiteInkSupport: bundle.machine.whiteInkSupport,
    mirroredOutput: bundle.output.mirroredOutput,
  };
}

/**
 * Get shared recipe preset for domain
 * Delegates to recipeEngine with versioning/migration support
 */
export function getSharedRecipePreset(domain: SharedPrepDomain): SharedRecipePreset {
  const recipe = getRecipePresetFromEngine(domain);
  const validation = validateRecipeForDomain(recipe, domain);
  if (!validation.valid) {
    console.warn(`Recipe validation warnings for ${domain}:`, validation.errors);
  }
  return recipe;
}

export function getSharedColorPlan(domain: SharedPrepDomain): SharedColorPlan {
  return resolveWorkflowColorPlan(domain);
}

export function getSharedPreflightPlan(domain: SharedPrepDomain): SharedPreflightPlan {
  return getSharedWorkflowPreflightPlan(domain);
}

export function getSharedExportPlan(domain: SharedPrepDomain): SharedExportPlan {
  const bundle = resolveProfileBundle(domain);
  return {
    format: bundle.output.format,
    flattenOutput: bundle.output.flattenOutput,
    preserveTransparency: bundle.output.preserveTransparency,
    includeCutLayer: bundle.output.includeCutLayer,
  };
}

export function runSharedWorkflowPrep(
  workflowId: PrepWorkflowId,
  domain: SharedPrepDomain,
  input: PrepIngestInput,
  overrides?: SharedPrepOverrides,
): PrepResultSummary {
  const baseIssues = baseQualityChecks(input);
  const hydratedSelection = hydrateProfileSelection(domain, overrides?.metadata);
  const profileBundle = resolveProfileBundle(domain, overrides?.profileSelection ?? hydratedSelection);
  const profile = getSharedProfile(domain);
  
  // Resolve recipe with versioning/migration support
  const requestedRecipeId = overrides?.metadata?.recipeId as string | undefined;
  const resolvedRecipeId = resolveRecipeId(requestedRecipeId, domain);
  const recipeMigrationDetected = Boolean(requestedRecipeId && requestedRecipeId !== resolvedRecipeId);
  const recipe = getSharedRecipePresetById(domain, resolvedRecipeId);
  const colorPlan = resolveWorkflowColorPlan(domain, {
    profileSelection: profileBundle.selection,
    recipeId: recipe.id,
  });
  const preflight = runWorkflowPreflight(domain, input, {
    workflowId,
    machinePreset: profileBundle.machine.machinePreset,
    materialProfile: profileBundle.material.label,
    recipeLabel: recipe.label,
    colorProfile: colorPlan.profileName,
  });
  const preflightPlan = preflight.plan;
  const baseExportPlan = getSharedExportPlan(domain);
  const requestedExportFormat =
    typeof overrides?.metadata?.exportFormat === "string"
      ? (overrides.metadata.exportFormat as SharedExportPlan["format"])
      : baseExportPlan.format;
  const exportValidation = validateExportFormatForDomain(domain, requestedExportFormat);
  const exportPlan: SharedExportPlan = {
    ...baseExportPlan,
    format: exportValidation.resolvedFormat,
  };

  const exportIssues: PrepIssue[] = exportValidation.valid
    ? []
    : [
        {
          type: "export_format_mismatch",
          severity: "warning",
          message: `${domain} does not support ${requestedExportFormat}. Using ${exportValidation.resolvedFormat} instead.`,
        },
      ];
  const exportRecommendations: PrepRecommendation[] = exportValidation.valid
    ? []
    : [
        {
          type: "export_format_override",
          message: `Use one of the supported formats for ${domain}: ${EXPORT_FORMAT_ALLOWLIST[domain].join(", ")}.`,
        },
      ];

  const issues = [
    ...baseIssues,
    ...preflight.issues,
    ...exportIssues,
    ...(overrides?.additionalIssues ?? []),
  ];
  const recommendations = [
    ...preflight.recommendations,
    ...exportRecommendations,
    ...(overrides?.additionalRecommendations ?? []),
  ];

  return {
    readinessScore: computeReadiness(issues),
    issues,
    recommendations,
    exportPreset: overrides?.exportPreset ?? profile.exportPreset,
    generatedProof: overrides?.generatedProof ?? preflightPlan.proofEnabled,
    metadata: {
      workflowId,
      domain,
      profile,
      recipe,
      recipeId: recipe.id,
      requestedRecipeId,
      resolvedRecipeId,
      recipeMigration: recipeMigrationDetected
        ? {
            from: requestedRecipeId,
            to: resolvedRecipeId,
          }
        : null,
      colorPlan,
      preflightPlan,
      preflightResult: preflight.operatorResult,
      exportPlan,
      ...buildColorMetadata(colorPlan),
      ...buildProfileMetadata(profileBundle),
      machinePreset: profileBundle.machine.machinePreset,
      colorProfile: profileBundle.machine.colorProfile,
      targetDpi: profileBundle.machine.targetDpi,
      workOrderSourceOfTruth: true,
      ...overrides?.metadata,
    },
  };
}
