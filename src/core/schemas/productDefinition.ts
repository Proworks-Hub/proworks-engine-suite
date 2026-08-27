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
});

export type PriceModifier = z.infer<typeof priceModifierSchema>;
export type OptionValue = z.infer<typeof optionValueSchema>;
export type OptionGroup = z.infer<typeof optionGroupSchema>;
export type DimensionPreset = z.infer<typeof dimensionPresetSchema>;
export type ProductSurface = z.infer<typeof surfaceSchema>;
export type PricingRules = z.infer<typeof pricingRulesSchema>;
export type ManufacturingConstraints = z.infer<typeof manufacturingConstraintsSchema>;
export type ProductDefinition = z.infer<typeof productDefinitionSchema>;
