import type { Point } from "../../core/export/cutlineSvg.js";

// Browser-only contour tracing for uploaded artwork: alpha-channel mask →
// dilation → marching-squares → RDP simplify → Chaikin smoothing. Ported from
// the host's proven die-cut pipeline; lives under react/ (not core/) because
// it needs canvas + Image. Returns points normalized to the artwork's own
// bounds ([0..1]×[0..1]) or null when the image has no usable alpha (JPEG,
// full-bleed PNG) — callers fall back to the placement-frame-only cutline.

export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
}

export interface TracedContours {
  outer: Point[];
  // Interior holes of the silhouette. When the design is cut through a
  // panel, the material enclosed by each hole becomes a free-falling island
  // unless the shop adds bridges — callers surface that as a warning.
  holes: Point[][];
}

export async function traceImageCutContour(
  url: string,
  samplePx = 480,
  offsetFrac = 0.01,
): Promise<TracedContours | null> {
  const img = await loadImageElement(url);
  return traceAlphaContours(img, samplePx, offsetFrac);
}

export function traceAlphaContour(
  img: HTMLImageElement,
  samplePx = 480,
  offsetFrac = 0.04,
): { points: Point[] } | null {
  const traced = traceAlphaContours(img, samplePx, offsetFrac);
  return traced ? { points: traced.outer } : null;
}

export function traceAlphaContours(
  img: HTMLImageElement,
  samplePx = 480,
  offsetFrac = 0.01,
): TracedContours | null {
  const aspect = img.naturalWidth / img.naturalHeight;
  const long = samplePx;
  const w = aspect >= 1 ? long : Math.max(8, Math.round(long * aspect));
  const h = aspect >= 1 ? Math.max(8, Math.round(long / aspect)) : long;
  const offsetPx = Math.max(1, Math.round(offsetFrac * Math.max(w, h)));
  const pad = offsetPx + 2;

  const cw = w + pad * 2;
  const ch = h + pad * 2;
  const cv = document.createElement("canvas");
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, pad, pad, w, h);
  const data = ctx.getImageData(0, 0, cw, ch).data;

  const mask = new Uint8Array(cw * ch);
  let any = false;
  let opaque = 0;
  for (let i = 0; i < cw * ch; i++) {
    if (data[i * 4 + 3] > 32) {
      mask[i] = 1;
      any = true;
      opaque++;
    }
  }
  if (!any) return null;
  // A near-full-bleed image (JPEG or borderless PNG) has no meaningful
  // silhouette — treat as untraceable so it stays an engrave reference.
  if (opaque > 0.98 * w * h) return null;

  const dilated = dilateMask(mask, cw, ch, offsetPx);
  const contour = marchingSquares(dilated, cw, ch);
  if (!contour || contour.length < 3) return null;

  const norm = (pts: Point[]) => pts.map((p) => ({ x: (p.x - pad) / w, y: (p.y - pad) / h }));
  const smooth = (pts: Point[]) => chaikin(rdpSimplify(pts, Math.max(1.2, long * 0.004)), 2);

  // Interior holes: background pixels not reachable from the canvas border.
  const holes: Point[][] = [];
  const exterior = floodExterior(dilated, cw, ch);
  const seen = new Uint8Array(cw * ch);
  const minHolePx = Math.max(9, Math.round((long * long) / 10000)); // ignore speck noise
  for (let y = 1; y < ch - 1; y++) {
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      if (dilated[i] || exterior[i] || seen[i]) continue;
      // Collect this hole component.
      const component: number[] = [];
      const holeMask = new Uint8Array(cw * ch);
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!;
        component.push(j);
        holeMask[j] = 1;
        const jx = j % cw;
        const jy = (j / cw) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = jx + dx;
          const ny = jy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const n = ny * cw + nx;
          if (!dilated[n] && !exterior[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      if (component.length < minHolePx) continue;
      const holeContour = marchingSquares(holeMask, cw, ch);
      if (holeContour && holeContour.length >= 3) {
        holes.push(norm(smooth(holeContour)));
      }
    }
  }

  return { outer: norm(smooth(contour)), holes };
}

// Marks every background pixel reachable from the canvas border (the true
// exterior); what remains unmarked and unmasked is an interior hole.
function floodExterior(mask: Uint8Array, w: number, h: number): Uint8Array {
  const exterior = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!mask[i] && !exterior[i]) {
      exterior[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return exterior;
}

function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      const enter = x + r;
      if (enter < w && mask[row + enter]) count++;
      const exit = x - r - 1;
      if (exit >= 0 && mask[row + exit]) count--;
      if (x >= 0) tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h; y++) {
      const enter = y + r;
      if (enter < h && tmp[enter * w + x]) count++;
      const exit = y - r - 1;
      if (exit >= 0 && tmp[exit * w + x]) count--;
      if (y >= 0) out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function marchingSquares(mask: Uint8Array, w: number, h: number): Point[] | null {
  const at = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0;
  let sx = -1;
  let sy = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y)) {
        sx = x;
        sy = y;
        break outer;
      }
    }
  }
  if (sx < 0) return null;

  // Moore-neighbour tracing
  const dirs = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const path: Point[] = [];
  let cx = sx;
  let cy = sy;
  let dir = 6;
  const maxSteps = w * h * 4;
  for (let step = 0; step < maxSteps; step++) {
    path.push({ x: cx, y: cy });
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (dir + 6 + i) % 8;
      const nx = cx + dirs[d][0];
      const ny = cy + dirs[d][1];
      if (at(nx, ny)) {
        cx = nx;
        cy = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy && path.length > 2) break;
  }
  return path;
}

function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const dmax = { dist: 0, idx: 0 };
  const [a, b] = [points[0], points[points.length - 1]];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > dmax.dist) {
      dmax.dist = d;
      dmax.idx = i;
    }
  }
  if (dmax.dist > epsilon) {
    const left = rdpSimplify(points.slice(0, dmax.idx + 1), epsilon);
    const right = rdpSimplify(points.slice(dmax.idx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [a, b];
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

function chaikin(points: Point[], iterations: number): Point[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const next: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
      next.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    pts = next;
  }
  return pts;
}
