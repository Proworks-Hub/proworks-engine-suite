import { z } from "zod";

// Provider abstraction — the engine never imports a vendor SDK. Hosts inject
// whatever model they use; the engine owns the prompt, the schema, and the
// manufacturing validation of whatever comes back.

export interface AIGenerateRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface AIProvider {
  /** Identifier surfaced in responses and logs, e.g. "anthropic" | "mock". */
  name: string;
  /**
   * Returns the model's raw text. The engine parses and validates it — a
   * provider must not attempt to interpret the payload.
   */
  generate(request: AIGenerateRequest): Promise<string>;
}

// ── The five questions ──────────────────────────────────────────────────────
export const conceptBriefSchema = z.object({
  what: z.string().max(300).optional(), // "a fire pit for my dad"
  who: z.string().max(200).optional(), // "retired Navy, last name Thompson"
  occasion: z.string().max(200).optional(), // "Father's Day"
  style: z.string().max(200).optional(), // "outdoorsy, rustic"
  mustInclude: z.string().max(300).optional(), // "his name and Est. 1974"
  avoid: z.string().max(300).optional(),
});
export type ConceptBrief = z.infer<typeof conceptBriefSchema>;

// ── What we ask the model to return ─────────────────────────────────────────
// Deliberately narrow: text placements only. The model cannot upload artwork,
// and geometry it invents must survive engine validation, so the shape stays
// small enough to be reliably produced and fully checkable.
export const conceptTextElementSchema = z.object({
  text: z.string().min(1).max(60),
  xIn: z.number(),
  yIn: z.number(),
  heightIn: z.number().positive(),
});

export const conceptDraftSchema = z.object({
  name: z.string().max(80),
  rationale: z.string().max(400),
  selections: z.record(z.string()),
  surfaces: z.record(z.array(conceptTextElementSchema)),
});

export const conceptResponseSchema = z.object({
  concepts: z.array(conceptDraftSchema).min(1),
});

export type ConceptDraft = z.infer<typeof conceptDraftSchema>;
