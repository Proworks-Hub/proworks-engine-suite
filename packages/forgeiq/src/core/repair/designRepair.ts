// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductConfiguration, SurfaceElement } from "../schemas/configuration.js";
import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { ValidationContext, ValidationIssue } from "../validation/types.js";
import { elementBounds } from "../validation/geometry.js";
import { resolveSurfaceDims } from "../resolve.js";

// DesignRepairService — turns a validation issue into a concrete, applyable
// change to the configuration ("Fix automatically"). Repairs are pure
// functions: they take a configuration and return a new one, never mutating
// the input, so a caller can preview, apply, or undo freely.
//
// Each repair declares the rule it answers. New rules add new repairs here
// without touching the runner; a rule with no repair simply has no button.

export interface RepairSuggestion {
  id: string; // stable per (rule, element) so UI can key on it
  rule: string; // the ValidationIssue.rule this answers
  surfaceId?: string;
  elementId?: string;
  label: string; // button text, e.g. "Enlarge text"
  description: string; // what will change, in customer words
  apply(config: ProductConfiguration): ProductConfiguration;
}

export interface RepairContext {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
}

// Structural helpers — every repair edits exactly one element in place.
function replaceElement(
  config: ProductConfiguration,
  surfaceId: string,
  elementId: string,
  patch: (el: SurfaceElement) => SurfaceElement,
): ProductConfiguration {
  const elements = config.surfaces[surfaceId] ?? [];
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      [surfaceId]: elements.map((el) => (el.id === elementId ? patch(el) : el)),
    },
  };
}

function findElement(
  config: ProductConfiguration,
  surfaceId: string | undefined,
  elementId: string | undefined,
): SurfaceElement | undefined {
  if (!surfaceId || !elementId) return undefined;
  return (config.surfaces[surfaceId] ?? []).find((el) => el.id === elementId);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Builds the list of automatic fixes available for a validation result.
 * Issues with no known repair are simply absent from the list.
 */
export function suggestRepairs(
  issues: ValidationIssue[],
  ctx: RepairContext,
): RepairSuggestion[] {
  const { definition, configuration } = ctx;
  const dims = resolveSurfaceDims(definition, configuration);
  const out: RepairSuggestion[] = [];

  for (const issue of issues) {
    const element = findElement(configuration, issue.surfaceId, issue.elementId);
    const surfaceId = issue.surfaceId;
    const elementId = issue.elementId;

    // ── Text below the minimum cuttable height ──────────────────────────
    if (issue.rule === "text-min-height" && element?.type === "text" && surfaceId && elementId) {
      const target = definition.constraints.minTextHeightIn;
      out.push({
        id: `${issue.rule}:${elementId}`,
        rule: issue.rule,
        surfaceId,
        elementId,
        label: "Enlarge text",
        description: `Raise the text to ${target}" tall so it can be cut cleanly.`,
        apply: (config) =>
          replaceElement(config, surfaceId, elementId, (el) =>
            el.type === "text" ? { ...el, heightIn: target } : el,
          ),
      });
      continue;
    }

    // ── Element off the panel or across the safe area ────────────────────
    if (issue.rule === "surface-bounds" && element && surfaceId && elementId) {
      const surface = definition.surfaces.find((s) => s.id === surfaceId);
      const dim = dims.get(surfaceId);
      if (!surface || !dim) continue;
      const inset = surface.safeAreaIn;
      const bounds = elementBounds(element);
      const width = bounds.maxX - bounds.minX;
      const height = bounds.maxY - bounds.minY;
      // Only offer a move when the element actually fits inside the safe
      // area — otherwise the honest fix is resizing, offered below.
      const fits = width <= dim.widthIn - inset * 2 && height <= dim.heightIn - inset * 2;
      if (fits) {
        // Shift so the rotated bounding box lands inside the safe area,
        // preserving the element's offset between origin and bounds.
        const dx =
          bounds.minX < inset
            ? inset - bounds.minX
            : bounds.maxX > dim.widthIn - inset
              ? dim.widthIn - inset - bounds.maxX
              : 0;
        const dy =
          bounds.minY < inset
            ? inset - bounds.minY
            : bounds.maxY > dim.heightIn - inset
              ? dim.heightIn - inset - bounds.maxY
              : 0;
        if (dx !== 0 || dy !== 0) {
          out.push({
            id: `${issue.rule}:${elementId}`,
            rule: issue.rule,
            surfaceId,
            elementId,
            label: "Move into place",
            description: "Nudge this element back inside the safe area.",
            apply: (config) =>
              replaceElement(config, surfaceId, elementId, (el) => ({
                ...el,
                xIn: round2(el.xIn + dx),
                yIn: round2(el.yIn + dy),
              })),
          });
        }
      } else {
        // Too big for the panel — scale it to fit, then centre it.
        const maxW = dim.widthIn - inset * 2;
        const maxH = dim.heightIn - inset * 2;
        const scale = Math.min(maxW / width, maxH / height);
        out.push({
          id: `${issue.rule}:${elementId}`,
          rule: issue.rule,
          surfaceId,
          elementId,
          label: "Resize to fit",
          description: `Scale this element to ${Math.round(scale * 100)}% so it fits the panel.`,
          apply: (config) =>
            replaceElement(config, surfaceId, elementId, (el) => {
              const centredX = round2((dim.widthIn - width * scale) / 2);
              const centredY = round2((dim.heightIn - height * scale) / 2);
              if (el.type === "text") {
                return { ...el, heightIn: round2(el.heightIn * scale), xIn: centredX, yIn: centredY };
              }
              return {
                ...el,
                widthIn: round2(el.widthIn * scale),
                heightIn: round2(el.heightIn * scale),
                xIn: centredX,
                yIn: centredY,
              };
            }),
        });
      }
      continue;
    }

    // ── Artwork placed below the usable resolution ───────────────────────
    if (issue.rule === "image-resolution" && element?.type === "image" && surfaceId && elementId) {
      const minDpi = definition.constraints.minImageDpi;
      const maxWidthIn = element.naturalWidthPx / minDpi;
      const maxHeightIn = element.naturalHeightPx / minDpi;
      const scale = Math.min(maxWidthIn / element.widthIn, maxHeightIn / element.heightIn);
      if (scale < 1) {
        const newWidth = round2(element.widthIn * scale);
        out.push({
          id: `${issue.rule}:${elementId}`,
          rule: issue.rule,
          surfaceId,
          elementId,
          label: "Resize for quality",
          description: `Shrink this image to ${newWidth}" wide so it prints at full ${minDpi} DPI detail.`,
          apply: (config) =>
            replaceElement(config, surfaceId, elementId, (el) =>
              el.type === "image"
                ? {
                    ...el,
                    widthIn: newWidth,
                    heightIn: round2(el.heightIn * scale),
                  }
                : el,
            ),
        });
      }
      continue;
    }

    // ── Panel larger than the machine can cut ────────────────────────────
    if (issue.rule === "machine-work-area") {
      const sizeGroup = definition.optionGroups.find((g) =>
        g.values.some((v) => v.dimensionPresetId !== undefined),
      );
      if (!sizeGroup) continue;
      // Smallest preset by panel footprint — the option guaranteed to fit if
      // any does.
      const candidates = sizeGroup.values
        .filter((v) => v.dimensionPresetId)
        .map((v) => ({
          value: v,
          preset: definition.dimensionPresets.find((p) => p.id === v.dimensionPresetId),
        }))
        .filter((c) => c.preset)
        .sort((a, b) => a.preset!.widthIn - b.preset!.widthIn);
      const smallest = candidates[0];
      if (!smallest || configuration.selections[sizeGroup.id] === smallest.value.id) continue;
      out.push({
        id: `${issue.rule}:size`,
        rule: issue.rule,
        label: `Switch to ${smallest.value.label}`,
        description: `Use the ${smallest.value.label} size, which fits the machine.`,
        apply: (config) => ({
          ...config,
          selections: { ...config.selections, [sizeGroup.id]: smallest.value.id },
        }),
      });
      continue;
    }
  }

  // Deduplicate — one repair per issue id, first wins.
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Applies repairs in order, threading the configuration through each. */
export function applyRepairs(
  config: ProductConfiguration,
  repairs: RepairSuggestion[],
): ProductConfiguration {
  return repairs.reduce((acc, repair) => repair.apply(acc), config);
}

// Convenience for callers that already built a full ValidationContext.
export function suggestRepairsForContext(
  issues: ValidationIssue[],
  ctx: Pick<ValidationContext, "definition" | "configuration">,
): RepairSuggestion[] {
  return suggestRepairs(issues, {
    definition: ctx.definition,
    configuration: ctx.configuration,
  });
}
