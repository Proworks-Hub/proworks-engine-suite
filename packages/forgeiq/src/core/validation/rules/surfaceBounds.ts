import type { ValidationIssue, ValidationRule } from "../types.js";
import { elementBounds } from "../geometry.js";

// Elements must stay on the surface (error) and ideally inside the safe area
// (warning when they cross the safe-area inset but remain on the surface).
export const surfaceBoundsRule: ValidationRule = {
  id: "surface-bounds",
  run(ctx) {
    const issues: ValidationIssue[] = [];
    for (const [surfaceId, elements] of Object.entries(ctx.configuration.surfaces)) {
      const surface = ctx.definition.surfaces.find((s) => s.id === surfaceId);
      const dims = ctx.resolvedSurfaceDims.get(surfaceId);
      if (!surface || !dims) continue;
      const inset = surface.safeAreaIn;
      for (const el of elements) {
        const b = elementBounds(el);
        const offSurface =
          b.minX < 0 || b.minY < 0 || b.maxX > dims.widthIn || b.maxY > dims.heightIn;
        const outsideSafeArea =
          b.minX < inset ||
          b.minY < inset ||
          b.maxX > dims.widthIn - inset ||
          b.maxY > dims.heightIn - inset;
        if (offSurface) {
          issues.push({
            severity: "error",
            rule: "surface-bounds",
            surfaceId,
            elementId: el.id,
            message: `An element extends past the edge of the ${surface.name} panel.`,
            suggestedFix: "Move or shrink the element so it fits on the panel.",
          });
        } else if (outsideSafeArea && inset > 0) {
          issues.push({
            severity: "warning",
            rule: "surface-bounds",
            surfaceId,
            elementId: el.id,
            message: `An element on the ${surface.name} panel crosses the ${inset}" safe area.`,
            suggestedFix: "Keep artwork inside the dashed safe-area line for reliable results.",
          });
        }
      }
    }
    return issues;
  },
};
