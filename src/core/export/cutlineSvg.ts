import type { SurfaceElement } from "../schemas/configuration";

// Per-panel production cutline SVG, in real inches, following the LightBurn
// color convention used across the shop:
//   #FF00FF hairline = cut through
//   #00B050          = engrave (raster placement reference)
// Text is emitted as <text> (convert to paths in LightBurn — the job manifest
// header says so); uploaded raster art gets a placement frame + embedded
// image for operator reference. True raster→vector contour tracing arrives
// with the full production-file phase.

export type Point = { x: number; y: number };

export interface CutlineSvgInput {
  productSlug: string;
  panelId: string;
  panelName: string;
  widthIn: number;
  heightIn: number;
  elements: SurfaceElement[];
  materialLabel?: string;
  machineLabel?: string;
  // Traced silhouettes for image elements, keyed by element id. Points are
  // normalized to the artwork's own bounds ([0..1]×[0..1]); the builder
  // scales them to the element's placed size and position. An image with a
  // contour becomes a CUT (through-hole); without one it stays an engrave
  // placement reference. Kept as data so this module stays DOM-free.
  cutContours?: Record<string, Point[]>;
}

const CUT = "#FF00FF";
const ENGRAVE = "#00B050";
const HAIRLINE = 0.01; // inches

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPanelCutlineSvg(input: CutlineSvgInput): string {
  const { widthIn: w, heightIn: h } = input;
  const parts: string[] = [];

  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!-- ForgeIQ production cutline -->`,
    `<!-- Product: ${esc(input.productSlug)} | Panel: ${esc(input.panelName)} (${w}" x ${h}") -->`,
    input.materialLabel ? `<!-- Material: ${esc(input.materialLabel)} -->` : "",
    input.machineLabel ? `<!-- Machine: ${esc(input.machineLabel)} -->` : "",
    `<!-- Colors: ${CUT} hairline = CUT THROUGH, ${ENGRAVE} = engrave/reference -->`,
    `<!-- NOTE: convert text objects to paths before cutting -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}in" height="${h}in" viewBox="0 0 ${w} ${h}">`,
    // Panel outline — the blank itself is cut to size.
    `  <g id="panel-outline">`,
    `    <rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${CUT}" stroke-width="${HAIRLINE}"/>`,
    `  </g>`,
  );

  const cutTexts: string[] = [];
  const cutContourPaths: string[] = [];
  const engraveImages: string[] = [];

  for (const el of input.elements) {
    if (el.type === "text") {
      // Approximate em size from cap height (cap ≈ 70% of em for most faces).
      const fontSize = el.heightIn / 0.7;
      const estWidth = el.text.length * el.heightIn * 0.6;
      const cx = el.xIn + estWidth / 2;
      const cy = el.yIn + el.heightIn / 2;
      const transform =
        el.rotationDeg !== 0 ? ` transform="rotate(${el.rotationDeg} ${cx} ${cy})"` : "";
      cutTexts.push(
        `    <text x="${el.xIn}" y="${el.yIn + el.heightIn}" font-family="${esc(el.fontFamily)}" font-size="${fontSize}" fill="none" stroke="${CUT}" stroke-width="${HAIRLINE}"${transform}>${esc(el.text)}</text>`,
      );
    } else {
      const cx = el.xIn + el.widthIn / 2;
      const cy = el.yIn + el.heightIn / 2;
      const transform =
        el.rotationDeg !== 0 ? ` transform="rotate(${el.rotationDeg} ${cx} ${cy})"` : "";
      const contour = input.cutContours?.[el.id];
      if (contour && contour.length >= 3) {
        // Scale the normalized silhouette to the placed element and cut it
        // through the panel.
        const d =
          contour
            .map(
              (p, i) =>
                `${i === 0 ? "M" : "L"}${(el.xIn + p.x * el.widthIn).toFixed(4)},${(el.yIn + p.y * el.heightIn).toFixed(4)}`,
            )
            .join(" ") + " Z";
        cutContourPaths.push(
          `    <g${transform}>`,
          `      <path d="${d}" fill="none" stroke="${CUT}" stroke-width="${HAIRLINE}"/>`,
          `    </g>`,
        );
        // Keep the artwork as an operator reference underneath the cut.
        engraveImages.push(
          `    <g${transform}>`,
          `      <image xlink:href="${esc(el.url)}" x="${el.xIn}" y="${el.yIn}" width="${el.widthIn}" height="${el.heightIn}" preserveAspectRatio="none" opacity="0.5"/>`,
          `    </g>`,
        );
      } else {
        engraveImages.push(
          `    <g${transform}>`,
          `      <image xlink:href="${esc(el.url)}" x="${el.xIn}" y="${el.yIn}" width="${el.widthIn}" height="${el.heightIn}" preserveAspectRatio="none"/>`,
          `      <rect x="${el.xIn}" y="${el.yIn}" width="${el.widthIn}" height="${el.heightIn}" fill="none" stroke="${ENGRAVE}" stroke-width="${HAIRLINE}" stroke-dasharray="0.1 0.05"/>`,
          `    </g>`,
        );
      }
    }
  }

  if (cutTexts.length > 0) {
    parts.push(`  <g id="cut-text" inkscape:label="cut-text" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">`, ...cutTexts, `  </g>`);
  }
  if (cutContourPaths.length > 0) {
    parts.push(`  <g id="cut-artwork">`, ...cutContourPaths, `  </g>`);
  }
  if (engraveImages.length > 0) {
    parts.push(`  <g id="artwork-reference">`, ...engraveImages, `  </g>`);
  }
  parts.push(`</svg>`);
  return parts.filter(Boolean).join("\n");
}

// Filename convention the host's admin production tooling parses:
// dimension + "-cutline.svg" suffix routes the file to the laser/cutter, and
// a material hint (e.g. "steel") steers fiber-vs-CO2 classification.
export function cutlineFilename(opts: {
  productSlug: string;
  panelId: string;
  widthIn: number;
  heightIn: number;
  materialSlug?: string;
}): string {
  const mat = opts.materialSlug ? `-${opts.materialSlug}` : "";
  return `${opts.productSlug}-${opts.panelId}${mat}-${opts.widthIn}x${opts.heightIn}in-cutline.svg`;
}
