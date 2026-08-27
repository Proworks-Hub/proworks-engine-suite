// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import type { MachineProfileSpecs } from "../schemas/machineProfile.js";
import type { ProductConfiguration, SurfaceElement } from "../schemas/configuration.js";
import { productConfigurationSchema } from "../schemas/configuration.js";
import { computePrice, type PriceBreakdown } from "../pricing/pricingEngine.js";
import { runValidation } from "../validation/validationEngine.js";
import type { ValidationResult } from "../validation/types.js";
import { applyRepairs, suggestRepairs } from "../repair/designRepair.js";
import { buildConceptSystemPrompt, buildConceptUserPrompt } from "./conceptPrompt.js";
import {
  conceptResponseSchema,
  type AIProvider,
  type ConceptBrief,
  type ConceptDraft,
} from "./types.js";

export interface Concept {
  id: string;
  name: string;
  rationale: string;
  configuration: ProductConfiguration;
  price: PriceBreakdown;
  validation: ValidationResult;
  /** Repairs the engine applied to make the model's draft manufacturable. */
  repairsApplied: string[];
}

export interface GenerateConceptsInput {
  definition: ProductDefinition;
  materials: Map<number, MaterialProfileSpecs>;
  machine: MachineProfileSpecs;
  material?: MaterialProfileSpecs;
  brief: ConceptBrief;
  provider: AIProvider;
  count?: number;
}

export interface GenerateConceptsResult {
  concepts: Concept[];
  provider: string;
  /** Drafts discarded because they could not be made manufacturable. */
  rejected: { name: string; reason: string }[];
}

// Models return JSON with varying wrappers; pull out the first balanced
// object rather than trusting the whole string to parse.
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace scanning
  }
  const start = trimmed.indexOf("{");
  if (start === -1) throw new Error("Model returned no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error("Model returned malformed JSON");
}

// Turns a model draft into a real configuration: unknown option ids fall back
// to the definition's defaults, and text elements get engine-owned ids and
// defaults so nothing depends on the model getting the schema perfect.
function draftToConfiguration(
  draft: ConceptDraft,
  definition: ProductDefinition,
  index: number,
): ProductConfiguration {
  const selections: Record<string, string> = {};
  for (const group of definition.optionGroups) {
    const proposed = draft.selections?.[group.id];
    const valid = group.values.some((v) => v.id === proposed);
    const fallback = group.defaultValueId ?? group.values[0]?.id;
    if (valid) selections[group.id] = proposed;
    else if (fallback) selections[group.id] = fallback;
  }

  const surfaces: Record<string, SurfaceElement[]> = {};
  for (const surface of definition.surfaces) {
    if (!surface.editable) continue;
    const proposed = draft.surfaces?.[surface.id] ?? [];
    const allowsText = surface.allowedElementTypes.includes("text");
    if (!allowsText || proposed.length === 0) continue;
    surfaces[surface.id] = proposed.map((el, i) => ({
      id: `c${index}-${surface.id}-${i}`,
      type: "text" as const,
      text: el.text,
      fontFamily: "Arial",
      xIn: el.xIn,
      yIn: el.yIn,
      heightIn: el.heightIn,
      rotationDeg: 0,
    }));
  }

  return productConfigurationSchema.parse({ selections, surfaces, quantity: 1 });
}

export async function generateConcepts(
  input: GenerateConceptsInput,
): Promise<GenerateConceptsResult> {
  const count = input.count ?? 3;
  const raw = await input.provider.generate({
    system: buildConceptSystemPrompt({
      definition: input.definition,
      material: input.material,
      machine: input.machine,
      count,
    }),
    user: buildConceptUserPrompt(input.brief),
    maxTokens: 2000,
  });

  const parsed = conceptResponseSchema.safeParse(extractJsonObject(raw));
  if (!parsed.success) {
    throw new Error("The design assistant returned an unusable response");
  }

  const concepts: Concept[] = [];
  const rejected: { name: string; reason: string }[] = [];

  parsed.data.concepts.slice(0, count).forEach((draft, index) => {
    let configuration = draftToConfiguration(draft, input.definition, index);
    const engineInput = {
      definition: input.definition,
      materials: input.materials,
      machine: input.machine,
    };

    // The model designs; the engine enforces. Anything fixable is repaired
    // automatically so a near-miss concept still reaches the customer.
    let validation = runValidation({ ...engineInput, configuration });
    const repairsApplied: string[] = [];
    if (!validation.valid) {
      const repairs = suggestRepairs(validation.issues, {
        definition: input.definition,
        configuration,
      });
      if (repairs.length > 0) {
        configuration = applyRepairs(configuration, repairs);
        repairsApplied.push(...repairs.map((r) => r.label));
        validation = runValidation({ ...engineInput, configuration });
      }
    }

    if (!validation.valid) {
      rejected.push({
        name: draft.name,
        reason: validation.issues.find((i) => i.severity === "error")?.message ?? "not manufacturable",
      });
      return;
    }

    concepts.push({
      id: `concept-${index + 1}`,
      name: draft.name,
      rationale: draft.rationale,
      configuration,
      price: computePrice({ ...engineInput, configuration }),
      validation,
      repairsApplied,
    });
  });

  return { concepts, provider: input.provider.name, rejected };
}
