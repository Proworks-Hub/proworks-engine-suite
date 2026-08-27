// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import { inferSpotProcessModeFromPreset, type SpotProcessMode } from "./spotChannelPrep.js";

export type AccentLayerType = "text" | "uploaded_image" | "duplicate_artwork" | "derived_mask" | "selection" | "shape" | "texture";
export type AccentLayerSource = "text" | "image" | "artwork" | "mask" | "selection" | "shape" | "channel";
export type AccentLayerTargetChannel = "W1" | "W2" | "W3";
export type AccentBlendMode = "normal" | "multiply" | "screen" | "overlay";
export type AccentRenderMode = "fill" | "contour" | "edge";
export type AccentPreviewMode = "base" | "w1" | "w2" | "w3" | "combined";

export interface AccentLayerTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  align: "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

export interface AccentLayerValidation {
  valid: boolean;
  warnings: string[];
}

export interface AccentLayerItem {
  id: string;
  name: string;
  type: AccentLayerType;
  enabled: boolean;
  source: AccentLayerSource;
  targetChannel: AccentLayerTargetChannel;
  opacity: number;
  choke: number;
  expand: number;
  feather: number;
  blendMode: AccentBlendMode;
  order: number;
  invert: boolean;
  threshold: number;
  minArea: number;
  preserveHoles: boolean;
  contourOnly: boolean;
  fillOnly: boolean;
  edgeOnly: boolean;
  softEdgeThreshold: number;
  glossIntensity: number;
  foilSolidOnly: boolean;
  textureIntensity: number;
  knockoutFromWhite: boolean;
  overprintOnWhite: boolean;
  snapToArtBounds: boolean;
  safeMargin: number;
  isolate: boolean;
  renderMode: AccentRenderMode;
  channelPreviewTint: string;
  sourceData?: string;
  textContent?: string;
  transform: AccentLayerTransform;
  validation: AccentLayerValidation;
}

export interface AccentW1Settings {
  enabled: boolean;
  source: "alpha" | "artwork" | "mask" | "flood";
  opacity: number;
  choke: number;
  expand: number;
  feather: number;
  preserveSoftFades: boolean;
}

export interface AccentCapabilities {
  supportsW1: boolean;
  supportsW2: boolean;
  supportsW3: boolean;
  supportsAdvancedAccentLayers: boolean;
  supportsFoil: boolean;
}

export interface AccentLayerState {
  processMode: SpotProcessMode;
  capabilities: AccentCapabilities;
  previewMode: AccentPreviewMode;
  selectedLayerId: string | null;
  layers: AccentLayerItem[];
  w1Settings: AccentW1Settings;
  readiness: "ready" | "warning" | "error";
  warnings: string[];
  validationErrors: string[];
}

const CHANNEL_TINTS: Record<AccentLayerTargetChannel, string> = {
  W1: "#67A7FF",
  W2: "#B28AFF",
  W3: "#FFC04D",
};

function defaultW1ForProcess(mode: SpotProcessMode): AccentW1Settings {
  if (mode === "DTF") return { enabled: true, source: "alpha", opacity: 95, choke: 1, expand: 1, feather: 1, preserveSoftFades: true };
  if (mode === "UV") return { enabled: true, source: "artwork", opacity: 86, choke: 1, expand: 2, feather: 0, preserveSoftFades: false };
  return { enabled: true, source: "mask", opacity: 88, choke: 1, expand: 2, feather: 0, preserveSoftFades: false };
}

function capabilitiesForProcess(mode: SpotProcessMode): AccentCapabilities {
  if (mode === "DTF") {
    return {
      supportsW1: true,
      supportsW2: false,
      supportsW3: false,
      supportsAdvancedAccentLayers: true,
      supportsFoil: false,
    };
  }
  if (mode === "UV") {
    return {
      supportsW1: true,
      supportsW2: true,
      supportsW3: true,
      supportsAdvancedAccentLayers: true,
      supportsFoil: true,
    };
  }
  return {
    supportsW1: true,
    supportsW2: true,
    supportsW3: true,
    supportsAdvancedAccentLayers: true,
    supportsFoil: true,
  };
}

export function supportedChannels(capabilities: AccentCapabilities): AccentLayerTargetChannel[] {
  const channels: AccentLayerTargetChannel[] = [];
  if (capabilities.supportsW1) channels.push("W1");
  if (capabilities.supportsW2) channels.push("W2");
  if (capabilities.supportsW3) channels.push("W3");
  return channels;
}

export function processSupportsAccent(machinePreset: string | undefined | null): boolean {
  const normalized = String(machinePreset ?? "").toUpperCase();
  if (normalized === "LASER_ENGRAVING") return false;
  return true;
}

export function createDefaultLayer(
  type: AccentLayerType,
  processMode: SpotProcessMode,
  order: number,
  overrides?: Partial<AccentLayerItem>,
): AccentLayerItem {
  const defaultChannel: AccentLayerTargetChannel = processMode === "DTF" ? "W1" : "W2";
  const name = type === "text" ? "Text Accent"
    : type === "uploaded_image" ? "Image Accent"
      : type === "duplicate_artwork" ? "Artwork Duplicate Accent"
        : type === "derived_mask" ? "Derived Mask Accent"
          : type === "selection" ? "Selection Accent"
            : type === "shape" ? "Shape Accent"
              : "Texture Accent";

  const id = `accent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const base: AccentLayerItem = {
    id,
    name,
    type,
    enabled: true,
    source: type === "text" ? "text"
      : type === "uploaded_image" ? "image"
        : type === "duplicate_artwork" ? "artwork"
          : type === "derived_mask" ? "mask"
            : type === "selection" ? "selection"
              : type === "shape" ? "shape"
                : "channel",
    targetChannel: defaultChannel,
    opacity: processMode === "DTF" ? 85 : 78,
    choke: 0,
    expand: 0,
    feather: processMode === "DTF" ? 1 : 0,
    blendMode: "normal",
    order,
    invert: false,
    threshold: 128,
    minArea: 2,
    preserveHoles: true,
    contourOnly: false,
    fillOnly: true,
    edgeOnly: false,
    softEdgeThreshold: processMode === "DTF" ? 55 : 35,
    glossIntensity: processMode === "DTF" ? 0 : 72,
    foilSolidOnly: processMode !== "DTF",
    textureIntensity: 35,
    knockoutFromWhite: false,
    overprintOnWhite: true,
    snapToArtBounds: true,
    safeMargin: 0,
    isolate: false,
    renderMode: "fill",
    channelPreviewTint: CHANNEL_TINTS[defaultChannel],
    transform: {
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      align: "center",
    },
    validation: {
      valid: true,
      warnings: [],
    },
  };

  return validateAccentLayer({
    ...base,
    ...overrides,
    id,
    order,
  });
}

export function defaultAccentStateForPreset(machinePreset: string | undefined | null): AccentLayerState {
  const processMode = inferSpotProcessModeFromPreset(machinePreset);
  const capabilities = capabilitiesForProcess(processMode);

  return validateAccentState({
    processMode,
    capabilities,
    previewMode: "combined",
    selectedLayerId: null,
    layers: [],
    w1Settings: defaultW1ForProcess(processMode),
    readiness: "ready",
    warnings: [],
    validationErrors: [],
  });
}

export function mergeAccentState(
  machinePreset: string | undefined | null,
  raw: Partial<AccentLayerState> | undefined,
): AccentLayerState {
  const base = defaultAccentStateForPreset(machinePreset);
  const layers = Array.isArray(raw?.layers)
    ? raw.layers.map((layer, index) => validateAccentLayer({
      ...createDefaultLayer(layer.type ?? "derived_mask", base.processMode, index),
      ...layer,
      id: typeof layer.id === "string" && layer.id.length > 0 ? layer.id : `accent-${Date.now()}-${index}`,
      order: index,
      targetChannel: normalizeChannel(layer.targetChannel, base.capabilities),
      opacity: clamp(layer.opacity ?? 80, 0, 100),
      choke: clamp(layer.choke ?? 0, -12, 24),
      expand: clamp(layer.expand ?? 0, -12, 24),
      feather: clamp(layer.feather ?? 0, 0, 32),
      threshold: clamp(layer.threshold ?? 128, 0, 255),
      minArea: clamp(layer.minArea ?? 2, 0, 120),
      softEdgeThreshold: clamp(layer.softEdgeThreshold ?? 50, 0, 100),
      glossIntensity: clamp(layer.glossIntensity ?? 70, 0, 100),
      textureIntensity: clamp(layer.textureIntensity ?? 35, 0, 100),
      safeMargin: clamp(layer.safeMargin ?? 0, 0, 50),
      transform: {
        x: clamp(layer.transform?.x ?? 0, -9999, 9999),
        y: clamp(layer.transform?.y ?? 0, -9999, 9999),
        scale: clampFloat(layer.transform?.scale ?? 1, 0.1, 8),
        rotation: clamp(layer.transform?.rotation ?? 0, -360, 360),
        align: normalizeAlign(layer.transform?.align),
      },
    }))
    : [];

  const merged: AccentLayerState = {
    ...base,
    ...raw,
    processMode: inferSpotProcessModeFromPreset(machinePreset),
    capabilities: capabilitiesForProcess(inferSpotProcessModeFromPreset(machinePreset)),
    previewMode: normalizePreview(raw?.previewMode),
    selectedLayerId: typeof raw?.selectedLayerId === "string" ? raw.selectedLayerId : null,
    layers,
    w1Settings: {
      ...base.w1Settings,
      ...(raw?.w1Settings ?? {}),
      enabled: Boolean(raw?.w1Settings?.enabled ?? base.w1Settings.enabled),
      source: normalizeW1Source(raw?.w1Settings?.source),
      opacity: clamp(raw?.w1Settings?.opacity ?? base.w1Settings.opacity, 0, 100),
      choke: clamp(raw?.w1Settings?.choke ?? base.w1Settings.choke, -12, 24),
      expand: clamp(raw?.w1Settings?.expand ?? base.w1Settings.expand, -12, 24),
      feather: clamp(raw?.w1Settings?.feather ?? base.w1Settings.feather, 0, 32),
      preserveSoftFades: Boolean(raw?.w1Settings?.preserveSoftFades ?? base.w1Settings.preserveSoftFades),
    },
  };

  return validateAccentState(merged);
}

export function validateAccentLayer(layer: AccentLayerItem): AccentLayerItem {
  const warnings: string[] = [];
  if (layer.enabled && layer.opacity < 4) warnings.push("Layer is enabled but opacity is near zero.");
  if (layer.enabled && !layer.sourceData && layer.type !== "duplicate_artwork" && layer.type !== "shape") warnings.push("Layer has no source data.");
  if (layer.foilSolidOnly && layer.softEdgeThreshold > 30) warnings.push("Foil-safe mode prefers harder edges.");
  if (layer.edgeOnly && layer.renderMode === "fill") warnings.push("Edge-only enabled while render mode is fill.");
  if (layer.contourOnly && layer.fillOnly) warnings.push("Contour-only and fill-only are both enabled.");

  return {
    ...layer,
    validation: {
      valid: warnings.length === 0,
      warnings,
    },
  };
}

export function validateAccentState(state: AccentLayerState): AccentLayerState {
  const warnings: string[] = [];
  const errors: string[] = [];

  const supported = supportedChannels(state.capabilities);

  if (!processSupportsAccent(state.processMode)) {
    warnings.push("Current process has limited accent-layer support.");
  }

  if (state.layers.length === 0) warnings.push("No accent layers created yet.");

  const layers = state.layers.map((layer, idx) => {
    const next = validateAccentLayer({ ...layer, order: idx });

    if (next.enabled && !supported.includes(next.targetChannel)) {
      errors.push(`${next.name} targets ${next.targetChannel}, which is unavailable for this process.`);
    }

    if (next.enabled && next.minArea > 24) {
      warnings.push(`${next.name} may remove too much detail due to high minimum area.`);
    }

    if (next.enabled && next.foilSolidOnly && next.targetChannel === "W3" && next.feather > 3) {
      warnings.push(`${next.name} feather is high for foil-safe output.`);
    }

    if (next.enabled && next.edgeOnly && next.softEdgeThreshold > 60) {
      warnings.push(`${next.name} has fragile edge-only settings.`);
    }

    return next;
  });

  if (state.processMode === "DTF") {
    if (layers.some((layer) => layer.enabled && layer.targetChannel !== "W1")) {
      warnings.push("DTF usually limits accent output to W1-related shaping.");
    }
  }

  if (state.processMode === "UV" || state.processMode === "UVDTF") {
    const glossLayers = layers.filter((layer) => layer.enabled && layer.targetChannel === "W2");
    if (glossLayers.length === 0) {
      warnings.push("No W2 accent layer found for gloss/varnish style output.");
    }
  }

  const readiness: AccentLayerState["readiness"] = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ready";
  const selectedLayerId = state.selectedLayerId && layers.some((layer) => layer.id === state.selectedLayerId)
    ? state.selectedLayerId
    : layers[0]?.id ?? null;

  return {
    ...state,
    selectedLayerId,
    layers,
    warnings,
    validationErrors: errors,
    readiness,
  };
}

export function addLayerToState(state: AccentLayerState, type: AccentLayerType, overrides?: Partial<AccentLayerItem>): AccentLayerState {
  const layer = createDefaultLayer(type, state.processMode, state.layers.length, overrides);
  return validateAccentState({
    ...state,
    selectedLayerId: layer.id,
    layers: [...state.layers, layer],
  });
}

export function removeLayerFromState(state: AccentLayerState, layerId: string): AccentLayerState {
  return validateAccentState({
    ...state,
    layers: state.layers.filter((layer) => layer.id !== layerId),
    selectedLayerId: state.selectedLayerId === layerId ? null : state.selectedLayerId,
  });
}

export function reorderLayer(state: AccentLayerState, layerId: string, direction: "up" | "down"): AccentLayerState {
  const currentIndex = state.layers.findIndex((layer) => layer.id === layerId);
  if (currentIndex < 0) return state;

  const target = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (target < 0 || target >= state.layers.length) return state;

  const next = [...state.layers];
  const [item] = next.splice(currentIndex, 1);
  next.splice(target, 0, item);

  return validateAccentState({
    ...state,
    layers: next,
  });
}

export function patchLayer(state: AccentLayerState, layerId: string, updates: Partial<AccentLayerItem>): AccentLayerState {
  return validateAccentState({
    ...state,
    layers: state.layers.map((layer) => {
      if (layer.id !== layerId) return layer;
      return validateAccentLayer({
        ...layer,
        ...updates,
        targetChannel: normalizeChannel(updates.targetChannel ?? layer.targetChannel, state.capabilities),
      });
    }),
  });
}

function normalizeChannel(
  channel: AccentLayerTargetChannel | undefined,
  capabilities: AccentCapabilities,
): AccentLayerTargetChannel {
  const supported = supportedChannels(capabilities);
  if (!channel || !supported.includes(channel)) return supported[0] ?? "W1";
  return channel;
}

function normalizeW1Source(source: AccentW1Settings["source"] | undefined): AccentW1Settings["source"] {
  if (source === "artwork" || source === "mask" || source === "flood") return source;
  return "alpha";
}

function normalizeAlign(value: AccentLayerTransform["align"] | undefined): AccentLayerTransform["align"] {
  if (value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right") return value;
  return "center";
}

function normalizePreview(value: AccentPreviewMode | undefined): AccentPreviewMode {
  if (value === "base" || value === "w1" || value === "w2" || value === "w3") return value;
  return "combined";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
