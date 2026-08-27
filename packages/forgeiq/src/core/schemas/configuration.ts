import { z } from "zod";

// All element geometry is in INCHES relative to the surface's top-left corner.
// The UI converts px <-> in; the server engines only ever see inches.

export const textElementSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  text: z.string().min(1).max(200),
  fontFamily: z.string().default("Arial"),
  xIn: z.number(),
  yIn: z.number(),
  heightIn: z.number().positive(), // cap height — the min-text-height rule's target
  rotationDeg: z.number().default(0),
});

export const imageElementSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  url: z.string(), // as returned by the host's injected uploadFile
  // Captured at upload; required for the image-resolution rule.
  naturalWidthPx: z.number().int().positive(),
  naturalHeightPx: z.number().int().positive(),
  // Count of enclosed interior holes in the artwork's silhouette, captured by
  // client-side tracing at upload. When the design is cut through, material
  // inside each hole becomes a free-falling island — the artwork-islands
  // rule warns on this. Absent for untraceable images (JPEG/full-bleed).
  interiorIslands: z.number().int().min(0).optional(),
  xIn: z.number(),
  yIn: z.number(),
  widthIn: z.number().positive(),
  heightIn: z.number().positive(),
  rotationDeg: z.number().default(0),
});

export const surfaceElementSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
]);

export const productConfigurationSchema = z.object({
  selections: z.record(z.string()), // optionGroupId → optionValueId
  surfaces: z.record(z.array(surfaceElementSchema)), // surfaceId → elements
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(2000).optional(),
});

export type TextElement = z.infer<typeof textElementSchema>;
export type ImageElement = z.infer<typeof imageElementSchema>;
export type SurfaceElement = z.infer<typeof surfaceElementSchema>;
export type ProductConfiguration = z.infer<typeof productConfigurationSchema>;
