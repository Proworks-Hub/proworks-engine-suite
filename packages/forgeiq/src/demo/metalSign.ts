// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductDefinition } from "../core/schemas/productDefinition.js";
import type { MaterialProfileSpecs } from "../core/schemas/materialProfile.js";

// A second example product, deliberately unlike the fire pit: one flat face
// instead of four panels, an optional engraving pass, no welding, and
// different stock. Its purpose is to prove the engines are generic — the
// same ForgeIQ, CostIQ, and Prime handle it with no code changes, only data.

export const demoAluminumSpecs: MaterialProfileSpecs = {
  category: "aluminum",
  thicknessIn: 0.125,
  sheetWidthIn: 48,
  sheetHeightIn: 96,
  costPerSqFt: 7.25,
  customerUpchargePerSqFt: 2,
  finishOptions: ["mill", "brushed"],
};

export interface MetalSignProfileIds {
  cortenMaterialId: number;
  aluminumMaterialId: number;
  fiberLaserMachineId: number;
}

export function buildMetalSignDefinition(ids: MetalSignProfileIds): ProductDefinition {
  return {
    slug: "metal-sign",
    name: "Custom Metal Sign",
    category: "sign",
    manufacturingProcess: "fiber-laser-cut",
    description:
      "A single-panel metal sign cut from steel or aluminum, with optional engraved detail and keyhole hangers.",
    optionGroups: [
      {
        id: "size",
        label: "Size",
        type: "select",
        required: true,
        defaultValueId: "size_18x12",
        values: [
          { id: "size_18x12", label: '18" × 12"', dimensionPresetId: "18x12", meta: {} },
          {
            id: "size_24x18",
            label: '24" × 18"',
            dimensionPresetId: "24x18",
            priceModifier: { kind: "flat", amount: 45 },
            meta: {},
          },
        ],
      },
      {
        id: "material",
        label: "Material",
        type: "select",
        required: true,
        defaultValueId: "mat_corten",
        values: [
          {
            id: "mat_corten",
            label: 'Corten Steel 1/8"',
            materialProfileId: ids.cortenMaterialId,
            meta: { preview: "corten" },
          },
          {
            id: "mat_aluminum",
            label: 'Aluminum 1/8"',
            materialProfileId: ids.aluminumMaterialId,
            priceModifier: { kind: "flat", amount: 25 },
            meta: { preview: "stainless" },
          },
        ],
      },
      {
        id: "detail",
        label: "Detail",
        type: "select",
        required: true,
        defaultValueId: "detail_cut",
        values: [
          { id: "detail_cut", label: "Cut only", meta: {} },
          {
            id: "detail_engraved",
            label: "Cut + engraved detail",
            priceModifier: { kind: "flat", amount: 35 },
            meta: {},
          },
        ],
      },
    ],
    dimensionPresets: [
      {
        id: "18x12",
        label: '18" × 12"',
        widthIn: 18,
        heightIn: 12,
        surfaceOverrides: {},
      },
      {
        id: "24x18",
        label: '24" × 18"',
        widthIn: 24,
        heightIn: 18,
        surfaceOverrides: { face: { widthIn: 24, heightIn: 18 } },
      },
    ],
    defaultDimensionPresetId: "18x12",
    surfaces: [
      {
        id: "face",
        name: "Face",
        widthIn: 18,
        heightIn: 12,
        safeAreaIn: 0.5,
        editable: true,
        allowedElementTypes: ["text", "image"],
      },
    ],
    allowedMaterialProfileIds: [ids.cortenMaterialId, ids.aluminumMaterialId],
    defaultMachineProfileId: ids.fiberLaserMachineId,
    pricing: {
      basePrice: 129,
      perElementCharge: { text: 5, image: 12 },
      quantityTiers: [
        { minQty: 1, unitMultiplier: 1 },
        { minQty: 5, unitMultiplier: 0.88 },
      ],
      internalCost: {
        setupMinutes: 10,
        estMachineMinutesPerSqFt: 3,
        laborMinutes: 12,
        laborRatePerHour: 30,
        targetMarginPct: 0.55,
      },
    },
    constraints: {
      minFeatureIn: 0.08,
      minTextHeightIn: 0.375,
      minImageDpi: 150,
      maxPanelWidthIn: 24,
      maxPanelHeightIn: 24,
    },
    operations: [
      {
        id: "laser-cut",
        name: "Laser cut face",
        type: "cut",
        process: "fiber-laser",
        time: { basis: "per-sq-ft", minutesPerSqFt: 3 },
        setupMinutes: 10,
        labor: false,
      },
      {
        id: "engrave",
        name: "Engrave detail",
        type: "engrave",
        process: "fiber-laser",
        time: { basis: "per-sq-ft", minutesPerSqFt: 5 },
        setupMinutes: 5,
        labor: false,
        requiresOptionValueId: "detail_engraved",
      },
      {
        id: "deburr",
        name: "Deburr and clean",
        type: "finish",
        time: { basis: "per-part", minutesPerPart: 2, partIds: ["face-panel"] },
        setupMinutes: 0,
        labor: true,
      },
      {
        id: "pack",
        name: "Pack for shipping",
        type: "pack",
        time: { basis: "per-unit", minutesPerUnit: 4 },
        setupMinutes: 0,
        labor: true,
      },
    ],
    bom: [
      {
        id: "face-panel",
        name: "Sign face",
        kind: "cut-part",
        quantity: { mode: "per-surface" },
        dimensions: { source: "surface" },
        note: "Keyhole hangers cut in the same pass",
      },
      {
        id: "hardware",
        name: "Mounting hardware pack",
        kind: "hardware",
        quantity: { mode: "fixed", count: 1 },
        unitCost: 3.25,
      },
      {
        id: "packaging",
        name: "Carton + corner protectors",
        kind: "packaging",
        quantity: { mode: "fixed", count: 1 },
        unitCost: 4.5,
      },
    ],
  };
}
