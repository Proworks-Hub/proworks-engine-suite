// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { Point } from "./cutlineSvg.js";

// Bridge (tab) generation for cut-through geometry.
//
// A closed cut path that encloses material leaves that material unsupported —
// it drops out of the panel. Shops solve this by leaving small uncut spans
// ("bridges" / "tabs") at intervals around the path. This module takes a
// closed polygon in INCH space and returns the open polylines that remain
// once bridges are removed, so the emitted SVG cuts everything except the
// tabs.
//
// Pure geometry: no DOM, no canvas.

export interface BridgeOptions {
  // Uncut span length, in inches. Typical: 0.08–0.15" for 1/8" steel.
  bridgeWidthIn: number;
  // Target number of bridges. The real count adapts to perimeter so tiny
  // shapes are not chopped to pieces and large ones get enough support.
  count?: number;
  // Never bridge a path shorter than this — below it the enclosed piece is
  // small enough that a single tab would dominate the outline.
  minPerimeterIn?: number;
}

function perimeterOf(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

// How many tabs a path of this size wants: one per ~2.5" of perimeter,
// clamped to [2, 8]. Two is the practical minimum for a piece to stay put.
export function suggestBridgeCount(perimeterIn: number): number {
  return Math.max(2, Math.min(8, Math.round(perimeterIn / 2.5)));
}

/**
 * Splits a closed polygon into the open polylines that remain after removing
 * evenly spaced bridge spans. Returns the original closed ring (as a single
 * polyline whose last point repeats the first) when bridging does not apply.
 */
export function bridgeClosedPath(points: Point[], opts: BridgeOptions): Point[][] {
  if (points.length < 3) return [points];
  const perimeter = perimeterOf(points);
  const minPerimeter = opts.minPerimeterIn ?? 0.75;
  const count = opts.count ?? suggestBridgeCount(perimeter);

  // Too small to bridge, or the tabs would consume most of the outline —
  // emit the closed ring untouched and let the operator decide.
  if (perimeter < minPerimeter || opts.bridgeWidthIn * count > perimeter * 0.5) {
    return [[...points, points[0]]];
  }

  // Walk the ring accumulating arc length, cutting everywhere except inside
  // a bridge span.
  const spacing = perimeter / count;
  const half = opts.bridgeWidthIn / 2;
  const inBridge = (distance: number) => {
    const offset = ((distance % spacing) + spacing) % spacing;
    return offset < half || offset > spacing - half;
  };

  const segments: Point[][] = [];
  let current: Point[] = [];
  let travelled = 0;

  const pointAt = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const edgeLength = Math.hypot(b.x - a.x, b.y - a.y);
    if (edgeLength === 0) continue;

    // Sample each edge finely enough that bridge boundaries land accurately
    // without inflating the path with needless vertices.
    const steps = Math.max(1, Math.ceil(edgeLength / Math.max(half / 2, 0.01)));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const mid = travelled + edgeLength * ((t0 + t1) / 2);
      const p0 = pointAt(a, b, t0);
      const p1 = pointAt(a, b, t1);
      if (inBridge(mid)) {
        // Inside a tab: close off whatever run we were cutting.
        if (current.length > 1) segments.push(current);
        current = [];
      } else {
        if (current.length === 0) current.push(p0);
        current.push(p1);
      }
    }
    travelled += edgeLength;
  }
  if (current.length > 1) segments.push(current);

  // Degenerate result (everything landed inside tabs) — fall back to a full
  // cut rather than emitting nothing.
  if (segments.length === 0) return [[...points, points[0]]];
  return segments;
}
