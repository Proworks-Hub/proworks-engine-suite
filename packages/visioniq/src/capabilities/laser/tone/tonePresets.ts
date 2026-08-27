// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's laser-prep module without behavioural
// change. The whole intelligence layer was already free of the DOM and of React
// — only ImageData annotations needed the PixelBuffer seam, and every one of
// its imports pointed at its own siblings, so nothing outside came with it.

import type {
  LaserToneMachinePreset,
  LaserToneMaterialPreset,
} from "./LaserToneBuilderTypes.js";
import { mergeToneDefaults } from "./toneDefaults.js";

export interface ToneMachinePresetOption {
  id: LaserToneMachinePreset;
  label: string;
}

export interface ToneMaterialPresetOption {
  id: LaserToneMaterialPreset;
  label: string;
}

export const LASER_TONE_MACHINE_PRESETS: ToneMachinePresetOption[] = [
  { id: "co2", label: "CO2" },
  { id: "diode", label: "Diode" },
  { id: "fiber", label: "Fiber" },
  { id: "mopa", label: "MOPA" },
];

export const LASER_TONE_MATERIAL_PRESETS: ToneMaterialPresetOption[] = [
  { id: "wood", label: "Wood" },
  { id: "slate", label: "Slate" },
  { id: "anodized_metal", label: "Anodized Metal" },
  { id: "acrylic", label: "Acrylic" },
  { id: "leather", label: "Leather" },
  { id: "coated_metal", label: "Coated Metal" },
];

export function getTonePresetConfig(
  machinePreset: LaserToneMachinePreset,
  materialPreset: LaserToneMaterialPreset,
) {
  return mergeToneDefaults(machinePreset, materialPreset);
}
