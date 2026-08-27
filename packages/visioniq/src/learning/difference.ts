// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { PixelBuffer } from "../core/pixelBuffer.js";
import { luminance } from "../core/pixelBuffer.js";

// ─────────────────────────────────────────────────────────────────────────────
// What changed when somebody edited a file outside the system.
//
// An operator exports to Photoshop, fixes something, and re-imports. No plugin
// told us what they did. This compares before and after and proposes what
// changed — then asks them to confirm, because a guess presented as knowledge
// is worse than no guess.
//
// WHY CONFIDENCE MATTERS MORE THAN DETECTION. Nearly any two images differ.
// The useful question is whether the difference has a RECOGNISABLE SHAPE:
// uniform lift across all channels looks like brightness; alpha appearing
// where there was none looks like a background knockout; a size change is
// simply a size change. Anything else is `unknown_visual_change`, and saying
// so is the honest answer — §23 is explicit that VisionIQ must not pretend to
// understand an external edit when confidence is inadequate.
//
// Everything here is structural. No image is stored, and the output carries
// measurements rather than pixels.
// ─────────────────────────────────────────────────────────────────────────────

export const DETECTED_CHANGES = [
  "dimensions_changed",
  "background_removed",
  "transparency_added",
  "transparency_removed",
  "brightness_adjusted",
  "contrast_adjusted",
  "colors_reduced",
  "converted_to_grayscale",
  "crop_changed",
  "unknown_visual_change",
] as const;
export type DetectedChangeKind = (typeof DETECTED_CHANGES)[number];

export interface DetectedChange {
  readonly kind: DetectedChangeKind;
  /** 0–1. How well the evidence fits this explanation. */
  readonly confidence: number;
  /** The measurement behind it, so a human can judge the claim. */
  readonly evidence: string;
}

export interface AssetDifference {
  readonly sourceAssetId: string;
  readonly finalAssetId: string;
  readonly detectedChanges: ReadonlyArray<DetectedChange>;
  /** The strongest single explanation, or 0 when nothing is recognisable. */
  readonly confidence: number;
  /**
   * True unless the change is both recognised and unambiguous.
   *
   * Defaults towards asking. An operator dismissing a prompt costs two
   * seconds; a wrong lesson learned silently costs every job after it.
   */
  readonly requiresOperatorConfirmation: boolean;
}

interface Summary {
  readonly meanLuma: number;
  readonly lumaStdDev: number;
  readonly transparentRatio: number;
  readonly distinctColors: number;
  readonly isGrayscale: boolean;
}

/** Cheap structural summary. Never retained — only its numbers are. */
function summarize(buffer: PixelBuffer): Summary {
  const { data } = buffer;
  const pixels = buffer.width * buffer.height;
  let sum = 0;
  let sumSq = 0;
  let transparent = 0;
  let grayscale = true;
  const colors = new Set<number>();

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 8) transparent += 1;
    if (r !== g || g !== b) grayscale = false;
    const l = luminance(r, g, b);
    sum += l;
    sumSq += l * l;
    // Quantized to keep the set bounded on a large image; exact counts are not
    // needed, only whether the palette collapsed.
    if (colors.size < 4096) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
  }

  const mean = sum / pixels;
  return {
    meanLuma: mean,
    lumaStdDev: Math.sqrt(Math.max(0, sumSq / pixels - mean * mean)),
    transparentRatio: transparent / pixels,
    distinctColors: colors.size,
    isGrayscale: grayscale,
  };
}

const LUMA_SHIFT = 6;
const CONTRAST_SHIFT = 0.12;
const TRANSPARENCY_SHIFT = 0.05;

/**
 * Compares two versions of an asset and proposes what changed.
 *
 * Dimension changes short-circuit the pixel comparison: once an image has been
 * resized or cropped, every statistic below is measuring a different picture,
 * and reporting "brightness adjusted" alongside it would be an artefact of the
 * resize rather than an edit somebody made.
 */
export function compareAssets(
  before: PixelBuffer,
  after: PixelBuffer,
  ids: { sourceAssetId: string; finalAssetId: string },
): AssetDifference {
  const changes: DetectedChange[] = [];

  if (before.width !== after.width || before.height !== after.height) {
    const sameAspect =
      Math.abs(before.width / before.height - after.width / after.height) < 0.01;
    changes.push({
      // Same aspect ratio is a resize; a different one means content was cut.
      kind: sameAspect ? "dimensions_changed" : "crop_changed",
      confidence: 0.95,
      evidence: `${before.width}×${before.height} → ${after.width}×${after.height}`,
    });
    return finalize(ids, changes);
  }

  const a = summarize(before);
  const b = summarize(after);

  const transparencyDelta = b.transparentRatio - a.transparentRatio;
  if (transparencyDelta > TRANSPARENCY_SHIFT) {
    // Transparency appearing across a large area is a knockout; a little of it
    // is an edge being cleaned up.
    const wholesale = transparencyDelta > 0.25;
    changes.push({
      kind: wholesale ? "background_removed" : "transparency_added",
      confidence: wholesale ? 0.85 : 0.6,
      evidence:
        `transparent pixels ${(a.transparentRatio * 100).toFixed(1)}% → ` +
        `${(b.transparentRatio * 100).toFixed(1)}%`,
    });
  } else if (transparencyDelta < -TRANSPARENCY_SHIFT) {
    changes.push({
      kind: "transparency_removed",
      confidence: 0.8,
      evidence: `transparency fell by ${(-transparencyDelta * 100).toFixed(1)}%`,
    });
  }

  if (!a.isGrayscale && b.isGrayscale) {
    changes.push({
      kind: "converted_to_grayscale",
      confidence: 0.95,
      evidence: "every pixel now has equal channels",
    });
  }

  const lumaDelta = b.meanLuma - a.meanLuma;
  if (Math.abs(lumaDelta) > LUMA_SHIFT) {
    changes.push({
      kind: "brightness_adjusted",
      confidence: 0.75,
      evidence: `mean luminance ${a.meanLuma.toFixed(1)} → ${b.meanLuma.toFixed(1)}`,
    });
  }

  const spreadRatio = a.lumaStdDev > 1 ? b.lumaStdDev / a.lumaStdDev : 1;
  if (Math.abs(spreadRatio - 1) > CONTRAST_SHIFT) {
    changes.push({
      kind: "contrast_adjusted",
      confidence: 0.7,
      evidence: `tonal spread ×${spreadRatio.toFixed(2)}`,
    });
  }

  if (b.distinctColors < a.distinctColors * 0.5 && a.distinctColors > 32) {
    changes.push({
      kind: "colors_reduced",
      confidence: 0.7,
      evidence: `${a.distinctColors} → ${b.distinctColors} distinct colours`,
    });
  }

  if (changes.length === 0 && (Math.abs(lumaDelta) > 0.5 || spreadRatio !== 1)) {
    // Something moved, and none of the known shapes fit. Saying so is the
    // honest answer — and it still prompts, because an unexplained change is
    // exactly the one worth asking a human about.
    changes.push({
      kind: "unknown_visual_change",
      confidence: 0.3,
      evidence: `mean luminance moved ${lumaDelta.toFixed(2)} with no recognised pattern`,
    });
  }

  return finalize(ids, changes);
}

function finalize(
  ids: { sourceAssetId: string; finalAssetId: string },
  changes: DetectedChange[],
): AssetDifference {
  const confidence = changes.reduce((max, c) => Math.max(max, c.confidence), 0);
  return {
    sourceAssetId: ids.sourceAssetId,
    finalAssetId: ids.finalAssetId,
    detectedChanges: changes,
    confidence,
    // Confident AND singular. Two competing explanations mean the engine does
    // not know which one the operator intended, however sure it is of each.
    requiresOperatorConfirmation: !(confidence >= 0.85 && changes.length === 1),
  };
}
