// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change.

import type { PrintMode } from "./printModeRules";

export type { PrintMode };

export type SpotChannelAssignment =
  | "W1"
  | "W2"
  | "W3"
  | "gloss"
  | "matte"
  | "metallic_gold"
  | "metallic_silver"
  | "metallic_copper"
  | "rose_gold"
  | "neon_yellow"
  | "neon_pink"
  | "neon_green"
  | "neon_orange"
  | "spot_black"
  | "clear_coat";

export type AccentLayerKind = "text" | "image" | "artwork";

export interface AccentLayer {
  id: string;
  kind: AccentLayerKind;
  assignment: SpotChannelAssignment;
  opacity: number;
  choke: number;
  expand: number;
  feather: number;
  edgeHardness: number;
  enabled: boolean;
  label: string;
  sourceData?: string;
}

export interface W1Settings {
  enabled: boolean;
  mode: "under" | "over" | "ink" | "highlight";
  density: number;
  spread: number;
  choke: number;
  preserveSoftFades: boolean;
  minimumOpacity: number;
  maximumOpacity: number;
  generateFromLuminosity: boolean;
  invertMask: boolean;
  trapSize: number;
}

export const DEFAULT_W1_SETTINGS: W1Settings = {
  enabled: true,
  mode: "under",
  density: 100,
  spread: 0,
  choke: 0,
  preserveSoftFades: true,
  minimumOpacity: 20,
  maximumOpacity: 100,
  generateFromLuminosity: true,
  invertMask: false,
  trapSize: 1,
};

export function getDefaultW1Settings(): W1Settings {
  return { ...DEFAULT_W1_SETTINGS };
}

export function generateLayerId(): string {
  return `layer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ChannelLabelConfig {
  bgClass: string;
  borderClass: string;
  textClass: string;
  label: string;
}

export const CHANNEL_LABELS: Record<SpotChannelAssignment, ChannelLabelConfig> = {
  W1: { bgClass: "bg-blue-500/10", borderClass: "border-blue-500/30", textClass: "text-blue-400", label: "W1 White" },
  W2: { bgClass: "bg-sky-500/10", borderClass: "border-sky-500/30", textClass: "text-sky-400", label: "W2 White" },
  W3: { bgClass: "bg-cyan-500/10", borderClass: "border-cyan-500/30", textClass: "text-cyan-400", label: "W3 White" },
  gloss: { bgClass: "bg-purple-500/10", borderClass: "border-purple-500/30", textClass: "text-purple-400", label: "Gloss" },
  matte: { bgClass: "bg-gray-500/10", borderClass: "border-gray-500/30", textClass: "text-gray-400", label: "Matte" },
  metallic_gold: { bgClass: "bg-yellow-500/10", borderClass: "border-yellow-500/30", textClass: "text-yellow-400", label: "Metallic Gold" },
  metallic_silver: { bgClass: "bg-slate-400/10", borderClass: "border-slate-400/30", textClass: "text-slate-300", label: "Metallic Silver" },
  metallic_copper: { bgClass: "bg-orange-700/10", borderClass: "border-orange-700/30", textClass: "text-orange-500", label: "Metallic Copper" },
  rose_gold: { bgClass: "bg-pink-400/10", borderClass: "border-pink-400/30", textClass: "text-pink-400", label: "Rose Gold" },
  neon_yellow: { bgClass: "bg-lime-400/10", borderClass: "border-lime-400/30", textClass: "text-lime-400", label: "Neon Yellow" },
  neon_pink: { bgClass: "bg-fuchsia-500/10", borderClass: "border-fuchsia-500/30", textClass: "text-fuchsia-400", label: "Neon Pink" },
  neon_green: { bgClass: "bg-green-400/10", borderClass: "border-green-400/30", textClass: "text-green-400", label: "Neon Green" },
  neon_orange: { bgClass: "bg-orange-500/10", borderClass: "border-orange-500/30", textClass: "text-orange-400", label: "Neon Orange" },
  spot_black: { bgClass: "bg-zinc-800/20", borderClass: "border-zinc-600/30", textClass: "text-zinc-400", label: "Spot Black" },
  clear_coat: { bgClass: "bg-teal-500/10", borderClass: "border-teal-500/30", textClass: "text-teal-400", label: "Clear Coat" },
};

export interface PrintModeRuleConfig {
  allowsAccentLayers: boolean;
  requiresW1: boolean;
  allowW2: boolean;
  allowW3: boolean;
}

export const PRINT_MODE_RULES: Record<PrintMode, PrintModeRuleConfig> = {
  standard:        { allowsAccentLayers: false, requiresW1: false, allowW2: false, allowW3: false },
  w1_white_ink:    { allowsAccentLayers: true,  requiresW1: true,  allowW2: false, allowW3: false },
  w1_white_under:  { allowsAccentLayers: true,  requiresW1: true,  allowW2: true,  allowW3: false },
  w1_white_over:   { allowsAccentLayers: true,  requiresW1: true,  allowW2: true,  allowW3: true  },
  cmyk_only:       { allowsAccentLayers: false, requiresW1: false, allowW2: false, allowW3: false },
  spot_color:      { allowsAccentLayers: true,  requiresW1: false, allowW2: false, allowW3: false },
  highlight_white: { allowsAccentLayers: true,  requiresW1: true,  allowW2: false, allowW3: false },
};

export const SPOT_CHANNEL_PRESETS = ["UVDTF", "UV"] as const;

export function isSpotChannelPreset(preset: string): boolean {
  return SPOT_CHANNEL_PRESETS.includes(preset as (typeof SPOT_CHANNEL_PRESETS)[number]);
}

export function getMachinePresetPrintMode(presetKey: string): PrintMode {
  switch (presetKey) {
    case "DTF":              return "w1_white_under";
    case "UVDTF":            return "w1_white_ink";
    case "UV":               return "spot_color";
    case "FINE_ART":         return "cmyk_only";
    case "POSTER":           return "standard";
    case "LASER_ENGRAVING":  return "cmyk_only";
    default:                 return "standard";
  }
}
