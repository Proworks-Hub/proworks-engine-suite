// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { DEFAULT_LASER_TONE_BUILDER_CONFIG } from "../LaserPrepConfig.js";
import type { LaserToneBuilderConfig } from "../tone/LaserToneBuilderTypes.js";
import { runThreshold } from "../tone/threshold.js";
import { runErrorDiffusion } from "../tone/errorDiffusion.js";
import { runOrderedDither } from "../tone/orderedDither.js";
import { calculateImageStats } from "../tone/imageStats.js";

// ─────────────────────────────────────────────────────────────────────────────
// The laser tone pipeline had no tests of its own. These pin the properties a
// laser actually depends on — not exact pixels, which are a matter of algorithm
// choice, but the invariants that make output burnable at all.
//
// The pipeline works on normalized grayscale (`Float32Array`, 0–1) rather than
// RGBA, which is why it needed no PixelBuffer seam: it had already separated
// tone from pixel storage. That is a better internal boundary than the one I
// assumed before reading it.
//
// A laser is two-state on these paths: it fires or it does not. Tone is an
// illusion made of dot spacing, so every method must produce pure black and
// white. Anything in between reaches the machine as a guess about what grey
// means, and machines guess differently.
// ─────────────────────────────────────────────────────────────────────────────

const WIDTH = 64;
const HEIGHT = 16;

// The config type here is the tone/ one; the defaults constant is typed against
// the sibling declaration in LaserPrepConfig. Their fields match — only the
// `mode` union differs — which is exactly the duplication the capability's
// index documents.
const config = (over: Partial<LaserToneBuilderConfig> = {}): LaserToneBuilderConfig =>
  ({ ...DEFAULT_LASER_TONE_BUILDER_CONFIG, ...over }) as unknown as LaserToneBuilderConfig;

/** A left-to-right grey ramp: the honest input for a tone method. */
function ramp(scale = 1): Float32Array {
  const gray = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      gray[y * WIDTH + x] = (x / (WIDTH - 1)) * scale;
    }
  }
  return gray;
}

const isTwoState = (gray: Float32Array): boolean =>
  gray.every((v) => v === 0 || v === 1);

/**
 * Fraction of the image the laser will fire on.
 *
 * 1 means FIRE, not "white" — the pipeline emits `gray <= threshold ? 1 : 0`,
 * so a dark input becomes a burn. I had this backwards on the first pass and
 * the tests caught it: two assertions failed against correct code, which is the
 * right way round for a characterization test to be wrong.
 */
const inkCoverage = (gray: Float32Array): number => {
  let fired = 0;
  for (const v of gray) if (v === 1) fired += 1;
  return fired / gray.length;
};

const METHODS: Array<[string, (gray: Float32Array) => Float32Array]> = [
  ["threshold", (g) => runThreshold(g, config())],
  ["error diffusion", (g) => runErrorDiffusion(g, WIDTH, HEIGHT, config())],
  ["ordered dither", (g) => runOrderedDither(g, WIDTH, HEIGHT, config())],
];

describe("every tone method produces something a laser can fire", () => {
  for (const [name, run] of METHODS) {
    it(`${name} yields two states, never grey`, () => {
      expect(isTwoState(run(ramp())), name).toBe(true);
    });

    it(`${name} preserves the pixel count`, () => {
      const source = ramp();
      expect(run(source).length).toBe(source.length);
    });

    it(`${name} does not mutate its input`, () => {
      // Prep Studio previews several methods against one upload. A method that
      // mutated in place would make the second preview depend on the first —
      // and error diffusion, which accumulates error as it scans, is exactly
      // the kind of algorithm where that is tempting to get wrong.
      const source = ramp();
      const before = Array.from(source);
      run(source);
      expect(Array.from(source)).toEqual(before);
    });
  }

  it("keeps a darker image darker, whichever method runs", () => {
    // Tone must be monotonic. A darker photograph coming out with less ink
    // than a lighter one is the failure a customer sees as a washed-out
    // engraving, and no amount of machine tuning fixes it.
    for (const [name, run] of METHODS) {
      expect(inkCoverage(run(ramp(0.4))), name).toBeGreaterThanOrEqual(
        inkCoverage(run(ramp(1))),
      );
    }
  });

  it("burns everything at full black and nothing at full white", () => {
    const black = new Float32Array(WIDTH * HEIGHT).fill(0);
    const white = new Float32Array(WIDTH * HEIGHT).fill(1);

    for (const [name, run] of METHODS) {
      expect(inkCoverage(run(black)), `${name} on black`).toBe(1);
      expect(inkCoverage(run(white)), `${name} on white`).toBe(0);
    }
  });
});

describe("reading an image before deciding how to treat it", () => {
  it("measures the mean of a ramp near the middle", () => {
    const stats = calculateImageStats(ramp(), WIDTH, HEIGHT);
    expect(stats.meanLuma).toBeGreaterThan(0.4);
    expect(stats.meanLuma).toBeLessThan(0.6);
  });

  it("reports no variance for a flat image", () => {
    // The case that matters: a flat image has nothing to dither, and a tone
    // method applied to it produces either a solid burn or nothing at all.
    const flat = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    const stats = calculateImageStats(flat, WIDTH, HEIGHT);

    expect(stats.lumaVariance).toBeCloseTo(0, 5);
    expect(stats.edgeDensity).toBeCloseTo(0, 5);
  });

  it("separates a dark image from a bright one", () => {
    const dark = calculateImageStats(new Float32Array(WIDTH * HEIGHT).fill(0.1), WIDTH, HEIGHT);
    const bright = calculateImageStats(new Float32Array(WIDTH * HEIGHT).fill(0.9), WIDTH, HEIGHT);

    expect(dark.darkRatio).toBeGreaterThan(bright.darkRatio);
    expect(bright.brightRatio).toBeGreaterThan(dark.brightRatio);
  });
});
