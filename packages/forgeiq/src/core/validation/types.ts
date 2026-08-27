// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { ProductConfiguration } from "../schemas/configuration.js";
import type { MachineProfileSpecs } from "../schemas/machineProfile.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import type { SurfaceDims } from "../resolve.js";

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
  /** The product's primary machine — the one that cuts. */
  machine: MachineProfileSpecs;
  /**
   * Every machine the product's routing may name. Without it, operations
   * validate against the primary machine, which is how validation behaved
   * before routing could send a step elsewhere.
   */
  machines?: Map<number, { name?: string; specs: MachineProfileSpecs }>;
  // Preset-adjusted surface dimensions, computed once before rules run.
  resolvedSurfaceDims: Map<string, SurfaceDims>;
  /**
   * The product's cut parts, expanded from its bill of materials once before
   * rules run — so a rule can check the parts that actually reach a machine,
   * not just the customizable surfaces.
   */
  cutParts: { id: string; name: string; widthIn: number; heightIn: number }[];
}

export interface ValidationRule {
  id: string;
  run(ctx: ValidationContext): ValidationIssue[];
}
