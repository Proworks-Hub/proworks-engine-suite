import type { ValidationIssue, ValidationRule } from "../types.js";
import { resolveMaterialProfileId } from "../../resolve.js";

export const materialAllowedRule: ValidationRule = {
  id: "material-allowed",
  run(ctx) {
    const issues: ValidationIssue[] = [];
    const materialId = resolveMaterialProfileId(ctx.definition, ctx.configuration);
    if (
      materialId !== undefined &&
      !ctx.definition.allowedMaterialProfileIds.includes(materialId)
    ) {
      issues.push({
        severity: "error",
        rule: "material-allowed",
        message: "The selected material is not available for this product.",
        suggestedFix: "Choose one of the listed materials.",
      });
    }
    return issues;
  },
};
