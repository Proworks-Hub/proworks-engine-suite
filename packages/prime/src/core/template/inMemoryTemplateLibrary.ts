/*
 * Copyright © 2026 Steven. All Rights Reserved.
 *
 * This file was created under the sole direction and vision of Steven.
 * All product decisions, business logic, workflows, and architecture
 * were defined by Steven. AI tools (Cursor, Perplexity, ChatGPT)
 * were used strictly as a coding assistant, similar to working with
 * a hired developer.
 *
 * Owner: Steven
 * Project: MakerOps / ProWorks Hub
 * Created: 2026
 */

/**
 * PRIME Engine — In-memory Template Library adapter
 *
 * Reference implementation of the `TemplateLibrary` port. Backed by a plain
 * Map; safe for tests and local dev. Real implementations will query the
 * finished-products DB and the custom-process template library.
 *
 * Spec: PRIME-ENGINE-SPEC.md §3.2.
 *
 * Matching:
 * - The default matcher looks up by `lineItem.materialId === template.id`.
 *   This is intentionally crude — Phase 1 is about proving the resolve loop,
 *   not the matching algorithm.
 * - Callers can inject a richer matcher via `options.matcher` for their
 *   own rules (product id, tag-based, AI-assisted, etc.) without changing
 *   the resolve use case.
 */

import type { IntakeLineItem } from "../intake/intakeTypes.js";
import type {
  ProcessTemplate,
  TemplateLibrary,
} from "./templateTypes.js";

export type TemplateMatcher = (
  lineItem: IntakeLineItem,
  templates: ReadonlyMap<string, ProcessTemplate>
) => ProcessTemplate | null;

export interface InMemoryTemplateLibraryOptions {
  /** Initial templates to seed the library with. Keyed by `template.id`. */
  readonly templates?: ReadonlyArray<ProcessTemplate>;
  /**
   * Custom matcher. Defaults to materialId → template.id lookup.
   * Return `null` to indicate "no template matches this line item".
   */
  readonly matcher?: TemplateMatcher;
}

/**
 * Create a new in-memory template library. Each call returns an independent
 * library — adding a template to one does not affect another.
 */
export function createInMemoryTemplateLibrary(
  options: InMemoryTemplateLibraryOptions = {}
): TemplateLibrary {
  const byId = new Map<string, ProcessTemplate>();
  for (const t of options.templates ?? []) {
    byId.set(t.id, t);
  }
  const match: TemplateMatcher = options.matcher ?? defaultMatcher;

  return {
    async findForLineItem(lineItem: IntakeLineItem) {
      return match(lineItem, byId);
    },
  };
}

function defaultMatcher(
  item: IntakeLineItem,
  templates: ReadonlyMap<string, ProcessTemplate>
): ProcessTemplate | null {
  // Phase 1 matcher — keyed on materialId. When materialId is absent or unknown,
  // we return null rather than guess; the use case then surfaces a clear
  // `template_not_found` error so Pre-Production can pick manually.
  if (item.materialId && templates.has(item.materialId)) {
    return templates.get(item.materialId) ?? null;
  }
  return null;
}
