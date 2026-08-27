// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's canvasProcessing. Seventeen of its twenty
// functions were pure colour and pixel maths despite the file's name; only
// three genuinely needed a browser and stayed behind as host adapters:
// resizeHighQuality (a canvas resampler — already a port here),
// downloadTextFile (a browser download) and generateRosettePreview (paints onto
// a caller's canvas).
//
// The lesson from the file name: it described where the code RAN, not what it
// did. Most of it never touched a canvas at all.

import { createPixelBuffer, type PixelBuffer } from "../core/pixelBuffer.js";
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface PaletteColor {
  name: string;
  hex: string;
  group: string;
  rgb: RgbColor;
}

export interface DominantColor {
  r: number;
  g: number;
  b: number;
  hex: string;
  count: number;
}

export function hexToRgb(hex: string): RgbColor {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  ).toUpperCase();
}

export function clamp(v: number): number {
  return Math.max(0, Math.min(255, v));
}

export function distanceRgb(a: RgbColor, b: RgbColor): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function srgbToLinear(channel: number): number {
  const c = Math.max(0, Math.min(1, channel / 255));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(rgb: RgbColor): { l: number; a: number; b: number } {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  // D65, sRGB
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;

  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;

  const fxn = x / xn;
  const fyn = y / yn;
  const fzn = z / zn;
  const delta = 6 / 29;
  const f = (t: number) =>
    t > delta ** 3 ? Math.cbrt(t) : (t / (3 * delta * delta)) + 4 / 29;

  const fx = f(fxn);
  const fy = f(fyn);
  const fz = f(fzn);

  return {
    l: (116 * fy) - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function distanceLab(a: RgbColor, b: RgbColor): number {
  const la = rgbToLab(a);
  const lb = rgbToLab(b);
  const dl = la.l - lb.l;
  const da = la.a - lb.a;
  const db = la.b - lb.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function luminance(rgb: RgbColor): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

export function isNeutralish(rgb: RgbColor): boolean {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max - min < 18;
}

export function scaleColorPreserveShading(source: RgbColor, target: RgbColor): RgbColor {
  const srcLum = Math.max(1, luminance(source));
  const targetLum = Math.max(1, luminance(target));
  const ratio = srcLum / targetLum;
  return {
    r: clamp(target.r * ratio),
    g: clamp(target.g * ratio),
    b: clamp(target.b * ratio),
  };
}

export function nearestPaletteColor(
  rgb: RgbColor,
  palette: PaletteColor[]
): { color: PaletteColor; distance: number } {
  let best = palette[0];
  let bestDistance = Infinity;
  for (const color of palette) {
    // Use perceptual distance (Lab) for better print-safe color decisions.
    const d = distanceLab(rgb, color.rgb) * 2.55;
    if (d < bestDistance) {
      best = color;
      bestDistance = d;
    }
  }
  return { color: best, distance: bestDistance };
}

export function getDominantColors(
  imageData: PixelBuffer,
  maxColors = 12,
  alphaMin = 10,
  stride = 5
): DominantColor[] {
  const map = new Map<string, number>();
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4 * stride) {
    const a = data[i + 3];
    if (a < alphaMin) continue;
    const r = Math.round(data[i] / 16) * 16;
    const g = Math.round(data[i + 1] / 16) * 16;
    const b = Math.round(data[i + 2] / 16) * 16;
    const key = `${r},${g},${b}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([key, count]) => {
      const [r, g, b] = key.split(",").map(Number);
      return { r, g, b, hex: rgbToHex(r, g, b), count };
    });
}


export function boxBlur(imageData: PixelBuffer, radius = 1): PixelBuffer {
  if (radius <= 0) return imageData;
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const idx = (ny * width + nx) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count += 1;
        }
      }
      const outIdx = (y * width + x) * 4;
      out[outIdx] = r / count;
      out[outIdx + 1] = g / count;
      out[outIdx + 2] = b / count;
      out[outIdx + 3] = a / count;
    }
  }
  return createPixelBuffer(out, width, height);
}

export function unsharpMaskLike(imageData: PixelBuffer, amount = 0): PixelBuffer {
  if (amount <= 0) return imageData;
  const blurred = boxBlur(imageData, 1);
  const out = new Uint8ClampedArray(imageData.data.length);
  const strength = amount / 100;
  for (let i = 0; i < imageData.data.length; i += 4) {
    out[i] = clamp(imageData.data[i] + (imageData.data[i] - blurred.data[i]) * strength);
    out[i + 1] = clamp(imageData.data[i + 1] + (imageData.data[i + 1] - blurred.data[i + 1]) * strength);
    out[i + 2] = clamp(imageData.data[i + 2] + (imageData.data[i + 2] - blurred.data[i + 2]) * strength);
    out[i + 3] = imageData.data[i + 3];
  }
  return createPixelBuffer(out, imageData.width, imageData.height);
}

export function adjustContrastSaturation(imageData: PixelBuffer, contrast = 0, saturation = 0): PixelBuffer {
  const out = new Uint8ClampedArray(imageData.data.length);
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  for (let i = 0; i < imageData.data.length; i += 4) {
    let r = imageData.data[i];
    let g = imageData.data[i + 1];
    let b = imageData.data[i + 2];
    const a = imageData.data[i + 3];

    r = clamp(contrastFactor * (r - 128) + 128);
    g = clamp(contrastFactor * (g - 128) + 128);
    b = clamp(contrastFactor * (b - 128) + 128);

    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const s = saturation / 100;
    r = clamp(gray + (r - gray) * (1 + s));
    g = clamp(gray + (g - gray) * (1 + s));
    b = clamp(gray + (b - gray) * (1 + s));

    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = a;
  }
  return createPixelBuffer(out, imageData.width, imageData.height);
}

export function cleanupEdges(
  imageData: PixelBuffer,
  alphaThreshold = 8,
  harden = 0,
  preserveSoftEdges = true
): PixelBuffer {
  const out = new Uint8ClampedArray(imageData.data.length);
  const hardenFactor = harden / 100;
  for (let i = 0; i < imageData.data.length; i += 4) {
    out[i] = imageData.data[i];
    out[i + 1] = imageData.data[i + 1];
    out[i + 2] = imageData.data[i + 2];
    let a = imageData.data[i + 3];
    if (a < alphaThreshold) a = 0;
    if (!preserveSoftEdges && a > 0) {
      a = a > 140 ? clamp(a + 80 * hardenFactor) : clamp(a - 120 * hardenFactor);
      if (a < 50) a = 0;
      if (a > 215) a = 255;
    }
    out[i + 3] = a;
  }
  return createPixelBuffer(out, imageData.width, imageData.height);
}

export function posterizeImage(imageData: PixelBuffer, levels = 0): PixelBuffer {
  if (levels <= 1) return imageData;
  const out = new Uint8ClampedArray(imageData.data.length);
  const step = 255 / (levels - 1);
  for (let i = 0; i < imageData.data.length; i += 4) {
    out[i] = Math.round(imageData.data[i] / step) * step;
    out[i + 1] = Math.round(imageData.data[i + 1] / step) * step;
    out[i + 2] = Math.round(imageData.data[i + 2] / step) * step;
    out[i + 3] = imageData.data[i + 3];
  }
  return createPixelBuffer(out, imageData.width, imageData.height);
}

export interface HalftoneKnockoutOptions {
  enabled?: boolean;
  target?: "black" | "white" | "both";
  threshold?: number;
  softness?: number;
  strength?: number;
}

function resolveKnockoutAlphaFactor(
  luminance: number,
  options: HalftoneKnockoutOptions | undefined,
): number {
  if (!options?.enabled) return 1;

  const threshold = Math.max(0, Math.min(1, (options.threshold ?? 20) / 100));
  const softness = Math.max(0.005, (options.softness ?? 10) / 100);
  const strength = Math.max(0, Math.min(1, (options.strength ?? 85) / 100));
  const target = options.target ?? "black";

  const zoneStart = threshold - softness;
  const zoneEnd = threshold + softness;
  const blackFactor = luminance <= zoneStart
    ? (1 - strength)
    : luminance >= zoneEnd
      ? 1
      : (1 - strength) + ((luminance - zoneStart) / Math.max(0.001, zoneEnd - zoneStart)) * strength;
  const whiteFactor = luminance <= zoneStart
    ? 1
    : luminance >= zoneEnd
      ? (1 - strength)
      : 1 - ((luminance - zoneStart) / Math.max(0.001, zoneEnd - zoneStart)) * strength;

  if (target === "white") return Math.max(0, Math.min(1, whiteFactor));
  if (target === "both") return Math.max(0, Math.min(1, Math.min(blackFactor, whiteFactor)));
  return Math.max(0, Math.min(1, blackFactor));
}

export function applyHalftoneDots(
  imageData: PixelBuffer,
  cellSize = 6,
  strength = 60,
  knockoutOptions?: HalftoneKnockoutOptions,
): PixelBuffer {
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data);
  const alphaStrength = strength / 100;
  const safeCell = Math.max(1, Math.round(cellSize));

  for (let y = 0; y < height; y += safeCell) {
    for (let x = 0; x < width; x += safeCell) {
      let lumSum = 0;
      let count = 0;
      for (let yy = y; yy < Math.min(y + safeCell, height); yy++) {
        for (let xx = x; xx < Math.min(x + safeCell, width); xx++) {
          const idx = (yy * width + xx) * 4;
          const alpha = data[idx + 3] / 255;
          if (alpha <= 0.001) continue;
          const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          lumSum += lum * alpha;
          count += alpha;
        }
      }
      const avg = lumSum / Math.max(1, count);
      const minRadius = (safeCell / 2) * 0.08 * alphaStrength;
      const radius = Math.max(minRadius, ((255 - avg) / 255) * (safeCell / 2) * alphaStrength);
      const cx = x + safeCell / 2;
      const cy = y + safeCell / 2;

      for (let yy = y; yy < Math.min(y + safeCell, height); yy++) {
        for (let xx = x; xx < Math.min(x + safeCell, width); xx++) {
          const dx = xx + 0.5 - cx;
          const dy = yy + 0.5 - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const idx = (yy * width + xx) * 4;

          // Real halftone behavior: pixels outside the dot are fully cleared.
          if (dist > radius) {
            out[idx + 3] = 0;
            continue;
          }

          if (knockoutOptions?.enabled) {
            if (out[idx + 3] > 0) {
              const lum = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
              const alphaFactor = resolveKnockoutAlphaFactor(lum, knockoutOptions);
              out[idx + 3] = clamp(out[idx + 3] * alphaFactor);
            }
          }
        }
      }
    }
  }
  return createPixelBuffer(out, width, height);
}

export function removeBackgroundAdvanced(
  imageData: PixelBuffer,
  mode = "auto",
  strength = 60,
  feather = 10,
  whiteThreshold = 245,
  darkThreshold = 18
): PixelBuffer {
  const { width, height, data } = imageData;
  const out = new Uint8ClampedArray(data);
  const edgeSoftness = Math.max(0.01, feather / 100);

  // Average all border pixels (subsampled) to get a more stable background estimate.
  const bgAvg = { r: 0, g: 0, b: 0 };
  let bgCount = 0;
  const borderStep = Math.max(1, Math.round(Math.min(width, height) / 240));
  for (let x = 0; x < width; x += borderStep) {
    const topIdx = x * 4;
    const bottomIdx = ((height - 1) * width + x) * 4;
    bgAvg.r += data[topIdx] + data[bottomIdx];
    bgAvg.g += data[topIdx + 1] + data[bottomIdx + 1];
    bgAvg.b += data[topIdx + 2] + data[bottomIdx + 2];
    bgCount += 2;
  }
  for (let y = 1; y < height - 1; y += borderStep) {
    const leftIdx = (y * width) * 4;
    const rightIdx = (y * width + (width - 1)) * 4;
    bgAvg.r += data[leftIdx] + data[rightIdx];
    bgAvg.g += data[leftIdx + 1] + data[rightIdx + 1];
    bgAvg.b += data[leftIdx + 2] + data[rightIdx + 2];
    bgCount += 2;
  }
  bgAvg.r /= Math.max(1, bgCount);
  bgAvg.g /= Math.max(1, bgCount);
  bgAvg.b /= Math.max(1, bgCount);

  const strengthFactor = strength / 100;
  const edgeReach = Math.max(1, Math.min(width, height) * (0.14 + edgeSoftness * 0.55));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
    const rgb: RgbColor = { r: data[i], g: data[i + 1], b: data[i + 2] };
    const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    let removeScore = 0;
    const distFromBg = distanceRgb(rgb, bgAvg);

    const edgeDistance = Math.min(x, y, width - 1 - x, height - 1 - y);
    const edgeBias = Math.max(0, Math.min(1, 1 - (edgeDistance / edgeReach)));

    if (mode === "white") {
      const whiteScore = lum >= whiteThreshold ? 1 : Math.max(0, (lum - (whiteThreshold - 50)) / 50);
      removeScore = whiteScore * (0.55 + edgeBias * 0.45);
    } else if (mode === "dark") {
      const darkScore = lum <= darkThreshold ? 1 : Math.max(0, ((darkThreshold + 40) - lum) / 40);
      removeScore = darkScore * (0.55 + edgeBias * 0.45);
    } else if (mode === "logo") {
      removeScore = Math.max(0, 1 - distFromBg / 95) * (0.45 + edgeBias * 0.55);
      if (lum > 245) removeScore = Math.max(removeScore, 0.95);
    } else if (mode === "product") {
      removeScore = Math.max(0, 1 - distFromBg / 70) * (0.5 + edgeBias * 0.5);
    } else {
      const brightBoost = lum > 242 ? 0.35 : 0;
      removeScore = (Math.max(0, 1 - distFromBg / 80) + brightBoost) * (0.5 + edgeBias * 0.5);
      removeScore = Math.min(1, removeScore);
    }

    if (removeScore > 0.08) {
      const confidence = removeScore * removeScore;
      const alphaReduction = 255 * confidence * strengthFactor;
      let nextAlpha = clamp(data[i + 3] - alphaReduction);
      if (nextAlpha < 255 && nextAlpha > 0) {
        nextAlpha = clamp(nextAlpha * (1 - edgeSoftness * 0.35));
      }
      out[i + 3] = nextAlpha;
    }
    }
  }

  return createPixelBuffer(out, width, height);
}

export function vectorizePreview(
  imageData: PixelBuffer,
  palette: PaletteColor[],
  tolerance: number
): string {
  const data = imageData.data;
  const groups = new Map<string, Array<{ x: number; y: number; size: number }>>();
  const step = Math.max(2, Math.round(Math.min(imageData.width, imageData.height) / 180));
  for (let y = 0; y < imageData.height; y += step) {
    for (let x = 0; x < imageData.width; x += step) {
      const idx = (y * imageData.width + x) * 4;
      const a = data[idx + 3];
      if (a < 20) continue;
      const rgb: RgbColor = { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
      const nearest = nearestPaletteColor(rgb, palette);
      if (nearest.distance > tolerance) continue;
      const key = nearest.color.hex;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ x, y, size: step });
    }
  }

  const paths: string[] = [];
  groups.forEach((points, hex) => {
    points.slice(0, 250).forEach((p) => {
      paths.push(`<rect x="${p.x}" y="${p.y}" width="${p.size}" height="${p.size}" fill="${hex}" />`);
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${imageData.width} ${imageData.height}" width="${imageData.width}" height="${imageData.height}">${paths.join("")}</svg>`;
}


export interface RosettePreviewSettings {
  lpi: number;
  printerDpi: number;
  dotShape: string;
  channelAngles: { C: number; M: number; Y: number; K: number };
  enabled: boolean;
}

const CMYK_COLORS: Array<{
  channel: keyof RosettePreviewSettings["channelAngles"];
  r: number;
  g: number;
  b: number;
}> = [
  { channel: "C", r: 0, g: 188, b: 212 },
  { channel: "M", r: 233, g: 30, b: 99 },
  { channel: "Y", r: 255, g: 235, b: 59 },
  { channel: "K", r: 30, g: 30, b: 30 },
];

