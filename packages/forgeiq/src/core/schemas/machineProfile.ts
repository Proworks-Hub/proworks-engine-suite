// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import { z } from "zod";

// The jsonb "specs" body of a machine profile row. Identity (id, orgId, name,
// active) lives as real columns on mo_machine_profiles.
export const machineProfileSpecsSchema = z.object({
  process: z.string(), // e.g. "fiber-laser", "co2-laser", "uv-printer"
  workAreaWidthIn: z.number().positive(),
  workAreaHeightIn: z.number().positive(),
  maxMaterialThicknessIn: z.number().positive(),
  // Material categories this machine can process, e.g. ["corten", "mild-steel"]
  compatibleMaterialCategories: z.array(z.string()),
  costPerHour: z.number().min(0), // internal — never exposed on public endpoints
  setupMinutesDefault: z.number().min(0).default(10),
});

export type MachineProfileSpecs = z.infer<typeof machineProfileSpecsSchema>;
