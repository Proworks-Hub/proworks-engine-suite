import type { ValidationIssue, ValidationRule } from "../types.js";

export const imageResolutionRule: ValidationRule = {
  id: "image-resolution",
  run(ctx) {
    const minDpi = ctx.definition.constraints.minImageDpi;
    const issues: ValidationIssue[] = [];
    for (const [surfaceId, elements] of Object.entries(ctx.configuration.surfaces)) {
      for (const el of elements) {
        if (el.type !== "image") continue;
        const dpi = Math.min(
          el.naturalWidthPx / el.widthIn,
          el.naturalHeightPx / el.heightIn,
        );
        if (dpi < minDpi) {
          issues.push({
            severity: "warning",
            rule: "image-resolution",
            surfaceId,
            elementId: el.id,
            message: `An image is placed at ~${Math.round(dpi)} DPI — below the recommended ${minDpi} DPI and may look soft or lose detail.`,
            suggestedFix: "Use a higher-resolution image or place it at a smaller size.",
          });
        }
      }
    }
    return issues;
  },
};
