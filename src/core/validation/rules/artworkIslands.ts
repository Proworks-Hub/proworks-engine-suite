import type { ValidationIssue, ValidationRule } from "../types";

// When a design is cut through the panel, panel material enclosed by an
// interior hole of the silhouette has nothing holding it — it falls out.
// The island count is captured client-side at upload (interiorIslands);
// this rule turns it into a customer-visible manufacturing warning.
export const artworkIslandsRule: ValidationRule = {
  id: "artwork-islands",
  run(ctx) {
    if (!ctx.definition.manufacturingProcess.includes("cut")) return [];
    const issues: ValidationIssue[] = [];
    for (const [surfaceId, elements] of Object.entries(ctx.configuration.surfaces)) {
      for (const el of elements) {
        if (el.type !== "image" || !el.interiorIslands) continue;
        issues.push({
          severity: "warning",
          rule: "artwork-islands",
          surfaceId,
          elementId: el.id,
          message: `This artwork has ${el.interiorIslands} enclosed area${el.interiorIslands === 1 ? "" : "s"} that would fall out when cut through the metal.`,
          suggestedFix:
            "Your production file automatically includes small bridges holding those pieces in place — no action needed.",
        });
      }
    }
    return issues;
  },
};
