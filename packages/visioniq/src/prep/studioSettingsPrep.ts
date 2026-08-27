import { getVisionStorage } from "../core/storage.js";
// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import type { PrepJob } from "../core/prepSettings.js";
import { mapLegacyPresetToFamily, type PrepProcessFamily } from "../machines/machineTargeting.js";

export const STUDIO_SETTINGS_STORAGE_KEY = "ksix_studio_settings_v2";

export type RecipeApplyMode = "suggest-only" | "auto-apply-safe";
export type IncompatibleToolBehavior = "hide" | "collapse";
export type PreviewDefaultTab = "current" | "original" | "compare";
export type PreviewQuality = "performance" | "balanced" | "quality";
export type ControlDensity = "compact" | "comfortable";
export type PrecedenceMode = "machine_then_recipe_then_manual" | "recipe_then_machine_then_manual";

export interface StudioSettingsState {
  globalDefaults: {
    autoDetectArtTypeOnOpen: boolean;
    autoSuggestRecipeOnOpen: boolean;
    autoLoadPreviousRecipe: boolean;
    autoLoadMachineDefaults: boolean;
    autoOpenLastTool: boolean;
    autoRunReadinessOnIntake: boolean;
    autoRestorePreviewViewport: boolean;
    rememberPanelStates: boolean;
    rememberLastTool: boolean;
  };
  recipeBehavior: {
    suggestByMachineProcessArtType: boolean;
    autoApplyRecommendedRecipe: boolean;
    applyMode: RecipeApplyMode;
    preferredNewJobBehavior: "none" | "last-used" | "machine-recommended";
    quickSavePromptAfterMajorChanges: boolean;
  };
  machineBehavior: {
    autoApplyProcessDefaultsOnMachineChange: boolean;
    promptBeforeMachineOverwrite: boolean;
    incompatibleToolBehavior: IncompatibleToolBehavior;
    defaultMachinePreset: string;
    defaultProcessFamily: PrepProcessFamily | "auto";
  };
  exportDefaults: {
    defaultDestinationType: "job_files" | "work_order_files" | "production_files" | "download";
    defaultDestination: string;
    defaultNamingTemplate: string;
    includeWorkOrderNumber: boolean;
    includeMachineCode: boolean;
    includeVersionSuffix: boolean;
    includeChannelSuffix: boolean;
    sanitizeFilenames: boolean;
    overwriteProtection: "append-version" | "replace" | "block";
  };
  previewDefaults: {
    defaultPreviewTab: PreviewDefaultTab;
    checkerboardTransparency: boolean;
    showDebugOverlaysByDefault: boolean;
    showEdgesMaskColorZonesByDefault: boolean;
    previewQuality: PreviewQuality;
    zoomBehavior: "fit-on-open" | "remember-last";
  };
  debugSettings: {
    verboseDebugLogging: boolean;
    showDiagnosticsPanel: boolean;
    exportValidationLogging: boolean;
    machineTemplateResolutionLogging: boolean;
    performanceDebug: boolean;
  };
  operatorPreferences: {
    controlDensity: ControlDensity;
    confirmDestructiveActions: boolean;
    showAdvancedSettingsByDefault: boolean;
    autoCollapseUnrelatedSections: boolean;
    showKeyboardShortcutHelp: boolean;
    enableNotifications: boolean;
  };
  performanceSettings: {
    enableLivePreviewByDefault: boolean;
    autoGeneratePreviews: boolean;
    largeImageSafeguardWarnings: boolean;
    autoDisableExpensiveOverlaysOnHugeFiles: boolean;
    preferredPreviewResolution: number;
  };
  precedence: {
    mode: PrecedenceMode;
    explain: string;
  };
  updatedAt: string;
  version: number;
}

export function defaultStudioSettings(): StudioSettingsState {
  return {
    globalDefaults: {
      autoDetectArtTypeOnOpen: true,
      autoSuggestRecipeOnOpen: true,
      autoLoadPreviousRecipe: false,
      autoLoadMachineDefaults: true,
      autoOpenLastTool: true,
      autoRunReadinessOnIntake: false,
      autoRestorePreviewViewport: true,
      rememberPanelStates: true,
      rememberLastTool: true,
    },
    recipeBehavior: {
      suggestByMachineProcessArtType: true,
      autoApplyRecommendedRecipe: false,
      applyMode: "suggest-only",
      preferredNewJobBehavior: "machine-recommended",
      quickSavePromptAfterMajorChanges: true,
    },
    machineBehavior: {
      autoApplyProcessDefaultsOnMachineChange: true,
      promptBeforeMachineOverwrite: true,
      incompatibleToolBehavior: "hide",
      defaultMachinePreset: "",
      defaultProcessFamily: "auto",
    },
    exportDefaults: {
      defaultDestinationType: "job_files",
      defaultDestination: "prep-job-files",
      defaultNamingTemplate: "{artwork}_{process}_{machine}_{version}",
      includeWorkOrderNumber: true,
      includeMachineCode: true,
      includeVersionSuffix: true,
      includeChannelSuffix: false,
      sanitizeFilenames: true,
      overwriteProtection: "append-version",
    },
    previewDefaults: {
      defaultPreviewTab: "current",
      checkerboardTransparency: true,
      showDebugOverlaysByDefault: false,
      showEdgesMaskColorZonesByDefault: false,
      previewQuality: "balanced",
      zoomBehavior: "fit-on-open",
    },
    debugSettings: {
      verboseDebugLogging: false,
      showDiagnosticsPanel: false,
      exportValidationLogging: false,
      machineTemplateResolutionLogging: false,
      performanceDebug: false,
    },
    operatorPreferences: {
      controlDensity: "comfortable",
      confirmDestructiveActions: true,
      showAdvancedSettingsByDefault: false,
      autoCollapseUnrelatedSections: false,
      showKeyboardShortcutHelp: true,
      enableNotifications: false,
    },
    performanceSettings: {
      enableLivePreviewByDefault: true,
      autoGeneratePreviews: true,
      largeImageSafeguardWarnings: true,
      autoDisableExpensiveOverlaysOnHugeFiles: true,
      preferredPreviewResolution: 1300,
    },
    precedence: {
      mode: "machine_then_recipe_then_manual",
      explain: "Studio defaults seed behavior, machine template provides baseline, recipe overlays selected sections, manual job changes always win.",
    },
    updatedAt: new Date().toISOString(),
    version: 2,
  };
}

export function mergeStudioSettings(raw: Partial<StudioSettingsState> | undefined): StudioSettingsState {
  const base = defaultStudioSettings();
  const merged: StudioSettingsState = {
    ...base,
    ...raw,
    globalDefaults: { ...base.globalDefaults, ...(raw?.globalDefaults ?? {}) },
    recipeBehavior: { ...base.recipeBehavior, ...(raw?.recipeBehavior ?? {}) },
    machineBehavior: { ...base.machineBehavior, ...(raw?.machineBehavior ?? {}) },
    exportDefaults: { ...base.exportDefaults, ...(raw?.exportDefaults ?? {}) },
    previewDefaults: { ...base.previewDefaults, ...(raw?.previewDefaults ?? {}) },
    debugSettings: { ...base.debugSettings, ...(raw?.debugSettings ?? {}) },
    operatorPreferences: { ...base.operatorPreferences, ...(raw?.operatorPreferences ?? {}) },
    performanceSettings: {
      ...base.performanceSettings,
      ...(raw?.performanceSettings ?? {}),
      preferredPreviewResolution: clamp(Number(raw?.performanceSettings?.preferredPreviewResolution ?? base.performanceSettings.preferredPreviewResolution), 320, 4000),
    },
    precedence: {
      ...base.precedence,
      ...(raw?.precedence ?? {}),
      mode: raw?.precedence?.mode === "recipe_then_machine_then_manual" ? "recipe_then_machine_then_manual" : "machine_then_recipe_then_manual",
    },
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    version: 2,
  };

  return merged;
}

export function loadStudioSettingsFromStorage(storageKey = STUDIO_SETTINGS_STORAGE_KEY): StudioSettingsState {
  try {
    const raw = getVisionStorage()?.getItem(storageKey) ?? null;
    if (!raw) return defaultStudioSettings();
    const parsed = JSON.parse(raw) as Partial<StudioSettingsState>;
    return mergeStudioSettings(parsed);
  } catch {
    return defaultStudioSettings();
  }
}

export function saveStudioSettingsToStorage(settings: StudioSettingsState, storageKey = STUDIO_SETTINGS_STORAGE_KEY): void {
  try {
    getVisionStorage()?.setItem(storageKey, JSON.stringify({ ...settings, updatedAt: new Date().toISOString(), version: 2 }));
  } catch {
    // Ignore unavailable storage.
  }
}

export function resetStudioSettingsSection(
  settings: StudioSettingsState,
  section: keyof Omit<StudioSettingsState, "updatedAt" | "version">,
): StudioSettingsState {
  const defaults = defaultStudioSettings();
  return {
    ...settings,
    [section]: defaults[section],
    updatedAt: new Date().toISOString(),
  };
}

export function recommendedStudioSettingsForJob(job: PrepJob): StudioSettingsState {
  const defaults = defaultStudioSettings();
  const family = mapLegacyPresetToFamily(job.machinePreset as string);

  if (family === "laser") {
    return {
      ...defaults,
      previewDefaults: {
        ...defaults.previewDefaults,
        defaultPreviewTab: "compare",
        showEdgesMaskColorZonesByDefault: true,
      },
      performanceSettings: {
        ...defaults.performanceSettings,
        enableLivePreviewByDefault: false,
        autoGeneratePreviews: false,
        preferredPreviewResolution: 1000,
      },
      recipeBehavior: {
        ...defaults.recipeBehavior,
        applyMode: "suggest-only",
      },
    };
  }

  if (family === "uv" || family === "uvdtf") {
    return {
      ...defaults,
      globalDefaults: {
        ...defaults.globalDefaults,
        autoSuggestRecipeOnOpen: true,
      },
      recipeBehavior: {
        ...defaults.recipeBehavior,
        preferredNewJobBehavior: "machine-recommended",
      },
      previewDefaults: {
        ...defaults.previewDefaults,
        showDebugOverlaysByDefault: true,
      },
    };
  }

  return defaults;
}

export function buildSettingsSnapshotMetadata(settings: StudioSettingsState): Record<string, unknown> {
  return {
    version: settings.version,
    updatedAt: settings.updatedAt,
    precedenceMode: settings.precedence.mode,
    recipeMode: settings.recipeBehavior.applyMode,
    defaultDestinationType: settings.exportDefaults.defaultDestinationType,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
