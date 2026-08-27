// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.
//
// Extracted from KSix Prep Studio without behavioural change. Import paths were
// rewritten, host generated types replaced with the structurally identical ones
// in core/prepSettings.ts, and `ImageData` annotations swapped for PixelBuffer —
// which ImageData satisfies structurally, so a browser host passes its own
// objects straight in.

import type { AccentLayer, SpotChannelAssignment } from "./spotChannels.js";
import type { PrintMode } from "./printModeRules.js";

export interface SpotChannelValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ChannelConfig {
  assignment: SpotChannelAssignment;
  name: string;
  color: string;
  solidity: number;
  printOrder: number;
  enabled: boolean;
}

export interface ValidationIssue {
  severity: "error" | "warning" | "info";
  message: string;
  channel?: SpotChannelAssignment;
  code?: string;
}

export interface PreflightResult {
  pass: boolean;
  issues: ValidationIssue[];
  printMode: PrintMode | null;
  exportFormat: string;
  enabledChannels: SpotChannelAssignment[];
  summary: string;
}

export function buildPreflightResult(
  channels: ChannelConfig[],
  layers: AccentLayer[],
  printMode: PrintMode | null,
  exportFormat = "TIFF"
): PreflightResult {
  const issues: ValidationIssue[] = [];
  const enabledChannels = channels.filter(c => c.enabled).map(c => c.assignment);

  if (channels.length === 0) {
    issues.push({ severity: "info", message: "No spot channels configured." });
  }

  const enabledList = channels.filter(c => c.enabled);
  if (channels.length > 0 && enabledList.length === 0) {
    issues.push({ severity: "warning", message: "All spot channels are disabled — no specialty inks will be output." });
  }

  const orders = enabledList.map(c => c.printOrder);
  const uniqueOrders = new Set(orders);
  if (uniqueOrders.size !== orders.length) {
    issues.push({ severity: "error", message: "Duplicate print order values detected — each channel must have a unique order.", code: "DUPE_ORDER" });
  }

  for (const ch of enabledList) {
    if (ch.solidity < 1 || ch.solidity > 100) {
      issues.push({ severity: "error", message: `Channel "${ch.name}" has invalid solidity: ${ch.solidity} (must be 1–100).`, channel: ch.assignment, code: "INVALID_SOLIDITY" });
    }
    if (!ch.color || !/^#[0-9A-Fa-f]{6}$/.test(ch.color)) {
      issues.push({ severity: "warning", message: `Channel "${ch.name}" has an invalid or missing color value.`, channel: ch.assignment, code: "INVALID_COLOR" });
    }
  }

  const channelAssignments = new Set(enabledList.map(c => c.assignment));
  for (const layer of layers.filter(l => l.enabled && l.kind !== "artwork")) {
    if (!channelAssignments.has(layer.assignment)) {
      issues.push({
        severity: "warning",
        message: `Layer "${layer.label}" is assigned to "${layer.assignment}" but no matching channel is active.`,
        channel: layer.assignment,
        code: "UNMATCHED_LAYER",
      });
    }
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warnCount = issues.filter(i => i.severity === "warning").length;
  const pass = errorCount === 0;

  return {
    pass,
    issues,
    printMode,
    exportFormat,
    enabledChannels,
    summary: pass
      ? warnCount > 0
        ? `Preflight passed with ${warnCount} warning${warnCount > 1 ? "s" : ""}.`
        : "All spot channel checks passed."
      : `Preflight failed: ${errorCount} error${errorCount > 1 ? "s" : ""}${warnCount ? `, ${warnCount} warning${warnCount > 1 ? "s" : ""}` : ""}.`,
  };
}

export function validateSpotChannels(
  channels: ChannelConfig[],
  layers: AccentLayer[]
): SpotChannelValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (channels.length === 0) {
    warnings.push("No spot channels configured.");
    return { valid: true, errors, warnings };
  }

  const enabledChannels = channels.filter(c => c.enabled);
  if (enabledChannels.length === 0) {
    warnings.push("All spot channels are disabled.");
  }

  const orders = enabledChannels.map(c => c.printOrder);
  const uniqueOrders = new Set(orders);
  if (uniqueOrders.size !== orders.length) {
    errors.push("Duplicate print order values detected — each channel must have a unique order.");
  }

  for (const ch of enabledChannels) {
    if (ch.solidity < 1 || ch.solidity > 100) {
      errors.push(`Channel "${ch.name}" has invalid solidity: ${ch.solidity} (must be 1–100).`);
    }
    if (!ch.color || !/^#[0-9A-Fa-f]{6}$/.test(ch.color)) {
      warnings.push(`Channel "${ch.name}" has an invalid or missing color value.`);
    }
  }

  const unassignedLayers = layers.filter(l => l.enabled && l.kind !== "artwork");
  const channelAssignments = new Set(enabledChannels.map(c => c.assignment));
  for (const layer of unassignedLayers) {
    if (!channelAssignments.has(layer.assignment)) {
      warnings.push(`Layer "${layer.label}" is assigned to "${layer.assignment}" but no matching channel is configured.`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function autoAssignChannels(
  layers: AccentLayer[],
  existing: ChannelConfig[]
): ChannelConfig[] {
  const assigned: ChannelConfig[] = [...existing];
  let order = assigned.length;
  const existingAssignments = new Set(existing.map(c => c.assignment));

  for (const layer of layers) {
    if (existingAssignments.has(layer.assignment)) continue;
    assigned.push({
      assignment: layer.assignment,
      name: layer.label,
      color: "#888888",
      solidity: 100,
      printOrder: order++,
      enabled: true,
    });
    existingAssignments.add(layer.assignment);
  }

  return assigned;
}
