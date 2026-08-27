import type { ValidationIssue, ValidationRule } from "../types";
import { resolveMaterialProfileId } from "../../resolve";

export const machineMaterialCompatRule: ValidationRule = {
  id: "machine-material-compat",
  run(ctx) {
    const issues: ValidationIssue[] = [];
    const materialId = resolveMaterialProfileId(ctx.definition, ctx.configuration);
    const material = materialId !== undefined ? ctx.materials.get(materialId) : undefined;
    if (!material) return issues;

    if (!ctx.machine.compatibleMaterialCategories.includes(material.category)) {
      issues.push({
        severity: "error",
        rule: "machine-material-compat",
        message: `This material (${material.category}) cannot be processed on the assigned machine.`,
        suggestedFix: "Choose a compatible material.",
      });
    }
    if (material.thicknessIn > ctx.machine.maxMaterialThicknessIn) {
      issues.push({
        severity: "error",
        rule: "machine-material-compat",
        message: `Material thickness ${material.thicknessIn}" exceeds the machine's ${ctx.machine.maxMaterialThicknessIn}" limit.`,
        suggestedFix: "Choose a thinner material.",
      });
    }
    return issues;
  },
};
