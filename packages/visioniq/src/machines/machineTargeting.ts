// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten and the host's generated API types replaced with the structurally
// identical declarations in core/prepSettings.ts — every one of those imports
// was `import type`, so all of it erased at runtime.

import type { PrepMachine } from "../core/prepSettings.js";
import type { MachinePresetKey } from "./machinePresets.js";

export type PrepProcessFamily =
  | "dtf"
  | "uvdtf"
  | "uv"
  | "fine_art"
  | "poster_photo"
  | "sticker_vinyl"
  | "sublimation"
  | "canvas"
  | "laser"
  | "unknown";

export interface ResolvedMachineTarget {
  machineId: string;
  machineLabel: string;
  processFamily: PrepProcessFamily;
  suggestedPreset: MachinePresetKey;
}

function readMachineLabel(machine: PrepMachine): string {
  return String(machine.displayName ?? machine.name ?? "PrepMachine");
}

export function inferProcessFamilyFromMachine(machine: PrepMachine): PrepProcessFamily {
  const label = `${machine.name ?? ""} ${machine.displayName ?? ""} ${machine.description ?? ""}`.toLowerCase();

  if (label.includes("uv dtf") || label.includes("uvdtf")) return "uvdtf";
  if (label.includes("dtf")) return "dtf";
  if (label.includes("sublimation") || label.includes("dye sub")) return "sublimation";
  if (label.includes("canvas")) return "canvas";
  if (label.includes("poster") || label.includes("photo") || label.includes("large format")) return "poster_photo";
  if (label.includes("fine art") || label.includes("giclee")) return "fine_art";
  if (label.includes("sticker") || label.includes("vinyl") || label.includes("plotter")) return "sticker_vinyl";
  if (label.includes("laser") || label.includes("engrave") || label.includes("co2") || label.includes("fiber")) return "laser";
  if (label.includes("uv")) return "uv";

  if (machine.catalogMachineId && machine.catalogMachineId.toLowerCase().includes("laser")) return "laser";
  if (machine.catalogMachineId && machine.catalogMachineId.toLowerCase().includes("uvdtf")) return "uvdtf";
  if (machine.catalogMachineId && machine.catalogMachineId.toLowerCase().includes("dtf")) return "dtf";

  return "unknown";
}

export function mapProcessFamilyToPreset(family: PrepProcessFamily): MachinePresetKey {
  if (family === "dtf") return "DTF";
  if (family === "uvdtf") return "UVDTF";
  if (family === "uv") return "UV";
  if (family === "fine_art") return "FINE_ART";
  if (family === "poster_photo") return "POSTER";
  if (family === "sticker_vinyl") return "STICKER_VINYL";
  if (family === "sublimation") return "SUBLIMATION";
  if (family === "canvas") return "CANVAS_PRINT";
  if (family === "laser") return "LASER_ENGRAVING";
  return "DTF";
}

export function resolveMachineTarget(machine: PrepMachine): ResolvedMachineTarget {
  const processFamily = inferProcessFamilyFromMachine(machine);
  return {
    machineId: String(machine.id),
    machineLabel: readMachineLabel(machine),
    processFamily,
    suggestedPreset: mapProcessFamilyToPreset(processFamily),
  };
}

export function mapLegacyPresetToFamily(preset: string | undefined | null): PrepProcessFamily {
  const normalized = String(preset ?? "").toUpperCase();
  if (normalized === "DTF") return "dtf";
  if (normalized === "UVDTF") return "uvdtf";
  if (normalized === "UV") return "uv";
  if (normalized === "FINE_ART") return "fine_art";
  if (normalized === "POSTER") return "poster_photo";
  if (normalized === "STICKER_VINYL") return "sticker_vinyl";
  if (normalized === "SUBLIMATION") return "sublimation";
  if (normalized === "CANVAS_PRINT") return "canvas";
  if (normalized === "LASER_ENGRAVING") return "laser";
  return "unknown";
}

export function getVisiblePrepTabsByPreset(preset: string | undefined | null): string[] {
  const normalized = String(preset ?? "").toUpperCase();
  const always = ["ai", "intake", "machine", "export", "recipes", "settings"];

  if (normalized === "LASER_ENGRAVING") {
    return [...always, "cleanup", "halftones", "dither", "vector"];
  }

  if (normalized === "UV" || normalized === "UVDTF") {
    return [...always, "background", "cleanup", "color", "halftones", "channels", "vector", "accent"];
  }

  if (normalized === "FINE_ART" || normalized === "POSTER" || normalized === "CANVAS_PRINT" || normalized === "SUBLIMATION") {
    return [...always, "background", "cleanup", "color", "halftones", "vector", "accent"];
  }

  return [...always, "background", "cleanup", "color", "halftones", "dither", "channels", "vector", "accent"];
}
