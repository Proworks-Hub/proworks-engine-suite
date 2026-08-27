// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio (InvoFlowHub/src/modules/ksix-prep-studio/core)
// without behavioural change. Only import paths were rewritten: the suite is ESM
// and resolves relative specifiers with explicit .js extensions, where the host
// used a bundler alias. The logic below is the host's, unmodified.

export type PrepProfileDomain = "laser" | "dtf" | "uv_uvdtf" | "sublimation" | "large_format";

export interface MachineProfile {
  id: string;
  domain: PrepProfileDomain;
  label: string;
  machinePreset: string;
  targetDpi: number;
  colorProfile: string;
  whiteInkSupport: boolean;
}

export interface MaterialProfile {
  id: string;
  domain: PrepProfileDomain;
  label: string;
  materialKey: string;
}

export interface OutputProfile {
  id: string;
  domain: PrepProfileDomain;
  label: string;
  colorSpace: "cmyk" | "rgb";
  format: "png" | "tiff" | "pdf" | "svg";
  exportPreset: string;
  preserveTransparency: boolean;
  flattenOutput: boolean;
  includeCutLayer: boolean;
  mirroredOutput: boolean;
}

export interface ProfileSelection {
  machineProfileId?: string;
  materialProfileId?: string;
  outputProfileId?: string;
}

export interface ResolvedProfileBundle {
  domain: PrepProfileDomain;
  machine: MachineProfile;
  material: MaterialProfile;
  output: OutputProfile;
  selection: Required<ProfileSelection>;
}

const MACHINE_PROFILES: Record<PrepProfileDomain, MachineProfile[]> = {
  laser: [
    {
      id: "machine-laser-co2",
      domain: "laser",
      label: "CO2 Laser",
      machinePreset: "laser_co2",
      targetDpi: 500,
      colorProfile: "Laser-Engrave-RGB",
      whiteInkSupport: false,
    },
  ],
  dtf: [
    {
      id: "machine-dtf-roll-22",
      domain: "dtf",
      label: "DTF Roll 22in",
      machinePreset: "dtf-roll-22",
      targetDpi: 300,
      colorProfile: "DTF-Transfer-ICC",
      whiteInkSupport: true,
    },
  ],
  uv_uvdtf: [
    {
      id: "machine-uv-flatbed",
      domain: "uv_uvdtf",
      label: "UV Flatbed",
      machinePreset: "uv-flatbed",
      targetDpi: 300,
      colorProfile: "UV-Substrate-ICC",
      whiteInkSupport: true,
    },
  ],
  sublimation: [
    {
      id: "machine-sublimation-sheet",
      domain: "sublimation",
      label: "Sublimation Sheet",
      machinePreset: "sublimation-sheet",
      targetDpi: 300,
      colorProfile: "Sublimation-Transfer-ICC",
      whiteInkSupport: false,
    },
  ],
  large_format: [
    {
      id: "machine-large-format-roll",
      domain: "large_format",
      label: "Large Format Roll",
      machinePreset: "large-format-roll",
      targetDpi: 150,
      colorProfile: "Wide-Gamut-Solvent-ICC",
      whiteInkSupport: false,
    },
  ],
};

const MATERIAL_PROFILES: Record<PrepProfileDomain, MaterialProfile[]> = {
  laser: [
    { id: "material-laser-wood", domain: "laser", label: "Wood", materialKey: "wood" },
    { id: "material-laser-acrylic", domain: "laser", label: "Acrylic", materialKey: "acrylic" },
  ],
  dtf: [
    { id: "material-dtf-pet-film", domain: "dtf", label: "PET Film", materialKey: "pet-film" },
    { id: "material-dtf-hot-peel", domain: "dtf", label: "Hot Peel", materialKey: "hot-peel" },
  ],
  uv_uvdtf: [
    { id: "material-uv-acrylic", domain: "uv_uvdtf", label: "Acrylic", materialKey: "acrylic" },
    { id: "material-uv-glass", domain: "uv_uvdtf", label: "Glass", materialKey: "glass" },
  ],
  sublimation: [
    {
      id: "material-sub-poly-fabric",
      domain: "sublimation",
      label: "Poly Fabric",
      materialKey: "poly-fabric",
    },
    {
      id: "material-sub-hardboard",
      domain: "sublimation",
      label: "Hardboard",
      materialKey: "hardboard",
    },
  ],
  large_format: [
    { id: "material-large-vinyl", domain: "large_format", label: "Vinyl", materialKey: "vinyl" },
    { id: "material-large-banner", domain: "large_format", label: "Banner", materialKey: "banner" },
  ],
};

const OUTPUT_PROFILES: Record<PrepProfileDomain, OutputProfile[]> = {
  laser: [
    {
      id: "output-laser-svg",
      domain: "laser",
      label: "Laser Vector Output",
      colorSpace: "rgb",
      format: "svg",
      exportPreset: "laser-cut-score-engrave",
      preserveTransparency: false,
      flattenOutput: true,
      includeCutLayer: true,
      mirroredOutput: false,
    },
  ],
  dtf: [
    {
      id: "output-dtf-png",
      domain: "dtf",
      label: "DTF Transfer PNG",
      colorSpace: "cmyk",
      format: "png",
      exportPreset: "dtf-uvdtf-gangsheet-roll",
      preserveTransparency: true,
      flattenOutput: false,
      includeCutLayer: false,
      mirroredOutput: false,
    },
  ],
  uv_uvdtf: [
    {
      id: "output-uv-tiff",
      domain: "uv_uvdtf",
      label: "UV TIFF",
      colorSpace: "cmyk",
      format: "tiff",
      exportPreset: "uv-flatbed-export",
      preserveTransparency: true,
      flattenOutput: false,
      includeCutLayer: false,
      mirroredOutput: false,
    },
  ],
  sublimation: [
    {
      id: "output-sub-png",
      domain: "sublimation",
      label: "Sublimation Mirrored PNG",
      colorSpace: "rgb",
      format: "png",
      exportPreset: "sublimation-mirrored",
      preserveTransparency: false,
      flattenOutput: true,
      includeCutLayer: false,
      mirroredOutput: true,
    },
  ],
  large_format: [
    {
      id: "output-large-pdf",
      domain: "large_format",
      label: "Large Format PDF",
      colorSpace: "cmyk",
      format: "pdf",
      exportPreset: "large-format-roll-export",
      preserveTransparency: false,
      flattenOutput: true,
      includeCutLayer: true,
      mirroredOutput: false,
    },
  ],
};

const WORKFLOW_DEFAULTS: Record<PrepProfileDomain, Required<ProfileSelection>> = {
  laser: {
    machineProfileId: "machine-laser-co2",
    materialProfileId: "material-laser-wood",
    outputProfileId: "output-laser-svg",
  },
  dtf: {
    machineProfileId: "machine-dtf-roll-22",
    materialProfileId: "material-dtf-pet-film",
    outputProfileId: "output-dtf-png",
  },
  uv_uvdtf: {
    machineProfileId: "machine-uv-flatbed",
    materialProfileId: "material-uv-acrylic",
    outputProfileId: "output-uv-tiff",
  },
  sublimation: {
    machineProfileId: "machine-sublimation-sheet",
    materialProfileId: "material-sub-poly-fabric",
    outputProfileId: "output-sub-png",
  },
  large_format: {
    machineProfileId: "machine-large-format-roll",
    materialProfileId: "material-large-vinyl",
    outputProfileId: "output-large-pdf",
  },
};

const LEGACY_MACHINE_PRESET_TO_PROFILE: Record<string, string> = {
  laser_co2: "machine-laser-co2",
  "dtf-roll-22": "machine-dtf-roll-22",
  "uv-flatbed": "machine-uv-flatbed",
  "sublimation-sheet": "machine-sublimation-sheet",
  "large-format-roll": "machine-large-format-roll",
};

function findById<T extends { id: string }>(items: T[], id: string | undefined): T | null {
  if (!id) return null;
  return items.find((item) => item.id === id) ?? null;
}

export function listMachineProfiles(domain: PrepProfileDomain): MachineProfile[] {
  return MACHINE_PROFILES[domain];
}

export function listMaterialProfiles(domain: PrepProfileDomain): MaterialProfile[] {
  return MATERIAL_PROFILES[domain];
}

export function listOutputProfiles(domain: PrepProfileDomain): OutputProfile[] {
  return OUTPUT_PROFILES[domain];
}

export function getWorkflowProfileDefaults(domain: PrepProfileDomain): Required<ProfileSelection> {
  return WORKFLOW_DEFAULTS[domain];
}

export function normalizeProfileSelection(
  domain: PrepProfileDomain,
  selection?: ProfileSelection,
): Required<ProfileSelection> {
  const defaults = getWorkflowProfileDefaults(domain);
  return {
    machineProfileId: selection?.machineProfileId ?? defaults.machineProfileId,
    materialProfileId: selection?.materialProfileId ?? defaults.materialProfileId,
    outputProfileId: selection?.outputProfileId ?? defaults.outputProfileId,
  };
}

export function resolveProfileBundle(
  domain: PrepProfileDomain,
  selection?: ProfileSelection,
): ResolvedProfileBundle {
  const normalized = normalizeProfileSelection(domain, selection);

  const machine =
    findById(MACHINE_PROFILES[domain], normalized.machineProfileId) ?? MACHINE_PROFILES[domain][0];
  const material =
    findById(MATERIAL_PROFILES[domain], normalized.materialProfileId) ?? MATERIAL_PROFILES[domain][0];
  const output =
    findById(OUTPUT_PROFILES[domain], normalized.outputProfileId) ?? OUTPUT_PROFILES[domain][0];

  return {
    domain,
    machine,
    material,
    output,
    selection: {
      machineProfileId: machine.id,
      materialProfileId: material.id,
      outputProfileId: output.id,
    },
  };
}

export function hydrateProfileSelection(
  domain: PrepProfileDomain,
  metadata?: Record<string, unknown>,
): ProfileSelection | undefined {
  if (!metadata) return undefined;

  const fromMetadata = metadata.profileSelection;
  if (fromMetadata && typeof fromMetadata === "object") {
    const profileSelection = fromMetadata as Record<string, unknown>;
    return {
      machineProfileId:
        typeof profileSelection.machineProfileId === "string" ? profileSelection.machineProfileId : undefined,
      materialProfileId:
        typeof profileSelection.materialProfileId === "string" ? profileSelection.materialProfileId : undefined,
      outputProfileId:
        typeof profileSelection.outputProfileId === "string" ? profileSelection.outputProfileId : undefined,
    };
  }

  const machinePreset = typeof metadata.machinePreset === "string" ? metadata.machinePreset : undefined;
  const legacyMachineProfileId = machinePreset ? LEGACY_MACHINE_PRESET_TO_PROFILE[machinePreset] : undefined;

  if (!legacyMachineProfileId) return undefined;

  return {
    machineProfileId: legacyMachineProfileId,
    materialProfileId: WORKFLOW_DEFAULTS[domain].materialProfileId,
    outputProfileId: WORKFLOW_DEFAULTS[domain].outputProfileId,
  };
}

export function buildProfileMetadata(bundle: ResolvedProfileBundle): Record<string, unknown> {
  return {
    profileSelection: bundle.selection,
    machinePreset: bundle.machine.machinePreset,
    materialProfile: bundle.material.materialKey,
    outputProfile: bundle.output.colorSpace,
    colorProfile: bundle.machine.colorProfile,
    targetDpi: bundle.machine.targetDpi,
  };
}
