// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import type {
  CleanupSettings,
  ColorSettings,
  ExportSettings,
  HalftoneSettings,
  PrepJob,
  VectorSettings,
} from "../core/prepSettings.js";
import type { PrepRecipeLocal } from "./recipeTypes.js";
import { mapLegacyPresetToFamily, type PrepProcessFamily } from "../machines/machineTargeting.js";

export type RecipeSection =
  | "machine"
  | "background"
  | "cleanup"
  | "color"
  | "halftones"
  | "garmentPrep"
  | "spotChannels"
  | "vector"
  | "accentLayers"
  | "export";

export interface WorkflowRecipeMeta {
  version: number;
  description?: string;
  tags: string[];
  processFamily: PrepProcessFamily;
  machinePreset: string;
  includedSections: RecipeSection[];
  favorite?: boolean;
  pinned?: boolean;
  compatibility: {
    machinePreset: string;
    processFamily: PrepProcessFamily;
  };
  payload: {
    backgroundSettings?: PrepJob["backgroundSettings"];
    cleanupSettings?: CleanupSettings;
    colorSettings?: ColorSettings;
    halftoneSettings?: HalftoneSettings;
    garmentPrep?: Record<string, unknown>;
    vectorSettings?: VectorSettings;
    exportSettings?: ExportSettings;
    spotChannels?: Record<string, unknown>;
    accentLayers?: Record<string, unknown>;
  };
  lastUsedAt?: string;
}

export interface WorkflowRecipe {
  id: string;
  name: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  machinePreset: string;
  processFamily: PrepProcessFamily;
  tags: string[];
  includedSections: RecipeSection[];
  description?: string;
  favorite: boolean;
  pinned: boolean;
  compatibility: {
    level: "high" | "medium" | "low";
    warnings: string[];
  };
  payload: WorkflowRecipeMeta["payload"];
}

export interface SaveRecipeInput {
  name: string;
  description?: string;
  tags: string[];
  includeSections: RecipeSection[];
  favorite?: boolean;
  pinned?: boolean;
}

const RECIPE_META_PREFIX = "[KSIX_RECIPE_META_V1]";

export const ALL_RECIPE_SECTIONS: RecipeSection[] = [
  "machine",
  "background",
  "cleanup",
  "color",
  "halftones",
  "garmentPrep",
  "spotChannels",
  "vector",
  "accentLayers",
  "export",
];

export function extractPrepMetadata(job: PrepJob): Record<string, unknown> {
  const meta = (job as unknown as Record<string, unknown>).metadata;
  const metadata = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
  const prep = metadata.prepStudio;
  return prep && typeof prep === "object" ? (prep as Record<string, unknown>) : {};
}

export function buildRecipeMetaFromJob(job: PrepJob, input: SaveRecipeInput): WorkflowRecipeMeta {
  const prep = extractPrepMetadata(job);
  const sections = (input.includeSections.length > 0 ? input.includeSections : ["machine", "cleanup", "color", "export"]) as RecipeSection[];

  return {
    version: 1,
    description: input.description,
    tags: input.tags,
    processFamily: mapLegacyPresetToFamily(job.machinePreset as string),
    machinePreset: String(job.machinePreset ?? "DTF"),
    includedSections: sections,
    favorite: Boolean(input.favorite),
    pinned: Boolean(input.pinned),
    compatibility: {
      machinePreset: String(job.machinePreset ?? "DTF"),
      processFamily: mapLegacyPresetToFamily(job.machinePreset as string),
    },
    payload: {
      backgroundSettings: sections.includes("background") ? job.backgroundSettings : undefined,
      cleanupSettings: sections.includes("cleanup") ? job.cleanupSettings : undefined,
      colorSettings: sections.includes("color") ? job.colorSettings : undefined,
      halftoneSettings: sections.includes("halftones") ? job.halftoneSettings : undefined,
      garmentPrep: sections.includes("garmentPrep") ? (prep.garmentPrep as Record<string, unknown> | undefined) : undefined,
      vectorSettings: sections.includes("vector") ? job.vectorSettings : undefined,
      exportSettings: sections.includes("export") ? job.exportSettings : undefined,
      spotChannels: sections.includes("spotChannels") ? (prep.spotChannels as Record<string, unknown> | undefined) : undefined,
      accentLayers: sections.includes("accentLayers") ? (prep.accentLayers as Record<string, unknown> | undefined) : undefined,
    },
  };
}

export function encodeRecipeNotes(baseNotes: string | undefined, meta: WorkflowRecipeMeta): string {
  const notes = (baseNotes ?? "").trim();
  const payload = `${RECIPE_META_PREFIX}${JSON.stringify(meta)}`;
  if (!notes) return payload;
  return `${notes}\n\n${payload}`;
}

export function parseRecipeMeta(notes: string | undefined): { plainNotes: string; meta: WorkflowRecipeMeta | null } {
  const value = String(notes ?? "");
  const index = value.indexOf(RECIPE_META_PREFIX);
  if (index < 0) {
    return { plainNotes: value.trim(), meta: null };
  }

  const plain = value.slice(0, index).trim();
  const raw = value.slice(index + RECIPE_META_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(raw) as WorkflowRecipeMeta;
    if (!parsed || typeof parsed !== "object") return { plainNotes: plain, meta: null };
    return { plainNotes: plain, meta: sanitizeMeta(parsed) };
  } catch {
    return { plainNotes: plain, meta: null };
  }
}

export function toWorkflowRecipe(local: PrepRecipeLocal, job: PrepJob): WorkflowRecipe {
  const parsed = parseRecipeMeta(local.notes);
  const meta = parsed.meta;

  const processFamily = meta?.processFamily ?? mapLegacyPresetToFamily(local.presetKey);
  const includedSections = meta?.includedSections ?? inferIncludedSections(local);
  const tags = meta?.tags ?? [];
  const payload = meta?.payload ?? {
    backgroundSettings: { enabled: local.backgroundRemoval },
    cleanupSettings: { edgeHardness: local.edgeMode === "hard" ? 85 : 50 },
    colorSettings: { enabled: local.colorMapping },
    halftoneSettings: { enabled: local.halftoneEnabled },
    garmentPrep: undefined,
    vectorSettings: { enabled: local.vectorizeRecommended },
    exportSettings: undefined,
    spotChannels: undefined,
    accentLayers: undefined,
  };

  const compatibility = computeCompatibility(job, {
    machinePreset: meta?.machinePreset ?? local.presetKey,
    processFamily,
    includedSections,
  });

  return {
    id: local.id,
    name: local.name,
    notes: parsed.plainNotes,
    createdAt: local.createdAt,
    updatedAt: local.updatedAt,
    machinePreset: meta?.machinePreset ?? local.presetKey,
    processFamily,
    tags,
    includedSections,
    description: meta?.description ?? (parsed.plainNotes || undefined),
    favorite: Boolean(meta?.favorite),
    pinned: Boolean(meta?.pinned),
    compatibility,
    payload,
  };
}

export function computeCompatibility(
  job: PrepJob,
  recipe: { machinePreset: string; processFamily: PrepProcessFamily; includedSections: RecipeSection[] },
): { level: "high" | "medium" | "low"; warnings: string[] } {
  const warnings: string[] = [];
  const jobFamily = mapLegacyPresetToFamily(job.machinePreset as string);

  if (recipe.machinePreset !== String(job.machinePreset ?? "")) {
    warnings.push(`Recipe machine ${recipe.machinePreset} differs from current machine ${String(job.machinePreset ?? "Unknown")}.`);
  }

  if (recipe.processFamily !== jobFamily) {
    warnings.push(`Recipe process ${recipe.processFamily} differs from current process ${jobFamily}.`);
  }

  if (recipe.includedSections.includes("spotChannels") && !(jobFamily === "dtf" || jobFamily === "uv" || jobFamily === "uvdtf")) {
    warnings.push("Spot channel section may be incompatible with this process.");
  }

  if (recipe.includedSections.includes("vector") && !(jobFamily === "laser" || jobFamily === "sticker_vinyl" || jobFamily === "uv" || jobFamily === "uvdtf")) {
    warnings.push("Vector section may not be ideal for this process.");
  }

  if (warnings.length === 0) return { level: "high", warnings };
  if (warnings.length <= 2) return { level: "medium", warnings };
  return { level: "low", warnings };
}

export function applyWorkflowRecipe(
  job: PrepJob,
  recipe: WorkflowRecipe,
  selectedSections: RecipeSection[],
  options?: { preserveMachineBaseline?: boolean },
): Partial<PrepJob> {
  const sections = selectedSections.length > 0 ? selectedSections : recipe.includedSections;
  const preserveMachineBaseline = options?.preserveMachineBaseline ?? true;
  const prep = extractPrepMetadata(job);

  const updates: Partial<PrepJob> = {};

  if (!preserveMachineBaseline && sections.includes("machine")) {
    updates.machinePreset = recipe.machinePreset as PrepJob["machinePreset"];
  }

  if (sections.includes("background") && recipe.payload.backgroundSettings) updates.backgroundSettings = recipe.payload.backgroundSettings as PrepJob["backgroundSettings"];
  if (sections.includes("cleanup") && recipe.payload.cleanupSettings) updates.cleanupSettings = recipe.payload.cleanupSettings;
  if (sections.includes("color") && recipe.payload.colorSettings) updates.colorSettings = recipe.payload.colorSettings;
  if (sections.includes("halftones") && recipe.payload.halftoneSettings) updates.halftoneSettings = recipe.payload.halftoneSettings;
  if (sections.includes("vector") && recipe.payload.vectorSettings) updates.vectorSettings = recipe.payload.vectorSettings;
  if (sections.includes("export") && recipe.payload.exportSettings) updates.exportSettings = recipe.payload.exportSettings;

  const nextPrep: Record<string, unknown> = { ...prep };
  if (sections.includes("spotChannels") && recipe.payload.spotChannels) nextPrep.spotChannels = recipe.payload.spotChannels;
  if (sections.includes("accentLayers") && recipe.payload.accentLayers) nextPrep.accentLayers = recipe.payload.accentLayers;
  if (sections.includes("garmentPrep") && recipe.payload.garmentPrep) nextPrep.garmentPrep = recipe.payload.garmentPrep;
  nextPrep.appliedRecipe = {
    id: recipe.id,
    name: recipe.name,
    sections,
    appliedAt: new Date().toISOString(),
  };

  const meta = (job as unknown as Record<string, unknown>).metadata;
  const metadata = meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};

  (updates as unknown as Record<string, unknown>).metadata = {
    ...metadata,
    prepStudio: nextPrep,
  };

  return updates;
}

export function inferIncludedSections(recipe: PrepRecipeLocal): RecipeSection[] {
  const sections: RecipeSection[] = ["machine"];
  if (recipe.backgroundRemoval) sections.push("background");
  sections.push("cleanup");
  if (recipe.colorMapping) sections.push("color");
  if (recipe.halftoneEnabled) sections.push("halftones");
  if (recipe.halftoneEnabled) sections.push("garmentPrep");
  if (recipe.vectorizeRecommended) sections.push("vector");
  sections.push("export");
  return sections;
}

export function filterRecipes(
  recipes: WorkflowRecipe[],
  query: string,
  processFilter: "all" | PrepProcessFamily,
  sectionFilter: "all" | RecipeSection,
): WorkflowRecipe[] {
  const q = query.trim().toLowerCase();
  return recipes.filter((recipe) => {
    if (processFilter !== "all" && recipe.processFamily !== processFilter) return false;
    if (sectionFilter !== "all" && !recipe.includedSections.includes(sectionFilter)) return false;
    if (!q) return true;

    const haystack = [
      recipe.name,
      recipe.description ?? "",
      recipe.machinePreset,
      recipe.processFamily,
      ...recipe.tags,
      ...recipe.includedSections,
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });
}

export function sortRecipes(recipes: WorkflowRecipe[], sortBy: "recent" | "name" | "process"): WorkflowRecipe[] {
  const clone = [...recipes];
  if (sortBy === "name") return clone.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "process") return clone.sort((a, b) => a.processFamily.localeCompare(b.processFamily));
  return clone.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function sanitizeMeta(meta: WorkflowRecipeMeta): WorkflowRecipeMeta {
  return {
    version: 1,
    description: typeof meta.description === "string" ? meta.description : undefined,
    tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === "string") : [],
    processFamily: meta.processFamily,
    machinePreset: String(meta.machinePreset ?? "DTF"),
    includedSections: Array.isArray(meta.includedSections)
      ? meta.includedSections.filter((section): section is RecipeSection => ALL_RECIPE_SECTIONS.includes(section as RecipeSection))
      : ["machine", "cleanup", "color", "export"],
    favorite: Boolean(meta.favorite),
    pinned: Boolean(meta.pinned),
    compatibility: {
      machinePreset: String(meta.compatibility?.machinePreset ?? meta.machinePreset ?? "DTF"),
      processFamily: meta.compatibility?.processFamily ?? meta.processFamily,
    },
    payload: {
      backgroundSettings: meta.payload?.backgroundSettings,
      cleanupSettings: meta.payload?.cleanupSettings,
      colorSettings: meta.payload?.colorSettings,
      halftoneSettings: meta.payload?.halftoneSettings,
      vectorSettings: meta.payload?.vectorSettings,
      exportSettings: meta.payload?.exportSettings,
      spotChannels: meta.payload?.spotChannels,
      accentLayers: meta.payload?.accentLayers,
    },
    lastUsedAt: typeof meta.lastUsedAt === "string" ? meta.lastUsedAt : undefined,
  };
}
