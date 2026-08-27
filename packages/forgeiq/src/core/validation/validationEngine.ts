import { resolveSurfaceDims } from "../resolve";
import { buildBillOfMaterials } from "../production/bom";
import type { ValidationContext, ValidationResult, ValidationRule } from "./types";
import { surfaceBoundsRule } from "./rules/surfaceBounds";
import { textMinHeightRule } from "./rules/textMinHeight";
import { imageResolutionRule } from "./rules/imageResolution";
import { materialAllowedRule } from "./rules/materialAllowed";
import { machineMaterialCompatRule } from "./rules/machineMaterialCompat";
import { machineWorkAreaRule } from "./rules/machineWorkArea";
import { artworkIslandsRule } from "./rules/artworkIslands";
import { textCountersRule } from "./rules/textCounters";

export type {
  ValidationContext,
  ValidationIssue,
  ValidationResult,
  ValidationRule,
} from "./types";

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
