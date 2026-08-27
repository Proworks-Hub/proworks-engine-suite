import type { ProductDefinition } from "../core/schemas/productDefinition.js";
import type { MachineProfileSpecs } from "../core/schemas/machineProfile.js";
import type { MaterialProfileSpecs } from "../core/schemas/materialProfile.js";

// Demo/example product: a customizable square metal fire pit. Hosts seed this
// with their own real profile row ids; tests use stable fake ids. This file is
// example DATA — the engine core has no fire-pit knowledge.

export const demoFiberLaserSpecs: MachineProfileSpecs = {
  process: "fiber-laser",
  workAreaWidthIn: 24,
  workAreaHeightIn: 24,
  maxMaterialThicknessIn: 0.25,
  compatibleMaterialCategories: ["corten", "mild-steel", "stainless"],
  costPerHour: 45,
  setupMinutesDefault: 10,
};

// A second machine, so the fire pit routes across two: panels are cut on the
// laser, then their top edge is folded on the brake for rigidity.
export const demoPressBrakeSpecs: MachineProfileSpecs = {
  process: "press-brake",
  workAreaWidthIn: 48,
  workAreaHeightIn: 48,
  maxMaterialThicknessIn: 0.25,
  compatibleMaterialCategories: ["corten", "mild-steel", "stainless", "aluminum"],
  costPerHour: 32,
  setupMinutesDefault: 15,
};

export const demoCortenSpecs: MaterialProfileSpecs = {
  category: "corten",
  thicknessIn: 0.125,
  sheetWidthIn: 48,
  sheetHeightIn: 96,
  costPerSqFt: 5.5,
  customerUpchargePerSqFt: 1.25,
  finishOptions: ["raw", "natural-patina"],
};

export const demoMildSteelSpecs: MaterialProfileSpecs = {
  category: "mild-steel",
  thicknessIn: 0.125,
  sheetWidthIn: 48,
  sheetHeightIn: 96,
  costPerSqFt: 3.75,
  customerUpchargePerSqFt: 0,
  finishOptions: ["raw", "high-temp-black"],
};

export interface FirepitProfileIds {
  cortenMaterialId: number;
  mildSteelMaterialId: number;
  fiberLaserMachineId: number;
  pressBrakeMachineId: number;
}

export function buildFirepitDefinition(ids: FirepitProfileIds): ProductDefinition {
  // Base panel dims correspond to the default 24" preset; other presets
  // override per-surface.
  const panel = (id: string, name: string) => ({
    id,
    name,
    widthIn: 24,
    heightIn: 18,
    safeAreaIn: 0.75,
    editable: true,
    allowedElementTypes: ["text", "image"] as ("text" | "image")[],
  });

  return {
    slug: "firepit-24",
    name: "Custom Metal Fire Pit",
    category: "fire-pit",
    manufacturingProcess: "fiber-laser-cut",
    description:
      "A personalized steel fire pit with four customizable panels — add names, artwork, and scenes cut straight into the metal.",
    optionGroups: [
      {
        id: "size",
        label: "Size",
        type: "select",
        required: true,
        defaultValueId: "size_24",
        values: [
          {
            id: "size_20",
            label: '20"',
            dimensionPresetId: "20in",
            priceModifier: { kind: "flat", amount: -60 },
            meta: {},
          },
          { id: "size_24", label: '24"', dimensionPresetId: "24in", meta: {} },
          {
            id: "size_30",
            label: '30"',
            dimensionPresetId: "30in",
            priceModifier: { kind: "flat", amount: 110 },
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
            description: "Weathers to a rich rust patina; never needs paint.",
            materialProfileId: ids.cortenMaterialId,
            meta: { preview: "corten" },
          },
          {
            id: "mat_mild",
            label: 'Mild Steel 1/8"',
            description: "Classic raw steel; pair with a high-temp finish.",
            materialProfileId: ids.mildSteelMaterialId,
            priceModifier: { kind: "flat", amount: -40 },
            meta: { preview: "mild-steel" },
          },
        ],
      },
      {
        id: "finish",
        label: "Finish",
        type: "select",
        required: true,
        defaultValueId: "fin_raw",
        values: [
          { id: "fin_raw", label: "Raw / natural", meta: {} },
          {
            id: "fin_hightemp",
            label: "High-temp black coating",
            priceModifier: { kind: "flat", amount: 45 },
            meta: {},
          },
        ],
      },
      {
        id: "style",
        label: "Style",
        type: "select",
        required: true,
        defaultValueId: "style_custom",
        values: [
          { id: "style_modern", label: "Modern", meta: {} },
          { id: "style_rustic", label: "Rustic", meta: {} },
          { id: "style_military", label: "Military", meta: {} },
          { id: "style_mountain", label: "Mountain", meta: {} },
          { id: "style_western", label: "Western", meta: {} },
          { id: "style_custom", label: "Custom", meta: {} },
        ],
      },
    ],
    dimensionPresets: [
      {
        id: "20in",
        label: '20" square',
        widthIn: 20,
        heightIn: 16,
        depthIn: 20,
        surfaceOverrides: {
          front: { widthIn: 18, heightIn: 12 },
          back: { widthIn: 18, heightIn: 12 },
          left: { widthIn: 18, heightIn: 12 },
          right: { widthIn: 18, heightIn: 12 },
        },
      },
      { id: "24in", label: '24" square', widthIn: 24, heightIn: 18, depthIn: 24, surfaceOverrides: {} },
      {
        id: "30in",
        label: '30" square',
        widthIn: 30,
        heightIn: 20,
        depthIn: 30,
        // Panels are capped at the machine's 24" work-area width — a 30" pit
        // uses framed 24"-wide art panels rather than full-span sides.
        surfaceOverrides: {
          front: { widthIn: 24, heightIn: 18 },
          back: { widthIn: 24, heightIn: 18 },
          left: { widthIn: 24, heightIn: 18 },
          right: { widthIn: 24, heightIn: 18 },
        },
      },
    ],
    defaultDimensionPresetId: "24in",
    surfaces: [panel("front", "Front"), panel("back", "Back"), panel("left", "Left"), panel("right", "Right")],
    allowedMaterialProfileIds: [ids.cortenMaterialId, ids.mildSteelMaterialId],
    defaultMachineProfileId: ids.fiberLaserMachineId,
    pricing: {
      basePrice: 429,
      perElementCharge: { text: 5, image: 15 },
      quantityTiers: [
        { minQty: 1, unitMultiplier: 1 },
        { minQty: 3, unitMultiplier: 0.92 },
      ],
      internalCost: {
        setupMinutes: 20,
        estMachineMinutesPerSqFt: 4,
        laborMinutes: 45,
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
    // What actually happens on the floor, in order. The laser runs; the rest
    // is bench work. Coating only appears when the customer chose it.
    operations: [
      {
        id: "laser-cut",
        name: "Laser cut panels",
        type: "cut",
        process: "fiber-laser",
        time: { basis: "per-sq-ft", minutesPerSqFt: 4 },
        setupMinutes: 20,
        labor: false,
        note: "Cuts all panels, the bottom plate, and the legs from nested stock.",
      },
      {
        id: "deburr",
        name: "Deburr edges",
        type: "finish",
        time: { basis: "per-part", minutesPerPart: 1.5, partIds: ["side-panel", "bottom-plate", "leg"] },
        setupMinutes: 0,
        labor: true,
      },
      {
        id: "form-flange",
        name: "Form top flange",
        type: "bend",
        machineProfileId: ids.pressBrakeMachineId,
        time: { basis: "per-part", minutesPerPart: 2.5, partIds: ["side-panel"] },
        setupMinutes: 15,
        labor: false,
        note: "Folds a 1\" return on each panel's top edge for rigidity.",
      },
      {
        id: "weld-assemble",
        name: "Weld and assemble",
        type: "weld",
        time: { basis: "per-unit", minutesPerUnit: 35 },
        setupMinutes: 10,
        labor: true,
      },
      {
        id: "high-temp-coat",
        name: "High-temp coating",
        type: "finish",
        time: { basis: "per-unit", minutesPerUnit: 15 },
        setupMinutes: 10,
        labor: true,
        requiresOptionValueId: "fin_hightemp",
      },
      {
        id: "pack",
        name: "Crate for shipping",
        type: "pack",
        time: { basis: "per-unit", minutesPerUnit: 8 },
        setupMinutes: 0,
        labor: true,
      },
    ],
    bom: [
      {
        id: "side-panel",
        name: "Side panel",
        kind: "cut-part",
        quantity: { mode: "per-surface" },
        dimensions: { source: "surface" },
        note: "Customer artwork cut through; top edge folded on the brake",
      },
      {
        id: "bottom-plate",
        name: "Bottom plate",
        kind: "cut-part",
        quantity: { mode: "fixed", count: 1 },
        dimensions: { source: "footprint" },
        note: "Drain holes per template",
      },
      {
        id: "leg",
        name: "Leg",
        kind: "cut-part",
        quantity: { mode: "fixed", count: 4 },
        dimensions: { source: "fixed", widthIn: 3, heightIn: 8 },
      },
      {
        id: "fasteners",
        name: "Stainless fastener set",
        kind: "hardware",
        quantity: { mode: "fixed", count: 1 },
        unitCost: 6.5,
        note: "16× M6 bolts, nuts, washers",
      },
      {
        id: "weld-consumables",
        name: "Weld wire / gas",
        kind: "consumable",
        quantity: { mode: "fixed", count: 1 },
        unitCost: 4,
      },
      {
        id: "packaging",
        name: "Crate + padding",
        kind: "packaging",
        quantity: { mode: "fixed", count: 1 },
        unitCost: 14,
      },
    ],
  };
}
