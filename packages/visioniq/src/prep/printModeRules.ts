// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

export type PrintMode =
  | "standard"
  | "w1_white_ink"
  | "w1_white_under"
  | "w1_white_over"
  | "cmyk_only"
  | "spot_color"
  | "highlight_white";

export type ChannelId = "W1" | "W2" | "W3";

export type ChannelStatus = "enabled" | "disabled" | "not_allowed";

export interface PrintModeRule {
  mode: PrintMode;
  label: string;
  description: string;
  requiresWhiteChannel: boolean;
  requiresSpotChannel: boolean;
  allowsTransparency: boolean;
  maxColors: number | null;
  recommendedDpi: number;
  notes: string[];
}

export const PRINT_MODE_RULES: Record<PrintMode, PrintModeRule> = {
  standard: {
    mode: "standard",
    label: "Standard CMYK",
    description: "Full color CMYK print with no special channels",
    requiresWhiteChannel: false,
    requiresSpotChannel: false,
    allowsTransparency: false,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["Best for photographic or full-color artwork"],
  },
  w1_white_ink: {
    mode: "w1_white_ink",
    label: "W1 White Ink",
    description: "White ink layer generated from luminosity",
    requiresWhiteChannel: true,
    requiresSpotChannel: false,
    allowsTransparency: true,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["White channel drives ink opacity on dark substrates"],
  },
  w1_white_under: {
    mode: "w1_white_under",
    label: "W1 White Under",
    description: "White underbase printed first, then CMYK over",
    requiresWhiteChannel: true,
    requiresSpotChannel: false,
    allowsTransparency: true,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["Common for DTF on dark garments"],
  },
  w1_white_over: {
    mode: "w1_white_over",
    label: "W1 White Over",
    description: "White overprint on top of CMYK for highlight pop",
    requiresWhiteChannel: true,
    requiresSpotChannel: false,
    allowsTransparency: false,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["Used for highlight white effects on clear substrates"],
  },
  cmyk_only: {
    mode: "cmyk_only",
    label: "CMYK Only",
    description: "Pure CMYK, no white or spot channels",
    requiresWhiteChannel: false,
    requiresSpotChannel: false,
    allowsTransparency: false,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["For light substrates where white is not needed"],
  },
  spot_color: {
    mode: "spot_color",
    label: "Spot Color",
    description: "Named spot channels for specialty inks",
    requiresWhiteChannel: false,
    requiresSpotChannel: true,
    allowsTransparency: false,
    maxColors: 8,
    recommendedDpi: 300,
    notes: ["Each spot channel maps to a physical ink", "Use for metallic, neon, or brand-matched colors"],
  },
  highlight_white: {
    mode: "highlight_white",
    label: "Highlight White",
    description: "Selective white only on highlight areas",
    requiresWhiteChannel: true,
    requiresSpotChannel: false,
    allowsTransparency: true,
    maxColors: null,
    recommendedDpi: 300,
    notes: ["Minimum ink use", "Best for subtle white-on-white effects"],
  },
};

export const PRINT_MODE_OPTIONS: Array<{ value: PrintMode; label: string; description: string }> =
  Object.values(PRINT_MODE_RULES).map(r => ({
    value: r.mode,
    label: r.label,
    description: r.description,
  }));

export interface PrintModeChannelRule {
  allowed: ChannelId[];
  tooltip: Partial<Record<ChannelId, string>>;
}

export const PRINT_MODE_CHANNEL_RULES: Record<PrintMode, PrintModeChannelRule> = {
  standard: { allowed: [], tooltip: {} },
  cmyk_only: { allowed: [], tooltip: {} },
  spot_color: { allowed: [], tooltip: {} },
  w1_white_ink: {
    allowed: ["W1"],
    tooltip: { W1: "White ink generated from artwork luminosity — drives ink coverage on dark substrates" },
  },
  w1_white_under: {
    allowed: ["W1", "W2"],
    tooltip: {
      W1: "Primary white underbase — printed first under CMYK",
      W2: "Secondary white for extra coverage on dense areas",
    },
  },
  w1_white_over: {
    allowed: ["W1", "W2", "W3"],
    tooltip: {
      W1: "Base white channel",
      W2: "Mid white for blending",
      W3: "Top white overprint for highlight pop",
    },
  },
  highlight_white: {
    allowed: ["W1"],
    tooltip: { W1: "Selective white applied only to highlight zones" },
  },
};

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  W1: "W1 White Under",
  W2: "W2 White Over",
  W3: "W3 White Highlight",
};

export const CHANNEL_DESCRIPTIONS: Record<ChannelId, string> = {
  W1: "Primary white channel — underbase or ink layer driven by artwork or luminosity",
  W2: "Secondary white — for additional coverage or accent layer assignments",
  W3: "Tertiary white — used in W1-over modes for triple-white effects",
};

export interface W1Config {
  enabled: boolean;
  source: "artwork" | "selection" | "flood";
  softFades: boolean;
  hardEdge: boolean;
  choke: number;
  expand: number;
  density: number;
}

export interface W2Config {
  enabled: boolean;
  assignedAccentLayer?: string;
  choke: number;
  expand: number;
}

export interface W3Config {
  enabled: boolean;
  assignedAccentLayer?: string;
  choke: number;
  expand: number;
}

export interface SpotChannelConfig {
  printMode: PrintMode | null;
  W1: W1Config;
  W2: W2Config;
  W3: W3Config;
}

export const DEFAULT_SPOT_CHANNEL_CONFIG: SpotChannelConfig = {
  printMode: null,
  W1: {
    enabled: false,
    source: "artwork",
    softFades: true,
    hardEdge: false,
    choke: 0,
    expand: 0,
    density: 100,
  },
  W2: { enabled: false, choke: 0, expand: 0 },
  W3: { enabled: false, choke: 0, expand: 0 },
};

export function getChannelStatus(channelId: ChannelId, config: SpotChannelConfig): ChannelStatus {
  if (!config.printMode) return "not_allowed";
  const rules = PRINT_MODE_CHANNEL_RULES[config.printMode];
  if (!rules.allowed.includes(channelId)) return "not_allowed";
  return config[channelId].enabled ? "enabled" : "disabled";
}

export function applyPrintModeRules(mode: PrintMode, current: SpotChannelConfig): SpotChannelConfig {
  const rules = PRINT_MODE_CHANNEL_RULES[mode];
  return {
    ...current,
    printMode: mode,
    W1: { ...current.W1, enabled: rules.allowed.includes("W1") && current.W1.enabled },
    W2: { ...current.W2, enabled: rules.allowed.includes("W2") && current.W2.enabled },
    W3: { ...current.W3, enabled: rules.allowed.includes("W3") && current.W3.enabled },
  };
}

export function validateSpotChannelConfiguration(config: SpotChannelConfig): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!config.printMode) {
    issues.push("No print mode selected — spot channel configuration is inactive.");
    return { valid: false, issues };
  }
  const rules = PRINT_MODE_CHANNEL_RULES[config.printMode];
  const rule = PRINT_MODE_RULES[config.printMode];

  if (rule.requiresWhiteChannel && !config.W1.enabled) {
    issues.push(`Print mode "${rule.label}" requires W1 white channel to be enabled.`);
  }
  if (config.W2.enabled && !rules.allowed.includes("W2")) {
    issues.push("W2 is enabled but not supported in the current print mode.");
  }
  if (config.W3.enabled && !rules.allowed.includes("W3")) {
    issues.push("W3 is enabled but not supported in the current print mode.");
  }
  if (config.W2.enabled && !config.W1.enabled && rules.allowed.includes("W1")) {
    issues.push("W2 is enabled but W1 is disabled — W1 should be enabled first.");
  }
  if (config.W3.enabled && !config.W2.enabled) {
    issues.push("W3 is enabled but W2 is disabled — enable W2 before W3.");
  }

  return { valid: issues.length === 0, issues };
}

export function validateModeCompatibility(
  mode: PrintMode,
  colorCount: number,
  hasTransparency: boolean
): string[] {
  const rule = PRINT_MODE_RULES[mode];
  const issues: string[] = [];
  if (rule.maxColors !== null && colorCount > rule.maxColors) {
    issues.push(`${mode} supports max ${rule.maxColors} colors (found ${colorCount})`);
  }
  if (!rule.allowsTransparency && hasTransparency) {
    issues.push(`${mode} does not support transparency — flatten before export`);
  }
  return issues;
}
