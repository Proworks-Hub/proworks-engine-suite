import type { MachineProfileSpecs } from "../../schemas/machineProfile.js";
import type { ProductOperation } from "../../schemas/productDefinition.js";
import type { ValidationContext, ValidationIssue, ValidationRule } from "../types.js";

// Every part must fit the machine that actually processes it — and on a job
// that crosses machines, that is not always the machine that cut it. A panel
// the laser handles easily can still be too wide for the brake that folds it.
//
// Products with no routing fall back to checking the customizable surfaces
// against the primary machine, which is how this rule always behaved.

/** Fits in either orientation. */
function fits(
  part: { widthIn: number; heightIn: number },
  machine: MachineProfileSpecs,
): boolean {
  const { workAreaWidthIn: w, workAreaHeightIn: h } = machine;
  return (
    (part.widthIn <= w && part.heightIn <= h) || (part.widthIn <= h && part.heightIn <= w)
  );
}

/**
 * Which parts an operation touches. A per-part step that names components
 * touches exactly those; anything else works the whole set of cut parts.
 * Time basis and part scope are different questions — a laser cut priced by
 * area still cuts every part.
 */
function partsForOperation(op: ProductOperation, ctx: ValidationContext) {
  const named = op.time.basis === "per-part" ? op.time.partIds : undefined;
  if (!named) return ctx.cutParts;
  return ctx.cutParts.filter((part) => {
    // Per-surface components expand to "<componentId>:<surfaceId>".
    const componentId = part.id.split(":")[0];
    return named.includes(componentId) || named.includes(part.id);
  });
}

export const machineWorkAreaRule: ValidationRule = {
  id: "machine-work-area",
  run(ctx) {
    const issues: ValidationIssue[] = [];
    const machineOps = (ctx.definition.operations ?? []).filter((op) => !op.labor);

    if (machineOps.length > 0 && ctx.cutParts.length > 0) {
      // Report each part once per machine it does not fit, so a part too big
      // for two machines names both rather than stopping at the first.
      const reported = new Set<string>();
      for (const op of machineOps) {
        const entry =
          op.machineProfileId !== undefined ? ctx.machines?.get(op.machineProfileId) : undefined;
        const specs = entry?.specs ?? ctx.machine;
        const label = entry?.name ?? op.process ?? specs.process;
        for (const part of partsForOperation(op, ctx)) {
          const key = `${part.id}:${label}`;
          if (reported.has(key) || fits(part, specs)) continue;
          reported.add(key);
          issues.push({
            severity: "error",
            rule: "machine-work-area",
            message: `${part.name} (${part.widthIn}" × ${part.heightIn}") does not fit ${label} for ${op.name.toLowerCase()} — that machine works up to ${specs.workAreaWidthIn}" × ${specs.workAreaHeightIn}".`,
            suggestedFix: "Choose a smaller size, or route this step to a larger machine.",
          });
        }
      }
    } else {
      // No routing declared: check the customizable panels against the
      // product's primary machine.
      for (const [surfaceId, dims] of ctx.resolvedSurfaceDims) {
        const surface = ctx.definition.surfaces.find((s) => s.id === surfaceId);
        const name = surface?.name ?? surfaceId;
        if (!fits(dims, ctx.machine)) {
          issues.push({
            severity: "error",
            rule: "machine-work-area",
            surfaceId,
            message: `The ${name} panel (${dims.widthIn}"×${dims.heightIn}") exceeds the machine work area (${ctx.machine.workAreaWidthIn}"×${ctx.machine.workAreaHeightIn}").`,
            suggestedFix: "Choose a smaller size.",
          });
        }
      }
    }

    // The product's own panel limits apply regardless of routing.
    const { maxPanelWidthIn, maxPanelHeightIn } = ctx.definition.constraints;
    for (const [surfaceId, dims] of ctx.resolvedSurfaceDims) {
      const surface = ctx.definition.surfaces.find((s) => s.id === surfaceId);
      const name = surface?.name ?? surfaceId;
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
