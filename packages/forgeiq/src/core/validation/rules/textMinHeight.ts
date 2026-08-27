import type { ValidationIssue, ValidationRule } from "../types.js";

export const textMinHeightRule: ValidationRule = {
  id: "text-min-height",
  run(ctx) {
    const min = ctx.definition.constraints.minTextHeightIn;
    const issues: ValidationIssue[] = [];
    for (const [surfaceId, elements] of Object.entries(ctx.configuration.surfaces)) {
      for (const el of elements) {
        if (el.type === "text" && el.heightIn < min) {
          issues.push({
            severity: "error",
            rule: "text-min-height",
            surfaceId,
            elementId: el.id,
            message: `Text "${el.text.slice(0, 24)}" is ${el.heightIn}" tall — too small to cut reliably.`,
            suggestedFix: `Increase the text height to at least ${min}".`,
          });
        }
      }
    }
    return issues;
  },
};
