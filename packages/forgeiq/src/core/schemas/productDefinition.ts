// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// ── Price modifiers ─────────────────────────────────────────────────────────
// "flat" adds USD to the running subtotal; "percent" multiplies it
// (amount 0.10 = +10%). Applied in definition order of the option groups.
export const priceModifierSchema = z.object({
  kind: z.enum(["flat", "percent"]),
  amount: z.number(),
});

// One selectable value inside an option group.
export const optionValueSchema = z.object({
  id: z.string(), // "size_24", "mat_corten_125"
  label: z.string(),
  description: z.string().optional(),
  priceModifier: priceModifierSchema.optional(),
  // Cross-references resolved against profile rows / definition blocks:
  materialProfileId: z.number().int().optional(), // material-type groups
  machineProfileId: z.number().int().optional(), // overrides defaultMachineProfileId
  dimensionPresetId: z.string().optional(), // size-type groups
  meta: z.record(z.unknown()).default({}), // forward-compat escape hatch
});

export const optionGroupSchema = z.object({
  id: z.string(), // "size", "material", "finish", "style"
  label: z.string(),
  type: z.literal("select"), // Phase 1: select only; enum grows later
  required: z.boolean().default(true),
  defaultValueId: z.string().optional(),
  values: z.array(optionValueSchema).min(1),
  // Conditional visibility — parsed and stored now, enforced by the UI in a
  // later phase.
  visibleWhen: z
    .array(z.object({ groupId: z.string(), valueIdIn: z.array(z.string()) }))
    .optional(),
});

// ── Dimensions ──────────────────────────────────────────────────────────────
export const dimensionPresetSchema = z.object({
  id: z.string(), // "24in"
  label: z.string(),
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  depthIn: z.number().positive().optional(),
  // Per-preset surface size overrides (surfaceId → dims): a 30" fire pit has
  // bigger panels than a 20" one without duplicating the surface list.
  surfaceOverrides: z
    .record(
      z.object({
        widthIn: z.number().positive(),
        heightIn: z.number().positive(),
      }),
    )
    .default({}),
});

// ── Surfaces (customizable areas) ───────────────────────────────────────────
export const surfaceSchema = z.object({
  id: z.string(), // "front" | "back" | ...
  name: z.string(),
  widthIn: z.number().positive(), // dims for the default preset
  heightIn: z.number().positive(),
  safeAreaIn: z.number().min(0).default(0.5), // inset from all edges
  editable: z.boolean().default(true),
  allowedElementTypes: z.array(z.enum(["text", "image"])).default(["text", "image"]),
});

// ── Pricing rules ───────────────────────────────────────────────────────────
export const pricingRulesSchema = z.object({
  basePrice: z.number().min(0), // customer-facing base, USD
  perElementCharge: z.object({
    text: z.number().min(0).default(0),
    image: z.number().min(0).default(0),
  }),
  // Sorted ascending by minQty; highest tier with minQty <= quantity wins.
  quantityTiers: z
    .array(
      z.object({
        minQty: z.number().int().min(1),
        unitMultiplier: z.number().positive(),
      }),
    )
    .default([{ minQty: 1, unitMultiplier: 1 }]),
  // Internal-cost estimation knobs — admin-only outputs.
  internalCost: z.object({
    setupMinutes: z.number().min(0).default(15),
    estMachineMinutesPerSqFt: z.number().min(0),
    laborMinutes: z.number().min(0).default(0),
    laborRatePerHour: z.number().min(0).default(30),
    targetMarginPct: z.number().min(0).max(0.95).default(0.5),
  }),
});

// ── Bill of materials ───────────────────────────────────────────────────────
// What the shop actually consumes to build one unit. Cut parts are nested on
// stock sheets to derive the real material requirement; hardware and
// consumables are counted and costed per unit.
export const bomComponentSchema = z.object({
  id: z.string(), // "side-panel", "bottom-plate", "leg", "fasteners"
  name: z.string(),
  kind: z.enum(["cut-part", "hardware", "consumable", "packaging"]),
  // How many per unit: a fixed count, or one per customizable surface (so a
  // 4-panel product yields 4 side panels without hardcoding the number).
  quantity: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("fixed"), count: z.number().int().min(1) }),
    z.object({ mode: z.literal("per-surface") }),
  ]),
  // Cut parts need dimensions to nest. "surface" takes the resolved panel
  // size; "footprint" takes the selected preset's width/depth; "fixed" is
  // literal inches.
  dimensions: z
    .discriminatedUnion("source", [
      z.object({ source: z.literal("surface") }),
      z.object({ source: z.literal("footprint") }),
      z.object({
        source: z.literal("fixed"),
        widthIn: z.number().positive(),
        heightIn: z.number().positive(),
      }),
    ])
    .optional(),
  // Hardware/consumables carry their own cost; cut parts inherit the
  // selected material's sheet cost through nesting.
  unitCost: z.number().min(0).optional(),
  note: z.string().optional(),
});

// ── Manufacturing operations ────────────────────────────────────────────────
// What physically happens to turn stock into the finished product, in order.
// A product without operations still works: the plan derives a single
// primary operation from the pricing block's time estimate, which is how
// every definition behaved before this existed.

// The operation vocabulary is a shared contract — declared once in
// @proworks-hub/contracts and re-exported here so product definitions and
// manufacturing plans can never drift apart.
export { operationTypeSchema } from "@proworks-hub/contracts";
import { operationTypeSchema } from "@proworks-hub/contracts";

/** How long an operation takes, expressed against something real. */
export const operationTimeSchema = z.discriminatedUnion("basis", [
  /** Scales with the customizable area — cutting, engraving, printing. */
  z.object({ basis: z.literal("per-sq-ft"), minutesPerSqFt: z.number().min(0) }),
  /** Scales with part count — deburring, bending, drilling. */
  z.object({
    basis: z.literal("per-part"),
    minutesPerPart: z.number().min(0),
    /**
     * BOM component ids this applies to. A per-surface component expands to
     * ids like "side-panel:front", so listing "side-panel" covers them all.
     * Omit to apply to every cut part.
     */
    partIds: z.array(z.string()).optional(),
  }),
  /** Scales with order quantity — assembly, finishing, packing. */
  z.object({ basis: z.literal("per-unit"), minutesPerUnit: z.number().min(0) }),
  /** Once per job regardless of quantity. */
  z.object({ basis: z.literal("fixed"), minutes: z.number().min(0) }),
]);

export const productOperationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: operationTypeSchema,
  /**
   * Machine process this runs on, matching a MachineProfile's `process`.
   * Omit for bench work that occupies a person rather than a machine.
   */
  process: z.string().optional(),
  machineProfileId: z.number().int().optional(),
  time: operationTimeSchema,
  /** Once-per-job setup, never multiplied by quantity. */
  setupMinutes: z.number().min(0).default(0),
  /** Bench work: costed at the labor rate rather than a machine rate. */
  labor: z.boolean().default(false),
  /** Include only when this option value is selected — e.g. a coating step. */
  requiresOptionValueId: z.string().optional(),
  note: z.string().optional(),
});

// ── Manufacturing constraints ───────────────────────────────────────────────
export const manufacturingConstraintsSchema = z.object({
  minFeatureIn: z.number().positive().default(0.05),
  minTextHeightIn: z.number().positive().default(0.25),
  minImageDpi: z.number().positive().default(150),
  maxPanelWidthIn: z.number().positive().optional(),
  maxPanelHeightIn: z.number().positive().optional(),
});

// ── The definition ──────────────────────────────────────────────────────────
// Stored as the jsonb body of a mo_product_definitions row; id, orgId, slug,
// version, and status are real columns (slug is duplicated here for
// portability of the document itself).
export const productDefinitionSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  category: z.string(), // "fire-pit"
  manufacturingProcess: z.string(), // "fiber-laser-cut"
  description: z.string().optional(),
  optionGroups: z.array(optionGroupSchema),
  dimensionPresets: z.array(dimensionPresetSchema).min(1),
  defaultDimensionPresetId: z.string(),
  surfaces: z.array(surfaceSchema),
  allowedMaterialProfileIds: z.array(z.number().int()),
  defaultMachineProfileId: z.number().int(),
  pricing: pricingRulesSchema,
  constraints: manufacturingConstraintsSchema,
  // Optional: products without a BOM fall back to area-based material costing.
  bom: z.array(bomComponentSchema).default([]),
  // Optional: products without operations fall back to a single derived one.
  operations: z.array(productOperationSchema).default([]),
});

export type PriceModifier = z.infer<typeof priceModifierSchema>;
export type OptionValue = z.infer<typeof optionValueSchema>;
export type OptionGroup = z.infer<typeof optionGroupSchema>;
export type DimensionPreset = z.infer<typeof dimensionPresetSchema>;
export type ProductSurface = z.infer<typeof surfaceSchema>;
export type PricingRules = z.infer<typeof pricingRulesSchema>;
export type BomComponent = z.infer<typeof bomComponentSchema>;
export type { OperationType } from "@proworks-hub/contracts";
export type OperationTime = z.infer<typeof operationTimeSchema>;
export type ProductOperation = z.infer<typeof productOperationSchema>;
export type ManufacturingConstraints = z.infer<typeof manufacturingConstraintsSchema>;
export type ProductDefinition = z.infer<typeof productDefinitionSchema>;
