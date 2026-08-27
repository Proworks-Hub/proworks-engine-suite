// Copyright (c) 2026 Steven Kreutzer. All rights reserved.
// Proprietary and confidential. Unauthorized copying, modification, or
// distribution of this file, via any medium, is strictly prohibited.

import type { ProductDefinition } from "../schemas/productDefinition.js";
import type { MaterialProfileSpecs } from "../schemas/materialProfile.js";
import type { MachineProfileSpecs } from "../schemas/machineProfile.js";
import type { ConceptBrief } from "./types.js";

// Manufacturing-aware prompting: the model is told what the shop can actually
// make — panel sizes, minimum cuttable text, the material, the machine — so
// concepts arrive manufacturable rather than merely attractive. Anything it
// gets wrong is still caught by the validation engine afterwards; the prompt
// exists to make that rare, not to be trusted.

export function buildConceptSystemPrompt(input: {
  definition: ProductDefinition;
  material?: MaterialProfileSpecs;
  machine?: MachineProfileSpecs;
  count: number;
}): string {
  const { definition: def, count } = input;

  const surfaces = def.surfaces
    .filter((s) => s.editable)
    .map((s) => {
      const usableW = s.widthIn - s.safeAreaIn * 2;
      const usableH = s.heightIn - s.safeAreaIn * 2;
      return `  - "${s.id}" (${s.name}): ${s.widthIn}" x ${s.heightIn}", usable area ${usableW.toFixed(2)}" x ${usableH.toFixed(2)}" starting at (${s.safeAreaIn}", ${s.safeAreaIn}")`;
    })
    .join("\n");

  const options = def.optionGroups
    .map((g) => `  - "${g.id}" (${g.label}): ${g.values.map((v) => `"${v.id}"${v.label ? ` = ${v.label}` : ""}`).join(", ")}`)
    .join("\n");

  const c = def.constraints;

  return [
    `You design ${def.name.toLowerCase()}s that a fabrication shop cuts from solid material.`,
    `Every design you produce must be physically manufacturable on the shop's equipment.`,
    "",
    "PRODUCT",
    `  ${def.name} — process: ${def.manufacturingProcess}`,
    input.material
      ? `  Material: ${input.material.category}, ${input.material.thicknessIn}" thick`
      : "",
    input.machine
      ? `  Machine work area: ${input.machine.workAreaWidthIn}" x ${input.machine.workAreaHeightIn}"`
      : "",
    "",
    "CUSTOMIZABLE PANELS (coordinates in inches from each panel's top-left)",
    surfaces,
    "",
    "OPTIONS you must choose from (use the exact ids)",
    options,
    "",
    "MANUFACTURING RULES — a design that breaks these cannot be built",
    `  - Text must be at least ${c.minTextHeightIn}" tall or it cannot be cut cleanly.`,
    `  - Keep every element fully inside the usable area listed for its panel.`,
    `  - Minimum feature size is ${c.minFeatureIn}"; avoid delicate detail.`,
    `  - Text is cut THROUGH the material. Letters with enclosed centers (O, A, B, D)`,
    `    need bridges, which the shop adds automatically — prefer short, bold wording.`,
    `  - Estimate width as roughly 0.6 x height per character when placing text, and`,
    `    leave margin so long words do not run past the panel edge.`,
    "",
    "DESIGN GUIDANCE",
    "  - Personal and specific beats generic: use the names, dates, and service",
    "    details the customer gave you.",
    "  - Different concepts should feel genuinely different, not reworded.",
    "  - Leave a panel's array empty when a blank panel serves the design better.",
    "  - You cannot add images or artwork — text only.",
    "",
    `OUTPUT — return ONLY minified JSON, no prose, no markdown fences:`,
    `{"concepts":[{"name":"...","rationale":"one sentence for the customer",`,
    `"selections":{"<groupId>":"<valueId>"},`,
    `"surfaces":{"<surfaceId>":[{"text":"...","xIn":0,"yIn":0,"heightIn":0}]}}]}`,
    `Return exactly ${count} concepts.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildConceptUserPrompt(brief: ConceptBrief): string {
  const rows = [
    ["What they want", brief.what],
    ["Who it is for", brief.who],
    ["Occasion", brief.occasion],
    ["Style", brief.style],
    ["Must include", brief.mustInclude],
    ["Avoid", brief.avoid],
  ].filter(([, value]) => value && String(value).trim().length > 0);

  if (rows.length === 0) {
    return "The customer gave no details. Produce broadly appealing concepts.";
  }
  return rows.map(([label, value]) => `${label}: ${value}`).join("\n");
}
