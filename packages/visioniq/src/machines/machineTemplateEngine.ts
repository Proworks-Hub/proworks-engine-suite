// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten and the host's generated API types replaced with the structurally
// identical declarations in core/prepSettings.ts — every one of those imports
// was `import type`, so all of it erased at runtime.

import type { PrepJob } from "../core/prepSettings.js";
import type { PrepProcessFamily } from "./machineTargeting.js";
import type { MachinePresetKey } from "./machinePresets.js";

export type MachineTemplateScope =
  | "process_family_default"
  | "machine_default"
  | "workspace_override"
  | "custom_named";

export interface MachineTemplateConfig {
  backgroundSettings?: Partial<PrepJob["backgroundSettings"]>;
  cleanupSettings?: Partial<PrepJob["cleanupSettings"]>;
  colorSettings?: Partial<PrepJob["colorSettings"]>;
  halftoneSettings?: Partial<PrepJob["halftoneSettings"]>;
  vectorSettings?: Partial<PrepJob["vectorSettings"]>;
  exportSettings?: Partial<PrepJob["exportSettings"]>;
  spotChannelDefaults?: Record<string, unknown>;
}

export interface PrepMachineTemplateRecord {
  id: string;
  tenantId: string;
  workspaceId: string;
  scope: MachineTemplateScope;
  label: string;
  processFamily: PrepProcessFamily;
  machinePreset: MachinePresetKey;
  machineId?: string;
  version: number;
  isDefault: boolean;
  config: MachineTemplateConfig;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  createdBy: string;
  archivedAt?: string;
}

export interface MachineTemplateInheritanceResult {
  resolved: MachineTemplateConfig;
  inheritedBySection: Record<string, "inherited" | "overridden" | "reset_to_machine_default">;
  chain: {
    processFamilyDefault?: PrepMachineTemplateRecord;
    machineDefault?: PrepMachineTemplateRecord;
    workspaceOverride?: PrepMachineTemplateRecord;
    jobOverrideApplied: boolean;
  };
}

export type TemplateCompatibilityCode =
  | "unsupported_color_mode"
  | "unsupported_output_format"
  | "incompatible_transparency"
  | "wrong_dpi_target"
  | "missing_material_constraints";

export interface TemplateCompatibilityIssue {
  code: TemplateCompatibilityCode;
  severity: "warning" | "error";
  message: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

function mergeObjects<T extends Record<string, unknown>>(base: T, patch?: unknown): T {
  if (!patch || typeof patch !== "object") return base;
  return {
    ...base,
    ...(patch as Record<string, unknown>),
  } as T;
}

function normalizeSection(value: unknown): Record<string, unknown> {
  return asObject(value);
}

function sectionChanged(base: unknown, next: unknown): boolean {
  return JSON.stringify(normalizeSection(base)) !== JSON.stringify(normalizeSection(next));
}

export function resolveMachineTemplateInheritance(input: {
  templates: PrepMachineTemplateRecord[];
  processFamily: PrepProcessFamily;
  workspaceId: string;
  machinePreset: MachinePresetKey;
  machineId?: string | null;
  preferredWorkspaceTemplateId?: string | null;
  jobOverride?: MachineTemplateConfig;
}): MachineTemplateInheritanceResult {
  const active = input.templates.filter((template) => !template.archivedAt);

  const processFamilyDefault = active.find(
    (template) =>
      template.scope === "process_family_default" &&
      template.processFamily === input.processFamily &&
      template.isDefault,
  );

  const machineDefault = active.find(
    (template) =>
      template.scope === "machine_default" &&
      template.processFamily === input.processFamily &&
      template.machinePreset === input.machinePreset &&
      template.machineId === (input.machineId ?? undefined) &&
      template.isDefault,
  );

  const preferredWorkspace = input.preferredWorkspaceTemplateId
    ? active.find((template) => template.id === input.preferredWorkspaceTemplateId)
    : undefined;

  const workspaceOverride =
    preferredWorkspace &&
    (preferredWorkspace.scope === "workspace_override" || preferredWorkspace.scope === "custom_named")
      ? preferredWorkspace
      : active.find(
          (template) =>
            template.scope === "workspace_override" &&
            template.workspaceId === input.workspaceId &&
            template.processFamily === input.processFamily &&
            template.machinePreset === input.machinePreset &&
            template.isDefault,
        );

  const familyConfig = processFamilyDefault?.config ?? {};
  const machineConfig = machineDefault?.config ?? {};
  const workspaceConfig = workspaceOverride?.config ?? {};
  const jobOverride = input.jobOverride ?? {};

  const processLayer: MachineTemplateConfig = {
    backgroundSettings: familyConfig.backgroundSettings,
    cleanupSettings: familyConfig.cleanupSettings,
    colorSettings: familyConfig.colorSettings,
    halftoneSettings: familyConfig.halftoneSettings,
    vectorSettings: familyConfig.vectorSettings,
    exportSettings: familyConfig.exportSettings,
    spotChannelDefaults: familyConfig.spotChannelDefaults,
  };

  const machineLayer: MachineTemplateConfig = {
    backgroundSettings: mergeObjects(asObject(processLayer.backgroundSettings), machineConfig.backgroundSettings),
    cleanupSettings: mergeObjects(asObject(processLayer.cleanupSettings), machineConfig.cleanupSettings),
    colorSettings: mergeObjects(asObject(processLayer.colorSettings), machineConfig.colorSettings),
    halftoneSettings: mergeObjects(asObject(processLayer.halftoneSettings), machineConfig.halftoneSettings),
    vectorSettings: mergeObjects(asObject(processLayer.vectorSettings), machineConfig.vectorSettings),
    exportSettings: mergeObjects(asObject(processLayer.exportSettings), machineConfig.exportSettings),
    spotChannelDefaults: mergeObjects(asObject(processLayer.spotChannelDefaults), machineConfig.spotChannelDefaults),
  };

  const workspaceLayer: MachineTemplateConfig = {
    backgroundSettings: mergeObjects(asObject(machineLayer.backgroundSettings), workspaceConfig.backgroundSettings),
    cleanupSettings: mergeObjects(asObject(machineLayer.cleanupSettings), workspaceConfig.cleanupSettings),
    colorSettings: mergeObjects(asObject(machineLayer.colorSettings), workspaceConfig.colorSettings),
    halftoneSettings: mergeObjects(asObject(machineLayer.halftoneSettings), workspaceConfig.halftoneSettings),
    vectorSettings: mergeObjects(asObject(machineLayer.vectorSettings), workspaceConfig.vectorSettings),
    exportSettings: mergeObjects(asObject(machineLayer.exportSettings), workspaceConfig.exportSettings),
    spotChannelDefaults: mergeObjects(asObject(machineLayer.spotChannelDefaults), workspaceConfig.spotChannelDefaults),
  };

  const resolved: MachineTemplateConfig = {
    backgroundSettings: mergeObjects(asObject(workspaceLayer.backgroundSettings), jobOverride.backgroundSettings),
    cleanupSettings: mergeObjects(asObject(workspaceLayer.cleanupSettings), jobOverride.cleanupSettings),
    colorSettings: mergeObjects(asObject(workspaceLayer.colorSettings), jobOverride.colorSettings),
    halftoneSettings: mergeObjects(asObject(workspaceLayer.halftoneSettings), jobOverride.halftoneSettings),
    vectorSettings: mergeObjects(asObject(workspaceLayer.vectorSettings), jobOverride.vectorSettings),
    exportSettings: mergeObjects(asObject(workspaceLayer.exportSettings), jobOverride.exportSettings),
    spotChannelDefaults: mergeObjects(asObject(workspaceLayer.spotChannelDefaults), jobOverride.spotChannelDefaults),
  };

  const inheritedBySection: MachineTemplateInheritanceResult["inheritedBySection"] = {
    backgroundSettings: "inherited",
    cleanupSettings: "inherited",
    colorSettings: "inherited",
    halftoneSettings: "inherited",
    vectorSettings: "inherited",
    exportSettings: "inherited",
    spotChannelDefaults: "inherited",
  };

  const machineSections = [
    "backgroundSettings",
    "cleanupSettings",
    "colorSettings",
    "halftoneSettings",
    "vectorSettings",
    "exportSettings",
    "spotChannelDefaults",
  ] as const;

  for (const section of machineSections) {
    const machineValue = machineLayer[section];
    const workspaceValue = workspaceLayer[section];
    const resolvedValue = resolved[section];
    if (sectionChanged(machineValue, workspaceValue)) {
      inheritedBySection[section] = "overridden";
    }
    if (sectionChanged(workspaceValue, resolvedValue)) {
      inheritedBySection[section] = "overridden";
    }
    if (!sectionChanged(machineValue, resolvedValue)) {
      inheritedBySection[section] = "reset_to_machine_default";
    }
  }

  return {
    resolved,
    inheritedBySection,
    chain: {
      processFamilyDefault,
      machineDefault,
      workspaceOverride,
      jobOverrideApplied: Object.keys(jobOverride).length > 0,
    },
  };
}

const FAMILY_COMPATIBILITY: Record<
  PrepProcessFamily,
  {
    colorModes: string[];
    formats: string[];
    allowTransparency: boolean;
    dpiRange: [number, number];
  }
> = {
  dtf: { colorModes: ["rgb", "cmyk"], formats: ["PNG", "TIFF", "PSD"], allowTransparency: true, dpiRange: [240, 600] },
  uvdtf: { colorModes: ["rgb", "cmyk"], formats: ["PNG", "TIFF", "PSD"], allowTransparency: true, dpiRange: [300, 600] },
  uv: { colorModes: ["rgb", "cmyk"], formats: ["PNG", "TIFF", "PSD"], allowTransparency: true, dpiRange: [300, 720] },
  fine_art: { colorModes: ["rgb", "cmyk"], formats: ["TIFF", "PDF", "PNG"], allowTransparency: false, dpiRange: [300, 1200] },
  poster_photo: { colorModes: ["rgb", "cmyk"], formats: ["PDF", "TIFF", "PNG"], allowTransparency: false, dpiRange: [120, 300] },
  sticker_vinyl: { colorModes: ["rgb", "cmyk"], formats: ["PNG", "TIFF", "SVG"], allowTransparency: true, dpiRange: [240, 600] },
  sublimation: { colorModes: ["rgb"], formats: ["PNG", "TIFF"], allowTransparency: false, dpiRange: [240, 600] },
  canvas: { colorModes: ["rgb", "cmyk"], formats: ["TIFF", "PDF", "PNG"], allowTransparency: false, dpiRange: [240, 600] },
  laser: { colorModes: ["grayscale", "bitmap"], formats: ["SVG", "PDF", "PNG"], allowTransparency: false, dpiRange: [300, 1200] },
  unknown: { colorModes: ["rgb", "cmyk"], formats: ["PNG", "TIFF", "PDF"], allowTransparency: true, dpiRange: [150, 600] },
};

function normalizeMode(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function extractFormat(exportSettings: unknown): string {
  const asRecord = asObject(exportSettings);
  const firstFormat = Array.isArray(asRecord.formats) ? asRecord.formats[0] : undefined;
  return String(firstFormat ?? asRecord.format ?? "PNG").toUpperCase();
}

function extractResolution(exportSettings: unknown, fallback = 300): number {
  const asRecord = asObject(exportSettings);
  const resolution = Number(asRecord.resolution ?? fallback);
  return Number.isFinite(resolution) ? resolution : fallback;
}

function extractTransparency(exportSettings: unknown, fallback = true): boolean {
  const asRecord = asObject(exportSettings);
  if (typeof asRecord.transparency === "boolean") return asRecord.transparency;
  return fallback;
}

function extractMaterial(job: PrepJob): string {
  const maybe = asObject(job);
  const metadata = asObject(maybe.metadata);
  return String(
    maybe.materialName ??
      maybe.materialType ??
      metadata.materialName ??
      metadata.materialType ??
      "",
  )
    .trim()
    .toLowerCase();
}

export function runMachineCompatibilityChecks(input: {
  processFamily: PrepProcessFamily;
  machine: { compatibleMaterials?: string[] } | null;
  job: PrepJob;
  resolvedConfig: MachineTemplateConfig;
}): TemplateCompatibilityIssue[] {
  const profile = FAMILY_COMPATIBILITY[input.processFamily] ?? FAMILY_COMPATIBILITY.unknown;
  const issues: TemplateCompatibilityIssue[] = [];

  const colorMode = normalizeMode((input.job as unknown as Record<string, unknown>).sourceColorMode);
  if (colorMode && !profile.colorModes.includes(colorMode)) {
    issues.push({
      code: "unsupported_color_mode",
      severity: "error",
      message: `${input.processFamily} does not support source color mode \"${colorMode}\".`,
    });
  }

  const format = extractFormat(input.resolvedConfig.exportSettings);
  if (!profile.formats.includes(format)) {
    issues.push({
      code: "unsupported_output_format",
      severity: "error",
      message: `${input.processFamily} output does not support ${format}.`,
    });
  }

  const transparency = extractTransparency(input.resolvedConfig.exportSettings, true);
  if (transparency && !profile.allowTransparency) {
    issues.push({
      code: "incompatible_transparency",
      severity: "warning",
      message: `${input.processFamily} is configured for flattened output, but transparency is enabled.`,
    });
  }

  const resolution = extractResolution(input.resolvedConfig.exportSettings, 300);
  const [minDpi, maxDpi] = profile.dpiRange;
  if (resolution < minDpi || resolution > maxDpi) {
    issues.push({
      code: "wrong_dpi_target",
      severity: "warning",
      message: `${input.processFamily} target DPI should be between ${minDpi} and ${maxDpi}; current target is ${resolution}.`,
    });
  }

  const compatibleMaterials = (input.machine?.compatibleMaterials ?? []).map((item) => item.toLowerCase());
  const material = extractMaterial(input.job);
  if (compatibleMaterials.length > 0 && (!material || !compatibleMaterials.includes(material))) {
    issues.push({
      code: "missing_material_constraints",
      severity: "warning",
      message: "PrepJob material is missing or not listed in machine-compatible materials.",
    });
  }

  return issues;
}

export function getSuggestedExportTargets(processFamily: PrepProcessFamily): {
  visibleTabs: string[];
  preferredFormats: string[];
} {
  const profile = FAMILY_COMPATIBILITY[processFamily] ?? FAMILY_COMPATIBILITY.unknown;
  return {
    visibleTabs:
      processFamily === "laser"
        ? ["ai", "intake", "machine", "cleanup", "halftones", "dither", "vector", "export", "recipes", "settings"]
        : processFamily === "uv" || processFamily === "uvdtf"
          ? ["ai", "intake", "machine", "background", "cleanup", "color", "halftones", "channels", "vector", "accent", "export", "recipes", "settings"]
          : ["ai", "intake", "machine", "background", "cleanup", "color", "halftones", "vector", "accent", "export", "recipes", "settings"],
    preferredFormats: profile.formats,
  };
}
