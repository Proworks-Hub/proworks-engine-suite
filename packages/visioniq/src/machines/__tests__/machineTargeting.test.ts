// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import {
  inferProcessFamilyFromMachine,
  mapProcessFamilyToPreset,
  resolveMachineTarget,
} from "../machineTargeting.js";
import { MACHINE_PRESETS, PRESET_ORDER } from "../machinePresets.js";
import type { PrepMachine } from "../../core/prepSettings.js";

// ─────────────────────────────────────────────────────────────────────────────
// These pin behaviour that arrived with the extraction and had no tests of its
// own. They are characterization tests: they assert what the host's code does
// today, so a later refactor inside VisionIQ cannot change a shop's machine
// routing without somebody deciding to.
//
// The ordering of the rules is the substance. Inference walks from most
// specific to least, and the extraction preserved that order exactly.
// ─────────────────────────────────────────────────────────────────────────────

const machine = (over: Partial<PrepMachine> = {}): PrepMachine => ({
  id: 7,
  name: "Machine",
  ...over,
});

describe("working out what a machine is for", () => {
  it("reads UV DTF before DTF", () => {
    // "UV DTF" contains "dtf". Checking DTF first would route every UV DTF
    // machine to the wrong process, and the label would still look right.
    expect(inferProcessFamilyFromMachine(machine({ name: "UV DTF Printer" }))).toBe("uvdtf");
    expect(inferProcessFamilyFromMachine(machine({ name: "UVDTF Station" }))).toBe("uvdtf");
    expect(inferProcessFamilyFromMachine(machine({ name: "DTF Printer 2" }))).toBe("dtf");
  });

  it("reads the specific print families before the generic UV rule", () => {
    // "uv" is checked last among the label rules for the same reason: it is a
    // substring of the more specific ones.
    expect(inferProcessFamilyFromMachine(machine({ name: "Sublimation Press" }))).toBe("sublimation");
    expect(inferProcessFamilyFromMachine(machine({ name: "Dye Sub Printer" }))).toBe("sublimation");
    expect(inferProcessFamilyFromMachine(machine({ name: "UV Flatbed" }))).toBe("uv");
  });

  it("recognises a laser by any of the words a shop actually uses", () => {
    for (const name of ["Fiber Laser", "CO2 Cutter", "Engraver 1", "Laser 2"]) {
      expect(inferProcessFamilyFromMachine(machine({ name })), name).toBe("laser");
    }
  });

  it("looks at every label field, not just the name", () => {
    // Shops name machines "Machine 3" and describe them properly, or the
    // reverse. Reading one field would work in development and fail in a shop.
    expect(inferProcessFamilyFromMachine(machine({ name: "Machine 3", displayName: "Big Sublimation" })))
      .toBe("sublimation");
    expect(inferProcessFamilyFromMachine(machine({ name: "M4", description: "Fiber laser marker" })))
      .toBe("laser");
  });

  it("falls back to the catalogue id when the labels say nothing", () => {
    expect(inferProcessFamilyFromMachine(machine({ name: "Unit 9", catalogMachineId: "gweike-LASER-m3" })))
      .toBe("laser");
    expect(inferProcessFamilyFromMachine(machine({ name: "Unit 9", catalogMachineId: "epson-uvdtf-01" })))
      .toBe("uvdtf");
  });

  it("says unknown rather than guessing", () => {
    // A wrong guess routes a job to the wrong machine. "Unknown" makes a human
    // look, which is the correct outcome for a machine nobody labelled.
    expect(inferProcessFamilyFromMachine(machine({ name: "Bench 4" }))).toBe("unknown");
    expect(inferProcessFamilyFromMachine(machine({}))).toBe("unknown");
  });
});

describe("turning that into a preset", () => {
  it("maps every family it can infer to a real preset", () => {
    // A family with no preset would resolve to something undefined at the point
    // a job is being set up, which is the worst place to find out.
    const families = [
      "uvdtf", "dtf", "sublimation", "canvas", "poster_photo",
      "fine_art", "sticker_vinyl", "laser", "uv", "unknown",
    ] as const;

    for (const family of families) {
      const preset = mapProcessFamilyToPreset(family);
      expect(MACHINE_PRESETS[preset], `${family} -> ${preset}`).toBeDefined();
    }
  });

  it("keeps every declared preset in the ordering", () => {
    // PRESET_ORDER drives how a shop sees them listed. A preset missing from it
    // exists and is invisible.
    for (const key of Object.keys(MACHINE_PRESETS)) {
      expect(PRESET_ORDER, key).toContain(key);
    }
  });
});

describe("resolving a machine to a target", () => {
  it("carries the id through as a string", () => {
    // The host's id is numeric; everything downstream treats it as an opaque
    // string. The conversion happens once, here.
    const resolved = resolveMachineTarget(machine({ id: 12, name: "Fiber Laser" }));

    expect(resolved.machineId).toBe("12");
    expect(resolved.processFamily).toBe("laser");
  });

  it("labels a machine a person can recognise", () => {
    expect(resolveMachineTarget(machine({ displayName: "Laser 2", name: "gw-m3" })).machineLabel)
      .toBe("Laser 2");
    // Falls back rather than showing an empty chip.
    expect(resolveMachineTarget(machine({ name: "gw-m3", displayName: undefined })).machineLabel)
      .toBe("gw-m3");
  });

  it("suggests a preset consistent with the family it inferred", () => {
    const resolved = resolveMachineTarget(machine({ name: "DTF Printer" }));
    expect(resolved.suggestedPreset).toBe(mapProcessFamilyToPreset("dtf"));
  });
});
