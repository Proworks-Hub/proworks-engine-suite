import { getVisionStorage } from "../core/storage.js";
// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

export interface AutoCheckInputs {
  dpi?: number;
  hasBackground?: boolean;
  colorCount?: number;
  presetKey?: string;
  colorMode?: string;
  hasAlpha?: boolean;
  fileSizeMb?: number;
  fileName?: string;
}

export interface QACheckResult {
  id: string;
  label: string;
  pass: boolean;
  severity: "info" | "warning" | "error";
  message?: string;
}

export interface ManualCheckItem {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  category: "color" | "output" | "substrate" | "file" | "general";
}

export interface ReadinessBadge {
  label: string;
  color: "green" | "yellow" | "red";
  score: number;
}

const MANUAL_CHECKS_KEY = "ksix_manual_checks";

const DEFAULT_MANUAL_CHECKS: ManualCheckItem[] = [
  { id: "proof_approved", label: "Proof Approved by Customer", description: "Customer has signed off on the digital proof", checked: false, category: "output" },
  { id: "substrate_confirmed", label: "Substrate Material Confirmed", description: "Correct material selected for this order", checked: false, category: "substrate" },
  { id: "color_match_verified", label: "Color Match Verified", description: "Colors checked against reference or Pantone", checked: false, category: "color" },
  { id: "bleed_checked", label: "Bleed & Safe Zone Checked", description: "Artwork has correct bleed and margins", checked: false, category: "file" },
  { id: "rip_test_print", label: "RIP Test Print Done", description: "Test print sent through RIP before final run", checked: false, category: "output" },
  { id: "ink_levels_ok", label: "Ink Levels Sufficient", description: "Ink levels checked for production run", checked: false, category: "output" },
  { id: "size_confirmed", label: "Output Size Confirmed", description: "Final print dimensions match order specs", checked: false, category: "general" },
];

export function deriveAutoChecks(inputs: AutoCheckInputs): QACheckResult[] {
  const results: QACheckResult[] = [];

  const dpi = inputs.dpi ?? 72;
  if (dpi < 150) {
    results.push({ id: "dpi", label: "Resolution", pass: false, severity: "error", message: `DPI too low (${dpi}) — minimum 150, recommended 300+` });
  } else if (dpi < 300) {
    results.push({ id: "dpi", label: "Resolution", pass: false, severity: "warning", message: `DPI (${dpi}) is below recommended 300 — output may appear soft` });
  } else {
    results.push({ id: "dpi", label: "Resolution", pass: true, severity: "info", message: `DPI: ${dpi} ✓` });
  }

  const dtfLike = inputs.presetKey === "DTF" || inputs.presetKey === "UVDTF";
  if (dtfLike) {
    if (inputs.hasBackground === true) {
      results.push({ id: "background", label: "Background Removal", pass: false, severity: "error", message: "Background must be removed for DTF/UVDTF printing" });
    } else {
      results.push({ id: "background", label: "Background Removal", pass: true, severity: "info", message: "Background removed ✓" });
    }
  }

  if (inputs.colorMode && inputs.colorMode !== "RGB" && inputs.colorMode !== "CMYK") {
    results.push({ id: "colorMode", label: "Color Mode", pass: false, severity: "warning", message: `Color mode "${inputs.colorMode}" may not be supported — use RGB or CMYK` });
  } else if (inputs.colorMode) {
    results.push({ id: "colorMode", label: "Color Mode", pass: true, severity: "info", message: `Color mode: ${inputs.colorMode} ✓` });
  }

  const colorCount = inputs.colorCount ?? 0;
  if (colorCount > 64 && (inputs.presetKey === "UVDTF" || inputs.presetKey === "LASER_ENGRAVING")) {
    results.push({ id: "colorCount", label: "Color Count", pass: false, severity: "warning", message: `${colorCount} colors detected — ${inputs.presetKey} works best with fewer colors` });
  }

  if (inputs.fileSizeMb && inputs.fileSizeMb > 200) {
    results.push({ id: "fileSize", label: "File Size", pass: false, severity: "warning", message: `File size ${inputs.fileSizeMb.toFixed(0)} MB — very large files may slow RIP processing` });
  }

  if (!inputs.fileName || inputs.fileName.trim() === "" || inputs.fileName === "untitled") {
    results.push({ id: "fileName", label: "File Name", pass: false, severity: "info", message: "File has no name — please name before export" });
  } else {
    results.push({ id: "fileName", label: "File Name", pass: true, severity: "info", message: `File: ${inputs.fileName} ✓` });
  }

  return results;
}

export function runAutoChecks(inputs: AutoCheckInputs): QACheckResult[] {
  return deriveAutoChecks(inputs);
}

export function loadManualChecks(): ManualCheckItem[] {
  try {
    const raw = getVisionStorage()?.getItem(MANUAL_CHECKS_KEY) ?? null;
    if (!raw) return DEFAULT_MANUAL_CHECKS.map(c => ({ ...c }));
    const saved = JSON.parse(raw) as Record<string, boolean>;
    return DEFAULT_MANUAL_CHECKS.map(c => ({ ...c, checked: saved[c.id] ?? false }));
  } catch {
    return DEFAULT_MANUAL_CHECKS.map(c => ({ ...c }));
  }
}

export function saveManualCheck(id: string, checked: boolean): void {
  try {
    const storage = getVisionStorage();
    if (!storage) return;
    const raw = storage.getItem(MANUAL_CHECKS_KEY);
    const saved: Record<string, boolean> = raw ? JSON.parse(raw) : {};
    saved[id] = checked;
    storage.setItem(MANUAL_CHECKS_KEY, JSON.stringify(saved));
  } catch {
    // ignore storage errors
  }
}

export function clearManualChecks(): void {
  try {
    getVisionStorage()?.removeItem(MANUAL_CHECKS_KEY);
  } catch {
    // ignore
  }
}

export function computeReadinessBadge(
  autoChecks: QACheckResult[],
  manualChecks: ManualCheckItem[]
): ReadinessBadge {
  const autoErrors = autoChecks.filter(c => !c.pass && c.severity === "error").length;
  const autoWarns = autoChecks.filter(c => !c.pass && c.severity === "warning").length;
  const manualTotal = manualChecks.length;
  const manualDone = manualChecks.filter(c => c.checked).length;
  const manualPct = manualTotal > 0 ? manualDone / manualTotal : 1;

  const autoScore = Math.max(0, 100 - autoErrors * 30 - autoWarns * 10);
  const manualScore = Math.round(manualPct * 100);
  const score = Math.round((autoScore * 0.6 + manualScore * 0.4));

  if (autoErrors > 0 || score < 50) {
    return { label: "Not Ready", color: "red", score };
  } else if (autoWarns > 0 || score < 80) {
    return { label: "Needs Review", color: "yellow", score };
  } else {
    return { label: "Print Ready", color: "green", score };
  }
}
