import type {
  DimensionPreset,
  OptionValue,
  ProductDefinition,
} from "./schemas/productDefinition";
import type { ProductConfiguration } from "./schemas/configuration";

// Shared resolution helpers used by both the pricing and validation engines so
// they always agree on which preset, material, machine, and surface sizes a
// configuration refers to.

export function selectedOptionValues(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): OptionValue[] {
  const out: OptionValue[] = [];
  for (const group of definition.optionGroups) {
    const valueId = configuration.selections[group.id] ?? group.defaultValueId;
    if (!valueId) continue;
    const value = group.values.find((v) => v.id === valueId);
    if (value) out.push(value);
  }
  return out;
}

export function resolveDimensionPreset(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): DimensionPreset {
  const fromSelection = selectedOptionValues(definition, configuration)
    .map((v) => v.dimensionPresetId)
    .find((id) => id !== undefined);
  const presetId = fromSelection ?? definition.defaultDimensionPresetId;
  const preset = definition.dimensionPresets.find((p) => p.id === presetId);
  return preset ?? definition.dimensionPresets[0];
}

export type SurfaceDims = { widthIn: number; heightIn: number };

// Surface dimensions after applying the selected preset's overrides.
export function resolveSurfaceDims(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): Map<string, SurfaceDims> {
  const preset = resolveDimensionPreset(definition, configuration);
  const dims = new Map<string, SurfaceDims>();
  for (const surface of definition.surfaces) {
    const override = preset.surfaceOverrides[surface.id];
    dims.set(surface.id, {
      widthIn: override?.widthIn ?? surface.widthIn,
      heightIn: override?.heightIn ?? surface.heightIn,
    });
  }
  return dims;
}

export function resolveMaterialProfileId(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): number | undefined {
  return selectedOptionValues(definition, configuration)
    .map((v) => v.materialProfileId)
    .find((id) => id !== undefined);
}

export function resolveMachineProfileId(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): number {
  return (
    selectedOptionValues(definition, configuration)
      .map((v) => v.machineProfileId)
      .find((id) => id !== undefined) ?? definition.defaultMachineProfileId
  );
}

// Total customizable area at the selected preset, in square feet.
export function totalSurfaceAreaSqFt(
  definition: ProductDefinition,
  configuration: ProductConfiguration,
): number {
  let sqIn = 0;
  for (const dims of resolveSurfaceDims(definition, configuration).values()) {
    sqIn += dims.widthIn * dims.heightIn;
  }
  return sqIn / 144;
}
