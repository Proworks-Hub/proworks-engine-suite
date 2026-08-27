// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

export type SpotProcessMode = "DTF" | "UV" | "UVDTF";
export type SpotChannelId = "W1" | "W2" | "W3";
export type SpotChannelType = "white" | "varnish" | "foil";
export type SpotSourceMode = "artwork" | "selection" | "flood" | "mask_alpha" | "luminance";

export interface SpotChannelState {
  id: SpotChannelId;
  type: SpotChannelType;
  label: string;
  enabled: boolean;
  source: SpotSourceMode;
  preserveSoftFades: boolean;
  hardEdgeOnly: boolean;
  antiAlias: boolean;
  preserveInnerHoles: boolean;
  protectSmallDetails: boolean;
  choke: number;
  expand: number;
  opacity: number;
  density: number;
  invert: boolean;
  minArea: number;
  trapAmount: number;
  softEdgeThreshold: number;
  ignoreTinyIslands: boolean;
  knockout: boolean;
  overprint: boolean;
  previewTint: string;
  warnings: string[];
}

export interface SpotChannelsState {
  processMode: SpotProcessMode;
  channels: SpotChannelState[];
  channelPreviewMode: "composite" | SpotChannelId;
  validation: {
    valid: boolean;
    warnings: string[];
    errors: string[];
  };
  readiness: "ready" | "warning" | "error";
  estimatedCoverage: number;
}

function baseChannel(
  id: SpotChannelId,
  type: SpotChannelType,
  label: string,
  enabled: boolean,
  previewTint: string,
): SpotChannelState {
  return {
    id,
    type,
    label,
    enabled,
    source: "artwork",
    preserveSoftFades: true,
    hardEdgeOnly: false,
    antiAlias: true,
    preserveInnerHoles: true,
    protectSmallDetails: true,
    choke: 0,
    expand: 0,
    opacity: 100,
    density: 100,
    invert: false,
    minArea: 0,
    trapAmount: 0,
    softEdgeThreshold: 22,
    ignoreTinyIslands: true,
    knockout: false,
    overprint: true,
    previewTint,
    warnings: [],
  };
}

export function defaultSpotChannelsForProcess(mode: SpotProcessMode): SpotChannelsState {
  if (mode === "DTF") {
    return {
      processMode: mode,
      channels: [
        { ...baseChannel("W1", "white", "W1 White Underbase", true, "#60A5FA"), source: "mask_alpha", opacity: 95, density: 95, choke: 1, expand: 1 },
        { ...baseChannel("W2", "varnish", "W2 Varnish", false, "#A78BFA"), overprint: false },
        { ...baseChannel("W3", "foil", "W3 Foil", false, "#F59E0B"), overprint: false },
      ],
      channelPreviewMode: "composite",
      validation: { valid: true, warnings: [], errors: [] },
      readiness: "ready",
      estimatedCoverage: 0,
    };
  }

  if (mode === "UV") {
    return {
      processMode: mode,
      channels: [
        { ...baseChannel("W1", "white", "W1 White Base", true, "#60A5FA"), preserveSoftFades: false, hardEdgeOnly: true, antiAlias: false, source: "selection", choke: 1, expand: 2, opacity: 86, density: 88 },
        { ...baseChannel("W2", "varnish", "W2 Spot Varnish", true, "#A78BFA"), source: "selection", preserveSoftFades: false, hardEdgeOnly: true, opacity: 80, density: 84, minArea: 2 },
        { ...baseChannel("W3", "foil", "W3 Foil Accent", false, "#F59E0B"), source: "selection", preserveSoftFades: false, hardEdgeOnly: true, opacity: 78, density: 80, minArea: 4 },
      ],
      channelPreviewMode: "composite",
      validation: { valid: true, warnings: [], errors: [] },
      readiness: "ready",
      estimatedCoverage: 0,
    };
  }

  return {
    processMode: mode,
    channels: [
      { ...baseChannel("W1", "white", "W1 White Base", true, "#60A5FA"), source: "mask_alpha", preserveSoftFades: false, hardEdgeOnly: true, antiAlias: true, choke: 1, expand: 2, opacity: 90, density: 92 },
      { ...baseChannel("W2", "varnish", "W2 Clear Coat", true, "#A78BFA"), source: "selection", preserveSoftFades: false, hardEdgeOnly: true, opacity: 86, density: 88 },
      { ...baseChannel("W3", "foil", "W3 Hot Foil", true, "#F59E0B"), source: "selection", preserveSoftFades: false, hardEdgeOnly: true, opacity: 74, density: 78, minArea: 3 },
    ],
    channelPreviewMode: "composite",
    validation: { valid: true, warnings: [], errors: [] },
    readiness: "ready",
    estimatedCoverage: 0,
  };
}

export function inferSpotProcessModeFromPreset(preset: string | undefined | null): SpotProcessMode {
  const key = String(preset ?? "DTF").toUpperCase();
  if (key === "UVDTF") return "UVDTF";
  if (key === "UV") return "UV";
  return "DTF";
}

export function mergeSpotState(
  processMode: SpotProcessMode,
  raw: Partial<SpotChannelsState> | undefined,
): SpotChannelsState {
  const base = defaultSpotChannelsForProcess(processMode);
  const rawChannels = Array.isArray(raw?.channels) ? raw?.channels : [];
  const channels = base.channels.map((template) => {
    const found = rawChannels.find((entry) => entry?.id === template.id);
    if (!found) return template;
    return {
      ...template,
      ...found,
      id: template.id,
      type: template.type,
      label: found.label || template.label,
      opacity: clamp(found.opacity ?? template.opacity, 0, 100),
      density: clamp(found.density ?? template.density, 0, 100),
      choke: clamp(found.choke ?? template.choke, -8, 16),
      expand: clamp(found.expand ?? template.expand, -8, 16),
      minArea: clamp(found.minArea ?? template.minArea, 0, 50),
      trapAmount: clamp(found.trapAmount ?? template.trapAmount, 0, 20),
      softEdgeThreshold: clamp(found.softEdgeThreshold ?? template.softEdgeThreshold, 0, 100),
      warnings: Array.isArray(found.warnings) ? found.warnings.filter((w) => typeof w === "string") : [],
    } as SpotChannelState;
  });

  return validateSpotState({
    ...base,
    ...raw,
    processMode,
    channels,
    channelPreviewMode:
      raw?.channelPreviewMode === "W1" || raw?.channelPreviewMode === "W2" || raw?.channelPreviewMode === "W3"
        ? raw.channelPreviewMode
        : "composite",
  });
}

export function validateSpotState(state: SpotChannelsState): SpotChannelsState {
  const errors: string[] = [];
  const warnings: string[] = [];

  const w1 = state.channels.find((item) => item.id === "W1");
  const w2 = state.channels.find((item) => item.id === "W2");
  const w3 = state.channels.find((item) => item.id === "W3");

  if (state.processMode === "DTF") {
    if (!w1?.enabled) errors.push("DTF requires W1 white underbase enabled.");
    if (w2?.enabled || w3?.enabled) warnings.push("DTF typically does not use varnish/foil channels.");
  }

  if ((state.processMode === "UV" || state.processMode === "UVDTF") && !w1?.enabled) {
    errors.push("UV workflows require W1 white base.");
  }

  for (const channel of state.channels) {
    if (!channel.enabled) continue;
    if (channel.source === "selection" && channel.minArea > 20) warnings.push(`${channel.id} selection source min area is very high.`);
    if (channel.hardEdgeOnly && channel.preserveSoftFades) warnings.push(`${channel.id} has both hard-edge and soft-fade enabled; hard-edge will dominate.`);
    if (!channel.source) errors.push(`${channel.id} has no source mode.`);
  }

  const estimatedCoverage = estimateSpotCoverage(state.channels);
  if (state.processMode === "DTF" && estimatedCoverage > 260) warnings.push("Estimated spot coverage may be heavy for DTF.");
  if ((state.processMode === "UV" || state.processMode === "UVDTF") && estimatedCoverage > 300) warnings.push("Estimated spot coverage exceeds common UV comfort ranges.");

  const readiness: SpotChannelsState["readiness"] = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ready";

  return {
    ...state,
    estimatedCoverage,
    validation: {
      valid: errors.length === 0,
      warnings,
      errors,
    },
    readiness,
  };
}

export function estimateSpotCoverage(channels: SpotChannelState[]): number {
  const total = channels
    .filter((channel) => channel.enabled)
    .reduce((acc, channel) => {
      const weight = channel.type === "white" ? 1 : channel.type === "varnish" ? 0.7 : 0.6;
      return acc + channel.opacity * 0.6 * weight + channel.density * 0.4 * weight;
    }, 0);
  return clamp(Math.round(total), 0, 400);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
