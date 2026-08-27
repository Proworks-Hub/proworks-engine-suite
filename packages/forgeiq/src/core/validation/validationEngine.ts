import { resolveSurfaceDims } from "../resolve.js";
import { buildBillOfMaterials } from "../production/bom.js";
import type { ValidationContext, ValidationResult, ValidationRule } from "./types.js";
import { surfaceBoundsRule } from "./rules/surfaceBounds.js";
import { textMinHeightRule } from "./rules/textMinHeight.js";
import { imageResolutionRule } from "./rules/imageResolution.js";
import { materialAllowedRule } from "./rules/materialAllowed.js";
import { machineMaterialCompatRule } from "./rules/machineMaterialCompat.js";
import { machineWorkAreaRule } from "./rules/machineWorkArea.js";
import { artworkIslandsRule } from "./rules/artworkIslands.js";
import { textCountersRule } from "./rules/textCounters.js";

export type {
  ValidationContext,
  ValidationIssue,
  ValidationResult,
  ValidationRule,
} from "./types.js";

// Append-only registry: later phases add rules (island detection, stroke
// widths, bridge requirements) without touching the runner.
export const builtinRules: ValidationRule[] = [
  surfaceBoundsRule,
  textMinHeightRule,
  imageResolutionRule,
  materialAllowedRule,
  machineMaterialCompatRule,
  machineWorkAreaRule,
  artworkIslandsRule,
  textCountersRule,
];

export function runValidation(
  ctx: Omit<ValidationContext, "resolvedSurfaceDims" | "cutParts">,
  rules: ValidationRule[] = builtinRules,
): ValidationResult {
  const bom = buildBillOfMaterials({
    definition: ctx.definition,
    configuration: ctx.configuration,
    materials: ctx.materials,
  });
  const full: ValidationContext = {
    ...ctx,
    resolvedSurfaceDims: resolveSurfaceDims(ctx.definition, ctx.configuration),
    cutParts: bom.items
      .filter((item) => item.kind === "cut-part" && item.dimensionsIn)
      .map((item) => ({
        id: item.id,
        name: item.name,
        widthIn: item.dimensionsIn!.widthIn,
        heightIn: item.dimensionsIn!.heightIn,
      })),
  };
  const issues = rules.flatMap((rule) => rule.run(full));
  return { valid: !issues.some((i) => i.severity === "error"), issues };
}
