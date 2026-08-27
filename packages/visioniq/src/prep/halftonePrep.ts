// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

/*
 * MakerOps proprietary implementation.
 * This module is custom-authored for MakerOps Prep Studio workflows.
 */

import type { HalftoneSettings } from "../core/prepSettings.js";

export type DotShape = "round" | "elliptical" | "diamond" | "line" | "euclidean";
export type HalftoneMode = "am" | "stochastic" | "hybrid";
export type ChannelPreviewMode = "composite" | "c" | "m" | "y" | "k" | "w";
export type GarmentHalftoneMode = "dark" | "light";
export type GarmentKnockoutTarget = "black" | "white" | "both";
export type HalftoneAnglePreset = "classic" | "photo" | "textile" | "uv" | "custom";
export type SoftProofPreset = "custom" | "dark-cotton" | "light-cotton" | "heather" | "natural-paper" | "clear-film";

export interface LocalHalftoneSettings extends HalftoneSettings {
  garmentMode?: GarmentHalftoneMode;
  garmentKnockoutEnabled?: boolean;
  garmentKnockoutTarget?: GarmentKnockoutTarget;
  garmentKnockoutThreshold?: number;
  garmentKnockoutSoftness?: number;
  garmentKnockoutStrength?: number;
  anglePreset?: HalftoneAnglePreset;
  channelGainC?: number;
  channelGainM?: number;
  channelGainY?: number;
  channelGainK?: number;
  channelGainW?: number;
  shadowZoneStrength?: number;
  midtoneZoneStrength?: number;
  highlightZoneStrength?: number;
  softProofEnabled?: boolean;
  softProofPreset?: SoftProofPreset;
  softProofGarmentHex?: string;
  softProofBlend?: number;
  calibrationProfileName?: string;
  calibrationCompensation?: number;
  mode?: HalftoneMode;
  screenFrequencyLpi?: number;
  customLpi?: number;
  printerDpi?: number;
  dotShape?: DotShape;
  channelAngles?: {
    c: number;
    m: number;
    y: number;
    k: number;
    w: number;
  };
  underbaseEnabled?: boolean;
  underbaseMaskMinTone?: number;
  underbaseMaskMaxTone?: number;
  underbaseSpread?: number;
  underbaseOpacity?: number;
  underbaseDensity?: number;
  gcrStrength?: number;
  inkLimit?: number;
  minimumDot?: number;
  shadowPreservation?: number;
  highlightProtection?: number;
  dotGainCompensation?: number;
  separationSmoothness?: number;
  rosetteScale?: number;
  channelPreviewMode?: ChannelPreviewMode;
  rosettePreviewEnabled?: boolean;

  channelCurveC?: [number, number, number];
  channelCurveM?: [number, number, number];
  channelCurveY?: [number, number, number];
  channelCurveK?: [number, number, number];
  channelCurveW?: [number, number, number];
}

export function resolvePresetHalftoneDefaults(
  preset: string | undefined | null,
  garmentMode: GarmentHalftoneMode = "dark",
): LocalHalftoneSettings {
  const key = String(preset ?? "DTF").toUpperCase();

  if (key === "DTF") {
    const lightGarment = garmentMode === "light";
    return {
      enabled: true,
      garmentMode,
      garmentKnockoutEnabled: true,
      garmentKnockoutTarget: lightGarment ? "white" : "black",
      garmentKnockoutThreshold: lightGarment ? 82 : 22,
      garmentKnockoutSoftness: 12,
      garmentKnockoutStrength: 92,
      anglePreset: "textile",
      channelGainC: lightGarment ? 92 : 100,
      channelGainM: lightGarment ? 92 : 100,
      channelGainY: lightGarment ? 90 : 100,
      channelGainK: lightGarment ? 78 : 100,
      channelGainW: lightGarment ? 0 : 100,
      shadowZoneStrength: lightGarment ? 86 : 100,
      midtoneZoneStrength: 100,
      highlightZoneStrength: lightGarment ? 84 : 100,
      softProofEnabled: true,
      softProofPreset: lightGarment ? "light-cotton" : "dark-cotton",
      softProofGarmentHex: lightGarment ? "#f5f5f4" : "#1f2937",
      softProofBlend: 35,
      calibrationProfileName: "DTF Default",
      calibrationCompensation: 0,
      type: "dot",
      mode: "am",
      screenFrequencyLpi: lightGarment ? 50 : 45,
      customLpi: lightGarment ? 50 : 45,
      printerDpi: 300,
      dotShape: "round",
      channelAngles: { c: 15, m: 75, y: 0, k: 45, w: 22 },
      underbaseEnabled: !lightGarment,
      underbaseMaskMinTone: lightGarment ? 0 : 8,
      underbaseMaskMaxTone: lightGarment ? 100 : 86,
      underbaseSpread: lightGarment ? 0 : 2,
      underbaseOpacity: lightGarment ? 0 : 85,
      underbaseDensity: lightGarment ? 0 : 90,
      gcrStrength: lightGarment ? 42 : 55,
      inkLimit: lightGarment ? 220 : 260,
      minimumDot: 3,
      shadowPreservation: lightGarment ? 58 : 64,
      highlightProtection: lightGarment ? 70 : 58,
      dotGainCompensation: lightGarment ? 6 : 8,
      separationSmoothness: 65,
      rosetteScale: 65,
      rosettePreviewEnabled: true,
      channelPreviewMode: "composite",
      channelCurveC: [100, 100, 100],
      channelCurveM: [100, 100, 100],
      channelCurveY: [100, 100, 100],
      channelCurveK: [100, 100, 100],
      channelCurveW: [100, 100, 100],
      cellSize: 6,
      strength: lightGarment ? 52 : 58,
      angle: 45,
      monochrome: false,
      preserveTransparency: true,
      applyToDuplicate: true,
    };
  }

  if (key === "UVDTF" || key === "UV") {
    return {
      enabled: true,
      garmentMode: "dark",
      garmentKnockoutEnabled: false,
      garmentKnockoutTarget: "black",
      garmentKnockoutThreshold: 18,
      garmentKnockoutSoftness: 10,
      garmentKnockoutStrength: 80,
      anglePreset: "uv",
      channelGainC: 100,
      channelGainM: 100,
      channelGainY: 100,
      channelGainK: 92,
      channelGainW: 100,
      shadowZoneStrength: 98,
      midtoneZoneStrength: 100,
      highlightZoneStrength: 100,
      softProofEnabled: true,
      softProofPreset: "natural-paper",
      softProofGarmentHex: "#d6d3d1",
      softProofBlend: 28,
      calibrationProfileName: "UV Default",
      calibrationCompensation: 0,
      type: "dot",
      mode: "am",
      screenFrequencyLpi: 52,
      customLpi: 52,
      printerDpi: key === "UV" ? 360 : 300,
      dotShape: "elliptical",
      channelAngles: { c: 15, m: 75, y: 0, k: 45, w: 30 },
      underbaseEnabled: true,
      underbaseMaskMinTone: 8,
      underbaseMaskMaxTone: 94,
      underbaseSpread: 1,
      underbaseOpacity: 78,
      underbaseDensity: 80,
      gcrStrength: 68,
      inkLimit: 240,
      minimumDot: 2,
      shadowPreservation: 52,
      highlightProtection: 62,
      dotGainCompensation: 6,
      separationSmoothness: 58,
      rosetteScale: 60,
      rosettePreviewEnabled: true,
      channelPreviewMode: "composite",
      channelCurveC: [100, 100, 100],
      channelCurveM: [100, 100, 100],
      channelCurveY: [100, 100, 100],
      channelCurveK: [100, 100, 100],
      channelCurveW: [100, 100, 100],
      cellSize: 5,
      strength: 60,
      angle: 45,
      monochrome: false,
      preserveTransparency: true,
      applyToDuplicate: true,
    };
  }

  if (key === "LASER_ENGRAVING") {
    return {
      enabled: true,
      garmentMode: "dark",
      garmentKnockoutEnabled: false,
      garmentKnockoutTarget: "black",
      garmentKnockoutThreshold: 20,
      garmentKnockoutSoftness: 8,
      garmentKnockoutStrength: 70,
      anglePreset: "classic",
      channelGainC: 100,
      channelGainM: 100,
      channelGainY: 100,
      channelGainK: 100,
      channelGainW: 0,
      shadowZoneStrength: 100,
      midtoneZoneStrength: 100,
      highlightZoneStrength: 100,
      softProofEnabled: false,
      softProofPreset: "custom",
      softProofGarmentHex: "#222222",
      softProofBlend: 0,
      calibrationProfileName: "Laser Default",
      calibrationCompensation: 0,
      type: "grayscale",
      mode: "stochastic",
      screenFrequencyLpi: 35,
      customLpi: 35,
      printerDpi: 500,
      dotShape: "line",
      channelAngles: { c: 0, m: 0, y: 0, k: 45, w: 0 },
      underbaseEnabled: false,
      underbaseMaskMinTone: 0,
      underbaseMaskMaxTone: 100,
      underbaseSpread: 0,
      underbaseOpacity: 0,
      underbaseDensity: 0,
      gcrStrength: 80,
      inkLimit: 180,
      minimumDot: 2,
      shadowPreservation: 70,
      highlightProtection: 70,
      dotGainCompensation: 4,
      separationSmoothness: 55,
      rosetteScale: 45,
      rosettePreviewEnabled: false,
      channelPreviewMode: "k",
      channelCurveC: [100, 100, 100],
      channelCurveM: [100, 100, 100],
      channelCurveY: [100, 100, 100],
      channelCurveK: [100, 100, 100],
      channelCurveW: [100, 100, 100],
      cellSize: 4,
      strength: 70,
      angle: 45,
      monochrome: true,
      preserveTransparency: false,
      applyToDuplicate: true,
    };
  }

  return {
    enabled: false,
    garmentMode: "dark",
    garmentKnockoutEnabled: false,
    garmentKnockoutTarget: "black",
    garmentKnockoutThreshold: 20,
    garmentKnockoutSoftness: 10,
    garmentKnockoutStrength: 80,
    anglePreset: "classic",
    channelGainC: 100,
    channelGainM: 100,
    channelGainY: 100,
    channelGainK: 100,
    channelGainW: 100,
    shadowZoneStrength: 100,
    midtoneZoneStrength: 100,
    highlightZoneStrength: 100,
    softProofEnabled: false,
    softProofPreset: "custom",
    softProofGarmentHex: "#1f2937",
    softProofBlend: 0,
    calibrationProfileName: "Generic Default",
    calibrationCompensation: 0,
    type: "dot",
    mode: "am",
    screenFrequencyLpi: 40,
    customLpi: 40,
    printerDpi: 300,
    dotShape: "round",
    channelAngles: { c: 15, m: 75, y: 0, k: 45, w: 22 },
    underbaseEnabled: false,
    underbaseMaskMinTone: 0,
    underbaseMaskMaxTone: 100,
    underbaseSpread: 0,
    underbaseOpacity: 0,
    underbaseDensity: 0,
    gcrStrength: 45,
    inkLimit: 240,
    minimumDot: 2,
    shadowPreservation: 55,
    highlightProtection: 55,
    dotGainCompensation: 5,
    separationSmoothness: 60,
    rosetteScale: 60,
    rosettePreviewEnabled: true,
    channelPreviewMode: "composite",
    channelCurveC: [100, 100, 100],
    channelCurveM: [100, 100, 100],
    channelCurveY: [100, 100, 100],
    channelCurveK: [100, 100, 100],
    channelCurveW: [100, 100, 100],
    cellSize: 6,
    strength: 55,
    angle: 45,
    monochrome: true,
    preserveTransparency: true,
    applyToDuplicate: true,
  };
}

export function normalizeHalftoneSettings(
  input: Partial<LocalHalftoneSettings> | undefined,
  preset: string | undefined | null,
): LocalHalftoneSettings {
  const garmentMode = input?.garmentMode === "light" ? "light" : "dark";
  const base = resolvePresetHalftoneDefaults(preset, garmentMode);
  const settings = {
    ...base,
    ...(input ?? {}),
  };

  return {
    ...settings,
    garmentMode,
    garmentKnockoutEnabled: Boolean(settings.garmentKnockoutEnabled),
    garmentKnockoutTarget: normalizeGarmentKnockoutTarget(settings.garmentKnockoutTarget),
    garmentKnockoutThreshold: clamp(settings.garmentKnockoutThreshold ?? 20, 0, 100),
    garmentKnockoutSoftness: clamp(settings.garmentKnockoutSoftness ?? 10, 0, 50),
    garmentKnockoutStrength: clamp(settings.garmentKnockoutStrength ?? 80, 0, 100),
    anglePreset: normalizeAnglePreset(settings.anglePreset),
    channelGainC: clamp(settings.channelGainC ?? 100, 0, 200),
    channelGainM: clamp(settings.channelGainM ?? 100, 0, 200),
    channelGainY: clamp(settings.channelGainY ?? 100, 0, 200),
    channelGainK: clamp(settings.channelGainK ?? 100, 0, 200),
    channelGainW: clamp(settings.channelGainW ?? 100, 0, 200),
    shadowZoneStrength: clamp(settings.shadowZoneStrength ?? 100, 0, 200),
    midtoneZoneStrength: clamp(settings.midtoneZoneStrength ?? 100, 0, 200),
    highlightZoneStrength: clamp(settings.highlightZoneStrength ?? 100, 0, 200),
    softProofEnabled: Boolean(settings.softProofEnabled),
    softProofPreset: normalizeSoftProofPreset(settings.softProofPreset),
    softProofGarmentHex: normalizeHexColor(settings.softProofGarmentHex),
    softProofBlend: clamp(settings.softProofBlend ?? 0, 0, 100),
    calibrationProfileName: typeof settings.calibrationProfileName === "string"
      ? settings.calibrationProfileName.slice(0, 80)
      : "",
    calibrationCompensation: clamp(settings.calibrationCompensation ?? 0, -50, 50),
    enabled: Boolean(settings.enabled),
    mode: settings.mode === "stochastic" || settings.mode === "hybrid" ? settings.mode : "am",
    screenFrequencyLpi: clamp(settings.screenFrequencyLpi ?? 40, 10, 120),
    customLpi: clamp(settings.customLpi ?? settings.screenFrequencyLpi ?? 40, 10, 120),
    printerDpi: clamp(settings.printerDpi ?? 300, 72, 1440),
    dotShape: normalizeDotShape(settings.dotShape),
    channelAngles: {
      c: clamp(settings.channelAngles?.c ?? 15, 0, 180),
      m: clamp(settings.channelAngles?.m ?? 75, 0, 180),
      y: clamp(settings.channelAngles?.y ?? 0, 0, 180),
      k: clamp(settings.channelAngles?.k ?? 45, 0, 180),
      w: clamp(settings.channelAngles?.w ?? 22, 0, 180),
    },
    underbaseEnabled: Boolean(settings.underbaseEnabled),
    underbaseMaskMinTone: clamp(settings.underbaseMaskMinTone ?? 0, 0, 100),
    underbaseMaskMaxTone: clamp(settings.underbaseMaskMaxTone ?? 100, 0, 100),
    underbaseSpread: clamp(settings.underbaseSpread ?? 0, -8, 12),
    underbaseOpacity: clamp(settings.underbaseOpacity ?? 80, 0, 100),
    underbaseDensity: clamp(settings.underbaseDensity ?? 80, 0, 100),
    gcrStrength: clamp(settings.gcrStrength ?? 50, 0, 100),
    inkLimit: clamp(settings.inkLimit ?? 240, 120, 400),
    minimumDot: clamp(settings.minimumDot ?? 2, 0, 12),
    shadowPreservation: clamp(settings.shadowPreservation ?? 55, 0, 100),
    highlightProtection: clamp(settings.highlightProtection ?? 55, 0, 100),
    dotGainCompensation: clamp(settings.dotGainCompensation ?? 5, 0, 30),
    separationSmoothness: clamp(settings.separationSmoothness ?? 60, 0, 100),
    rosetteScale: clamp(settings.rosetteScale ?? 60, 10, 120),
    rosettePreviewEnabled: Boolean(settings.rosettePreviewEnabled),
    channelPreviewMode: normalizeChannelPreview(settings.channelPreviewMode),
    channelCurveC: normalizeCurvePoints(settings.channelCurveC),
    channelCurveM: normalizeCurvePoints(settings.channelCurveM),
    channelCurveY: normalizeCurvePoints(settings.channelCurveY),
    channelCurveK: normalizeCurvePoints(settings.channelCurveK),
    channelCurveW: normalizeCurvePoints(settings.channelCurveW),
    cellSize: clamp(settings.cellSize ?? 6, 1, 32),
    strength: clamp(settings.strength ?? 55, 0, 100),
    angle: clamp(settings.angle ?? 45, 0, 180),
    monochrome: Boolean(settings.monochrome),
    preserveTransparency: Boolean(settings.preserveTransparency),
    applyToDuplicate: Boolean(settings.applyToDuplicate),
  };
}

export function estimateInkCoverage(settings: LocalHalftoneSettings): number {
  const lpiFactor = (settings.customLpi ?? settings.screenFrequencyLpi ?? 40) / 50;
  const base = 150 + (settings.strength ?? 55) * 1.1 + lpiFactor * 18;
  const gcrRelief = (settings.gcrStrength ?? 50) * 0.35;
  const underbaseLoad = settings.underbaseEnabled
    ? ((settings.underbaseOpacity ?? 0) * 0.5 + (settings.underbaseDensity ?? 0) * 0.25)
    : 0;
  return clamp(Math.round(base - gcrRelief + underbaseLoad), 120, 420);
}

export function computeMoiréRisk(settings: LocalHalftoneSettings): "low" | "medium" | "high" {
  const angles = settings.channelAngles ?? { c: 15, m: 75, y: 0, k: 45, w: 22 };
  const values = [angles.c, angles.m, angles.y, angles.k];
  let minGap = 180;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const gap = Math.min(Math.abs(values[i] - values[j]), 180 - Math.abs(values[i] - values[j]));
      minGap = Math.min(minGap, gap);
    }
  }

  const lpi = settings.customLpi ?? settings.screenFrequencyLpi ?? 40;
  if (lpi > 65 || minGap < 8) return "high";
  if (lpi > 50 || minGap < 15) return "medium";
  return "low";
}

function normalizeDotShape(shape: LocalHalftoneSettings["dotShape"]): DotShape {
  if (shape === "elliptical" || shape === "diamond" || shape === "line" || shape === "euclidean") return shape;
  return "round";
}

function normalizeChannelPreview(mode: LocalHalftoneSettings["channelPreviewMode"]): ChannelPreviewMode {
  if (mode === "c" || mode === "m" || mode === "y" || mode === "k" || mode === "w") return mode;
  return "composite";
}

function normalizeGarmentKnockoutTarget(target: LocalHalftoneSettings["garmentKnockoutTarget"]): GarmentKnockoutTarget {
  if (target === "white" || target === "both") return target;
  return "black";
}

function normalizeAnglePreset(preset: LocalHalftoneSettings["anglePreset"]): HalftoneAnglePreset {
  if (preset === "photo" || preset === "textile" || preset === "uv" || preset === "custom") return preset;
  return "classic";
}

function normalizeHexColor(value: LocalHalftoneSettings["softProofGarmentHex"]): string {
  if (typeof value !== "string") return "#1f2937";
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  return "#1f2937";
}

function normalizeSoftProofPreset(value: LocalHalftoneSettings["softProofPreset"]): SoftProofPreset {
  if (value === "dark-cotton" || value === "light-cotton" || value === "heather" || value === "natural-paper" || value === "clear-film") {
    return value;
  }
  return "custom";
}

function normalizeCurvePoints(value: [number, number, number] | undefined): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return [100, 100, 100];
  return [
    clamp(Number(value[0] ?? 100), 40, 180),
    clamp(Number(value[1] ?? 100), 40, 180),
    clamp(Number(value[2] ?? 100), 40, 180),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
