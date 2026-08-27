// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

import {
  resolveProfileBundle,
  type PrepProfileDomain,
  type ProfileSelection,
} from "./profileEngine.js";

export type ColorPreviewMode = "soft-proof" | "standard";

export interface SharedColorPlan {
  profileName: string;
  renderingIntent: "perceptual" | "relative";
  preserveBlack: boolean;
  normalizeToProfile: boolean;
  previewMode: ColorPreviewMode;
  outputCompensation: "none" | "ink-limit" | "dot-gain";
}

export interface ResolveColorPlanInput {
  profileSelection?: ProfileSelection;
  recipeId?: string;
}

const DOMAIN_COLOR_DEFAULTS: Record<
  PrepProfileDomain,
  Omit<SharedColorPlan, "profileName">
> = {
  laser: {
    renderingIntent: "relative",
    preserveBlack: true,
    normalizeToProfile: true,
    previewMode: "standard",
    outputCompensation: "none",
  },
  dtf: {
    renderingIntent: "perceptual",
    preserveBlack: true,
    normalizeToProfile: true,
    previewMode: "soft-proof",
    outputCompensation: "ink-limit",
  },
  uv_uvdtf: {
    renderingIntent: "relative",
    preserveBlack: true,
    normalizeToProfile: true,
    previewMode: "soft-proof",
    outputCompensation: "dot-gain",
  },
  sublimation: {
    renderingIntent: "perceptual",
    preserveBlack: false,
    normalizeToProfile: true,
    previewMode: "soft-proof",
    outputCompensation: "ink-limit",
  },
  large_format: {
    renderingIntent: "relative",
    preserveBlack: true,
    normalizeToProfile: true,
    previewMode: "standard",
    outputCompensation: "dot-gain",
  },
};

export function resolveWorkflowColorPlan(
  domain: PrepProfileDomain,
  input?: ResolveColorPlanInput,
): SharedColorPlan {
  const defaults = DOMAIN_COLOR_DEFAULTS[domain];
  const bundle = resolveProfileBundle(domain, input?.profileSelection);

  return {
    ...defaults,
    profileName: bundle.machine.colorProfile,
  };
}

export function buildColorMetadata(colorPlan: SharedColorPlan): Record<string, unknown> {
  return {
    colorProfile: colorPlan.profileName,
    colorRenderingIntent: colorPlan.renderingIntent,
    colorPreserveBlack: colorPlan.preserveBlack,
    colorNormalized: colorPlan.normalizeToProfile,
    colorPreviewMode: colorPlan.previewMode,
    colorOutputCompensation: colorPlan.outputCompensation,
  };
}
