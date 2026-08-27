// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import { createPixelBuffer, type PixelBuffer } from "../core/pixelBuffer.js";
import type { VectorSettings } from "../core/prepSettings.js";

export type VectorPrepMode =
  | "balanced"
  | "text_logo"
  | "line_art"
  | "stencil"
  | "laser_safe"
  | "color_regions";

export type FillInterpretation = "fill" | "outline" | "hybrid";

export interface VectorSuitabilityReport {
  confidenceScore: number;
  likelySuitable: boolean;
  likelyManualRebuild: boolean;
  category: "logo_text" | "line_art" | "engraving_friendly" | "photo_heavy" | "noisy_compressed" | "mixed";
  warnings: string[];
  notes: string[];
}

export interface VectorGeneratedMetadata {
  width: number;
  height: number;
  pathCountEstimate: number;
  nodeDensity: number;
  tinyIslandCount: number;
  openPathRisk: number;
  selfIntersectionRisk: number;
  contourOnly: boolean;
  layered: boolean;
  machineContext: string;
}

export interface VectorPrepSettings {
  enabled: boolean;
  simplification: number;
  shapeThreshold: number;
  cornerCleanup: number;
  retainSmallDetails: boolean;
  threshold: number;
  edgeSensitivity: number;
  pathSmoothing: number;
  nodeReduction: number;
  curveFitting: number;
  minimumShapeSize: number;
  removeSpecks: boolean;
  mergeNearbyShapes: boolean;
  preserveHoles: boolean;
  fillInterpretation: FillInterpretation;
  mode: VectorPrepMode;
  stencilSafe: boolean;
  lineArtMode: boolean;
  laserSafeCleanup: boolean;
  colorRegionTracing: boolean;
  multiColorLayers: boolean;
  contourOnlyExport: boolean;
  problemAreaPreviewEnabled: boolean;
  manualRebuildFlag: boolean;
}

export interface VectorPrepState {
  settings: VectorPrepSettings;
  suitability: VectorSuitabilityReport;
  generatedVectorMetadata: VectorGeneratedMetadata | null;
  warnings: string[];
}

export interface VectorPreviewResult {
  vectorized: PixelBuffer;
  nodeDensityMask: Uint8ClampedArray;
  problemMask: Uint8ClampedArray;
  cornerMask: Uint8ClampedArray;
  openPathMask: Uint8ClampedArray;
  contourMask: Uint8ClampedArray;
  fillMask: Uint8ClampedArray;
  suitability: VectorSuitabilityReport;
  metadata: VectorGeneratedMetadata;
}

const BASE_SETTINGS: VectorPrepSettings = {
  enabled: false,
  simplification: 52,
  shapeThreshold: 50,
  cornerCleanup: 45,
  retainSmallDetails: true,
  threshold: 128,
  edgeSensitivity: 55,
  pathSmoothing: 42,
  nodeReduction: 48,
  curveFitting: 50,
  minimumShapeSize: 4,
  removeSpecks: true,
  mergeNearbyShapes: true,
  preserveHoles: true,
  fillInterpretation: "hybrid",
  mode: "balanced",
  stencilSafe: false,
  lineArtMode: false,
  laserSafeCleanup: false,
  colorRegionTracing: false,
  multiColorLayers: false,
  contourOnlyExport: false,
  problemAreaPreviewEnabled: false,
  manualRebuildFlag: false,
};

const DEFAULT_REPORT: VectorSuitabilityReport = {
  confidenceScore: 50,
  likelySuitable: false,
  likelyManualRebuild: true,
  category: "mixed",
  warnings: [],
  notes: ["Run Analyze Vector Suitability to evaluate this artwork."],
};

export function resolveVectorDefaultsForPreset(preset: string | undefined | null): VectorPrepSettings {
  const key = String(preset ?? "DTF").toUpperCase();

  if (key === "LASER_ENGRAVING") {
    return {
      ...BASE_SETTINGS,
      enabled: true,
      simplification: 64,
      shapeThreshold: 62,
      threshold: 142,
      cornerCleanup: 62,
      edgeSensitivity: 70,
      pathSmoothing: 58,
      nodeReduction: 64,
      curveFitting: 60,
      minimumShapeSize: 6,
      removeSpecks: true,
      mergeNearbyShapes: true,
      preserveHoles: true,
      mode: "laser_safe",
      lineArtMode: true,
      laserSafeCleanup: true,
      contourOnlyExport: true,
    };
  }

  if (key === "STICKER_VINYL") {
    return {
      ...BASE_SETTINGS,
      enabled: true,
      simplification: 60,
      shapeThreshold: 58,
      threshold: 136,
      cornerCleanup: 56,
      edgeSensitivity: 60,
      pathSmoothing: 55,
      nodeReduction: 58,
      curveFitting: 60,
      minimumShapeSize: 5,
      removeSpecks: true,
      mergeNearbyShapes: true,
      preserveHoles: true,
      mode: "line_art",
      contourOnlyExport: true,
    };
  }

  if (key === "UV" || key === "UVDTF") {
    return {
      ...BASE_SETTINGS,
      enabled: true,
      simplification: 55,
      shapeThreshold: 54,
      threshold: 132,
      cornerCleanup: 50,
      edgeSensitivity: 58,
      pathSmoothing: 50,
      nodeReduction: 52,
      curveFitting: 56,
      minimumShapeSize: 4,
      removeSpecks: true,
      mergeNearbyShapes: true,
      preserveHoles: true,
      mode: "text_logo",
      colorRegionTracing: true,
      multiColorLayers: true,
    };
  }

  return {
    ...BASE_SETTINGS,
    enabled: false,
  };
}

export function normalizeVectorPrepSettings(
  input: Partial<VectorPrepSettings> | undefined,
  preset: string | undefined | null,
): VectorPrepSettings {
  const base = resolveVectorDefaultsForPreset(preset);
  const next = {
    ...base,
    ...(input ?? {}),
  };

  return {
    ...next,
    enabled: Boolean(next.enabled),
    simplification: clamp(next.simplification, 0, 100),
    shapeThreshold: clamp(next.shapeThreshold, 0, 100),
    cornerCleanup: clamp(next.cornerCleanup, 0, 100),
    retainSmallDetails: Boolean(next.retainSmallDetails),
    threshold: clamp(next.threshold, 0, 255),
    edgeSensitivity: clamp(next.edgeSensitivity, 0, 100),
    pathSmoothing: clamp(next.pathSmoothing, 0, 100),
    nodeReduction: clamp(next.nodeReduction, 0, 100),
    curveFitting: clamp(next.curveFitting, 0, 100),
    minimumShapeSize: clamp(next.minimumShapeSize, 0, 50),
    removeSpecks: Boolean(next.removeSpecks),
    mergeNearbyShapes: Boolean(next.mergeNearbyShapes),
    preserveHoles: Boolean(next.preserveHoles),
    fillInterpretation: normalizeFillInterpretation(next.fillInterpretation),
    mode: normalizeMode(next.mode),
    stencilSafe: Boolean(next.stencilSafe),
    lineArtMode: Boolean(next.lineArtMode),
    laserSafeCleanup: Boolean(next.laserSafeCleanup),
    colorRegionTracing: Boolean(next.colorRegionTracing),
    multiColorLayers: Boolean(next.multiColorLayers),
    contourOnlyExport: Boolean(next.contourOnlyExport),
    problemAreaPreviewEnabled: Boolean(next.problemAreaPreviewEnabled),
    manualRebuildFlag: Boolean(next.manualRebuildFlag),
  };
}

export function mergeVectorPrepState(
  preset: string | undefined | null,
  vectorSettings: VectorSettings | undefined,
  metadataState: Partial<VectorPrepState> | undefined,
): VectorPrepState {
  const settings = normalizeVectorPrepSettings(
    {
      enabled: Boolean(vectorSettings?.enabled),
      simplification: vectorSettings?.flatColorSimplification,
      shapeThreshold: vectorSettings?.shapeThreshold,
      cornerCleanup: (vectorSettings?.cornerCleanup ?? true) ? 65 : 20,
      retainSmallDetails: vectorSettings?.retainSmallDetails,
      ...(metadataState?.settings ?? {}),
    },
    preset,
  );

  return {
    settings,
    suitability: metadataState?.suitability ?? DEFAULT_REPORT,
    generatedVectorMetadata: metadataState?.generatedVectorMetadata ?? null,
    warnings: Array.isArray(metadataState?.warnings)
      ? metadataState!.warnings!.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function buildCoreVectorSettings(settings: VectorPrepSettings): VectorSettings {
  return {
    enabled: settings.enabled,
    flatColorSimplification: settings.simplification,
    shapeThreshold: settings.shapeThreshold,
    cornerCleanup: settings.cornerCleanup >= 40,
    retainSmallDetails: settings.retainSmallDetails,
  };
}

export function analyzeVectorSuitability(
  imageData: PixelBuffer,
  settings: VectorPrepSettings,
  machinePreset: string | undefined | null,
): VectorSuitabilityReport {
  const stats = computeImageStats(imageData);
  const warnings: string[] = [];
  const notes: string[] = [];

  let score = 100;

  if (stats.gradientRatio > 0.45) {
    warnings.push("Artwork appears gradient-heavy and may trace poorly.");
    score -= 24;
  }

  if (stats.noiseRatio > 0.24) {
    warnings.push("High noise/compression artifacts detected.");
    score -= 20;
  }

  if (stats.tinyDetailRatio > 0.16 && !settings.retainSmallDetails) {
    warnings.push("Fine details are present and may be lost with current settings.");
    score -= 12;
  }

  if (stats.flatColorRatio > 0.58) {
    notes.push("Flat-color regions are strong; vector generation is likely viable.");
    score += 8;
  }

  if (stats.edgeDensity < 0.02) {
    warnings.push("Low edge definition detected; contours may be weak.");
    score -= 14;
  }

  const machine = String(machinePreset ?? "").toUpperCase();
  if (machine === "LASER_ENGRAVING") {
    if (stats.edgeDensity > 0.03) notes.push("Laser workflow context: contour readability is acceptable.");
    if (stats.gradientRatio > 0.35) {
      warnings.push("Laser workflow warning: gradients should be simplified before cut/engrave vector output.");
      score -= 8;
    }
  }

  if (settings.mode === "text_logo" && stats.flatColorRatio > 0.62) score += 6;
  if (settings.mode === "laser_safe" && stats.edgeDensity > 0.028) score += 6;

  score = clamp(score, 0, 100);

  const category = resolveCategory(stats, score);
  const likelySuitable = score >= 62 && category !== "photo_heavy";
  const likelyManualRebuild = score < 45 || category === "photo_heavy" || category === "noisy_compressed";

  if (likelyManualRebuild) {
    notes.push("Manual vector rebuild is recommended for production safety.");
  }

  if (warnings.length === 0) {
    notes.push("No major blockers detected for automatic vector generation.");
  }

  return {
    confidenceScore: score,
    likelySuitable,
    likelyManualRebuild,
    category,
    warnings,
    notes,
  };
}

export function shouldFlagManualRebuild(report: VectorSuitabilityReport): boolean {
  return report.likelyManualRebuild || report.confidenceScore < 45;
}

export function generateVectorPreview(
  imageData: PixelBuffer,
  settings: VectorPrepSettings,
  machinePreset: string | undefined | null,
): VectorPreviewResult {
  const width = imageData.width;
  const height = imageData.height;
  const pxCount = width * height;
  const binary = new Uint8ClampedArray(pxCount);
  const nodeDensityMask = new Uint8ClampedArray(pxCount);
  const problemMask = new Uint8ClampedArray(pxCount);
  const cornerMask = new Uint8ClampedArray(pxCount);
  const openPathMask = new Uint8ClampedArray(pxCount);
  const contourMask = new Uint8ClampedArray(pxCount);
  const fillMask = new Uint8ClampedArray(pxCount);

  const source = imageData.data;
  const threshold = clamp(settings.threshold + (settings.shapeThreshold - 50), 0, 255);

  for (let i = 0; i < source.length; i += 4) {
    const a = source[i + 3];
    if (a < 8) continue;
    const lum = 0.299 * source[i] + 0.587 * source[i + 1] + 0.114 * source[i + 2];
    binary[i / 4] = lum < threshold ? 255 : 0;
  }

  if (settings.removeSpecks || settings.minimumShapeSize > 0) {
    removeTinyIslands(binary, width, height, Math.max(1, settings.minimumShapeSize));
  }

  const edgeThreshold = 28 + settings.edgeSensitivity * 1.4;
  let nodeAccumulator = 0;
  let cornerAccumulator = 0;
  let openRiskAccumulator = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const current = binary[idx];
      const n = binary[idx - width];
      const s = binary[idx + width];
      const w = binary[idx - 1];
      const e = binary[idx + 1];

      const transitions = Number(current !== n) + Number(current !== s) + Number(current !== w) + Number(current !== e);
      if (transitions >= 2) contourMask[idx] = 255;
      if (current > 0) fillMask[idx] = 255;

      const cornerScore = Math.abs(n - s) + Math.abs(e - w);
      if (cornerScore > edgeThreshold * (1.2 - settings.cornerCleanup / 200)) {
        cornerMask[idx] = 255;
        cornerAccumulator += 1;
      }

      const localNode = transitions >= 3 ? 255 : 0;
      nodeDensityMask[idx] = localNode;
      if (localNode > 0) nodeAccumulator += 1;

      const openRisk = transitions === 1 && current > 0;
      if (openRisk) {
        openPathMask[idx] = 255;
        openRiskAccumulator += 1;
      }

      const tinyFragile = current > 0 && transitions >= 3 && settings.laserSafeCleanup;
      if (tinyFragile) problemMask[idx] = 255;
    }
  }

  if (settings.mergeNearbyShapes) {
    dilate(binary, width, height, clamp(Math.round(settings.pathSmoothing / 35), 0, 3));
  }

  if (!settings.preserveHoles) {
    fillTinyHoles(binary, width, height, Math.max(1, settings.minimumShapeSize));
  }

  const vectorizedPixels = new Uint8ClampedArray(source.length);
  for (let i = 0; i < pxCount; i += 1) {
    const value = binary[i];
    const p = i * 4;
    if (settings.fillInterpretation === "outline") {
      const line = contourMask[i] > 0 ? 255 : 0;
      vectorizedPixels[p] = line;
      vectorizedPixels[p + 1] = line;
      vectorizedPixels[p + 2] = line;
      vectorizedPixels[p + 3] = line;
    } else if (settings.fillInterpretation === "fill") {
      vectorizedPixels[p] = value;
      vectorizedPixels[p + 1] = value;
      vectorizedPixels[p + 2] = value;
      vectorizedPixels[p + 3] = value > 0 ? 255 : 0;
    } else {
      const mix = value > 0 ? 220 : contourMask[i] > 0 ? 120 : 0;
      vectorizedPixels[p] = mix;
      vectorizedPixels[p + 1] = mix;
      vectorizedPixels[p + 2] = mix;
      vectorizedPixels[p + 3] = mix > 0 ? 255 : 0;
    }
  }

  const suitability = analyzeVectorSuitability(imageData, settings, machinePreset);
  const tinyIslandCount = countTinyComponents(binary, width, height, Math.max(1, settings.minimumShapeSize));
  const nodeDensity = clamp(Math.round((nodeAccumulator / Math.max(1, pxCount)) * 1000), 0, 1000);
  const openPathRisk = clamp(Math.round((openRiskAccumulator / Math.max(1, pxCount)) * 1000), 0, 1000);
  const selfIntersectionRisk = clamp(Math.round((cornerAccumulator / Math.max(1, pxCount)) * 1000), 0, 1000);

  const metadata: VectorGeneratedMetadata = {
    width,
    height,
    pathCountEstimate: clamp(Math.round((nodeAccumulator + openRiskAccumulator) / 12), 1, 99999),
    nodeDensity,
    tinyIslandCount,
    openPathRisk,
    selfIntersectionRisk,
    contourOnly: settings.contourOnlyExport,
    layered: settings.multiColorLayers,
    machineContext: String(machinePreset ?? "Unknown"),
  };

  return {
    vectorized: createPixelBuffer(vectorizedPixels, width, height),
    nodeDensityMask,
    problemMask,
    cornerMask,
    openPathMask,
    contourMask,
    fillMask,
    suitability,
    metadata,
  };
}

export function buildSvgFromPreview(
  preview: VectorPreviewResult,
  settings: VectorPrepSettings,
): string {
  const mask = settings.contourOnlyExport ? preview.contourMask : preview.fillMask;
  const width = preview.metadata.width;
  const height = preview.metadata.height;
  const paths: string[] = [];

  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      const idx = y * width + x;
      if (mask[idx] < 128) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < width && mask[y * width + x + run] >= 128) run += 1;
      if (run >= Math.max(1, settings.minimumShapeSize)) {
        paths.push(`<rect x="${x}" y="${y}" width="${run}" height="1" />`);
      }
      x += run;
    }
  }

  const layerAttr = settings.multiColorLayers ? " data-layered=\"true\"" : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"${layerAttr}><g fill="#000">${paths.join("")}</g></svg>`;
}

function computeImageStats(imageData: PixelBuffer): {
  flatColorRatio: number;
  gradientRatio: number;
  noiseRatio: number;
  tinyDetailRatio: number;
  edgeDensity: number;
} {
  const { data, width, height } = imageData;
  let flat = 0;
  let gradients = 0;
  let noise = 0;
  let tinyDetails = 0;
  let edges = 0;

  const total = Math.max(1, width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a < 6) continue;

      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const right = idx + 4;
      const down = idx + width * 4;
      const lumRight = 0.299 * data[right] + 0.587 * data[right + 1] + 0.114 * data[right + 2];
      const lumDown = 0.299 * data[down] + 0.587 * data[down + 1] + 0.114 * data[down + 2];

      const d1 = Math.abs(lum - lumRight);
      const d2 = Math.abs(lum - lumDown);
      const edge = d1 + d2;

      if (edge < 4) flat += 1;
      if (edge >= 4 && edge < 16) gradients += 1;
      if (edge > 45) edges += 1;
      if (edge > 10 && edge < 24) tinyDetails += 1;

      const neighbors = [idx - 4, idx + 4, idx - width * 4, idx + width * 4];
      let variance = 0;
      for (const n of neighbors) {
        const nl = 0.299 * data[n] + 0.587 * data[n + 1] + 0.114 * data[n + 2];
        variance += Math.abs(lum - nl);
      }
      if (variance > 60 && edge < 18) noise += 1;
    }
  }

  return {
    flatColorRatio: flat / total,
    gradientRatio: gradients / total,
    noiseRatio: noise / total,
    tinyDetailRatio: tinyDetails / total,
    edgeDensity: edges / total,
  };
}

function resolveCategory(
  stats: { flatColorRatio: number; gradientRatio: number; noiseRatio: number; tinyDetailRatio: number; edgeDensity: number },
  score: number,
): VectorSuitabilityReport["category"] {
  if (stats.gradientRatio > 0.46 && stats.flatColorRatio < 0.36) return "photo_heavy";
  if (stats.noiseRatio > 0.24) return "noisy_compressed";
  if (stats.flatColorRatio > 0.6 && stats.edgeDensity > 0.018) return "logo_text";
  if (stats.edgeDensity > 0.03 && stats.gradientRatio < 0.3) return "line_art";
  if (score >= 68 && stats.gradientRatio < 0.28) return "engraving_friendly";
  return "mixed";
}

function normalizeMode(mode: VectorPrepMode | undefined): VectorPrepMode {
  if (mode === "text_logo" || mode === "line_art" || mode === "stencil" || mode === "laser_safe" || mode === "color_regions") {
    return mode;
  }
  return "balanced";
}

function normalizeFillInterpretation(mode: FillInterpretation | undefined): FillInterpretation {
  if (mode === "fill" || mode === "outline") return mode;
  return "hybrid";
}

function removeTinyIslands(mask: Uint8ClampedArray, width: number, height: number, minSize: number): void {
  if (minSize <= 1) return;
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];

  for (let i = 0; i < mask.length; i += 1) {
    if (visited[i] || mask[i] < 128) continue;

    const component: number[] = [];
    visited[i] = 1;
    stack.push(i);

    while (stack.length) {
      const idx = stack.pop()!;
      component.push(idx);
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || mask[next] < 128) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }

    if (component.length < minSize) {
      for (const idx of component) mask[idx] = 0;
    }
  }
}

function countTinyComponents(mask: Uint8ClampedArray, width: number, height: number, minSize: number): number {
  if (minSize <= 1) return 0;
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];
  let tiny = 0;

  for (let i = 0; i < mask.length; i += 1) {
    if (visited[i] || mask[i] < 128) continue;

    let count = 0;
    visited[i] = 1;
    stack.push(i);

    while (stack.length) {
      const idx = stack.pop()!;
      count += 1;
      const x = idx % width;
      const y = Math.floor(idx / width);
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || mask[next] < 128) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }

    if (count < minSize) tiny += 1;
  }

  return tiny;
}

function fillTinyHoles(mask: Uint8ClampedArray, width: number, height: number, holeSize: number): void {
  if (holeSize <= 1) return;
  const inverted = new Uint8ClampedArray(mask.length);
  for (let i = 0; i < mask.length; i += 1) inverted[i] = mask[i] > 0 ? 0 : 255;

  removeTinyIslands(inverted, width, height, holeSize);

  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = inverted[i] > 0 ? 0 : 255;
  }
}

function dilate(mask: Uint8ClampedArray, width: number, height: number, iterations: number): void {
  if (iterations <= 0) return;
  for (let step = 0; step < iterations; step += 1) {
    const source = new Uint8ClampedArray(mask);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        if (source[idx] > 0) continue;
        const neighbors = [idx - 1, idx + 1, idx - width, idx + width];
        if (neighbors.some((n) => source[n] > 0)) mask[idx] = 255;
      }
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
