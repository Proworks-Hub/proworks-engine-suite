import type { ProductConfiguration } from "../src/core/schemas/configuration";
import type { MaterialProfileSpecs } from "../src/core/schemas/materialProfile";
import {
  buildFirepitDefinition,
  demoCortenSpecs,
  demoFiberLaserSpecs,
  demoMildSteelSpecs,
} from "../src/demo/firepit";

export const IDS = { cortenMaterialId: 1, mildSteelMaterialId: 2, fiberLaserMachineId: 1 };

export const definition = buildFirepitDefinition(IDS);
export const machine = demoFiberLaserSpecs;
export const materials = new Map<number, MaterialProfileSpecs>([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.mildSteelMaterialId, demoMildSteelSpecs],
]);

export function baseConfig(overrides: Partial<ProductConfiguration> = {}): ProductConfiguration {
  return {
    selections: {
      size: "size_24",
      material: "mat_corten",
      finish: "fin_raw",
      style: "style_custom",
    },
    surfaces: {},
    quantity: 1,
    ...overrides,
  };
}
