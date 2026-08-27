import type { Point } from "../../core/export/cutlineSvg";

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

export async function traceImageCutContour(
  url: string,
  samplePx = 480,
  offsetFrac = 0.01,
): Promise<Point[] | null> {
  const img = await loadImageElement(url);
  const traced = traceAlphaContour(img, samplePx, offsetFrac);
  return traced?.points ?? null;
}

export function traceAlphaContour(
  img: HTMLImageElement,
  samplePx = 480,
  offsetFrac = 0.04,
): { points: Point[] } | null {
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

  const simplified = rdpSimplify(contour, Math.max(1.2, long * 0.004));
  const smoothed = chaikin(simplified, 2);
  const pts = smoothed.map((p) => ({ x: (p.x - pad) / w, y: (p.y - pad) / h }));
  return { points: pts };
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
