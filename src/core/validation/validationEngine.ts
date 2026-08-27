import { resolveSurfaceDims } from "../resolve";
import type { ValidationContext, ValidationResult, ValidationRule } from "./types";
import { surfaceBoundsRule } from "./rules/surfaceBounds";
import { textMinHeightRule } from "./rules/textMinHeight";
import { imageResolutionRule } from "./rules/imageResolution";
import { materialAllowedRule } from "./rules/materialAllowed";
import { machineMaterialCompatRule } from "./rules/machineMaterialCompat";
import { machineWorkAreaRule } from "./rules/machineWorkArea";

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
];

export function runValidation(
  ctx: Omit<ValidationContext, "resolvedSurfaceDims">,
  rules: ValidationRule[] = builtinRules,
): ValidationResult {
  const full: ValidationContext = {
    ...ctx,
    resolvedSurfaceDims: resolveSurfaceDims(ctx.definition, ctx.configuration),
  };
  const issues = rules.flatMap((rule) => rule.run(full));
  return { valid: !issues.some((i) => i.severity === "error"), issues };
}
