// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { motionStyle, type MotionState } from "../motion.js";
import { ENGINE_PALETTE, FALLBACK_PALETTE, STATE_INTENSITY, paletteVars, resolvePalette } from "../palette.js";
import { SCENE_REGISTRY, resolveScene } from "../scenes/index.js";
import { GenericScene } from "../scenes/supportScenes.js";
import { engineStateSchema } from "../../core/health.js";
import { SUITE_MANIFESTS } from "../../manifests/index.js";

// These are the visual layer's decisions rather than its pixels. Rendering is
// covered by the host application's own tests; what belongs here is the logic
// that decides whether anything moves and what colour it is, because that is
// where accessibility and the fallback behaviour actually live.

const motion = (over: Partial<MotionState> = {}): MotionState => ({
  paused: false,
  reducedMotion: false,
  animate: true,
  setPaused: () => {},
  togglePaused: () => {},
  ...over,
});

describe("reduced motion", () => {
  it("removes the animation rather than pausing it", () => {
    // A paused animation leaves the element wherever its keyframes had put it,
    // and "wherever it happened to be" is not a design.
    expect(motionStyle(motion({ reducedMotion: true }), "pw-spin 8s linear infinite")).toEqual({});
  });

  it("wins over the pause state, in either order", () => {
    expect(motionStyle(motion({ reducedMotion: true, paused: true }), "pw-spin 8s")).toEqual({});
    expect(motionStyle(motion({ reducedMotion: true, paused: false }), "pw-spin 8s")).toEqual({});
  });
});

describe("pause", () => {
  it("freezes an animation where it is instead of removing it", () => {
    // Pause should feel like the picture stopping, not jumping back to frame
    // one and rebuilding under the cursor of somebody reading a number.
    expect(motionStyle(motion({ paused: true }), "pw-spin 8s linear infinite")).toEqual({
      animation: "pw-spin 8s linear infinite",
      animationPlayState: "paused",
    });
  });

  it("runs when nothing is holding it back", () => {
    expect(motionStyle(motion(), "pw-spin 8s linear infinite").animationPlayState).toBe("running");
  });
});

describe("colour", () => {
  it("gives an unknown token a visible neutral rather than nothing", () => {
    // An invisible engine looks like an engine that is not there, which is the
    // one thing a monitoring console must never accidentally say.
    expect(resolvePalette("engine-chartreuse")).toBe(FALLBACK_PALETTE);
    expect(FALLBACK_PALETTE.base).not.toMatch(/transparent|none/);
  });

  it("resolves every token the shipped manifests use", () => {
    for (const manifest of SUITE_MANIFESTS) {
      expect(ENGINE_PALETTE[manifest.colorToken], manifest.id).toBeDefined();
    }
  });

  it("drains an engine's colour as its state worsens, in one direction", () => {
    // Failure should read as "gone quiet", not as a new hue an operator has to
    // re-learn mid-incident.
    expect(STATE_INTENSITY.failed).toBeLessThan(STATE_INTENSITY.degraded);
    expect(STATE_INTENSITY.degraded).toBeLessThan(STATE_INTENSITY.warning);
    expect(STATE_INTENSITY.warning).toBeLessThan(STATE_INTENSITY.operational);
  });

  it("sets a value for every custom property a scene reads", () => {
    const vars = paletteVars("engine-orange", "warning");
    for (const key of ["--engine-base", "--engine-dim", "--engine-bright", "--engine-intensity", "--engine-status"]) {
      expect(vars[key], key).toBeTruthy();
    }
  });

  it("has an intensity and a status colour for every state", () => {
    for (const state of engineStateSchema.options) {
      expect(paletteVars("engine-blue", state)["--engine-intensity"], state).toBeTruthy();
      expect(paletteVars("engine-blue", state)["--engine-status"], state).toBeTruthy();
    }
  });
});

describe("scenes", () => {
  it("draws an engine this build has never seen, rather than a blank card", () => {
    // A future engine appearing as empty space reads as a rendering bug and
    // gets investigated as one. A plain hexagon says "real engine, no artwork
    // yet", which is exactly what is true.
    expect(resolveScene("holographic-forge-2029")).toBe(GenericScene);
  });

  it("has artwork for every visualization type the manifests name", () => {
    for (const manifest of SUITE_MANIFESTS) {
      expect(SCENE_REGISTRY[manifest.visualizationType], manifest.id).toBeDefined();
    }
  });

  it("gives each engine a scene of its own", () => {
    // The identities are the point. Two engines sharing artwork would defeat
    // recognising one at a glance.
    const engines = SUITE_MANIFESTS.filter((m) => m.kind === "engine");
    const scenes = engines.map((m) => m.visualizationType);
    expect(new Set(scenes).size).toBe(engines.length);
  });
});
