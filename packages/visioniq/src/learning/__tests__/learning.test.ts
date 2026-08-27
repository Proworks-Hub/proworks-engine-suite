// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { describe, expect, it } from "vitest";

import { createPixelBuffer, type PixelBuffer } from "../../core/pixelBuffer.js";
import { compareAssets } from "../difference.js";
import {
  MINIMUM_SAMPLE_SIZE,
  assertObservationIsSafe,
  observeCorrection,
  suggestAdjustment,
  type FeedbackObservation,
  type LearningContext,
} from "../feedback.js";
import {
  appendStep,
  explain,
  lastEngineStep,
  wasCorrectedByHuman,
  type AssetProvenance,
} from "../provenance.js";

const W = 32;
const H = 32;

function solid(r: number, g: number, b: number, a = 255): PixelBuffer {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return createPixelBuffer(data, W, H);
}

function ramp(scale = 1): PixelBuffer {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = Math.round((x / (W - 1)) * 255 * scale);
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return createPixelBuffer(data, W, H);
}

const ids = { sourceAssetId: "a1", finalAssetId: "a2" };

describe("working out what an external editor did", () => {
  it("recognises a background knockout", () => {
    const before = solid(200, 30, 30);
    const after = solid(200, 30, 30, 0);

    const diff = compareAssets(before, after, ids);
    expect(diff.detectedChanges[0]?.kind).toBe("background_removed");
    expect(diff.confidence).toBeGreaterThan(0.8);
  });

  it("tells a resize from a crop by aspect ratio", () => {
    // Same shape means resized; a different shape means content was cut, and
    // those need different conversations with the operator.
    const square = solid(128, 128, 128);
    const halved = createPixelBuffer(new Uint8ClampedArray(16 * 16 * 4), 16, 16);
    const cut = createPixelBuffer(new Uint8ClampedArray(32 * 8 * 4), 32, 8);

    expect(compareAssets(square, halved, ids).detectedChanges[0]?.kind).toBe("dimensions_changed");
    expect(compareAssets(square, cut, ids).detectedChanges[0]?.kind).toBe("crop_changed");
  });

  it("stops comparing pixels once the size changed", () => {
    // Every statistic below would be measuring a different picture. Reporting
    // "brightness adjusted" alongside a resize is an artefact of the resize,
    // not an edit somebody made.
    const diff = compareAssets(ramp(), createPixelBuffer(new Uint8ClampedArray(16 * 16 * 4), 16, 16), ids);
    expect(diff.detectedChanges).toHaveLength(1);
  });

  it("recognises a conversion to grayscale", () => {
    const colour = solid(200, 40, 40);
    const grey = solid(90, 90, 90);
    const kinds = compareAssets(colour, grey, ids).detectedChanges.map((c) => c.kind);
    expect(kinds).toContain("converted_to_grayscale");
  });

  it("recognises a brightness lift", () => {
    const kinds = compareAssets(solid(80, 80, 80), solid(140, 140, 140), ids)
      .detectedChanges.map((c) => c.kind);
    expect(kinds).toContain("brightness_adjusted");
  });

  it("says it does not know rather than guessing", () => {
    // §23 is explicit: do not pretend to understand an external edit when
    // confidence is inadequate. An honest "unknown" still prompts a human.
    const before = ramp();
    const after = ramp();
    after.data[0] = 3;
    after.data[4] = 250;

    const diff = compareAssets(before, after, ids);
    if (diff.detectedChanges.length > 0) {
      expect(diff.confidence).toBeLessThan(0.85);
    }
    expect(diff.requiresOperatorConfirmation).toBe(true);
  });

  it("asks for confirmation whenever two explanations compete", () => {
    // Confident in each is not the same as knowing which the operator meant.
    const diff = compareAssets(solid(200, 40, 40), solid(140, 140, 140, 0), ids);
    expect(diff.detectedChanges.length).toBeGreaterThan(1);
    expect(diff.requiresOperatorConfirmation).toBe(true);
  });

  it("reports nothing for an unchanged file", () => {
    const diff = compareAssets(ramp(), ramp(), ids);
    expect(diff.detectedChanges).toEqual([]);
    expect(diff.confidence).toBe(0);
  });

  it("carries measurements, never pixels", () => {
    // A difference record that held image data would be unstorable, and would
    // put one shop's customer artwork where it does not belong.
    const serialized = JSON.stringify(compareAssets(solid(0, 0, 0), solid(255, 255, 255), ids));
    expect(serialized).not.toMatch(/Uint8|data"\s*:\s*\[/);
  });
});

describe("the chain of what happened", () => {
  const base: AssetProvenance = {
    assetId: "asset_1",
    organizationId: "org-a",
    sourceRef: "s3://uploads/family-photo.jpg",
    steps: [],
  };

  const engineStep = {
    stepId: "s1",
    actor: { kind: "engine" as const },
    action: "tone.contrast",
    parameters: { value: 12 },
    producedVersion: 1,
    at: "2026-08-27T12:00:00.000Z",
  };

  it("knows when a human overrode the engine", () => {
    // The single most useful question in the record: "the engine was right"
    // and "the engine was overridden" are different, and only the second is
    // worth learning from.
    const untouched = appendStep(base, engineStep);
    expect(wasCorrectedByHuman(untouched)).toBe(false);

    const corrected = appendStep(untouched, {
      stepId: "s2",
      actor: { kind: "operator", id: "op-4" },
      action: "tone.contrast",
      parameters: { value: 18 },
      producedVersion: 2,
      at: "2026-08-27T12:30:00.000Z",
    });
    expect(wasCorrectedByHuman(corrected)).toBe(true);
  });

  it("does not count a customer approval as a correction", () => {
    // A customer approving is the engine being right, not being overridden.
    const approved = appendStep(appendStep(base, engineStep), {
      stepId: "s2",
      actor: { kind: "customer", id: "cust-1" },
      action: "approval.granted",
      producedVersion: 1,
      at: "2026-08-27T12:10:00.000Z",
    });
    expect(wasCorrectedByHuman(approved)).toBe(false);
  });

  it("takes the latest engine proposal as the baseline", () => {
    // When the engine has run twice, the operator was looking at the second.
    const twice = appendStep(appendStep(base, engineStep), {
      ...engineStep,
      stepId: "s2",
      parameters: { value: 15 },
      producedVersion: 2,
    });
    expect(lastEngineStep(twice, "tone.contrast")?.parameters?.["value"]).toBe(15);
  });

  it("explains itself to an operator", () => {
    const lines = explain(appendStep(base, { ...engineStep, note: "low contrast for slate" }));
    expect(lines[0]).toBe("VisionIQ: tone.contrast — low contrast for slate");
  });
});

describe("turning corrections into observations", () => {
  const context: LearningContext = {
    organizationId: "org-a",
    process: "laser_engraving",
    machineClass: "co2_laser",
    materialId: "black-slate",
  };

  const provenance: AssetProvenance = {
    assetId: "asset_1",
    organizationId: "org-a",
    sourceRef: "s3://uploads/photo.jpg",
    steps: [
      {
        stepId: "s1",
        actor: { kind: "engine" },
        action: "tone.contrast",
        parameters: { value: 12 },
        producedVersion: 1,
        at: "2026-08-27T12:00:00.000Z",
      },
    ],
  };

  const correction = {
    stepId: "s2",
    actor: { kind: "operator" as const, id: "op-4" },
    action: "tone.contrast",
    parameters: { value: 18 },
    producedVersion: 2,
    at: "2026-08-27T12:30:00.000Z",
  };

  it("records the engine's value and the human's, and nothing else", () => {
    const observation = observeCorrection(provenance, correction, context, "obs_1")!;

    expect(observation.recommended).toBe(12);
    expect(observation.applied).toBe(18);
    expect(observation.kind).toBe("operator_adjusted");
    expect(() => assertObservationIsSafe(observation as unknown as Record<string, unknown>))
      .not.toThrow();
  });

  it("ignores a value the engine never proposed", () => {
    // An operator setting something the engine never suggested is a
    // preference, not a correction. Counting it would teach the wrong lesson.
    expect(
      observeCorrection(provenance, { ...correction, action: "crop.box" }, context, "obs_2"),
    ).toBeUndefined();
  });

  it("refuses an observation carrying anything unrecognised", () => {
    // Fails towards keeping data out — the only direction worth failing in.
    expect(() =>
      assertObservationIsSafe({
        observationId: "o", kind: "operator_adjusted", context, at: "now",
        sourceImage: "data:image/png;base64,iVBOR...",
      }),
    ).toThrow(/never the artwork/);
  });

  it("refuses an observation with no tenant", () => {
    expect(() =>
      assertObservationIsSafe({ observationId: "o", kind: "quality_pass", context: {}, at: "now" }),
    ).toThrow(/aggregated across shops/);
  });
});

describe("proposing a profile change", () => {
  const context: LearningContext = { organizationId: "org-a", materialId: "black-slate" };

  const observations = (count: number, delta: number, org = "org-a"): FeedbackObservation[] =>
    Array.from({ length: count }, (_, i) => ({
      observationId: `o${i}`,
      kind: "operator_adjusted" as const,
      context: { ...context, organizationId: org },
      action: "tone.contrast",
      recommended: 12,
      applied: 12 + delta,
      at: "2026-08-27T12:00:00.000Z",
    }));

  it("proposes nothing from too few jobs", () => {
    // Below the threshold a pattern is noise, and a profile changed on four
    // jobs is a profile that will change back on the next four.
    expect(
      suggestAdjustment(observations(MINIMUM_SAMPLE_SIZE - 1, 6), "tone.contrast", "material", context),
    ).toBeUndefined();
  });

  it("proposes a change when operators agree", () => {
    const suggestion = suggestAdjustment(observations(20, 6), "tone.contrast", "material", context)!;

    expect(suggestion.suggestedDelta).toBe(6);
    expect(suggestion.sampleSize).toBe(20);
    expect(suggestion.summary).toMatch(/operators raised tone.contrast/);
  });

  it("proposes nothing when corrections point both ways", () => {
    // Operators disagreeing with each other is not the engine being wrong.
    const mixed = [...observations(10, 6), ...observations(10, -6)];
    expect(suggestAdjustment(mixed, "tone.contrast", "material", context)).toBeUndefined();
  });

  it("is not moved by one operator's typo", () => {
    // The median, not the mean: somebody typing 90 instead of 9 should not
    // reshape a profile.
    const withOutlier = [...observations(19, 5), {
      ...observations(1, 5)[0]!, observationId: "typo", applied: 900,
    }];
    expect(suggestAdjustment(withOutlier, "tone.contrast", "material", context)!.suggestedDelta)
      .toBe(5);
  });

  it("never learns across tenants", () => {
    // The rule that matters most. Another shop's corrections are not evidence
    // about this shop, and a record that crossed would be one shop's
    // proprietary practice leaking into another's profile.
    const other = observations(30, 9, "org-b");
    expect(suggestAdjustment(other, "tone.contrast", "material", context)).toBeUndefined();
  });

  it("returns evidence a human can weigh, not just a number", () => {
    // §28: recommend, do not silently rewrite. The summary is what an admin
    // approves or ignores.
    const suggestion = suggestAdjustment(observations(43, 7), "tone.contrast", "machine", context)!;
    expect(suggestion.summary).toMatch(/Across 43 jobs/);
    expect(suggestion.agreementRatio).toBe(1);
  });
});
