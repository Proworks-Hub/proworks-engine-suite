import type { ProductDefinition } from "../schemas/productDefinition";
import type { ProductConfiguration } from "../schemas/configuration";
import type { MachineProfileSpecs } from "../schemas/machineProfile";
import type { MaterialProfileSpecs } from "../schemas/materialProfile";
import type { SurfaceDims } from "../resolve";

export interface ValidationIssue {
  severity: "error" | "warning";
  rule: string;
  surfaceId?: string;
  elementId?: string;
  message: string;
  suggestedFix?: string;
}

export interface ValidationResult {
  valid: boolean; // no severity:"error" issues
  issues: ValidationIssue[];
}

export interface ValidationContext {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
  materials: Map<number, MaterialProfileSpecs>;
  machine: MachineProfileSpecs;
  // Preset-adjusted surface dimensions, computed once before rules run.
  resolvedSurfaceDims: Map<string, SurfaceDims>;
}

export interface ValidationRule {
  id: string;
  run(ctx: ValidationContext): ValidationIssue[];
}
