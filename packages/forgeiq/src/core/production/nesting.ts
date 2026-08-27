// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

// Sheet nesting estimate.
//
// Shops buy stock in sheets, not square feet, so material cost follows sheet
// yield rather than raw part area. This is a shelf (guillotine) packer:
// parts are sorted tall-first and laid in rows across the sheet, opening a
// new shelf when the row fills and a new sheet when the shelf stack does.
//
// It deliberately under-promises — a real nesting engine interlocks parts and
// does better — so estimates stay conservative rather than optimistic.

export interface NestPart {
  id: string;
  widthIn: number;
  heightIn: number;
  quantity: number;
}

export interface NestResult {
  sheetsNeeded: number;
  partAreaSqFt: number; // area actually consumed by parts
  sheetAreaSqFt: number; // area of the sheets that must be bought
  utilizationPct: number; // partArea / sheetArea
  // Parts that cannot fit a single sheet in either orientation.
  oversizedPartIds: string[];
}

export interface NestOptions {
  sheetWidthIn: number;
  sheetHeightIn: number;
  // Cut width consumed between parts.
  kerfIn?: number;
  // Unusable margin around the sheet edge (clamps, grippers, damage).
  marginIn?: number;
}

export function estimateSheets(parts: NestPart[], opts: NestOptions): NestResult {
  const kerf = opts.kerfIn ?? 0.06;
  const margin = opts.marginIn ?? 0.25;
  const usableW = opts.sheetWidthIn - margin * 2;
  const usableH = opts.sheetHeightIn - margin * 2;
  const sheetAreaSqFt = (opts.sheetWidthIn * opts.sheetHeightIn) / 144;

  // Expand quantities into individual rectangles. Each part is turned
  // portrait (short edge across the sheet) where that orientation fits,
  // because narrower parts pack more per shelf row.
  const rects: { id: string; w: number; h: number }[] = [];
  const oversized = new Set<string>();
  let partAreaSqIn = 0;

  for (const part of parts) {
    const short = Math.min(part.widthIn, part.heightIn);
    const long = Math.max(part.widthIn, part.heightIn);
    const portraitFits = short <= usableW && long <= usableH;
    const landscapeFits = long <= usableW && short <= usableH;
    if (!portraitFits && !landscapeFits) {
      oversized.add(part.id);
      continue;
    }
    const w = portraitFits ? short : long;
    const h = portraitFits ? long : short;
    for (let i = 0; i < part.quantity; i++) {
      rects.push({ id: part.id, w, h });
      partAreaSqIn += part.widthIn * part.heightIn;
    }
  }

  if (rects.length === 0) {
    return {
      sheetsNeeded: oversized.size > 0 ? 0 : 0,
      partAreaSqFt: partAreaSqIn / 144,
      sheetAreaSqFt: 0,
      utilizationPct: 0,
      oversizedPartIds: [...oversized],
    };
  }

  // Tall parts first — shelf packing wastes least when heights are grouped.
  rects.sort((a, b) => b.h - a.h || b.w - a.w);

  let sheets = 1;
  let shelfTop = 0; // y of the current shelf on this sheet
  let shelfHeight = rects[0].h;
  let cursorX = 0;

  for (const rect of rects) {
    const needsWidth = cursorX === 0 ? rect.w : cursorX + kerf + rect.w;
    if (needsWidth <= usableW) {
      cursorX = needsWidth;
      shelfHeight = Math.max(shelfHeight, rect.h);
      continue;
    }
    // Row is full — open a new shelf.
    const nextShelfTop = shelfTop + shelfHeight + kerf;
    if (nextShelfTop + rect.h <= usableH) {
      shelfTop = nextShelfTop;
      shelfHeight = rect.h;
      cursorX = rect.w;
    } else {
      // Sheet is full — start another.
      sheets++;
      shelfTop = 0;
      shelfHeight = rect.h;
      cursorX = rect.w;
    }
  }

  const sheetArea = sheets * sheetAreaSqFt;
  return {
    sheetsNeeded: sheets,
    partAreaSqFt: partAreaSqIn / 144,
    sheetAreaSqFt: sheetArea,
    utilizationPct: sheetArea > 0 ? (partAreaSqIn / 144 / sheetArea) : 0,
    oversizedPartIds: [...oversized],
  };
}
