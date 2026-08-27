// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// ─────────────────────────────────────────────────────────────────────────────
// The portability seam for raster work.
//
// The host's algorithms are typed against `ImageData`, which is a DOM class. A
// portable engine cannot depend on one: a licensee running VisionIQ in a Node
// service has no `ImageData` constructor, and importing a polyfill to satisfy a
// type would be a runtime dependency bought to solve a compile-time problem.
//
// `ImageData` is structurally `{ width, height, data: Uint8ClampedArray }`, so
// this interface accepts one WITHOUT A CAST. A browser host passes its
// `ImageData` straight in; a Node caller passes a plain object. That is what
// makes swapping the annotation an extraction rather than a rewrite — the
// algorithms below it did not change at all.
//
// The one place that needed real work is CONSTRUCTION. `new ImageData(...)` is
// a runtime call, not a type, so it becomes an object literal. Same shape, same
// bytes, no DOM.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A raster image as bytes.
 *
 * RGBA, four bytes per pixel, row-major from the top-left — the same layout
 * `ImageData` uses, because it is the layout every browser algorithm here
 * already assumes.
 */
export interface PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/**
 * Builds a buffer, replacing `new ImageData(data, width, height)`.
 *
 * Argument order matches the DOM constructor deliberately, so a call site
 * changes by name only.
 */
export function createPixelBuffer(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): PixelBuffer {
  const expected = width * height * 4;
  if (data.length !== expected) {
    // The DOM constructor throws here too. Silently accepting a mismatched
    // buffer produces an image that renders as diagonal garbage, which people
    // debug for an hour before checking the length.
    throw new Error(
      `pixel buffer is ${data.length} bytes; ${width}×${height} RGBA needs ${expected}`,
    );
  }
  return { width, height, data };
}

/** An opaque black buffer of the given size. */
export function emptyPixelBuffer(width: number, height: number): PixelBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** A detached copy. Transformations that mutate should take one first. */
export function clonePixelBuffer(buffer: PixelBuffer): PixelBuffer {
  return {
    width: buffer.width,
    height: buffer.height,
    data: new Uint8ClampedArray(buffer.data),
  };
}

/** Byte offset of a pixel. Out-of-bounds coordinates return -1. */
export function pixelIndex(buffer: PixelBuffer, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return -1;
  return (y * buffer.width + x) * 4;
}

/**
 * Perceptual luminance, ITU-R BT.601.
 *
 * The same weights the host's engrave preparation already used. Extracted here
 * because three separate places were computing it inline, and a fourth would
 * eventually have used different coefficients.
 */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Effective resolution at a physical size — the number that actually matters.
 *
 * A file's declared DPI is metadata and can be rewritten by anything; this is
 * pixels divided by the inches they have to cover. Re-stamping a header to 300
 * does not create detail, and a system that cannot tell the two apart will call
 * a 72 DPI photo print-ready.
 *
 * Returns `undefined` rather than Infinity for a zero size, because a division
 * nobody can perform should not produce a number somebody might render.
 */
export function effectiveDpi(pixels: number, inches: number): number | undefined {
  if (!Number.isFinite(pixels) || !Number.isFinite(inches) || inches <= 0) {
    return undefined;
  }
  return pixels / inches;
}
