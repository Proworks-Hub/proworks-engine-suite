// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change.

/**
 * What kind of artwork this is, and how sure the detector was.
 *
 * The detector that produces this is still in the host — it reads pixels
 * through canvas and has not crossed the PixelBuffer seam yet. Its RESULT is a
 * plain data shape, and several extracted files consume it, so the type comes
 * across ahead of the implementation.
 *
 * Structurally identical to the host's, so the host can pass its own results in.
 */
export type ArtType = "logo" | "photo" | "screenshot" | "graphic" | "distress";

export interface ArtTypeResult {
  artType: ArtType;
  confidence: number;
  flatColorRatio: number;
  gradientScore: number;
  noiseScore: number;
  blockingScore: number;
  estimatedColorCount: number;
  dpi: number;
  colorMode: "RGB" | "CMYK" | "Grayscale" | "Unknown";
  notes: string[];
}
