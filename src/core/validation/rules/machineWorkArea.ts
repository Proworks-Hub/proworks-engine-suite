import type { ValidationIssue, ValidationRule } from "../types";

// Every panel must fit the machine's work area in at least one orientation,
// and any definition-level max panel constraints.
export const machineWorkAreaRule: ValidationRule = {
  id: "machine-work-area",
  run(ctx) {
    const issues: ValidationIssue[] = [];
    const { workAreaWidthIn: mw, workAreaHeightIn: mh } = ctx.machine;
    const { maxPanelWidthIn, maxPanelHeightIn } = ctx.definition.constraints;
    for (const [surfaceId, dims] of ctx.resolvedSurfaceDims) {
      const surface = ctx.definition.surfaces.find((s) => s.id === surfaceId);
      const name = surface?.name ?? surfaceId;
      const fits =
        (dims.widthIn <= mw && dims.heightIn <= mh) ||
        (dims.widthIn <= mh && dims.heightIn <= mw);
      if (!fits) {
        issues.push({
          severity: "error",
          rule: "machine-work-area",
          surfaceId,
          message: `The ${name} panel (${dims.widthIn}"×${dims.heightIn}") exceeds the machine work area (${mw}"×${mh}").`,
          suggestedFix: "Choose a smaller size.",
        });
      }
      if (
        (maxPanelWidthIn !== undefined && dims.widthIn > maxPanelWidthIn) ||
        (maxPanelHeightIn !== undefined && dims.heightIn > maxPanelHeightIn)
      ) {
        issues.push({
          severity: "error",
          rule: "machine-work-area",
          surfaceId,
          message: `The ${name} panel exceeds this product's maximum panel size.`,
          suggestedFix: "Choose a smaller size.",
        });
      }
    }
    return issues;
  },
};
