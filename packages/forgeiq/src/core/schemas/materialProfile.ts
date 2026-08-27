import { z } from "zod";

// The jsonb "specs" body of a material profile row. Identity (id, orgId, name,
// active) lives as real columns on mo_material_profiles.
export const materialProfileSpecsSchema = z.object({
  category: z.string(), // matches MachineProfileSpecs.compatibleMaterialCategories
  thicknessIn: z.number().positive(),
  sheetWidthIn: z.number().positive(),
  sheetHeightIn: z.number().positive(),
  costPerSqFt: z.number().min(0), // internal — never exposed on public endpoints
  customerUpchargePerSqFt: z.number().min(0).default(0),
  finishOptions: z.array(z.string()).default([]),
});

export type MaterialProfileSpecs = z.infer<typeof materialProfileSpecsSchema>;
