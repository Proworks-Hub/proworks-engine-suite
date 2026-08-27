// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { BomComponent, ProductDefinition } from "../schemas/productDefinition.js";
import type { ProductConfiguration } from "../schemas/configuration.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import { resolveDimensionPreset, resolveMaterialProfileId, resolveSurfaceDims } from "../resolve.js";
import { estimateSheets, type NestPart, type NestResult } from "./nesting.js";

// Bill of materials for one order line: what gets consumed, how much of it,
// and what the stock actually costs once parts are nested onto sheets.

export interface BomItem {
  id: string;
  name: string;
  kind: BomComponent["kind"];
  quantity: number; // total across the whole order (per-unit × order quantity)
  perUnit: number;
  dimensionsIn?: { widthIn: number; heightIn: number };
  materialName?: string;
  unitCost?: number;
  totalCost?: number; // hardware/consumables only; cut parts cost via sheets
  note?: string;
}

export interface BillOfMaterials {
  items: BomItem[];
  // Stock requirement for the cut parts, or null when the product has no
  // cut parts or no material resolved.
  stock: (NestResult & { materialName?: string; sheetCost: number }) | null;
  hardwareCost: number;
  materialCost: number; // sheets × cost, or area-based fallback
  /** True when costing fell back to raw area because no BOM was defined. */
  estimatedFromArea: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function componentDimensions(
  component: BomComponent,
  definition: ProductDefinition,
  configuration: ProductConfiguration,
  surfaceId?: string,
): { widthIn: number; heightIn: number } | undefined {
  const spec = component.dimensions;
  if (!spec) return undefined;
  if (spec.source === "fixed") return { widthIn: spec.widthIn, heightIn: spec.heightIn };
  if (spec.source === "footprint") {
    const preset = resolveDimensionPreset(definition, configuration);
    return { widthIn: preset.widthIn, heightIn: preset.depthIn ?? preset.widthIn };
  }
  // "surface"
  const dims = resolveSurfaceDims(definition, configuration);
  if (surfaceId) return dims.get(surfaceId);
  return dims.values().next().value;
}

export function buildBillOfMaterials(input: {
  definition: ProductDefinition;
  configuration: ProductConfiguration;
  materials: Map<number, MaterialProfileSpecs>;
  materialName?: string;
}): BillOfMaterials {
  const { definition, configuration, materials } = input;
  const orderQty = configuration.quantity;
  const materialId = resolveMaterialProfileId(definition, configuration);
  const material = materialId !== undefined ? materials.get(materialId) : undefined;

  // Definitions stored before `bom` existed come back without the field, so
  // never assume schema defaults were applied to persisted JSON.
  const components = definition.bom ?? [];

  // No BOM defined — fall back to the naive area estimate so costing still
  // works for simple products.
  if (components.length === 0) {
    const areaSqFt =
      [...resolveSurfaceDims(definition, configuration).values()].reduce(
        (sum, d) => sum + d.widthIn * d.heightIn,
        0,
      ) / 144;
    return {
      items: [],
      stock: null,
      hardwareCost: 0,
      materialCost: round2(areaSqFt * orderQty * (material?.costPerSqFt ?? 0)),
      estimatedFromArea: true,
    };
  }

  const items: BomItem[] = [];
  const nestParts: NestPart[] = [];
  let hardwareCost = 0;

  const editableSurfaces = definition.surfaces.filter((s) => s.editable);

  for (const component of components) {
    if (component.quantity.mode === "per-surface") {
      // One component per surface, each carrying that surface's dimensions.
      for (const surface of editableSurfaces) {
        const dimensionsIn = componentDimensions(component, definition, configuration, surface.id);
        const quantity = orderQty;
        items.push({
          id: `${component.id}:${surface.id}`,
          name: `${component.name} — ${surface.name}`,
          kind: component.kind,
          perUnit: 1,
          quantity,
          dimensionsIn,
          materialName: component.kind === "cut-part" ? input.materialName : undefined,
          unitCost: component.unitCost,
          totalCost:
            component.unitCost !== undefined ? round2(component.unitCost * quantity) : undefined,
          note: component.note,
        });
        if (component.kind === "cut-part" && dimensionsIn) {
          nestParts.push({ id: `${component.id}:${surface.id}`, ...dimensionsIn, quantity });
        }
        if (component.unitCost !== undefined) hardwareCost += component.unitCost * quantity;
      }
      continue;
    }

    const perUnit = component.quantity.count;
    const quantity = perUnit * orderQty;
    const dimensionsIn = componentDimensions(component, definition, configuration);
    items.push({
      id: component.id,
      name: component.name,
      kind: component.kind,
      perUnit,
      quantity,
      dimensionsIn,
      materialName: component.kind === "cut-part" ? input.materialName : undefined,
      unitCost: component.unitCost,
      totalCost:
        component.unitCost !== undefined ? round2(component.unitCost * quantity) : undefined,
      note: component.note,
    });
    if (component.kind === "cut-part" && dimensionsIn) {
      nestParts.push({ id: component.id, ...dimensionsIn, quantity });
    }
    if (component.unitCost !== undefined) hardwareCost += component.unitCost * quantity;
  }

  let stock: BillOfMaterials["stock"] = null;
  let materialCost = 0;
  if (nestParts.length > 0 && material) {
    const nest = estimateSheets(nestParts, {
      sheetWidthIn: material.sheetWidthIn,
      sheetHeightIn: material.sheetHeightIn,
    });
    const sheetCost = round2(
      (material.sheetWidthIn * material.sheetHeightIn / 144) * material.costPerSqFt,
    );
    materialCost = round2(nest.sheetsNeeded * sheetCost);
    stock = { ...nest, materialName: input.materialName, sheetCost };
  }

  return {
    items,
    stock,
    hardwareCost: round2(hardwareCost),
    materialCost,
    estimatedFromArea: false,
  };
}
