// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio's dtf-prep module without behavioural change.
// The intelligence layer had no DOM references, no ImageData, and no imports
// outside its own module — only the import paths changed.

import type { DtfDesign } from "./DtfDesign.js";
import type { DtfSheet } from "./DtfSheet.js";

interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Candidate {
  x: number;
  y: number;
}

interface GroupLayoutItem {
  design: DtfDesign;
  rotation: 0 | 90;
  width: number;
  height: number;
}

interface GroupLayout {
  width: number;
  height: number;
  items: Array<GroupLayoutItem & { offsetX: number; offsetY: number }>;
}

function orientedSize(design: DtfDesign): { width: number; height: number } {
  return design.rotation === 90
    ? { width: design.heightIn, height: design.widthIn }
    : { width: design.widthIn, height: design.heightIn };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function toRect(x: number, y: number, width: number, height: number, spacing: number): Rect {
  return {
    x1: x - spacing / 2,
    y1: y - spacing / 2,
    x2: x + width + spacing / 2,
    y2: y + height + spacing / 2,
  };
}

function buildGroupLayouts(groups: DtfDesign[][], spacing: number): Map<string, GroupLayout> {
  const layoutMap = new Map<string, GroupLayout>();
  for (const group of groups) {
    const key = group.map((design) => design.id).sort().join("|");
    const sorted = [...group].sort((a, b) => b.widthIn * b.heightIn - a.widthIn * a.heightIn);
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    const maxRowWidth = Math.max(
      1,
      Math.sqrt(sorted.reduce((sum, design) => sum + design.widthIn * design.heightIn, 0)) * 1.3,
    );
    const items: GroupLayout["items"] = [];
    let maxX = 0;
    let maxY = 0;

    for (const design of sorted) {
      const base = orientedSize(design);
      const allowRotate = !design.rotationSensitive;
      const options: Array<{ rotation: 0 | 90; width: number; height: number }> = [
        { rotation: design.rotation, width: base.width, height: base.height },
      ];
      if (allowRotate) {
        options.push({ rotation: design.rotation === 0 ? 90 : 0, width: base.height, height: base.width });
      }
      options.sort((a, b) => (a.height - b.height) || (a.width - b.width));
      const picked = options[0];

      if (cursorX > 0 && cursorX + picked.width > maxRowWidth) {
        cursorX = 0;
        cursorY += rowHeight + spacing;
        rowHeight = 0;
      }

      items.push({
        design,
        rotation: picked.rotation,
        width: picked.width,
        height: picked.height,
        offsetX: cursorX,
        offsetY: cursorY,
      });

      cursorX += picked.width + spacing;
      rowHeight = Math.max(rowHeight, picked.height);
      maxX = Math.max(maxX, cursorX - spacing);
      maxY = Math.max(maxY, cursorY + picked.height);
    }

    layoutMap.set(key, {
      width: maxX,
      height: maxY,
      items,
    });
  }
  return layoutMap;
}

function groupDesigns(designs: DtfDesign[]): DtfDesign[][] {
  const map = new Map<string, DtfDesign[]>();
  for (const design of designs) {
    const key = design.groupId ?? design.setId ?? `single:${design.id}`;
    const list = map.get(key) ?? [];
    list.push(design);
    map.set(key, list);
  }
  return Array.from(map.values());
}

function candidatePoints(occupied: Rect[], minX: number, minY: number): Candidate[] {
  const points: Candidate[] = [{ x: minX, y: minY }];
  for (const rect of occupied) {
    points.push({ x: rect.x2, y: rect.y1 });
    points.push({ x: rect.x1, y: rect.y2 });
  }
  return points;
}

function scorePlacement(x: number, y: number, width: number, height: number, densityMode: boolean): number {
  const footprint = (x + width) * 1.4 + (y + height) * 2.2;
  if (!densityMode) {
    return footprint;
  }
  const compactness = Math.abs(width - height) * 0.2;
  return footprint - width * height * 0.01 + compactness;
}

export function autoArrangeDesigns(sheet: DtfSheet, designs: DtfDesign[]): DtfDesign[] {
  const spacing = sheet.spacingIn;
  const margin = Math.max(0, sheet.cutSafeMarginIn ?? 0);
  const maxX = sheet.widthIn - margin;
  const maxY = sheet.heightIn - margin;
  const minX = margin;
  const minY = margin;

  const locked = designs.filter((design) => design.locked);
  const unlocked = designs.filter((design) => !design.locked);
  const occupied: Rect[] = locked.map((design) => {
    const size = orientedSize(design);
    return toRect(design.xIn, design.yIn, size.width, size.height, spacing);
  });

  const groups = groupDesigns(unlocked).sort(
    (a, b) =>
      b.reduce((sum, design) => sum + design.widthIn * design.heightIn, 0) -
      a.reduce((sum, design) => sum + design.widthIn * design.heightIn, 0),
  );
  const densityMode = (sheet.layoutMode ?? "balanced") === "density";
  const groupLayouts = buildGroupLayouts(groups, spacing);
  const placedById = new Map<string, DtfDesign>();

  for (const group of groups) {
    const key = group.map((design) => design.id).sort().join("|");
    const layout = groupLayouts.get(key);
    if (!layout) continue;

    let best: { x: number; y: number; score: number } | null = null;
    for (const candidate of candidatePoints(occupied, minX, minY)) {
      const x = candidate.x;
      const y = candidate.y;
      const groupRect = toRect(x, y, layout.width, layout.height, spacing);
      if (groupRect.x1 < minX || groupRect.y1 < minY || groupRect.x2 > maxX || groupRect.y2 > maxY) {
        continue;
      }
      if (occupied.some((rect) => intersects(groupRect, rect))) {
        continue;
      }
      const score = scorePlacement(x, y, layout.width, layout.height, densityMode);
      if (!best || score < best.score) {
        best = { x, y, score };
      }
    }

    if (!best) {
      // Keep original position if no valid placement exists.
      for (const design of group) {
        placedById.set(design.id, design);
      }
      continue;
    }

    const groupRect = toRect(best.x, best.y, layout.width, layout.height, spacing);
    occupied.push(groupRect);
    for (const item of layout.items) {
      placedById.set(item.design.id, {
        ...item.design,
        xIn: Number((best.x + item.offsetX).toFixed(3)),
        yIn: Number((best.y + item.offsetY).toFixed(3)),
        rotation: item.rotation,
      });
    }
  }

  return designs.map((design) => placedById.get(design.id) ?? design);
}
