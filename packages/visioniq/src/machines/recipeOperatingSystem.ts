// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten and the host's generated API types replaced with the structurally
// identical declarations in core/prepSettings.ts — every one of those imports
// was `import type`, so all of it erased at runtime.

import type { PrepJob } from "../core/prepSettings.js";
import type { PrepMachine } from "../core/prepSettings.js";
import {
  getVisiblePrepTabsByPreset,
  mapLegacyPresetToFamily,
  mapProcessFamilyToPreset,
  resolveMachineTarget,
  type PrepProcessFamily,
} from "./machineTargeting.js";
import {
  getSharedRecipePreset,
  type SharedRecipePreset,
} from "../core/recipeEngine.js";
import type { PrepMachineTemplateRecord } from "./machineTemplateEngine.js";

export type RecipeSourcePriority =
  | "explicit_job_override"
  | "workspace_recipe"
  | "machine_recipe"
  | "process_family_default"
  | "preset_default";

export type RecipeControlledSection =
  | "machinePreset"
  | "backgroundSettings"
  | "cleanupSettings"
  | "colorSettings"
  | "halftoneSettings"
  | "vectorSettings"
  | "exportSettings"
  | "visibleTools"
  | "releaseConstraints"
  | "specialistHints"
  | "proHandoffRequirements";

export interface RecipeSummary {
  id: string;
  label: string;
  processFamily: PrepProcessFamily;
  machinePreset: string;
  source: RecipeSourcePriority;
  machineId?: string;
  updatedAt?: string;
}

export interface RecipeReleaseConstraints {
  minDpi?: number;
  requireTransparency?: boolean;
  requiresManualReview?: boolean;
  blockedWithoutProof?: boolean;
}

export interface RecipeSpecialistHints {
  preferredMode?: "universal" | "dtf_uvdtf" | "laser" | "pro_handoff";
  dtfHint?: string;
  laserHint?: string;
}

export interface RecipeControlledPayload {
  machinePreset?: string;
  backgroundSettings?: Partial<PrepJob["backgroundSettings"]>;
  cleanupSettings?: Partial<PrepJob["cleanupSettings"]>;
  colorSettings?: Partial<PrepJob["colorSettings"]>;
  halftoneSettings?: Partial<PrepJob["halftoneSettings"]>;
  vectorSettings?: Partial<PrepJob["vectorSettings"]>;
  exportSettings?: Partial<PrepJob["exportSettings"]>;
  visibleTools?: string[];
  releaseConstraints?: RecipeReleaseConstraints;
  specialistHints?: RecipeSpecialistHints;
  proHandoffRequirements?: string[];
}

export interface RecipeAsset {
  summary: RecipeSummary;
  controls: RecipeControlledPayload;
  operatorNotes?: string;
  tags?: string[];
}

export interface MachineTargetSelection {
  mode: "machine" | "process_family_fallback";
  machineId?: string;
  machineLabel?: string;
  processFamily: PrepProcessFamily;
  suggestedPreset: string;
  machineAvailable: boolean;
  fallbackReason?: string;
}

export interface RecipeSectionDiff {
  section: RecipeControlledSection;
  inherited: boolean;
  overridden: boolean;
  currentValue: unknown;
  resolvedValue: unknown;
}

export interface RecipeDiff {
  sections: RecipeSectionDiff[];
  inheritedCount: number;
  overriddenCount: number;
}

export interface AppliedRecipeSnapshot {
  recipeId: string;
  recipeLabel: string;
  source: RecipeSourcePriority;
  appliedAt: string;
  appliedBy: string;
  machineTarget: MachineTargetSelection;
  preserveManualOverrides: boolean;
  sourceChain: Array<{ source: RecipeSourcePriority; recipeId: string | null }>;
  diff: RecipeDiff;
  impactedTools: string[];
  exportImplications: string[];
  releaseRisks: string[];
}

export interface ResolvedRecipePlan {
  machineTarget: MachineTargetSelection;
  resolvedRecipe: RecipeAsset;
  sourceChain: Array<{ source: RecipeSourcePriority; recipeId: string | null }>;
  impactedTools: string[];
  exportImplications: string[];
  releaseRisks: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeSection<T>(current: T | undefined, next: Partial<T> | undefined, preserveManualOverrides: boolean): T | undefined {
  if (!next) return current;
  if (!preserveManualOverrides) {
    return {
      ...(asRecord(current) as T),
      ...(asRecord(next) as T),
    };
  }
  return {
    ...(asRecord(next) as T),
    ...(asRecord(current) as T),
  };
}

function mapFamilyToDomain(family: PrepProcessFamily): SharedRecipePreset["domain"] {
  if (family === "laser") return "laser";
  if (family === "dtf") return "dtf";
  if (family === "uv" || family === "uvdtf") return "uv_uvdtf";
  if (family === "sublimation") return "sublimation";
  return "large_format";
}

export function buildPresetDefaultRecipeAsset(family: PrepProcessFamily): RecipeAsset {
  const preset = getSharedRecipePreset(mapFamilyToDomain(family));
  return {
    summary: {
      id: `${family}-preset-default`,
      label: `${preset.label} Preset Default`,
      processFamily: family,
      machinePreset: preset.machinePreset,
      source: "preset_default",
      updatedAt: preset.updatedAt,
    },
    controls: {
      machinePreset: preset.machinePreset,
      visibleTools: getVisiblePrepTabsByPreset(preset.machinePreset),
      releaseConstraints: {
        minDpi: family === "poster_photo" ? 150 : 300,
        requireTransparency: family === "dtf" || family === "uvdtf" || family === "uv",
      },
      specialistHints: {
        preferredMode: family === "laser" ? "laser" : family === "dtf" || family === "uvdtf" ? "dtf_uvdtf" : "universal",
      },
    },
    operatorNotes: preset.operatorNotes,
    tags: ["preset-default", family],
  };
}

export function toMachineRecipeAsset(template: PrepMachineTemplateRecord): RecipeAsset {
  const source: RecipeSourcePriority =
    template.scope === "machine_default"
      ? "machine_recipe"
      : template.scope === "process_family_default"
        ? "process_family_default"
        : "workspace_recipe";

  return {
    summary: {
      id: template.id,
      label: template.label,
      processFamily: template.processFamily,
      machinePreset: template.machinePreset,
      source,
      machineId: template.machineId,
      updatedAt: template.updatedAt,
    },
    controls: {
      machinePreset: template.machinePreset,
      backgroundSettings: template.config.backgroundSettings,
      cleanupSettings: template.config.cleanupSettings,
      colorSettings: template.config.colorSettings,
      halftoneSettings: template.config.halftoneSettings,
      vectorSettings: template.config.vectorSettings,
      exportSettings: template.config.exportSettings,
      visibleTools: getVisiblePrepTabsByPreset(template.machinePreset),
    },
    tags: ["template", template.scope],
  };
}

export function resolveMachineTargetSelection(input: {
  job: PrepJob;
  machines: PrepMachine[];
  selectedMachineId?: string;
  selectedProcessFamily?: PrepProcessFamily;
}): MachineTargetSelection {
  const activeMachines = input.machines.filter((machine) => machine.active);
  const selectedMachine = input.selectedMachineId
    ? activeMachines.find((machine) => String(machine.id) === input.selectedMachineId)
    : undefined;

  if (selectedMachine) {
    const resolved = resolveMachineTarget(selectedMachine as unknown as PrepMachine);
    return {
      mode: "machine",
      machineId: resolved.machineId,
      machineLabel: resolved.machineLabel,
      processFamily: resolved.processFamily,
      suggestedPreset: resolved.suggestedPreset,
      machineAvailable: true,
    };
  }

  const fallbackFamily = input.selectedProcessFamily ?? mapLegacyPresetToFamily(String(input.job.machinePreset ?? "DTF"));
  return {
    mode: "process_family_fallback",
    processFamily: fallbackFamily,
    suggestedPreset: mapProcessFamilyToPreset(fallbackFamily),
    machineAvailable: false,
    fallbackReason: input.selectedMachineId
      ? "Selected machine unavailable. Falling back to process family defaults."
      : "No machine selected. Using process family fallback.",
  };
}

function readExplicitOverrideRecipeId(job: PrepJob): string | null {
  const prepStudio = asRecord(asRecord((job as unknown as Record<string, unknown>).metadata).prepStudio);
  const recipeId = prepStudio.recipeOverrideId;
  return typeof recipeId === "string" && recipeId.length > 0 ? recipeId : null;
}

function findMachineRecipe(assets: RecipeAsset[], target: MachineTargetSelection): RecipeAsset | null {
  const directMachine = assets.find(
    (asset) =>
      asset.summary.source === "machine_recipe" &&
      asset.summary.machineId &&
      target.machineId &&
      asset.summary.machineId === target.machineId,
  );
  if (directMachine) return directMachine;

  return (
    assets.find(
      (asset) =>
        asset.summary.source === "machine_recipe" &&
        asset.summary.processFamily === target.processFamily,
    ) ?? null
  );
}

function findProcessFamilyDefault(assets: RecipeAsset[], target: MachineTargetSelection): RecipeAsset | null {
  return (
    assets.find(
      (asset) =>
        asset.summary.source === "process_family_default" &&
        asset.summary.processFamily === target.processFamily,
    ) ?? null
  );
}

function describeExportImplications(asset: RecipeAsset): string[] {
  const implications: string[] = [];
  const format = asRecord(asset.controls.exportSettings).formats;
  if (Array.isArray(format) && format.length > 0) {
    implications.push(`Primary export format: ${String(format[0]).toUpperCase()}`);
  }
  const transparency = asRecord(asset.controls.exportSettings).transparency;
  if (typeof transparency === "boolean") {
    implications.push(transparency ? "Transparency is enabled" : "Transparency is disabled/flattened");
  }
  const dpi = Number(asRecord(asset.controls.exportSettings).dpi);
  if (Number.isFinite(dpi) && dpi > 0) {
    implications.push(`Export DPI target: ${dpi}`);
  }
  if (implications.length === 0) implications.push("Uses machine/profile default export behavior");
  return implications;
}

function buildReleaseRisks(job: PrepJob, asset: RecipeAsset, target: MachineTargetSelection): string[] {
  const risks: string[] = [];
  const constraints = asset.controls.releaseConstraints;
  const sourceDpi = Number(job.sourceDpi ?? 0);

  if (constraints?.minDpi && sourceDpi > 0 && sourceDpi < constraints.minDpi) {
    risks.push(`Source DPI ${sourceDpi} is below recipe minimum ${constraints.minDpi}.`);
  }

  if (constraints?.requireTransparency) {
    const exportTransparency = asRecord(asset.controls.exportSettings).transparency;
    if (exportTransparency === false) {
      risks.push("Recipe requires transparency but export transparency is currently disabled.");
    }
  }

  if (!target.machineAvailable) {
    risks.push("PrepMachine is unavailable. Release should stay in process-family fallback review.");
  }

  if (constraints?.requiresManualReview) {
    risks.push("Recipe requires manual review before release.");
  }

  return risks;
}

export function resolveRecipePlan(input: {
  job: PrepJob;
  machineTarget: MachineTargetSelection;
  assets: RecipeAsset[];
  selectedWorkspaceRecipeId?: string;
}): ResolvedRecipePlan {
  const explicitRecipeId = readExplicitOverrideRecipeId(input.job);
  const explicitRecipe = explicitRecipeId ? input.assets.find((asset) => asset.summary.id === explicitRecipeId) ?? null : null;

  const selectedWorkspaceRecipe = input.selectedWorkspaceRecipeId
    ? input.assets.find(
        (asset) => asset.summary.id === input.selectedWorkspaceRecipeId && asset.summary.source === "workspace_recipe",
      ) ?? null
    : null;

  const machineRecipe = findMachineRecipe(input.assets, input.machineTarget);
  const processFamilyDefault = findProcessFamilyDefault(input.assets, input.machineTarget);
  const presetDefault = buildPresetDefaultRecipeAsset(input.machineTarget.processFamily);

  const resolvedRecipe =
    explicitRecipe ??
    selectedWorkspaceRecipe ??
    machineRecipe ??
    processFamilyDefault ??
    presetDefault;

  const sourceChain: Array<{ source: RecipeSourcePriority; recipeId: string | null }> = [
    { source: "explicit_job_override", recipeId: explicitRecipe?.summary.id ?? null },
    { source: "workspace_recipe", recipeId: selectedWorkspaceRecipe?.summary.id ?? null },
    { source: "machine_recipe", recipeId: machineRecipe?.summary.id ?? null },
    { source: "process_family_default", recipeId: processFamilyDefault?.summary.id ?? null },
    { source: "preset_default", recipeId: presetDefault.summary.id },
  ];

  const impactedTools = resolvedRecipe.controls.visibleTools ?? getVisiblePrepTabsByPreset(resolvedRecipe.summary.machinePreset);
  const exportImplications = describeExportImplications(resolvedRecipe);
  const releaseRisks = buildReleaseRisks(input.job, resolvedRecipe, input.machineTarget);

  return {
    machineTarget: input.machineTarget,
    resolvedRecipe,
    sourceChain,
    impactedTools,
    exportImplications,
    releaseRisks,
  };
}

export function computeRecipeDiff(job: PrepJob, plan: ResolvedRecipePlan, preserveManualOverrides: boolean): RecipeDiff {
  const mappings: Array<{ section: RecipeControlledSection; jobValue: unknown; recipeValue: unknown }> = [
    { section: "machinePreset", jobValue: job.machinePreset, recipeValue: plan.resolvedRecipe.controls.machinePreset },
    { section: "backgroundSettings", jobValue: job.backgroundSettings, recipeValue: plan.resolvedRecipe.controls.backgroundSettings },
    { section: "cleanupSettings", jobValue: job.cleanupSettings, recipeValue: plan.resolvedRecipe.controls.cleanupSettings },
    { section: "colorSettings", jobValue: job.colorSettings, recipeValue: plan.resolvedRecipe.controls.colorSettings },
    { section: "halftoneSettings", jobValue: job.halftoneSettings, recipeValue: plan.resolvedRecipe.controls.halftoneSettings },
    { section: "vectorSettings", jobValue: job.vectorSettings, recipeValue: plan.resolvedRecipe.controls.vectorSettings },
    { section: "exportSettings", jobValue: job.exportSettings, recipeValue: plan.resolvedRecipe.controls.exportSettings },
    { section: "visibleTools", jobValue: asRecord(asRecord((job as unknown as Record<string, unknown>).metadata).prepStudio).visibleTabs, recipeValue: plan.impactedTools },
    { section: "releaseConstraints", jobValue: null, recipeValue: plan.resolvedRecipe.controls.releaseConstraints },
    { section: "specialistHints", jobValue: null, recipeValue: plan.resolvedRecipe.controls.specialistHints },
    { section: "proHandoffRequirements", jobValue: null, recipeValue: plan.resolvedRecipe.controls.proHandoffRequirements },
  ];

  const sections = mappings.map(({ section, jobValue, recipeValue }) => {
    const overridden = preserveManualOverrides && hasValue(jobValue) && hasValue(recipeValue) && !deepEqual(jobValue, recipeValue);
    return {
      section,
      inherited: !overridden,
      overridden,
      currentValue: jobValue,
      resolvedValue: overridden ? jobValue : recipeValue,
    };
  });

  return {
    sections,
    inheritedCount: sections.filter((section) => section.inherited).length,
    overriddenCount: sections.filter((section) => section.overridden).length,
  };
}

export function buildRecipeApplicationPatch(input: {
  job: PrepJob;
  plan: ResolvedRecipePlan;
  preserveManualOverrides: boolean;
  appliedBy: string;
}): { patch: Partial<PrepJob>; snapshot: AppliedRecipeSnapshot } {
  const { job, plan, preserveManualOverrides, appliedBy } = input;
  const controls = plan.resolvedRecipe.controls;

  const patch: Partial<PrepJob> = {
    machinePreset: (controls.machinePreset ?? plan.machineTarget.suggestedPreset) as PrepJob["machinePreset"],
    backgroundSettings: mergeSection(job.backgroundSettings, controls.backgroundSettings, preserveManualOverrides),
    cleanupSettings: mergeSection(job.cleanupSettings, controls.cleanupSettings, preserveManualOverrides),
    colorSettings: mergeSection(job.colorSettings, controls.colorSettings, preserveManualOverrides),
    halftoneSettings: mergeSection(job.halftoneSettings, controls.halftoneSettings, preserveManualOverrides),
    vectorSettings: mergeSection(job.vectorSettings, controls.vectorSettings, preserveManualOverrides),
    exportSettings: mergeSection(job.exportSettings, controls.exportSettings, preserveManualOverrides),
  };

  const diff = computeRecipeDiff(job, plan, preserveManualOverrides);

  const snapshot: AppliedRecipeSnapshot = {
    recipeId: plan.resolvedRecipe.summary.id,
    recipeLabel: plan.resolvedRecipe.summary.label,
    source: plan.resolvedRecipe.summary.source,
    appliedAt: new Date().toISOString(),
    appliedBy,
    machineTarget: plan.machineTarget,
    preserveManualOverrides,
    sourceChain: plan.sourceChain,
    diff,
    impactedTools: plan.impactedTools,
    exportImplications: plan.exportImplications,
    releaseRisks: plan.releaseRisks,
  };

  const currentMetadata = asRecord((job as unknown as Record<string, unknown>).metadata);
  const currentPrepStudio = asRecord(currentMetadata.prepStudio);

  (patch as unknown as Record<string, unknown>).metadata = {
    ...currentMetadata,
    prepStudio: {
      ...currentPrepStudio,
      machineId: plan.machineTarget.machineId,
      machineDisplayName: plan.machineTarget.machineLabel,
      processFamily: plan.machineTarget.processFamily,
      visibleTabs: plan.impactedTools,
      selectedWorkspaceRecipeId:
        plan.sourceChain.find((node) => node.source === "workspace_recipe")?.recipeId ?? currentPrepStudio.selectedWorkspaceRecipeId,
      appliedRecipeSnapshot: snapshot,
    },
  };

  return { patch, snapshot };
}

export function resolveCompatibleWorkspaceRecipes(input: {
  recipes: RecipeAsset[];
  target: MachineTargetSelection;
}): RecipeAsset[] {
  return input.recipes
    .filter((recipe) => recipe.summary.source === "workspace_recipe")
    .filter((recipe) => {
      if (recipe.summary.processFamily === input.target.processFamily) return true;
      return recipe.summary.machinePreset === input.target.suggestedPreset;
    })
    .sort((a, b) => {
      const aFamily = a.summary.processFamily === input.target.processFamily ? 1 : 0;
      const bFamily = b.summary.processFamily === input.target.processFamily ? 1 : 0;
      if (aFamily !== bFamily) return bFamily - aFamily;
      return a.summary.label.localeCompare(b.summary.label);
    });
}
