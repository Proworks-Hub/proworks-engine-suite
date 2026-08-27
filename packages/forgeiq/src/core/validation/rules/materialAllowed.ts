// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

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
