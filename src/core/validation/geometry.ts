import type { SurfaceElement } from "../schemas/configuration";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Axis-aligned bounding box of an element after rotation about its center.
// Text width is approximated from cap height (~0.6 × height per character) —
// good enough for bounds/validation; exact glyph metrics arrive with the
// production-file phase.
export function elementBounds(el: SurfaceElement): Bounds {
  const widthIn =
    el.type === "image" ? el.widthIn : el.text.length * el.heightIn * 0.6;
  const heightIn = el.heightIn;
  const cx = el.xIn + widthIn / 2;
  const cy = el.yIn + heightIn / 2;
  const rad = (el.rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const halfW = (widthIn * cos + heightIn * sin) / 2;
  const halfH = (widthIn * sin + heightIn * cos) / 2;
  return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
}
