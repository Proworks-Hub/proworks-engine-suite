// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

/**
 * Recipe Engine for KSix Prep Studio
 * Handles domain-specific recipe presets, operator configurations, and versioning
 * Provides: recipe resolution, operator presets, fallback chains, version migration
 */

import type { PrepProfileDomain } from "./profileEngine.js";

export interface SharedRecipePreset {
  id: string;
  domain: PrepProfileDomain;
  version: number; // v2 = 2, v1 = 1, etc. for migration
  label: string;
  machinePreset: string;
  materialDefaults: string[];
  operatorNotes: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface OperatorRecipeVariant {
  recipeId: string;
  operatorId: string;
  customizations: {
    additionalMaterials?: string[];
    advancedNotes?: string;
    preflightOverrides?: string[];
  };
}

export interface MachineRecipeCompatibilityInput {
  machinePreset: string;
  expectedOutputFormat?: string;
  materialKey?: string;
}

export interface MachineRecipeCompatibilityResult {
  compatible: boolean;
  warnings: string[];
}

interface PersistedRecipeVariantState {
  schemaVersion: number;
  operators: Record<string, Partial<Record<PrepProfileDomain, OperatorRecipeVariant>>>;
}

/**
 * Standard recipe presets for all 5 domains
 * Each recipe is versioned; v2 is current production
 */
const RECIPE_REGISTRY: Record<PrepProfileDomain, SharedRecipePreset> = {
  laser: {
    id: "laser-standard-v2",
    domain: "laser",
    version: 2,
    label: "Laser Standard",
    machinePreset: "laser_co2",
    materialDefaults: ["wood", "acrylic"],
    operatorNotes: "Separate cut, score, and engrave layers before export.",
    updatedAt: "2026-03-15T10:00:00Z",
  },
  dtf: {
    id: "dtf-standard-v2",
    domain: "dtf",
    version: 2,
    label: "DTF Production",
    machinePreset: "dtf-roll-22",
    materialDefaults: ["pet-film", "hot-peel"],
    operatorNotes: "Validate gang-sheet spacing and white underbase before send.",
    updatedAt: "2026-03-15T10:00:00Z",
  },
  uv_uvdtf: {
    id: "uv-standard-v2",
    domain: "uv_uvdtf",
    version: 2,
    label: "UV Production",
    machinePreset: "uv-flatbed",
    materialDefaults: ["acrylic", "glass", "uv-film"],
    operatorNotes: "Use substrate-specific white and varnish strategy.",
    updatedAt: "2026-03-15T10:00:00Z",
  },
  sublimation: {
    id: "sublimation-standard-v2",
    domain: "sublimation",
    version: 2,
    label: "Sublimation Transfer",
    machinePreset: "sublimation-sheet",
    materialDefaults: ["poly-fabric", "hardboard"],
    operatorNotes: "Mirror output and keep transfer-safe ink limits.",
    updatedAt: "2026-03-15T10:00:00Z",
  },
  large_format: {
    id: "large-format-standard-v2",
    domain: "large_format",
    version: 2,
    label: "Large Format Roll",
    machinePreset: "large-format-roll",
    materialDefaults: ["vinyl", "banner"],
    operatorNotes: "Confirm bleed, panelization, and finishing marks.",
    updatedAt: "2026-03-15T10:00:00Z",
  },
};

/**
 * Legacy v1 recipe mappings for backward compatibility
 * Maps old v1 recipe IDs to v2 equivalents
 */
const RECIPE_MIGRATION_MAP: Record<string, string> = {
  "laser-standard-v1": "laser-standard-v2",
  "dtf-standard-v1": "dtf-standard-v2",
  "uv-standard-v1": "uv-standard-v2",
  "sublimation-standard-v1": "sublimation-standard-v2",
  "large-format-standard-v1": "large-format-standard-v2",
};

const RECIPE_VARIANT_STORAGE_KEY = "ksix_prep_operator_recipe_variants_v2";
const RECIPE_VARIANT_SCHEMA_VERSION = 2;

let operatorPresetCache: Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>> | null = null;

/**
 * In-memory operator preset storage (can be extended with persistence)
 * operatorId -> domain -> variant
 */
function toDomainMap(
  value: Partial<Record<PrepProfileDomain, OperatorRecipeVariant>>,
): Map<PrepProfileDomain, OperatorRecipeVariant> {
  const domainMap = new Map<PrepProfileDomain, OperatorRecipeVariant>();
  (Object.keys(value) as PrepProfileDomain[]).forEach((domain) => {
    const variant = value[domain];
    if (!variant) return;
    domainMap.set(domain, variant);
  });
  return domainMap;
}

function fromPresetMap(
  map: Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>>,
): PersistedRecipeVariantState {
  const operators: PersistedRecipeVariantState["operators"] = {};
  for (const [operatorId, domains] of map.entries()) {
    operators[operatorId] = {};
    for (const [domain, variant] of domains.entries()) {
      operators[operatorId][domain] = variant;
    }
  }
  return {
    schemaVersion: RECIPE_VARIANT_SCHEMA_VERSION,
    operators,
  };
}

/**
 * Where operator recipe variants persist.
 *
 * A PORT, added during extraction — the only behavioural seam this file needed
 * to leave the host. It previously reached for `window.localStorage` directly,
 * which a portable engine cannot do: a licensee running VisionIQ in a Node
 * service has no window, and the suite's portability guard rejects ambient I/O
 * in a pure engine. It caught this.
 *
 * HOSTS MUST INJECT ONE TO KEEP PERSISTENCE. In a browser that is
 * `setRecipeVariantStore(window.localStorage)` and behaviour is identical to
 * before extraction. Without a store, variants last the session — which is what
 * already happened outside a browser, so no existing path regressed.
 */
export interface RecipeVariantStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let injectedStore: RecipeVariantStore | null = null;

/** Host-supplied persistence. Pass `null` to fall back to the default. */
export function setRecipeVariantStore(store: RecipeVariantStore | null): void {
  injectedStore = store;
  // The cache is keyed to whatever was previously readable, so a store swap
  // must invalidate it — otherwise the first read after injection returns the
  // old host's data.
  operatorPresetCache = null;
}

function resolveStore(): RecipeVariantStore | null {
  // No fallback to ambient storage, deliberately. Reaching for
  // `globalThis.localStorage` is exactly the ambient I/O a portable engine must
  // not do, and the suite's guard rejects it by name — it caught my first
  // attempt, which kept a browser default "to preserve behaviour".
  //
  // A host that wants operator recipe variants to persist injects a store. In
  // the browser that is one line: `setRecipeVariantStore(window.localStorage)`.
  // Without one, variants live for the session — which is already what happened
  // outside a browser before extraction, so nothing regressed.
  return injectedStore;
}

function migrateLegacyPresetState(raw: unknown): PersistedRecipeVariantState {
  if (!raw || typeof raw !== "object") {
    return { schemaVersion: RECIPE_VARIANT_SCHEMA_VERSION, operators: {} };
  }

  const parsed = raw as Partial<PersistedRecipeVariantState>;
  if (parsed.schemaVersion === RECIPE_VARIANT_SCHEMA_VERSION && parsed.operators) {
    return {
      schemaVersion: RECIPE_VARIANT_SCHEMA_VERSION,
      operators: parsed.operators,
    };
  }

  // Legacy shape support: Record<operatorId, Record<domain, OperatorRecipeVariant>>
  const legacyOperators = raw as PersistedRecipeVariantState["operators"];
  return {
    schemaVersion: RECIPE_VARIANT_SCHEMA_VERSION,
    operators: legacyOperators,
  };
}

function readPersistedOperatorPresets(): Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>> {
  const store = resolveStore();
  if (!store) {
    return new Map();
  }

  try {
    const raw = store.getItem(RECIPE_VARIANT_STORAGE_KEY);
    if (!raw) return new Map();
    const migrated = migrateLegacyPresetState(JSON.parse(raw));
    const map = new Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>>();
    for (const [operatorId, domains] of Object.entries(migrated.operators)) {
      map.set(operatorId, toDomainMap(domains));
    }
    // Keep storage updated to latest schema once migration succeeds.
    store.setItem(RECIPE_VARIANT_STORAGE_KEY, JSON.stringify(migrated));
    return map;
  } catch {
    return new Map();
  }
}

function persistOperatorPresets(map: Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>>): void {
  const store = resolveStore();
  if (!store) return;
  try {
    store.setItem(RECIPE_VARIANT_STORAGE_KEY, JSON.stringify(fromPresetMap(map)));
  } catch {
    // Ignore persistence errors to keep prep operations non-blocking.
  }
}

function getOperatorPresetCache(): Map<string, Map<PrepProfileDomain, OperatorRecipeVariant>> {
  if (!operatorPresetCache) {
    operatorPresetCache = readPersistedOperatorPresets();
  }
  return operatorPresetCache;
}

/**
 * Get standard recipe preset for a domain
 * Returns the current production recipe (v2)
 */
export function getSharedRecipePreset(domain: PrepProfileDomain): SharedRecipePreset {
  const recipe = RECIPE_REGISTRY[domain];
  if (!recipe) {
    throw new Error(`No recipe registered for domain: ${domain}`);
  }
  return recipe;
}

export function getSharedRecipePresetById(
  domain: PrepProfileDomain,
  recipeId: string,
): SharedRecipePreset {
  const recipe = Object.values(RECIPE_REGISTRY).find(
    (candidate) => candidate.domain === domain && candidate.id === recipeId,
  );
  if (recipe) return recipe;
  return getSharedRecipePreset(domain);
}

/**
 * Get all recipes for a domain (past versions for audit/rollback)
 */
export function getRecipeHistory(domain: PrepProfileDomain): SharedRecipePreset[] {
  // In production, this would query a persistence layer
  // For now, return only current version
  const recipe = RECIPE_REGISTRY[domain];
  return recipe ? [recipe] : [];
}

/**
 * Resolve recipe ID with fallback and migration
 * Handles old v1 IDs, missing IDs, and migration paths
 */
export function resolveRecipeId(
  requestedId: string | undefined,
  domain: PrepProfileDomain,
): string {
  if (!requestedId) {
    // No recipe requested, use domain default
    return getSharedRecipePreset(domain).id;
  }

  // Check if requestedId is in current registry
  const isCurrentVersion = Object.values(RECIPE_REGISTRY)
    .filter((r) => r.domain === domain)
    .some((r) => r.id === requestedId);

  if (isCurrentVersion) {
    return requestedId;
  }

  // Check if it's a v1 recipe that needs migration
  const migratedId = RECIPE_MIGRATION_MAP[requestedId];
  if (migratedId) {
    console.warn(`Recipe ${requestedId} migrated to ${migratedId}`);
    return migratedId;
  }

  // Requested recipe doesn't exist, fall back to domain default
  console.warn(`Recipe ${requestedId} not found for domain ${domain}, using default`);
  return getSharedRecipePreset(domain).id;
}

/**
 * Get operator-customized recipe variant
 * Falls back to standard preset if no operator preset exists
 */
export function getOperatorRecipeVariant(
  domain: PrepProfileDomain,
  operatorId?: string,
): SharedRecipePreset {
  if (!operatorId) {
    return getSharedRecipePreset(domain);
  }

  const operatorMap = getOperatorPresetCache().get(operatorId);
  const variant = operatorMap?.get(domain);

  if (!variant) {
    return getSharedRecipePreset(domain);
  }

  // Return base recipe with operator customizations applied
  const baseRecipe = getSharedRecipePreset(domain);
  return {
    ...baseRecipe,
    materialDefaults: [
      ...baseRecipe.materialDefaults,
      ...(variant.customizations.additionalMaterials || []),
    ],
    operatorNotes: `${baseRecipe.operatorNotes}\n\nOperator Notes: ${variant.customizations.advancedNotes || ""}`,
  };
}

/**
 * Store or update an operator recipe preset
 * In production, persist to database
 */
export function setOperatorRecipeVariant(
  operatorId: string,
  domain: PrepProfileDomain,
  variant: OperatorRecipeVariant,
): void {
  const cache = getOperatorPresetCache();
  if (!cache.has(operatorId)) {
    cache.set(operatorId, new Map());
  }

  const operatorMap = cache.get(operatorId)!;
  operatorMap.set(domain, variant);
  persistOperatorPresets(cache);

  // In production: persist to database
  // e.g., await db.operatorRecipePresets.upsert({ operatorId, domain, ...variant })
}

/**
 * Validate recipe is compatible with domain
 * Ensures machine preset, materials, etc. are valid
 */
export function validateRecipeForDomain(
  recipe: SharedRecipePreset,
  domain: PrepProfileDomain,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (recipe.domain !== domain) {
    errors.push(`Recipe domain ${recipe.domain} does not match requested domain ${domain}`);
  }

  // Validate recipe has required fields
  if (!recipe.id) errors.push("Recipe missing id");
  if (!recipe.label) errors.push("Recipe missing label");
  if (!recipe.machinePreset) errors.push("Recipe missing machinePreset");
  if (!recipe.materialDefaults || recipe.materialDefaults.length === 0) {
    errors.push("Recipe missing materialDefaults");
  }

  // Domain-specific validations
  switch (domain) {
    case "laser":
      if (!recipe.machinePreset.includes("co2") && !recipe.machinePreset.includes("laser")) {
        errors.push(`Laser recipe requires laser machine preset, got ${recipe.machinePreset}`);
      }
      break;
    case "dtf":
      if (!recipe.machinePreset.includes("dtf") && !recipe.machinePreset.includes("roll")) {
        errors.push(`DTF recipe requires dtf/roll machine preset, got ${recipe.machinePreset}`);
      }
      break;
    case "uv_uvdtf":
      if (!recipe.machinePreset.includes("uv") && !recipe.machinePreset.includes("flatbed")) {
        errors.push(`UV recipe requires uv/flatbed machine preset, got ${recipe.machinePreset}`);
      }
      break;
    case "sublimation":
      if (!recipe.machinePreset.includes("sublimation")) {
        errors.push(`Sublimation recipe requires sublimation machine preset, got ${recipe.machinePreset}`);
      }
      break;
    case "large_format":
      if (!recipe.machinePreset.includes("large") && !recipe.machinePreset.includes("format")) {
        errors.push(
          `Large format recipe requires large-format machine preset, got ${recipe.machinePreset}`,
        );
      }
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get recipe suggestions for domain (for UI dropdowns)
 */
export function getRecipeSuggestions(domain: PrepProfileDomain): SharedRecipePreset[] {
  // In production, query persistence layer for recipes in this domain
  const recipe = RECIPE_REGISTRY[domain];
  return recipe ? [recipe] : [];
}

export function inferRecipeDomainFromMachinePreset(machinePreset: string): PrepProfileDomain {
  const normalized = machinePreset.toLowerCase();
  if (normalized.includes("laser")) return "laser";
  if (normalized.includes("dtf") && !normalized.includes("uv")) return "dtf";
  if (normalized.includes("uv")) return "uv_uvdtf";
  if (normalized.includes("sublimation")) return "sublimation";
  return "large_format";
}

export function getRecipeSuggestionsForMachine(machinePreset: string): SharedRecipePreset[] {
  return getRecipeSuggestions(inferRecipeDomainFromMachinePreset(machinePreset));
}

export function validateRecipeForMachine(
  recipe: SharedRecipePreset,
  input: MachineRecipeCompatibilityInput,
): MachineRecipeCompatibilityResult {
  const warnings: string[] = [];
  const inferredDomain = inferRecipeDomainFromMachinePreset(input.machinePreset);

  if (recipe.domain !== inferredDomain) {
    warnings.push(
      `Recipe domain ${recipe.domain} does not align with machine preset ${input.machinePreset} (${inferredDomain}).`,
    );
  }

  if (input.materialKey && !recipe.materialDefaults.includes(input.materialKey)) {
    warnings.push(`Material ${input.materialKey} is not in recipe material defaults.`);
  }

  if (input.expectedOutputFormat) {
    const format = input.expectedOutputFormat.toLowerCase();
    if (recipe.domain === "laser" && format !== "svg" && format !== "pdf") {
      warnings.push("Laser workflows are usually safest with vector-first export targets (SVG/PDF).");
    }
    if ((recipe.domain === "dtf" || recipe.domain === "uv_uvdtf") && format === "svg") {
      warnings.push("DTF/UV workflows are typically raster-output workflows. Confirm SVG target is intentional.");
    }
    if (recipe.domain === "sublimation" && format !== "png" && format !== "tiff") {
      warnings.push("Sublimation workflows usually expect raster transfer exports (PNG/TIFF).");
    }
  }

  return {
    compatible: warnings.length === 0,
    warnings,
  };
}

/**
 * Clear operator presets (for testing/reset)
 */
export function clearOperatorPresets(): void {
  getOperatorPresetCache().clear();
  persistOperatorPresets(getOperatorPresetCache());
}
