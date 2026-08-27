// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// Material-realistic panel backgrounds, keyed by the selected option value's
// meta.preview hint (data-driven — the definition decides, with a neutral
// steel fallback).

const BACKGROUNDS: Record<string, string> = {
  corten:
    "radial-gradient(ellipse at 30% 20%, rgba(255,166,77,0.28), transparent 55%)," +
    "radial-gradient(ellipse at 75% 70%, rgba(140,60,20,0.45), transparent 60%)," +
    "linear-gradient(135deg, #8a4a24 0%, #a35a2a 28%, #7c3f1d 55%, #94512a 80%, #6f3818 100%)",
  "mild-steel":
    "radial-gradient(ellipse at 40% 30%, rgba(255,255,255,0.10), transparent 55%)," +
    "linear-gradient(135deg, #3a3d42 0%, #52565c 30%, #43464b 55%, #5a5e64 80%, #34373b 100%)",
  stainless:
    "repeating-linear-gradient(90deg, #b9bcc0 0px, #d4d7da 2px, #b9bcc0 4px)," +
    "linear-gradient(135deg, #c7cacd 0%, #e2e4e6 50%, #b5b8bb 100%)",
};

const FALLBACK =
  "linear-gradient(135deg, #3f3f46 0%, #52525b 50%, #3f3f46 100%)";

export function panelBackground(preview?: string): string {
  return (preview && BACKGROUNDS[preview]) || FALLBACK;
}

// Cut-through text look: warm glow as if seeing fire through the cutout.
export const CUT_TEXT_COLOR = "#fbbf24";
export const CUT_TEXT_SHADOW = "0 0 6px rgba(251,146,60,0.8), 0 0 2px rgba(0,0,0,0.6)";
