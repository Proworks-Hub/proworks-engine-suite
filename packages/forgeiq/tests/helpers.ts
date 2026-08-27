import type { ProductConfiguration } from "../src/core/schemas/configuration";
import type { MaterialProfileSpecs } from "../src/core/schemas/materialProfile";
import type { MachineProfileSpecs } from "../src/core/schemas/machineProfile";
import {
  buildFirepitDefinition,
  demoCortenSpecs,
  demoFiberLaserSpecs,
  demoMildSteelSpecs,
  demoPressBrakeSpecs,
} from "../src/demo/firepit";

export const IDS = {
  cortenMaterialId: 1,
  mildSteelMaterialId: 2,
  fiberLaserMachineId: 1,
  pressBrakeMachineId: 2,
};

export const definition = buildFirepitDefinition(IDS);
/** The product's primary machine — the one that cuts. */
export const machine = demoFiberLaserSpecs;
export const materials = new Map<number, MaterialProfileSpecs>([
  [IDS.cortenMaterialId, demoCortenSpecs],
  [IDS.mildSteelMaterialId, demoMildSteelSpecs],
]);
/** Every machine the shop has, so routing can send steps to any of them. */
export const machines = new Map<number, { name?: string; specs: MachineProfileSpecs }>([
  [IDS.fiberLaserMachineId, { name: "Gweike M3 Ultra (fiber)", specs: demoFiberLaserSpecs }],
  [IDS.pressBrakeMachineId, { name: "Press brake", specs: demoPressBrakeSpecs }],
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
